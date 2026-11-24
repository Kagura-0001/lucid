import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeSessionMetadata } from "../src/acp/protocol.mjs";
import { LucidApp } from "../src/app.mjs";
import { InputParser } from "../src/term/input.mjs";
import { stripAnsi } from "../src/term/unicode.mjs";
import { Composer } from "../src/ui/composer.mjs";
import { parseAutoCompactOverride } from "../src/ui/format.mjs";
import { MultiAgentTracker } from "../src/ui/swarm.mjs";
import { createThemeStyler } from "../src/ui/themes.mjs";
import { applyOverlayModal, renderComposerBlock, renderHeader, renderTimeline } from "../src/ui/views.mjs";

test("InputParser decodes Kitty CSI-u spaces, shifted symbols, Unicode, and ignores key release", () => {
  const events = [];
  const parser = new InputParser((e) => events.push(e));

  parser.feed("\x1b[32u"); // Space
  parser.feed("\x1b[32;2u"); // Shift+Space
  parser.feed("\x1b[47:63;2u"); // Shifted ?
  parser.feed("\x1b[20013;1u"); // CJK '中'
  parser.feed("\x1b[97;1:3u"); // Key release (eventType 3) — should be ignored
  parser.destroy();

  assert.deepEqual(events, [
    { type: "text", text: " " },
    { type: "text", text: " " },
    { type: "text", text: "?" },
    { type: "text", text: "中" },
  ]);
});

test("thoughtMode supports Claude-style fold (1 per turn), expanded, and hidden independently of expandTools", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const items = [{ type: "user", text: "Inspect and fix everything" }];
  for (let i = 0; i < 5; i += 1) {
    items.push({
      type: "thought",
      text: `Internal step ${i} reasoning details`,
      streaming: false,
      durationMs: 400,
    });
    items.push({
      type: "tool",
      toolCallId: `t_${i}`,
      title: `Read file_${i}.mjs`,
      kind: "read",
      status: "completed",
      durationMs: 100,
    });
  }
  items.push({
    type: "assistant",
    streaming: false,
    text: "All done.",
  });

  // 1. Fold mode collapses 5 interleaved thoughts into 1 summary line, even with expandTools: true
  const foldedLines = renderTimeline(
    { cwd: "/tmp", items, thoughtMode: "fold", expandTools: true, spinnerFrame: 0 },
    100,
    style,
  ).map(stripAnsi);
  const foldedHeaders = foldedLines.filter((l) => l.includes("▸ Thought"));
  assert.equal(foldedHeaders.length, 1);
  assert.ok(foldedHeaders[0].includes("2.0s"));
  assert.ok(foldedHeaders[0].includes("5 steps"));
  assert.equal(foldedLines.some((l) => l.includes("Internal step 0 reasoning details")), false);

  // 2. Expanded mode renders all 5 thought bodies under rails
  const expandedLines = renderTimeline(
    { cwd: "/tmp", items, thoughtMode: "expanded", expandTools: false, spinnerFrame: 0 },
    100,
    style,
  ).map(stripAnsi);
  assert.equal(expandedLines.filter((l) => l.includes("▾ Thought")).length, 5);
  assert.equal(expandedLines.filter((l) => l.includes("Internal step")).length, 5);

  // 3. Hidden mode renders 0 thought lines
  const hiddenLines = renderTimeline(
    { cwd: "/tmp", items, thoughtMode: "hidden", expandTools: true, spinnerFrame: 0 },
    100,
    style,
  ).map(stripAnsi);
  assert.equal(hiddenLines.some((l) => l.includes("Thought")), false);
  assert.equal(hiddenLines.some((l) => l.includes("Internal step")), false);
});

