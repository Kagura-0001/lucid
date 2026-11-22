import assert from "node:assert/strict";
import test from "node:test";
import { LucidApp } from "../src/app.mjs";
import { displayWidth, stripAnsi } from "../src/term/unicode.mjs";
import { Composer } from "../src/ui/composer.mjs";
import { MultiAgentTracker, renderMemberTimeline, renderSwarmDock } from "../src/ui/swarm.mjs";
import { createThemeStyler, listThemes } from "../src/ui/themes.mjs";
import { extractCleanOutputPreview, parseExitCode } from "../src/ui/tool_format.mjs";
import { renderComposerBlock, renderTimeline } from "../src/ui/views.mjs";

const OPAQUE_BG_REGEX = /\x1b\[(?:4[0-7]|48;|10[0-7])/;

function buildRealisticTurnItems() {
  return [
    { type: "user", text: "进度" },
    { type: "thought", text: "Check board and swarm first.", streaming: false, durationMs: 12600 },
    {
      type: "tool",
      toolCallId: "t1",
      name: "read_board",
      title: "Run read_board",
      kind: "other",
      status: "completed",
      durationMs: 100,
    },
    {
      type: "tool",
      toolCallId: "t2",
      name: "swarm",
      title: "Run swarm",
      kind: "other",
      rawInput: { action: "status" },
      status: "completed",
      durationMs: 1300,
    },
    {
      type: "tool",
      toolCallId: "t3",
      name: "run_command",
      title: "ls -la /vlm/lws/repos/streaming/artifacts/20261120_guidance_v32_prod/logs/DONE_* /vlm/lws/repos/streaming/artifacts/20261120_guidance_v32_prod/export/ 2>&1",
      kind: "execute",
      status: "completed",
      durationMs: 2200,
      outputText: "Created At: 2026-11-22T11:22:08+08:00\nCompleted At: 2026-11-22T11:22:10+08:00\nCommand exited with code 0.\n\nCommand output:\nDONE_01\nDONE_02\nexport/\n",
    },
    {
      type: "tool",
      toolCallId: "t4",
      name: "run_command",
      title: "ssh 172.16.5.89 bash /vlm/lws/repos/streaming/artifacts/20261120_guidance_v32_prod/finish_node89_and_cleanup.sh",
      kind: "execute",
      status: "completed",
      durationMs: 9500,
      outputText: "Created At: 2026-11-22T11:22:28+08:00\nCompleted At: 2026-11-22T11:22:37+08:00\nCommand exited with code 0.\n",
    },
    {
      type: "tool",
      toolCallId: "t5",
      name: "run_command",
      title: "ssh 172.16.5.89 bash /vlm/lws/repos/streaming/artifacts/20261120_guidance_v32_prod/finish_node89_and_cleanup.sh",
      kind: "execute",
      status: "completed",
      durationMs: 45200,
      outputText: "Created At: 2026-11-22T11:22:40+08:00\nCompleted At: 2026-11-22T11:23:25+08:00\nCommand exited with code 1.\n\nCommand output:\nERROR: export shard 3 missing on node89\n",
    },
    {
      type: "tool",
      toolCallId: "t6",
      name: "read_file",
      title: "File streaming/artifacts/20261120_guidance_v32_prod/export_and_validate_prod.py",
      kind: "read",
      status: "completed",
      durationMs: 100,
    },
    {
      type: "tool",
      toolCallId: "t7",
      name: "read_file",
      title: "File streaming/artifacts/20261120_guidance_v32_prod/service/stop_node89.sh",
      kind: "read",
      status: "completed",
      durationMs: 100,
    },
    {
      type: "tool",
      toolCallId: "t8",
      name: "post_message",
      title: "Run post_message",
      kind: "other",
      rawInput: { text: "@worker 请核查 node89 的 shard 3 导出" },
      status: "completed",
      durationMs: 3300,
    },
    { type: "thought", text: "Summarize status for user.", streaming: false, durationMs: 27000 },
    { type: "assistant", streaming: false, text: "node89 导出缺少 shard 3，已通知 @worker 核查。" },
  ];
}

test("tool output cleaning strips agy timestamps and detects non-zero exit codes", () => {
  const raw = "Created At: 2026-11-22T11:22:08+08:00\nCompleted At: 2026-11-22T11:22:10+08:00\nCommand exited with code 1.\n\nCommand output:\nPermission denied\nSecond line\n";
  assert.equal(parseExitCode(raw), 1);
  const preview = extractCleanOutputPreview(raw);
  assert.equal(preview.includes("Created At"), false);
  assert.ok(preview.includes("Permission denied"));
  assert.ok(preview.includes("+1 lines"));
});

test("latest turn renders in clean Codex style without [kind] or Created At noise, and archived turn collapses in agy style", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const cwd = "/vlm/lws/repos";
  const latestItems = buildRealisticTurnItems();

  const latestLines = renderTimeline(
    { cwd, items: latestItems, thoughtMode: "fold", expandTools: false, spinnerFrame: 0 },
    108,
    style,
  );
  const latestPlain = latestLines.map(stripAnsi).join("\n");

  // No noisy debug tags or raw timestamps
  assert.equal(latestPlain.includes("[other]"), false, latestPlain);
  assert.equal(latestPlain.includes("[execute]"), false, latestPlain);
  assert.equal(latestPlain.includes("[read]"), false, latestPlain);
  assert.equal(latestPlain.includes("Created At:"), false, latestPlain);

  // Codex Explored grouping & clean verbs
  assert.ok(latestPlain.includes("Explored"), latestPlain);
  assert.ok(latestPlain.includes("Check board, swarm status"), latestPlain);
  assert.ok(latestPlain.includes("Read export_and_validate_prod.py, stop_node89.sh"), latestPlain);
  assert.ok(latestPlain.includes("Posted to @worker"), latestPlain);

  // Non-zero exit code marked with failure icon and real error line
  assert.ok(latestPlain.includes("✗ Ran ssh 172.16.5.89"), latestPlain);
  assert.ok(latestPlain.includes("exit 1"), latestPlain);
  assert.ok(latestPlain.includes("ERROR: export shard 3 missing on node89"), latestPlain);

  // Thought summary appears before the first tool call rather than dangling at the very bottom
  const thoughtIdx = latestLines.findIndex((l) => stripAnsi(l).includes("▸ Thought"));
  const firstExploredIdx = latestLines.findIndex((l) => stripAnsi(l).includes("Explored"));
  assert.ok(thoughtIdx >= 0 && firstExploredIdx > thoughtIdx, `Thought (${thoughtIdx}) should precede Explored (${firstExploredIdx})`);

  // Once a second user turn starts, the previous turn collapses into an agy-style header while preserving the failure
  const multiTurnItems = [
    ...latestItems,
    { type: "user", text: "现在怎么样了" },
    { type: "assistant", streaming: false, text: "已修复。" },
  ];
  const archivedLines = renderTimeline(
    { cwd, items: multiTurnItems, thoughtMode: "fold", expandTools: false, spinnerFrame: 0 },
    108,
    style,
  );
  const archivedPlain = archivedLines.map(stripAnsi).join("\n");
  assert.ok(archivedPlain.includes("▸ Worked for"), archivedPlain);
  assert.ok(archivedPlain.includes("^O expand"), archivedPlain);
  assert.ok(archivedPlain.includes("✗ Ran ssh 172.16.5.89"), archivedPlain);
  assert.equal(archivedPlain.includes("Check board, swarm status"), false, "Archived turn should collapse explore details");

  // Ctrl+O (expandTools: true) expands archived turns back out
  const expandedPlain = renderTimeline(
    { cwd, items: multiTurnItems, thoughtMode: "fold", expandTools: true, spinnerFrame: 0 },
    108,
    style,
  ).map(stripAnsi).join("\n");
  assert.equal(expandedPlain.includes("▸ Worked for"), false, "Expanded mode should not archive previous turns");
  assert.ok(expandedPlain.includes("Posted to @worker"), expandedPlain);

  // Verify zero opaque backgrounds and zero width overflow across all 5 themes
  for (const theme of listThemes()) {
    const themeStyle = createThemeStyler(theme.name, "truecolor");
    for (const rendered of [
      renderTimeline({ cwd, items: latestItems, thoughtMode: "fold", expandTools: false, spinnerFrame: 0 }, 96, themeStyle),
      renderTimeline({ cwd, items: multiTurnItems, thoughtMode: "fold", expandTools: false, spinnerFrame: 0 }, 96, themeStyle),
    ]) {
      for (const line of rendered) {
        assert.equal(OPAQUE_BG_REGEX.test(line), false, `Opaque bg in ${theme.name}`);
        assert.ok(displayWidth(line) <= 96, `Line overflow in ${theme.name}: ${stripAnsi(line)}`);
      }
    }
  }
});

