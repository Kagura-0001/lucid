import assert from "node:assert/strict";
import test from "node:test";
import { LucidApp } from "../src/app.mjs";
import { InputParser } from "../src/term/input.mjs";
import { stripAnsi } from "../src/term/unicode.mjs";
import { Composer } from "../src/ui/composer.mjs";
import { createThemeStyler } from "../src/ui/themes.mjs";
import { renderComposerBlock, renderTimeline } from "../src/ui/views.mjs";

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