test("LucidApp /thoughts [fold|show|hide] and Ctrl+T switch thought modes cleanly", async () => {
  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};

  await app.runLocalCommand("thoughts", "hide");
  assert.equal(app.state.thoughtMode, "hidden");
  assert.equal(app.state.showThoughts, false);

  await app.runLocalCommand("thoughts", "show");
  assert.equal(app.state.thoughtMode, "expanded");
  assert.equal(app.state.showThoughts, true);

  await app.runLocalCommand("thoughts", "fold");
  assert.equal(app.state.thoughtMode, "fold");
  assert.equal(app.state.showThoughts, false);

  // Ctrl+T toggles fold -> expanded -> fold
  app.handleMainKey({ type: "key", name: "t", ctrl: true, alt: false, shift: false });
  assert.equal(app.state.thoughtMode, "expanded");
  app.handleMainKey({ type: "key", name: "t", ctrl: true, alt: false, shift: false });
  assert.equal(app.state.thoughtMode, "fold");
});

test("permission modal replaces steer placeholder and shows error toast when user types text", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const composerBlock = renderComposerBlock(
    {
      cwd: "/tmp",
      busy: true,
      turnStartedAt: Date.now() - 1000,
      spinnerFrame: 0,
      scrollOffset: 0,
      mouseCapture: true,
      expandTools: false,
      thoughtMode: "fold",
      activeModalType: "permission",
      composer: new Composer(),
    },
    100,
    style,
  );
  const plain = composerBlock.lines.map(stripAnsi).join("\n");
  assert.ok(plain.includes("Permission approval required above"));
  assert.equal(plain.includes("Type to steer"), false);

  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};
  app.modal = {
    type: "permission",
    title: "Permission Approval",
    params: { options: [{ optionId: "allow", name: "Allow" }] },
    selected: 0,
    req: { selectOption: () => {}, cancel: () => {} },
  };
  app.handleModalInput({ type: "text", text: "a" });
  assert.equal(app.state.toast?.level, "error");
  assert.ok(app.state.toast?.text.includes("Permission dialog active"));
});

test("renderTimeline cache speeds up repeated frames and invalidates when _rev bumps", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const oldLines = Array.from({ length: 220 }, (_, i) => `export function fn_${i}(x) { return x + ${i}; }`).join("\n");
  const newLines = Array.from({ length: 220 }, (_, i) => `export function fn_${i}(x) { return x * 2 + ${i}; }`).join("\n");
  const items = [];
  for (let i = 0; i < 15; i += 1) {
    items.push({
      type: "tool",
      toolCallId: `tool_${i}`,
      title: `Edit module_${i}.mjs`,
      kind: "edit",
      status: "completed",
      durationMs: 120,
      diffs: [{ path: `/tmp/module_${i}.mjs`, oldText: oldLines, newText: newLines }],
      outputText: "ok\n".repeat(40),
      outputPreview: "ok",
      _rev: 0,
    });
  }
  const state = { cwd: "/tmp", items, thoughtMode: "fold", expandTools: false, spinnerFrame: 0 };

  const first = renderTimeline(state, 100, style);
  const t0 = performance.now();
  const second = renderTimeline(state, 100, style);
  const warmMs = performance.now() - t0;

  assert.deepEqual(second, first);
  assert.ok(warmMs < 5, `Expected warm renderTimeline < 5ms, got ${warmMs.toFixed(2)}ms`);

  items[0].title = "Updated module_0.mjs";
  items[0]._rev += 1;
  const third = renderTimeline(state, 100, style);
  assert.ok(third.some((l) => stripAnsi(l).includes("Updated module_0.mjs")));
});

