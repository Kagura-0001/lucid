import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readAgyOrchestratorConfig, saveAgyOrchestratorSettings } from "../src/acp/agy_state.mjs";
import {
  buildPermissionHookCommand,
  ensureLucidPermissionHook,
  LUCID_HOOK_NAME,
  PermissionBridgeServer,
} from "../src/acp/orchestrator_bridge.mjs";
import { evaluateHookPolicy, queryPermissionBridge } from "../src/acp/perm_hook.mjs";
import { OrchestratorStreamClient, serializeBlocksForStreamJson } from "../src/acp/stream_client.mjs";
import { LucidApp } from "../src/app.mjs";
import { buildModelPickerItems } from "../src/app/commands.mjs";
import { stripAnsi } from "../src/term/unicode.mjs";
import { createThemeStyler } from "../src/ui/themes.mjs";
import { applyOverlayModal } from "../src/ui/views.mjs";

test("evaluateHookPolicy enforces default, accept-edits, auto, plan, bypass, and unset-sock pass-through", () => {
  // Unset LUCID_PERM_SOCK -> immediate pass-through
  assert.deepEqual(
    evaluateHookPolicy({ toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } } }, {}),
    { immediate: true, response: { decision: "allow" } },
  );

  const envDefault = { LUCID_PERM_SOCK: "/tmp/perm.sock", LUCID_PERM_MODE: "default" };
  const envAccept = { LUCID_PERM_SOCK: "/tmp/perm.sock", LUCID_PERM_MODE: "accept-edits" };
  const envAuto = { LUCID_PERM_SOCK: "/tmp/perm.sock", LUCID_PERM_MODE: "auto" };
  const envBypass = { LUCID_PERM_SOCK: "/tmp/perm.sock", LUCID_PERM_MODE: "bypass" };

  // Read-only tools always immediate allow
  assert.deepEqual(
    evaluateHookPolicy({ cwd: "/ws", toolCall: { name: "view_file", args: { AbsolutePath: "/ws/a.js" } } }, envDefault),
    { immediate: true, response: { decision: "allow" } },
  );

  // default mode prompts for both file edits and commands
  assert.deepEqual(
    evaluateHookPolicy(
      { cwd: "/ws", workspacePaths: ["/ws"], toolCall: { name: "replace_file_content", args: { TargetFile: "/ws/a.js" } } },
      envDefault,
    ),
    { immediate: false },
  );
  assert.deepEqual(
    evaluateHookPolicy({ cwd: "/ws", toolCall: { name: "run_command", args: { CommandLine: "npm test" } } }, envDefault),
    { immediate: false },
  );

  // accept-edits auto-approves in-workspace edits, prompts outside workspace and commands
  assert.deepEqual(
    evaluateHookPolicy(
      { cwd: "/ws", workspacePaths: ["/ws"], toolCall: { name: "replace_file_content", args: { TargetFile: "/ws/src/a.js" } } },
      envAccept,
    ),
    { immediate: true, response: { decision: "auto_approve" } },
  );
  assert.deepEqual(
    evaluateHookPolicy(
      { cwd: "/ws", workspacePaths: ["/ws"], toolCall: { name: "write_to_file", args: { TargetFile: "/etc/hosts" } } },
      envAccept,
    ),
    { immediate: false },
  );
  assert.deepEqual(
    evaluateHookPolicy({ cwd: "/ws", toolCall: { name: "run_command", args: { CommandLine: "npm test" } } }, envAccept),
    { immediate: false },
  );

  // auto mode delegates safe workspace commands to PolicyGuardian, prompts risky or outside-workspace commands
  assert.deepEqual(
    evaluateHookPolicy({ cwd: "/ws", workspacePaths: ["/ws"], toolCall: { name: "run_command", args: { CommandLine: "npm test" } } }, envAuto),
    { immediate: true, response: { decision: "allow" } },
  );
  assert.deepEqual(
    evaluateHookPolicy({ cwd: "/ws", workspacePaths: ["/ws"], toolCall: { name: "run_command", args: { CommandLine: "git push origin main" } } }, envAuto),
    { immediate: false },
  );
  assert.deepEqual(
    evaluateHookPolicy({ cwd: "/ws", workspacePaths: ["/ws"], toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "/etc" } } }, envAuto),
    { immediate: false },
  );

  // bypass allows everything immediately
  assert.deepEqual(
    evaluateHookPolicy({ cwd: "/ws", toolCall: { name: "run_command", args: { CommandLine: "rm -rf /tmp/x" } } }, envBypass),
    { immediate: true, response: { decision: "allow" } },
  );
});

