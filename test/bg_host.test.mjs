import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findLiveBgSession, listLiveBgSessions, stopBgSession } from "../src/acp/bg_registry.mjs";
import { HostAcpClient, spawnSessionHost } from "../src/acp/host_client.mjs";
import { LucidApp } from "../src/app.mjs";
import { parseCliArgs, withDangerouslySkipPermissions } from "../src/config.mjs";

const MOCK_BG_AGENT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let nextId = 100;
const pending = new Map();
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id && !msg.method) {
    const fn = pending.get(msg.id);
    if (fn) { pending.delete(msg.id); fn(msg.result); }
    return;
  }
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Mock BG Agent", version: "1.0" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, load: {}, resume: {}, close: {} } },
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "bg-sess-1",
        modes: { currentModeId: "auto", availableModes: [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }] },
      },
    });
    return;
  }
  if (msg.method === "session/prompt") {
    const sid = msg.params.sessionId;
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working in background..." } } },
    });
    const permId = nextId++;
    pending.set(permId, (res) => {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " Finished (" + res.outcome.optionId + ")!" } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    });
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: permId,
        method: "session/request_permission",
        params: {
          sessionId: sid,
          title: "Run evaluation script?",
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
    }, 120);
    return;
  }
  if (msg.id) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;

test("parseCliArgs supports bg subcommands (list, prompt, stop)", () => {
  assert.equal(parseCliArgs(["bg"]).bgList, true);
  assert.equal(parseCliArgs(["bg", "ls"]).bgList, true);
  assert.equal(parseCliArgs(["bg", "stop", "a1b2c3"]).bgStop, "a1b2c3");
  assert.equal(parseCliArgs(["bg", "stop", "all"]).bgStop, "all");

  const runOpts = parseCliArgs(["bg", "--bypass", "-m", "neon", "Run", "all", "tests"]);
  assert.equal(runOpts.bgPrompt, "Run all tests");
  assert.equal(runOpts.dangerouslySkipPermissions, true);
  assert.equal(runOpts.model, "neon");
});