test("Swarm dock renders below composer with plan progress, inspect switching, and Esc return", () => {
  const tracker = new MultiAgentTracker();
  tracker.applyAgyState({
    swarmTitle: "guidance_v32",
    planSummary: {
      goalTitle: "Finish prod export",
      goalLine: "Validate all shards",
      totalTasks: 4,
      doneTasks: 2,
      blockedTasks: 0,
      threads: [
        { name: "node89-export", status: "working", detail: "retrying shard 3" },
        { name: "eval-check", status: "completed", detail: "verified" },
      ],
    },
    workers: [
      {
        name: "worker-a",
        state: "working",
        activity: "run_command bash finish_node89.sh",
        task: "Fix shard 3",
        startedAt: Date.now() - 42000,
        updatedAt: Date.now() - 1000,
        recentSteps: [
          { kind: "tool", name: "read_file", activity: "read_file export.py", status: "done" },
          { kind: "tool", name: "run_command", activity: "run_command bash finish_node89.sh", status: "running" },
        ],
      },
      {
        name: "verifier",
        state: "waiting",
        activity: "",
        task: "Verify outputs",
        startedAt: Date.now() - 95000,
        updatedAt: Date.now() - 5000,
        recentSteps: [],
      },
    ],
    subagents: [],
    board: [],
    messages: [],
  });

  for (const theme of listThemes()) {
    const style = createThemeStyler(theme.name, "truecolor");
    const dockRows = renderSwarmDock(tracker, 100, style, 1, {
      collapsed: false,
      focusedMemberId: "swarm:worker-a",
    });
    assert.ok(dockRows.length >= 3);
    const plain = dockRows.map(stripAnsi).join("\n");
    assert.ok(plain.includes('Swarm "guidance_v32"'));
    assert.ok(plain.includes("2/4 tasks"));
    assert.ok(plain.includes("worker-a"));
    assert.ok(plain.includes("verifier"));
    for (const row of dockRows) {
      assert.equal(OPAQUE_BG_REGEX.test(row), false, `Opaque bg in dock (${theme.name})`);
      assert.ok(displayWidth(row) <= 100, `Dock overflow (${theme.name}): ${stripAnsi(row)}`);
    }

    const collapsed = renderSwarmDock(tracker, 100, style, 1, { collapsed: true });
    assert.equal(collapsed.length, 1);

    const memberTimeline = renderMemberTimeline(tracker.getMemberById("swarm:worker-a"), 100, style, 1);
    const memberPlain = memberTimeline.map(stripAnsi).join("\n");
    assert.ok(memberPlain.includes("worker-a"));
    assert.ok(memberPlain.includes("read_file export.py"));
    for (const line of memberTimeline) {
      assert.equal(OPAQUE_BG_REGEX.test(line), false);
      assert.ok(displayWidth(line) <= 100);
    }

    // Composer block places the dock below the composer footer
    const composerBlock = renderComposerBlock(
      {
        cwd: "/tmp",
        busy: false,
        spinnerFrame: 1,
        scrollOffset: 0,
        mouseCapture: true,
        expandTools: false,
        thoughtMode: "fold",
        composer: new Composer(),
        multiAgent: tracker,
        swarmDockCollapsed: false,
        focusedAgentId: "swarm:worker-a",
        focusedAgentName: "worker-a",
      },
      100,
      style,
    );
    const compPlain = composerBlock.lines.map(stripAnsi);
    const promptIdx = compPlain.findIndex((l) => l.includes("❯"));
    const dockIdx = compPlain.findIndex((l) => l.includes('Swarm "guidance_v32"'));
    assert.ok(promptIdx >= 0 && dockIdx > promptIdx, "Dock must render below composer");
  }

  // Test LucidApp keybindings: Alt+], Alt+B, Esc
  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};
  app.state.multiAgent = tracker;

  app.handleMainKey({ type: "key", name: "]", ctrl: false, alt: true, shift: false });
  assert.equal(app.state.focusedAgentId, "swarm:worker-a");

  app.handleMainKey({ type: "key", name: "]", ctrl: false, alt: true, shift: false });
  assert.equal(app.state.focusedAgentId, "swarm:verifier");

  // Esc exits inspect view back to main conversation
  app.handleMainKey({ type: "key", name: "escape", ctrl: false, alt: false, shift: false });
  assert.equal(app.state.focusedAgentId, null);

  // Alt+B folds and expands the bottom dock
  app.handleMainKey({ type: "key", name: "b", ctrl: false, alt: true, shift: false });
  assert.equal(app.state.swarmDockCollapsed, true);
  app.handleMainKey({ type: "key", name: "b", ctrl: false, alt: true, shift: false });
  assert.equal(app.state.swarmDockCollapsed, false);
});