test("ensureLucidPermissionHook merges idempotently and guard passes through when LUCID_PERM_SOCK is unset", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-hook-test-"));
  try {
    const hooksPath = path.join(tmpDir, "hooks.json");
    fs.writeFileSync(hooksPath, JSON.stringify({ "existing-linter": { PostToolUse: [] } }, null, 2));

    const first = ensureLucidPermissionHook({ hooksPath });
    assert.equal(first.ok, true);
    assert.equal(first.updated, true);

    const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    assert.ok(parsed["existing-linter"]);
    assert.ok(parsed[LUCID_HOOK_NAME]);

    const second = ensureLucidPermissionHook({ hooksPath });
    assert.equal(second.ok, true);
    assert.equal(second.updated, false);

    // Execute the actual shell guard with LUCID_PERM_SOCK unset -> must print {"decision":"allow"} cleanly
    const cmd = buildPermissionHookCommand();
    const env = { ...process.env };
    delete env.LUCID_PERM_SOCK;
    const out = execSync(cmd, { env, encoding: "utf8" }).trim();
    assert.deepEqual(JSON.parse(out), { decision: "allow" });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("PermissionBridgeServer bridges interactive approve, allow_always grant, deny, and mid-turn bypass", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-perm-srv-"));
  const bridge = new PermissionBridgeServer({ bgDir: tmpDir });
  try {
    const sockPath = await bridge.start();
    const seen = [];
    bridge.on("permissionRequest", (req) => {
      seen.push(req);
    });

    // 1) Allow once
    const p1 = queryPermissionBridge(sockPath, { toolName: "run_command", args: { CommandLine: "echo hi" } });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(seen.length, 1);
    assert.match(seen[0].params.title, /Run command: echo hi/);
    seen[0].selectOption("allow_once");
    assert.deepEqual(await p1, { decision: "auto_approve" });

    // 2) Allow always caches grant for subsequent `git` commands
    const p2 = queryPermissionBridge(sockPath, { toolName: "run_command", args: { CommandLine: "git status" } });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(seen.length, 2);
    seen[1].selectOption("allow_always");
    assert.deepEqual(await p2, { decision: "auto_approve" });

    const p3 = queryPermissionBridge(sockPath, { toolName: "run_command", args: { CommandLine: "git diff" } });
    assert.deepEqual(await p3, { decision: "auto_approve" });
    assert.equal(seen.length, 2); // No new modal needed

    // 3) Deny / cancel
    const p4 = queryPermissionBridge(sockPath, { toolName: "write_to_file", args: { TargetFile: "/etc/foo" } });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(seen.length, 3);
    seen[2].cancel();
    const res4 = await p4;
    assert.equal(res4.decision, "deny");

    // 4) Mid-turn bypass toggle approves pending request immediately
    const p5 = queryPermissionBridge(sockPath, { toolName: "run_command", args: { CommandLine: "npm test" } });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(seen.length, 4);
    bridge.setBypassPermissions(true);
    assert.deepEqual(await p5, { decision: "auto_approve" });
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("OrchestratorStreamClient builds exact --settings args, streams updates/diffs/thoughts, and cancels cleanly", async () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-stream-data-"));
  const tmpBg = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-stream-bg-"));
  const sid = "sess-orch-stream-1";
  const logDir = path.join(tmpData, "brain", sid, ".system_generated", "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, "transcript.jsonl"),
    `${JSON.stringify({ step_index: 1, model: "gemini-4-neon-xhigh", thinking: "Planning the edit carefully." })}\n`,
  );

  const spawnedCalls = [];
  let fakeChild = null;
  const fakeSpawn = (cmd, args, opts) => {
    spawnedCalls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.killed = false;
    child.kill = (sig) => {
      child.killed = true;
      child.exitCode = 0;
      child.emit("exit", 0, sig);
    };
    fakeChild = child;
    return child;
  };

  const client = new OrchestratorStreamClient({
    command: "agy",
    cwd: "/ws",
    dataDir: tmpData,
    bgDir: tmpBg,
    skipHookInstall: true,
    spawnFn: fakeSpawn,
  });

  try {
    client.configure({
      sessionId: sid,
      modeId: "default",
      bypassPermissions: false,
      orchestratorConfig: {
        modelValue: "gemini-pro-orchestrator-neon",
        modelLabel: "Orchestrator (Neon)",
        plannerLabel: "Gemini 4 Neon (XHigh)",
        executorLabel: "Gemini 4 Hydrogen (Medium)",
      },
    });

    const args = client.buildSpawnArgs();
    assert.ok(args.includes("--input-format") && args.includes("stream-json"));
    assert.ok(args.includes("--conversation") && args.includes(sid));
    assert.equal(args.includes("--mode"), false); // default uses agentMode: "" instead of invalid --mode default
    const settingsIdx = args.indexOf("--settings");
    assert.ok(settingsIdx >= 0);
    assert.deepEqual(JSON.parse(args[settingsIdx + 1]), {
      model: "Orchestrator (Neon)",
      agentMode: "",
      orchestrator: {
        planner: "Gemini 4 Neon (XHigh)",
        executor: "Gemini 4 Hydrogen (Medium)",
      },
    });

    // Block serialization handles text + image gracefully
    const serialized = serializeBlocksForStreamJson([
      { type: "text", text: "Fix bug" },
      { type: "image", path: "/ws/screenshot.png" },
    ]);
    assert.ok(serialized.includes("Fix bug"));
    assert.ok(serialized.includes("/ws/screenshot.png"));

    const updates = [];
    client.on("sessionUpdate", (p) => updates.push(p.update));

    const turnPromise = client.sendPrompt(sid, [{ type: "text", text: "Edit a.js" }]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(spawnedCalls.length, 1);
    assert.ok(spawnedCalls[0].opts.env.LUCID_PERM_SOCK);
    assert.equal(spawnedCalls[0].opts.env.LUCID_PERM_MODE, "default");

    fakeChild.stdout.write(`${JSON.stringify({ event: "init", conversation_id: sid, init: {} })}\n`);
    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: sid,
          step_index: 1,
          state: "DONE",
          step_type: "agent_response",
          usage: { input_tokens: 1000, cache_read_tokens: 500, thinking_tokens: 120 },
        },
      })}\n`,
    );
    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: sid,
          step_index: 2,
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "replace_file_content",
          tool_info: {
            name: "replace_file_content",
            parameters: { TargetFile: "/ws/a.js", TargetContent: "old()", ReplacementContent: "new()" },
          },
        },
      })}\n`,
    );
    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: sid,
          step_index: 2,
          state: "DONE",
          step_type: "tool",
          tool_name: "replace_file_content",
          tool_info: {
            name: "replace_file_content",
            parameters: { TargetFile: "/ws/a.js", TargetContent: "old()", ReplacementContent: "new()" },
            output: "Replaced successfully",
          },
        },
      })}\n`,
    );
    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "step_update",
        step_update: {
          conversation_id: sid,
          step_index: 3,
          state: "DONE",
          step_type: "agent_response",
          text_delta: "Done!",
        },
      })}\n`,
    );
    fakeChild.stdout.write(
      `${JSON.stringify({
        event: "result",
        result: { conversation_id: sid, status: "SUCCESS", response: "Done!" },
      })}\n`,
    );

    const res = await turnPromise;
    assert.equal(res.stopReason, "end_turn");
    assert.ok(updates.some((u) => u.sessionUpdate === "agent_thought_chunk" && u.content.text.includes("Planning the edit")));
    assert.ok(updates.some((u) => u.sessionUpdate === "tool_call" && u.content?.[0]?.type === "diff" && u.content[0].newText === "new()"));
    assert.ok(updates.some((u) => u.sessionUpdate === "tool_call_update" && u.status === "completed"));
    assert.ok(updates.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.text === "Done!"));
    assert.ok(updates.some((u) => u.sessionUpdate === "usage_update" && u.used === 1500));

    // Verify cancelTurn interrupts active turn cleanly
    const cancelTurnPromise = client.sendPrompt(sid, [{ type: "text", text: "Long task" }]);
    await new Promise((r) => setTimeout(r, 10));
    client.cancelTurn();
    const cancelRes = await cancelTurnPromise;
    assert.equal(cancelRes.stopReason, "cancelled");
  } finally {
    await client.stop();
    fs.rmSync(tmpData, { recursive: true, force: true });
    fs.rmSync(tmpBg, { recursive: true, force: true });
  }
});

