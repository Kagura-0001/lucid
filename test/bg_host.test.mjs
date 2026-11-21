import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findLiveBgSession, listLiveBgSessions, stopBgSession } from "../src/acp/bg_registry.mjs";
import { HostAcpClient, spawnSessionHost } from "../src/acp/host_client.mjs";
import { LucidApp } from "../src/app.mjs";
import { parseCliArgs } from "../src/config.mjs";

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