test("Claude-style !command runs local shell directly without calling ACP and highlights composer in shell mode", async () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const composer = new Composer();
  composer.setText("!echo hello-lucid");

  const compBlock = renderComposerBlock(
    {
      cwd: "/tmp",
      busy: false,
      spinnerFrame: 0,
      scrollOffset: 0,
      mouseCapture: true,
      expandTools: false,
      thoughtMode: "fold",
      composer,
    },
    100,
    style,
  );
  const compPlain = compBlock.lines.map(stripAnsi).join("\n");
  assert.ok(compPlain.includes("! Local shell"), compPlain);
  assert.ok(compPlain.includes(" ! !echo hello-lucid"), compPlain);

  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};
  let sentToAgent = false;
  app.sendUserPrompt = () => {
    sentToAgent = true;
  };

  app.state.composer.setText("!printf 'line1\\nline2\\n'");
  app.submitComposer();
  assert.equal(sentToAgent, false, "!command must bypass ACP agent");

  // Wait for local shell process to exit
  const deadline = Date.now() + 3000;
  while (app.activeLocalShell && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(app.activeLocalShell, null);
  const shellItem = app.state.items.find((it) => it.type === "shell");
  assert.ok(shellItem);
  assert.equal(shellItem.status, "completed");
  assert.equal(shellItem.exitCode, 0);
  assert.ok(shellItem.output.includes("line1"));

  for (const theme of listThemes()) {
    const themeStyle = createThemeStyler(theme.name, "truecolor");
    const lines = renderTimeline(
      { cwd: "/tmp", items: app.state.items, thoughtMode: "fold", expandTools: false, spinnerFrame: 0 },
      96,
      themeStyle,
    );
    const plain = lines.map(stripAnsi).join("\n");
    assert.ok(plain.includes("line1"));
    for (const line of lines) {
      assert.equal(OPAQUE_BG_REGEX.test(line), false, `Opaque bg in shell item (${theme.name})`);
      assert.ok(displayWidth(line) <= 96, `Shell item overflow (${theme.name}): ${stripAnsi(line)}`);
    }
  }
});