test("/model unified Orchestrator row configures Planner+Executor models/efforts, syncs settings.json, and hands off ACP <-> stream-json", async () => {
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-orch-ui-"));
  try {
    saveAgyOrchestratorSettings(tmpData, {
      planner: "Gemini 4 Neon (High)",
      executor: "Gemini 4 Hydrogen (High)",
    });
    assert.deepEqual(readAgyOrchestratorConfig(tmpData), {
      planner: "Gemini 4 Neon (High)",
      executor: "Gemini 4 Hydrogen (High)",
    });

    const app = new LucidApp({ cwd: "/tmp" });
    app.scheduleRender = () => {};
    app.state.connected = true;
    app.state.sessionId = "sess-orch-ui-1";
    app.state.modeId = "default";
    app.agyStateWatcher = { dataDir: tmpData, setSession: () => {}, pollAsync: async () => null };
    app.state.models = [
      { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
      { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
      { modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
      { modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
      { modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
      { modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
      { modelId: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
      { modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
      { modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
      { modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
      { modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
      { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
      { modelId: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)" },
      { modelId: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
      { modelId: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
      { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
      { modelId: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
      { modelId: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)" },
    ];
    app.state.configOptions = [
      {
        id: "model",
        name: "Model",
        currentValue: "gemini-4-neon",
        options: [
          { value: "gemini-4-neon", name: "Gemini 4 Neon" },
          { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
          { value: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
          { value: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)" },
          { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
        ],
      },
      {
        id: "thought_level",
        name: "Thinking Level",
        currentValue: "high",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
          { value: "high", name: "High" },
          { value: "xhigh", name: "Extra" },
        ],
      },
    ];

    const acpOps = [];
    app.acp = {
      isHosted: false,
      supportsSessionLoad: () => true,
      supportsSessionResume: () => false,
      async closeSession(sid) {
        acpOps.push({ op: "closeSession", sid });
      },
      async loadSession(sid, cwd) {
        acpOps.push({ op: "loadSession", sid, cwd });
        return { configOptions: app.state.configOptions };
      },
      async setMode(sid, modeId) {
        acpOps.push({ op: "setMode", sid, modeId });
        return {};
      },
      async setModel(sid, value, preferConfig) {
        acpOps.push({ op: "setModel", sid, value, preferConfig });
        return {
          configOptions: [
            { ...app.state.configOptions[0], currentValue: value },
            {
              id: "thought_level",
              name: "Thinking Level",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
          ],
        };
      },
      async setConfigOption(sid, configId, value) {
        acpOps.push({ op: "setConfigOption", sid, configId, value });
        return {};
      },
    };

    // Unified Orchestrator row collapses all 3 Orchestrator options into 1
    const built = buildModelPickerItems(app);
    assert.deepEqual(
      built.items.map((i) => i.label),
      ["Gemini 4 Neon", "Orchestrator", "Claude Opus 5.5"],
    );

    await app.runLocalCommand("model", "");
    app.handleModalInput({ type: "key", name: "down" }); // Select Orchestrator
    assert.equal(app.modal.selected, 1);

    const orchItem = app.modal.filteredItems[1];
    assert.ok(orchItem.orchestrator);
    assert.equal(orchItem.orchestrator.focusField, 1); // Starts on Planner Effort

    // Right -> High to Extra (XHigh) on Planner (Neon)
    app.handleModalInput({ type: "key", name: "right" });
    assert.equal(orchItem.orchestrator.plannerEffortIdx, 3);

    // Tab -> Executor Model (field 2), Tab -> Executor Effort (field 3), Left -> High to Medium
    app.handleModalInput({ type: "key", name: "tab" });
    assert.equal(orchItem.orchestrator.focusField, 2);
    app.handleModalInput({ type: "key", name: "tab" });
    assert.equal(orchItem.orchestrator.focusField, 3);
    app.handleModalInput({ type: "key", name: "left" });
    assert.equal(orchItem.orchestrator.executorEffortIdx, 1);

    // Render modal to verify 2-line Orchestrator Planner/Executor panel
    const style = createThemeStyler("tokyo-night", "truecolor");
    const rendered = applyOverlayModal(
      Array.from({ length: 24 }, () => " ".repeat(100)),
      100,
      app.modal,
      style,
    )
      .map(stripAnsi)
      .join("\n");
    assert.ok(rendered.includes("Planner:"), rendered);
    assert.ok(rendered.includes("Executor:"), rendered);
    assert.ok(rendered.includes("Neon Extra → Hydrogen Medium"), rendered);
    assert.ok(rendered.includes("Tab field · ←/→ change"), rendered);

    // Enter applies Orchestrator -> saves settings.json + closes ACP session + arms stream client
    app.handleModalInput({ type: "key", name: "enter" });
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(app.state.modelLabel, "Orchestrator");
    assert.equal(app.state.effortLabel, "Neon Extra → Hydrogen Medium");
    assert.deepEqual(readAgyOrchestratorConfig(tmpData), {
      planner: "Gemini 4 Neon (XHigh)",
      executor: "Gemini 4 Hydrogen (Medium)",
    });
    assert.deepEqual(acpOps, [{ op: "closeSession", sid: "sess-orch-ui-1" }]);

    // /effort shortcut directly adjusts Orchestrator roles
    await app.runLocalCommand("effort", "planner=low executor=xhigh");
    assert.equal(app.state.effortLabel, "Neon Low → Hydrogen Extra");
    assert.deepEqual(readAgyOrchestratorConfig(tmpData), {
      planner: "Gemini 4 Neon (Low)",
      executor: "Gemini 4 Hydrogen (XHigh)",
    });

    // Switch back to Claude Opus 5.5 (Medium) -> reloads ACP session & applies model + effort
    acpOps.length = 0;
    await app.runLocalCommand("model", "");
    app.handleModalInput({ type: "key", name: "down" }); // Orchestrator -> Claude Opus 5.5
    app.handleModalInput({ type: "key", name: "left" }); // High -> Medium
    app.handleModalInput({ type: "key", name: "enter" });
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(app.state.orchestratorConfig, null);
    assert.equal(app.state.modelLabel, "Claude Opus 5.5");
    assert.equal(app.state.effortLabel, "Medium");
    assert.deepEqual(
      acpOps.map((x) => x.op),
      ["loadSession", "setMode", "setModel", "setConfigOption"],
    );

    await app.orchestratorStream?.stop();
  } finally {
    fs.rmSync(tmpData, { recursive: true, force: true });
  }
});