test("SessionHost survives detach mid-turn, queues permissions, replays full state on resume, and cleans up on stop", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-bg-test-"));
  const bgDir = path.join(tmpDir, "bg");
  const mockPath = path.join(tmpDir, "mock_agent.cjs");
  fs.writeFileSync(mockPath, MOCK_BG_AGENT, "utf8");

  const launchSpec = {
    name: "Mock BG Agent",
    command: process.execPath,
    args: [mockPath],
    supportsQuotaCli: false,
  };

  let hostMeta = null;
  try {
    const spawned = spawnSessionHost({
      cwd: tmpDir,
      launchSpec,
      bgDir,
    });

    // 1. Connect first client, create session, start a prompt, then detach immediately.
    const client1 = new HostAcpClient({ hostId: spawned.hostId, socketPath: spawned.socketPath, launchSpec });
    await client1.start(10000);
    const created = await client1.createSession(tmpDir, []);
    assert.equal(created.sessionId, "bg-sess-1");

    await client1.sendPrompt(created.sessionId, [{ type: "text", text: "Start long job" }], {
      text: "Start long job",
    });

    const detachInfo = await client1.detach();
    assert.equal(detachInfo.hostId, spawned.hostId);

    // Wait for the detached mock agent to emit its permission request while nobody is attached.
    let found = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const live = listLiveBgSessions({ cwd: tmpDir, bgDir });
      if (live.length === 1 && live[0].status === "waiting_permission") {
        found = live[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(found, "detached host should stay alive and report waiting_permission");
    hostMeta = found;
    assert.equal(findLiveBgSession(spawned.hostId.slice(0, 4), { bgDir })?.hostId, spawned.hostId);

    // 2. Re-attach via a fresh HostAcpClient & LucidApp.applyHostSnapshot (as /resume does).
    const client2 = new HostAcpClient({ hostId: found.hostId, socketPath: found.socketPath, launchSpec });
    const donePromise = new Promise((resolve) => client2.once("promptDone", resolve));
    const snapshot = await client2.start(10000);

    assert.equal(snapshot.sessionId, "bg-sess-1");
    assert.equal(snapshot.busy, true);
    assert.equal(snapshot.pendingPermissions.length, 1);

    const app = new LucidApp({ cwd: tmpDir, direct: true });
    app.scheduleRender = () => {};
    app.acp = client2;
    app.bindAcpClient(client2);
    app.state.connected = true;
    app.applyHostSnapshot(snapshot);

    assert.equal(app.state.busy, true);
    assert.equal(app.modal?.type, "permission", "queued permission dialog restores immediately on attach");
    assert.ok(app.state.items.some((i) => i.type === "user" && i.text === "Start long job"));

    // 3. Approve the permission and wait for the turn to complete live.
    app.resolveActivePermission(0);
    const doneInfo = await donePromise;
    assert.equal(doneInfo.stopReason, "end_turn");

    const assistantMsg = app.state.items.find((i) => i.type === "assistant");
    assert.ok(assistantMsg?.text.includes("Working in background..."));
    assert.ok(assistantMsg?.text.includes("Finished (allow-once)!"));
    assert.equal(app.state.busy, false);

    // 4. Clean shutdown removes host files and exits the host process.
    await client2.stop();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(listLiveBgSessions({ allCwd: true, includeAttached: true, bgDir }).length, 0);
    hostMeta = null;
  } finally {
    if (hostMeta) {
      await stopBgSession(hostMeta);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("withDangerouslySkipPermissions toggles flag without duplicating or mutating source spec", () => {
  const base = { name: "Antigravity", command: "agy", args: ["acp", "--stdio"], supportsDangerouslySkipPermissions: true };
  const upgraded = withDangerouslySkipPermissions(base, true);
  assert.deepEqual(base.args, ["acp", "--stdio"]);
  assert.deepEqual(upgraded.args, ["acp", "--stdio", "--dangerously-skip-permissions"]);

  const upgradedTwice = withDangerouslySkipPermissions(upgraded, true);
  assert.deepEqual(upgradedTwice.args, ["acp", "--stdio", "--dangerously-skip-permissions"]);

  const downgraded = withDangerouslySkipPermissions(upgraded, false);
  assert.deepEqual(downgraded.args, ["acp", "--stdio"]);
});

test("SessionHost hot-upgrades and downgrades backend with --dangerously-skip-permissions on Bypass switch and defers while workers run", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-bypass-swap-"));
  const bgDir = path.join(tmpDir, "bg");
  const logPath = path.join(tmpDir, "rpc.jsonl");
  const mockPath = path.join(tmpDir, "swap_agent.cjs");

  const MOCK_SWAP_AGENT = `
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.argv[2];
const argvFlags = process.argv.slice(3);
const record = (entry) => fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, argvFlags, ...entry }) + "\\n");
record({ event: "spawn" });

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let mode = "auto";
let model = "gemini-4";
let thought = "high";

const makeConfigOptions = () => [
  { id: "model", category: "model", currentValue: model, options: [{ value: "gemini-4", name: "Gemini 4" }] },
  { id: "thought_level", category: "thought_level", currentValue: thought, options: [{ value: "high", name: "High" }] },
];

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  record({ event: "rpc", method: msg.method, params: msg.params });
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Mock Swap Agy", version: "1.5.14" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {}, list: {}, close: {} } },
      },
    });
    return;
  }
  if (msg.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "bg-sess-swap",
        modes: { currentModeId: mode, availableModes: [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }] },
        configOptions: makeConfigOptions(),
      },
    });
    return;
  }
  if (msg.method === "session/resume") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: msg.params.sessionId,
        modes: { currentModeId: mode, availableModes: [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }] },
        configOptions: makeConfigOptions(),
      },
    });
    return;
  }
  if (msg.method === "session/set_mode") {
    mode = msg.params.modeId;
    send({ jsonrpc: "2.0", id: msg.id, result: { modes: { currentModeId: mode } } });
    return;
  }
  if (msg.method === "session/set_config_option") {
    if (msg.params.configId === "mode") mode = msg.params.value;
    if (msg.params.configId === "model") model = msg.params.value;
    if (msg.params.configId === "thought_level") thought = msg.params.value;
    send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: makeConfigOptions() } });
    return;
  }
  if (msg.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: msg.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Initial reply." } } },
    });
    send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    return;
  }
  if (msg.id) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;
  fs.writeFileSync(mockPath, MOCK_SWAP_AGENT, "utf8");

  const launchSpec = {
    name: "Mock Swap Agy",
    command: process.execPath,
    args: [mockPath, logPath],
    supportsQuotaCli: false,
    supportsDangerouslySkipPermissions: true,
  };

  let client = null;
  let hostMeta = null;
  try {
    const spawned = spawnSessionHost({ cwd: tmpDir, launchSpec, bgDir });
    client = new HostAcpClient({ hostId: spawned.hostId, socketPath: spawned.socketPath, launchSpec, hostPid: spawned.pid });

    let disconnects = 0;
    client.on("disconnect", () => {
      disconnects += 1;
    });

    await client.start(10000);
    const created = await client.createSession(tmpDir, []);
    assert.equal(created.sessionId, "bg-sess-swap");

    const donePromise = new Promise((resolve) => client.once("promptDone", resolve));
    await client.sendPrompt("bg-sess-swap", [{ type: "text", text: "Hello" }], { text: "Hello" });
    await donePromise;

    // 1. While Swarm workers are running, bypass swap defers without killing running backend.
    const deferredRes = await client.setBypassPermissions(true, { modeId: "auto", hasRunningMembers: true });
    assert.equal(deferredRes.deferred, true);
    assert.equal(deferredRes.restarted, false);
    assert.equal(deferredRes.nativeBypass, false);

    // 2. When idle, setBypassPermissions(true) hot-restarts backend with --dangerously-skip-permissions via session/resume.
    const upgradeRes = await client.setBypassPermissions(true, { modeId: "auto", hasRunningMembers: false });
    assert.equal(upgradeRes.restarted, true);
    assert.equal(upgradeRes.nativeBypass, true);
    assert.equal(upgradeRes.deferred, false);
    assert.equal(disconnects, 0, "hot-swap must not fire spurious disconnect");

    // 3. Switching back out of Bypass removes --dangerously-skip-permissions cleanly.
    const downgradeRes = await client.setBypassPermissions(false, { modeId: "default", hasRunningMembers: false });
    assert.equal(downgradeRes.restarted, true);
    assert.equal(downgradeRes.nativeBypass, false);
    assert.equal(disconnects, 0);

    const events = fs
      .readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const spawns = events.filter((e) => e.event === "spawn");
    assert.equal(spawns.length, 3, "should have initial spawn + bypass upgrade + bypass downgrade");
    assert.equal(spawns[0].argvFlags.includes("--dangerously-skip-permissions"), false);
    assert.equal(spawns[1].argvFlags.includes("--dangerously-skip-permissions"), true);
    assert.equal(spawns[2].argvFlags.includes("--dangerously-skip-permissions"), false);

    const resumedBySecond = events.filter((e) => e.pid === spawns[1].pid && e.method === "session/resume");
    assert.equal(resumedBySecond.length, 1);
    assert.equal(resumedBySecond[0].params.sessionId, "bg-sess-swap");
    const restoredThoughtBySecond = events.filter(
      (e) => e.pid === spawns[1].pid && e.method === "session/set_config_option" && e.params?.configId === "thought_level",
    );
    assert.equal(restoredThoughtBySecond[0]?.params?.value, "high");

    // 4. Deferred switch in LucidApp flushes automatically once Swarm workers finish.
    const app = new LucidApp({ cwd: tmpDir, direct: true });
    app.scheduleRender = () => {};
    app.acp = client;
    app.bindAcpClient(client);
    app.state.connected = true;
    app.state.sessionId = "bg-sess-swap";
    app.state.modes = [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }];
    app.state.modeId = "auto";
    app.state.multiAgent.applyAgyState({
      workers: [{ name: "ckpt-publisher", state: "working", startedAt: Date.now() }],
    });
    await app.switchMode("bypass");
    assert.equal(app.state.sessionBypass, true);
    assert.equal(app.state.nativeBypassActive, false);
    assert.ok(app.pendingNativeBypass, "queued while ckpt-publisher is working");

    app.state.multiAgent.applyAgyState({
      workers: [{ name: "ckpt-publisher", state: "waiting", startedAt: Date.now() }],
    });
    app.state.busy = false;
    const { maybeFlushPendingNativeBypass } = await import("../src/app/session.mjs");
    maybeFlushPendingNativeBypass(app);
    for (let i = 0; i < 40 && !app.state.nativeBypassActive; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(app.state.nativeBypassActive, true, "flushed native bypass once workers paused");

    await client.stop();
    client = null;
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    if (client) {
      await client.stop().catch(() => {});
    }
    if (hostMeta) {
      await stopBgSession(hostMeta);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("switchMode into Bypass updates immediately, skips restart when cycling past quickly, and upgrades in background when held", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-bypass-instant-"));
  const bgDir = path.join(tmpDir, "bg");
  const logPath = path.join(tmpDir, "rpc.jsonl");
  const mockPath = path.join(tmpDir, "instant_agent.cjs");

  const MOCK_INSTANT_AGENT = `
const fs = require("node:fs");
const readline = require("node:readline");
const logPath = process.argv[2];
const argvFlags = process.argv.slice(3);
fs.appendFileSync(logPath, JSON.stringify({ event: "spawn", pid: process.pid, argvFlags }) + "\\n");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
let mode = "default";

rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "Mock Instant Agy", version: "1.5.14" },
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, load: {}, list: {}, close: {} } },
      },
    });
    return;
  }
  if (msg.method === "session/new" || msg.method === "session/resume") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId: "bg-sess-instant",
        modes: { currentModeId: mode, availableModes: [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }] },
      },
    });
    return;
  }
  if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
    mode = msg.params.modeId || msg.params.value || mode;
    send({ jsonrpc: "2.0", id: msg.id, result: { modes: { currentModeId: mode } } });
    return;
  }
  if (msg.id) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;
  fs.writeFileSync(mockPath, MOCK_INSTANT_AGENT, "utf8");

  const launchSpec = {
    name: "Mock Instant Agy",
    command: process.execPath,
    args: [mockPath, logPath],
    supportsQuotaCli: false,
    supportsDangerouslySkipPermissions: true,
  };

  let client = null;
  try {
    const spawned = spawnSessionHost({ cwd: tmpDir, launchSpec, bgDir });
    client = new HostAcpClient({ hostId: spawned.hostId, socketPath: spawned.socketPath, launchSpec, hostPid: spawned.pid });
    await client.start(10000);
    await client.createSession(tmpDir, []);

    const app = new LucidApp({ cwd: tmpDir, direct: true });
    app.scheduleRender = () => {};
    app.launchSpec = launchSpec;
    app.nativeBypassDebounceMs = 80;
    app.acp = client;
    app.bindAcpClient(client);
    app.state.connected = true;
    app.state.sessionId = "bg-sess-instant";
    app.state.modes = [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }];
    app.state.modeId = "default";

    // 1. Cycling into Bypass and immediately out cancels the debounced restart (zero extra spawns).
    await app.switchMode("bypass");
    assert.equal(app.state.sessionBypass, true);
    assert.equal(app.state.modeId, "auto");
    assert.equal(app.state.nativeBypassActive, false, "switchMode returns without blocking on backend restart");

    await app.switchMode("default");
    assert.equal(app.state.sessionBypass, false);
    assert.equal(app.state.modeId, "default");

    await new Promise((r) => setTimeout(r, 140));
    const spawnsAfterCycle = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(spawnsAfterCycle.length, 1, "cycling past Bypass quickly must not restart the backend");

    // 2. Staying in Bypass past the debounce window upgrades the backend quietly in the background.
    await app.switchMode("bypass");
    for (let i = 0; i < 40 && !app.state.nativeBypassActive; i += 1) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(app.state.nativeBypassActive, true, "holding Bypass completes background native upgrade");
    const spawnsAfterHold = fs.readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(spawnsAfterHold.length, 2);
    assert.equal(spawnsAfterHold[1].argvFlags.includes("--dangerously-skip-permissions"), true);

    await client.stop();
    client = null;
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    if (client) await client.stop().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