test("mergeSessionMetadata clears stale effortLabel when Orchestrator omits thought_level, and /effort shows settings guidance", async () => {
  const rawMeta = {};
  const first = mergeSessionMetadata(rawMeta, {
    configOptions: [
      { id: "model", category: "model", currentValue: "gemini-4-neon", options: [{ value: "gemini-4-neon", name: "Gemini 4 Neon" }] },
      { id: "thought_level", category: "thought_level", currentValue: "high", options: [{ value: "high", name: "High" }] },
    ],
  });
  assert.equal(first.modelLabel, "Gemini 4 Neon");
  assert.equal(first.effortLabel, "High");

  const second = mergeSessionMetadata(rawMeta, {
    configOptions: [
      {
        id: "model",
        category: "model",
        currentValue: "gemini-pro-orchestrator-neon",
        options: [{ value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" }],
      },
    ],
  });
  assert.equal(second.modelLabel, "Orchestrator (Neon)");
  assert.equal(second.effortLabel, "");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-orch-settings-"));
  try {
    fs.writeFileSync(
      path.join(tmpRoot, "settings.json"),
      JSON.stringify({
        orchestrator: {
          planner: { model: "gemini-4-neon", effort: "xhigh" },
          executor: "gemini-4-carbon / high",
        },
      }),
      "utf8",
    );
    const app = new LucidApp({ cwd: "/tmp" });
    app.scheduleRender = () => {};
    app.acp = {};
    app.agyStateWatcher = { dataDir: tmpRoot };
    app.state.connected = true;
    app.state.sessionId = "s-orch";
    app.state.effortLabel = "High";
    app.applySessionMetadata({
      configOptions: [
        {
          id: "model",
          category: "model",
          currentValue: "gemini-pro-orchestrator-neon",
          options: [{ value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" }],
        },
      ],
    });
    assert.equal(app.state.effortLabel, "");

    await app.runLocalCommand("effort", "");
    const noticeText = app.state.items.find((i) => i.type === "notice")?.text || "";
    assert.match(noticeText, /does not expose Orchestrator Planner\/Executor effort over ACP/);
    assert.match(noticeText, /Planner: gemini-4-neon \/ xhigh/);
    assert.match(noticeText, /Executor: gemini-4-carbon \/ high/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("renderComposerBlock shows Waiting on summary for active subagents/background tasks and Working otherwise", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const multiAgent = new MultiAgentTracker();
  multiAgent.applyAgyState({
    subagents: [
      { conversationId: "sub-1", role: "Auditor", typeName: "research", state: "working", startedAt: Date.now() },
      { conversationId: "sub-2", role: "Surveyor", typeName: "research", state: "running", startedAt: Date.now() },
    ],
  });

  const waitingSubs = renderComposerBlock(
    {
      cwd: "/tmp",
      busy: true,
      turnStartedAt: Date.now() - 4000,
      spinnerFrame: 0,
      scrollOffset: 0,
      mouseCapture: true,
      expandTools: false,
      thoughtMode: "fold",
      composer: new Composer(),
      multiAgent,
      items: [{ type: "user", text: "Check results" }],
    },
    100,
    style,
  );
  assert.match(waitingSubs.lines.map(stripAnsi).join("\n"), /Waiting on 2 subagents/);

  const waitingBgTool = renderComposerBlock(
    {
      cwd: "/tmp",
      busy: true,
      turnStartedAt: Date.now() - 4000,
      spinnerFrame: 0,
      scrollOffset: 0,
      mouseCapture: true,
      expandTools: false,
      thoughtMode: "fold",
      composer: new Composer(),
      items: [
        { type: "user", text: "Run eval" },
        {
          type: "tool",
          status: "in_progress",
          title: "Eval suite",
          outputText: "Tool is running as a background task with task id: sess/task-9",
        },
      ],
    },
    100,
    style,
  );
  assert.match(waitingBgTool.lines.map(stripAnsi).join("\n"), /Waiting on background task \(Eval suite\)/);

  // Foreground tool running -> stays "Working"
  const workingForeground = renderComposerBlock(
    {
      cwd: "/tmp",
      busy: true,
      turnStartedAt: Date.now() - 4000,
      spinnerFrame: 0,
      scrollOffset: 0,
      mouseCapture: true,
      expandTools: false,
      thoughtMode: "fold",
      composer: new Composer(),
      multiAgent,
      items: [
        { type: "user", text: "Run eval" },
        { type: "tool", status: "in_progress", title: "Read file", outputText: "" },
      ],
    },
    100,
    style,
  );
  assert.match(workingForeground.lines.map(stripAnsi).join("\n"), /Working/);
  assert.equal(workingForeground.lines.map(stripAnsi).join("\n").includes("Waiting on"), false);

  // Actively streaming assistant message -> stays "Working"
  const workingStreaming = renderComposerBlock(
    {
      cwd: "/tmp",
      busy: true,
      turnStartedAt: Date.now() - 4000,
      spinnerFrame: 0,
      scrollOffset: 0,
      mouseCapture: true,
      expandTools: false,
      thoughtMode: "fold",
      composer: new Composer(),
      multiAgent,
      items: [
        { type: "user", text: "Run eval" },
        { type: "assistant", text: "Here is what I found", streaming: true },
      ],
    },
    100,
    style,
  );
  assert.match(workingStreaming.lines.map(stripAnsi).join("\n"), /Working/);
  assert.equal(workingStreaming.lines.map(stripAnsi).join("\n").includes("Waiting on"), false);
});

test("parseAutoCompactOverride parses agy 1.5.15+ formats and renderHeader displays compact threshold", async () => {
  assert.deepEqual(parseAutoCompactOverride("700000", 1_000_000), { tokens: 700000, pct: 70, label: "compact@700k" });
  assert.deepEqual(parseAutoCompactOverride("800K", 1_000_000), { tokens: 800000, pct: 80, label: "compact@800k" });
  assert.deepEqual(parseAutoCompactOverride("0.5M", 1_000_000), { tokens: 500000, pct: 50, label: "compact@500k" });
  assert.deepEqual(parseAutoCompactOverride("80%", 1_000_000), { tokens: 800000, pct: 80, label: "compact@80%" });
  assert.equal(parseAutoCompactOverride("", 1_000_000), null);
  assert.equal(parseAutoCompactOverride("invalid", 1_000_000), null);
  assert.equal(parseAutoCompactOverride("120%", 1_000_000), null);

  const style = createThemeStyler("tokyo-night", "truecolor");
  const headerPlain = renderHeader(
    {
      cwd: "/tmp/proj",
      modelLabel: "Gemini 4 Neon",
      effortLabel: "High",
      modeId: "auto",
      usage: { used: 320_000, size: 1_000_000 },
      autoCompactOverride: "80%",
    },
    120,
    style,
  )
    .map(stripAnsi)
    .join("\n");
  assert.ok(headerPlain.includes("320k/1.0M (32% · compact@80%)"), headerPlain);

  const prevEnv = process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE;
  process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE = "80%";
  try {
    const app = new LucidApp({ cwd: "/tmp" });
    app.scheduleRender = () => {};
    app.launchSpec = { ...app.launchSpec, supportsQuotaCli: false };
    app.state.usage = { used: 320_000, size: 1_000_000 };
    await app.runLocalCommand("usage", "");
    const texts = app.state.items.filter((i) => i.type === "notice").map((i) => i.text);
    assert.ok(texts.some((t) => t.includes("Auto-compact override: compact@80% (800,000 tokens · 80%)")));
  } finally {
    if (prevEnv === undefined) delete process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE;
    else process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE = prevEnv;
  }
});

test("/model opens unified agy-style picker with inline effort cycling and combined apply", async () => {
  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};
  app.state.connected = true;
  app.state.sessionId = "sess-model-1";
  app.state.models = [
    { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
    { modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
    { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (Extra)" },
    { modelId: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
    { modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
    { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
    { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
    { modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
  ];
  app.state.configOptions = [
    {
      id: "model",
      name: "Model",
      currentValue: "gemini-4-neon",
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
        { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
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
  app.state.modelLabel = "Gemini 4 Neon";
  app.state.effortLabel = "High";

  const rpcCalls = [];
  app.acp = {
    async setModel(sessionId, value, preferConfig) {
      rpcCalls.push({ kind: "setModel", sessionId, value, preferConfig });
      if (value === "claude-opus-5-5") {
        return {
          configOptions: [
            { ...app.state.configOptions[0], currentValue: "claude-opus-5-5" },
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
      }
      return {
        configOptions: [{ ...app.state.configOptions[0], currentValue: value }],
      };
    },
    async setConfigOption(sessionId, configId, value) {
      rpcCalls.push({ kind: "setConfigOption", sessionId, configId, value });
      const next = app.state.configOptions.map((opt) =>
        opt.id === configId ? { ...opt, currentValue: value } : opt,
      );
      return { configOptions: next };
    },
  };

  await app.runLocalCommand("model", "");
  assert.equal(app.modal?.type, "picker");
  assert.equal(app.modal?.layout, "model");
  assert.equal(app.modal?.selected, 0);

  const items = app.modal.filteredItems;
  assert.deepEqual(
    items[0].efforts.map((e) => e.label),
    ["Low", "Medium", "High", "Extra"],
  );
  assert.equal(items[0].selectedEffortIdx, 2); // current "high"
  assert.deepEqual(
    items[1].efforts.map((e) => e.label),
    ["Low", "Medium", "High"],
  );
  assert.equal(items[1].selectedEffortIdx, 2); // defaults to High
  assert.equal(items[2].isOrchestrator, true);
  assert.equal(items[2].efforts.length, 0);
  assert.equal(items[3].efforts.length, 0);
  assert.equal(items[3].rightTag, "Medium");

  // Render overlay to verify visual pills and footer hints
  const style = createThemeStyler("tokyo-night", "truecolor");
  const baseRows = Array.from({ length: 24 }, () => " ".repeat(100));
  const rendered = applyOverlayModal(baseRows, 100, app.modal, style).map(stripAnsi).join("\n");
  assert.ok(rendered.includes("Select Model & Effort"), rendered);
  assert.ok(rendered.includes("◂ Low · Medium · [High] · Extra ▸"), rendered);
  assert.ok(rendered.includes("←/→ or Tab effort"), rendered);

  // Press Right on current model (Gemini 4 Neon) -> High to Extra, Enter applies only setConfigOption
  app.handleModalInput({ type: "key", name: "right" });
  assert.equal(items[0].selectedEffortIdx, 3);
  app.handleModalInput({ type: "key", name: "tab" }); // wraps Extra -> Low
  assert.equal(items[0].selectedEffortIdx, 0);
  app.handleModalInput({ type: "key", name: "tab", shift: true }); // wraps Low -> Extra
  assert.equal(items[0].selectedEffortIdx, 3);
  app.handleModalInput({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(rpcCalls, [
    { kind: "setConfigOption", sessionId: "sess-model-1", configId: "thought_level", value: "xhigh" },
  ]);
  assert.equal(app.state.effortLabel, "Extra");

  // Reopen /model, move down to Claude Opus 5.5, press Left -> High to Medium, Enter applies setModel + setConfigOption
  rpcCalls.length = 0;
  await app.runLocalCommand("model", "");
  app.handleModalInput({ type: "key", name: "down" });
  assert.equal(app.modal.selected, 1);
  app.handleModalInput({ type: "key", name: "left" });
  assert.equal(app.modal.filteredItems[1].selectedEffortIdx, 1); // Medium

  // Check Orchestrator row footer hint when moved down once more, then back up to Opus
  app.handleModalInput({ type: "key", name: "down" });
  const orchRendered = applyOverlayModal(baseRows, 100, app.modal, style).map(stripAnsi).join("\n");
  assert.ok(orchRendered.includes("Orchestrator role effort: native agy /model"), orchRendered);
  app.handleModalInput({ type: "key", name: "up" });

  app.handleModalInput({ type: "key", name: "enter" });
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(rpcCalls, [
    { kind: "setModel", sessionId: "sess-model-1", value: "claude-opus-5-5", preferConfig: true },
    { kind: "setConfigOption", sessionId: "sess-model-1", configId: "thought_level", value: "medium" },
  ]);
  assert.equal(app.state.modelLabel, "Claude Opus 5.5");
  assert.equal(app.state.effortLabel, "Medium");
});
