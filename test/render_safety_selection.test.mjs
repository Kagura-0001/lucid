import assert from "node:assert/strict";
import test from "node:test";
import { TerminalRenderer } from "../src/term/renderer.mjs";
import { InputParser } from "../src/term/input.mjs";
import {
  displayWidth,
  sanitizeTerminalRow,
  splitGraphemes,
  stripAnsi,
  truncateAnsi,
  wrapAnsiLine,
} from "../src/term/unicode.mjs";
import { renderMarkdown } from "../src/ui/markdown.mjs";
import {
  cloneSelection,
  createSelection,
  extractSelectionText,
  highlightSelectionInViewport,
  patchSelectionInFrame,
} from "../src/ui/selection.mjs";
import { createThemeStyler } from "../src/ui/themes.mjs";
import { Composer } from "../src/ui/composer.mjs";
import { renderComposerBlock, renderTimeline } from "../src/ui/views.mjs";

const HEREDOC_COMMAND = [
  "python3 - <<'EOF'",
  "import json",
  "print(open('/vlm/yinxie/code/OV21/some/really/long/path/to/file.json').read())",
  "EOF",
].join("\n");

function createSink(columns = 80, rows = 12) {
  return {
    columns,
    rows,
    output: "",
    write(chunk) {
      this.output += chunk;
      return true;
    },
  };
}

test("sanitizeTerminalRow keeps SGR/OSC 8 and neutralizes line breaks, tabs and cursor escapes", () => {
  const link = "\x1b]8;;https://example.com\x1b\\site\x1b]8;;\x1b\\";
  const row = `\x1b[1mbold\x1b[0m a\nb\r\nc\rd\te\x1b[2A\x1b[Kf\x07 ${link}`;
  const safe = sanitizeTerminalRow(row);

  assert.ok(safe.includes("\x1b[1mbold\x1b[0m"));
  assert.ok(safe.includes(link));
  assert.ok(!/[\n\r\t\x07]/.test(safe));
  assert.ok(!safe.includes("\x1b[2A"));
  assert.ok(!safe.includes("\x1b[K"));
  assert.equal(stripAnsi(safe), "bold a ⏎ b ⏎ c ⏎ d    ef site");
});

test("renderer never writes raw newlines and erases each changed row before drawing it", () => {
  const sink = createSink(60, 6);
  const renderer = new TerminalRenderer(sink);
  renderer.enter({ mouseCapture: false });
  assert.ok(sink.output.includes("\x1b[?7l"), "autowrap is disabled in the alt screen");

  sink.output = "";
  renderer.render([`  ✓ ${HEREDOC_COMMAND}`, "second row"], null);
  assert.ok(!sink.output.includes("\n"));
  assert.ok(!sink.output.includes("\r"));
  assert.ok(sink.output.includes("\x1b[1;1H\x1b[0m\x1b[2K"));
  assert.ok(sink.output.includes("\x1b[2;1H\x1b[0m\x1b[2Ksecond row"));

  // An identical frame produces no output at all.
  sink.output = "";
  renderer.render([`  ✓ ${HEREDOC_COMMAND}`, "second row"], null);
  assert.equal(sink.output, "");

  sink.output = "";
  renderer.leave();
  assert.ok(sink.output.includes("\x1b[?7h"), "autowrap is restored on exit");
  assert.ok(sink.output.includes("\x1b[?1000l"), "mouse button tracking is disabled on exit");
  assert.ok(sink.output.includes("\x1b[?1002l"), "mouse drag tracking is disabled on exit");
  assert.ok(
    sink.output.indexOf("\x1b[?1002l") < sink.output.indexOf("\x1b[?1006l"),
    "tracking modes are disabled before SGR encoding mode",
  );
});

test("tool header shows only the first line of a multi-line command", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const items = [
    { type: "user", text: "run it" },
    { type: "tool", toolCallId: "t1", title: HEREDOC_COMMAND, kind: "execute", status: "completed", durationMs: 50 },
  ];
  const lines = renderTimeline({ cwd: "/tmp", items, thoughtMode: "fold", expandTools: false, spinnerFrame: 0 }, 100, style);
  const plain = lines.map(stripAnsi);
  const header = plain.find((line) => line.includes("python3 - <<'EOF'"));
  assert.ok(header, "header row exists");
  assert.ok(header.includes("(+3 lines)"));
  assert.ok(lines.every((line) => !/[\n\r]/.test(line)));
});

test("splitGraphemes matches Intl.Segmenter on mixed text", () => {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const samples = [
    "plain ascii only",
    "café e\u0301 naïve",
    "中文混排 with English 和标点，。",
    "emoji 👍🏽 family 👨‍👩‍👧 flag 🇨🇳 keycap 1\ufe0f\u20e3",
    "tab\tand\r\nnewline\n",
    "长".repeat(1000) + "a\u0301" + "字".repeat(700),
  ];
  for (const sample of samples) {
    const expected = [...segmenter.segment(sample)].map((item) => item.segment);
    assert.deepEqual(splitGraphemes(sample), expected, JSON.stringify(sample.slice(0, 40)));
  }
});

test("long single-line text wraps in linear time", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const longAscii = "streaming ".repeat(3000);
  const longCjk = "流式输出的中文段落，".repeat(3000);

  const start = performance.now();
  const asciiLines = renderMarkdown(longAscii, 120, style);
  const cjkLines = wrapAnsiLine(longCjk, 120);
  const elapsedMs = performance.now() - start;

  assert.ok(asciiLines.length > 200);
  assert.ok(cjkLines.every((line) => displayWidth(line) <= 120));
  // Previously ~280 ms for the ASCII case alone (quadratic Intl.Segmenter iteration).
  assert.ok(elapsedMs < 150, `took ${elapsedMs.toFixed(1)} ms`);
});

test("truncateAnsi terminates on a lone ESC byte", () => {
  // Used to loop forever: the unmatched ESC produced an empty chunk and no progress.
  assert.equal(truncateAnsi("ab\x1bcdefgh", 4), "ab\x1bcd");
});

test("InputParser reports left-button press, drag and release", () => {
  const events = [];
  const parser = new InputParser((event) => events.push(event));
  parser.feed("\x1b[<0;5;3M\x1b[<32;9;4M\x1b[<0;12;4m\x1b[<64;1;1M\x1b[<4;2;2M");
  parser.destroy();
  assert.deepEqual(
    events.map((event) => `${event.action}@${event.col},${event.row}`),
    ["leftDown@5,3", "leftDrag@9,4", "leftUp@12,4", "wheelUp@1,1", "leftDown@2,2"],
  );
});

test("selection extracts dedented plain text and highlights only the selected columns", () => {
  const lines = ["", "  \x1b[1mfirst line\x1b[0m here", "  second line", "  third"];
  const selection = createSelection(1, 2);
  selection.head = { line: 3, col: 6 };

  assert.equal(extractSelectionText(lines, selection), "first line here\nsecond line\nthird");

  const highlighted = highlightSelectionInViewport(lines, 0, selection);
  assert.equal(highlighted[0], "");
  assert.ok(highlighted[1].startsWith("  \x1b[1m\x1b[7mfirst"), JSON.stringify(highlighted[1]));
  assert.ok(highlighted[1].includes("\x1b[0m\x1b[7m"), "inverse survives the row's own reset");
  assert.equal(stripAnsi(highlighted[2]), "  second line ");
  assert.equal(stripAnsi(highlighted[3]), "  third");
});

test("patchSelectionInFrame only updates rows whose selected column range changed", () => {
  const viewportRawRows = ["  line 0", "  line 1", "  line 2", "  line 3", "  line 4"];
  const frameRows = ["HEADER", ...viewportRawRows, "FOOTER"];
  const sel1 = createSelection(1, 2);
  sel1.head = { line: 3, col: 5 };

  const touchedInitial = patchSelectionInFrame({
    frameRows,
    viewportRawRows,
    topRow: 1,
    firstLineIndex: 0,
    prevSelection: null,
    nextSelection: sel1,
  });
  assert.equal(touchedInitial, 3);
  const row1Before = frameRows[2];
  const row2Before = frameRows[3];

  // Extending the selection horizontally on line 3 should only touch line 3.
  const sel2 = cloneSelection(sel1);
  sel2.head = { line: 3, col: 7 };
  const touchedExtend = patchSelectionInFrame({
    frameRows,
    viewportRawRows,
    topRow: 1,
    firstLineIndex: 0,
    prevSelection: sel1,
    nextSelection: sel2,
  });
  assert.equal(touchedExtend, 1);
  assert.equal(frameRows[2], row1Before);
  assert.equal(frameRows[3], row2Before);

  // Clearing the selection restores the exact original row references.
  const touchedClear = patchSelectionInFrame({
    frameRows,
    viewportRawRows,
    topRow: 1,
    firstLineIndex: 0,
    prevSelection: sel2,
    nextSelection: null,
  });
  assert.equal(touchedClear, 3);
  assert.equal(frameRows[2], viewportRawRows[1]);
  assert.equal(frameRows[4], viewportRawRows[3]);
});

test("toast renders in the fixed footer line without shifting composer block height", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const baseState = {
    cwd: "/tmp",
    busy: false,
    spinnerFrame: 0,
    scrollOffset: 0,
    mouseCapture: true,
    expandTools: false,
    thoughtMode: "fold",
    composer: new Composer(),
    toast: null,
  };
  const withoutToast = renderComposerBlock(baseState, 100, style);
  const withToast = renderComposerBlock(
    {
      ...baseState,
      toast: { text: "Copied 42 chars (2 lines) via OSC 52", level: "info", expiresAt: Date.now() + 5000 },
    },
    100,
    style,
  );
  assert.equal(withToast.lines.length, withoutToast.lines.length);
  assert.ok(stripAnsi(withToast.lines.at(-1)).includes("Copied 42 chars"));
});

test("default config uses auto mode and supports --bypass / dangerouslySkipPermissions", async () => {
  const { DEFAULT_CONFIG, parseCliArgs, resolveAgentLaunch } = await import("../src/config.mjs");
  assert.equal(DEFAULT_CONFIG.mode, "auto");

  const parsed = parseCliArgs(["--bypass"]);
  assert.equal(parsed.dangerouslySkipPermissions, true);

  const launchFromCli = resolveAgentLaunch(parsed, DEFAULT_CONFIG);
  assert.ok(launchFromCli.args.includes("--dangerously-skip-permissions"));

  const launchFromConfig = resolveAgentLaunch({}, { ...DEFAULT_CONFIG, dangerouslySkipPermissions: true });
  assert.ok(launchFromConfig.args.includes("--dangerously-skip-permissions"));
});

test("bypass mode auto-answers permission requests and shows a header badge", async () => {
  const { LucidApp } = await import("../src/app.mjs");
  const { renderHeader } = await import("../src/ui/views.mjs");
  const app = new LucidApp({ cwd: "/tmp", dangerouslySkipPermissions: true });
  app.scheduleRender = () => {};
  assert.equal(app.state.bypassPermissions, true);

  let chosen = null;
  app.enqueuePermissionRequest({
    params: {
      options: [
        { optionId: "reject", name: "Reject", kind: "reject_once" },
        { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      ],
    },
    selectOption: (optionId) => {
      chosen = optionId;
    },
    cancel: () => {},
  });
  assert.equal(chosen, "allow-once");
  assert.equal(app.modal, null, "no permission dialog in bypass mode");

  const style = createThemeStyler("tokyo-night", "truecolor");
  const header = renderHeader(app.state, 100, style).map(stripAnsi).join("\n");
  assert.ok(header.includes("bypass"));
});

test("when mouseCapture is OFF, Alternate Scroll Up/Down bursts scroll timeline instead of moving composer cursor", async () => {
  const { LucidApp } = await import("../src/app.mjs");
  const app = new LucidApp({ cwd: "/tmp", noMouse: true });
  app.scheduleRender = () => {};
  app.state.maxScrollOffset = 50;
  app.state.scrollOffset = 0;
  app.state.composer.pushHistory("previous prompt");

  // Simulate a terminal Alternate Scroll (?1007h) wheel-up notch: 3x Up in one stdin batch
  app.dispatchInputBatch([
    { type: "key", name: "up", ctrl: false, alt: false, shift: false },
    { type: "key", name: "up", ctrl: false, alt: false, shift: false },
    { type: "key", name: "up", ctrl: false, alt: false, shift: false },
  ]);

  assert.equal(app.state.scrollOffset, 3);
  assert.equal(app.state.composer.text, "", "wheel burst must not load prompt history into composer");

  // Scrolling back down to bottom returns scrollOffset to 0
  app.dispatchInputBatch([
    { type: "key", name: "down", ctrl: false, alt: false, shift: false },
    { type: "key", name: "down", ctrl: false, alt: false, shift: false },
    { type: "key", name: "down", ctrl: false, alt: false, shift: false },
  ]);
  assert.equal(app.state.scrollOffset, 0);
});

test("when mouseCapture is OFF, a single slow wheel arrow scrolls immediately if the composer is empty", async () => {
  const { LucidApp } = await import("../src/app.mjs");
  const app = new LucidApp({ cwd: "/tmp", noMouse: true });
  app.scheduleRender = () => {};
  app.scheduleScrollFlush = () => {};
  app.state.maxScrollOffset = 50;
  app.state.composer.pushHistory("previous prompt");

  const up = { type: "key", name: "up", ctrl: false, alt: false, shift: false };
  app.dispatchInputBatch([up]);
  assert.equal(app.state.scrollOffset, 1, "first single arrow must scroll, not wait for a burst");
  assert.equal(app.state.composer.text, "", "must not load history");

  // With a draft in the composer and no recent scrolling, a single Up is a real keypress.
  app.lastAltScrollAt = 0;
  app.state.composer.setText("draft line one\ndraft line two");
  app.dispatchInputBatch([up]);
  assert.equal(app.state.scrollOffset, 1);
  assert.equal(app.state.composer.text, "draft line one\ndraft line two");
});

test("renderer uses VT100 scroll region to send only newly revealed rows when scrolling", () => {
  const sink = createSink(60, 10);
  const renderer = new TerminalRenderer(sink);
  renderer.enter({ mouseCapture: false });

  const frame1 = [
    "HEADER",
    "------",
    "line 10",
    "line 11",
    "line 12",
    "line 13",
    "line 14",
    "line 15",
    "------",
    "FOOTER",
  ];
  renderer.render(frame1, null);

  // Scroll UP by 2 lines (older lines 8 & 9 appear at top; lines 10..13 shift down)
  sink.output = "";
  const frame2 = [
    "HEADER",
    "------",
    "line 8",
    "line 9",
    "line 10",
    "line 11",
    "line 12",
    "line 13",
    "------",
    "FOOTER",
  ];
  renderer.render(frame2, null, { topRow: 2, height: 6, delta: 2 });

  assert.ok(sink.output.includes("\x1b[3;8r\x1b[3;1H\x1b[2L\x1b[r"), "emits DECSTBM + IL scroll shift");
  assert.ok(sink.output.includes("line 8"));
  assert.ok(sink.output.includes("line 9"));
  assert.equal(sink.output.includes("line 10"), false, "shifted row must not be retransmitted");
  assert.equal(sink.output.includes("line 13"), false, "shifted row must not be retransmitted");

  // Scroll DOWN by 2 lines (returns to frame1 via DL)
  sink.output = "";
  renderer.render(frame1, null, { topRow: 2, height: 6, delta: -2 });
  assert.ok(sink.output.includes("\x1b[3;8r\x1b[3;1H\x1b[2M\x1b[r"), "emits DECSTBM + DL scroll shift");
  assert.ok(sink.output.includes("line 14"));
  assert.ok(sink.output.includes("line 15"));
  assert.equal(sink.output.includes("line 10"), false, "shifted row must not be retransmitted");
  assert.equal(sink.output.includes("line 13"), false, "shifted row must not be retransmitted");
});

test("scrolling away from bottom keeps composer block height constant", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const baseState = {
    cwd: "/tmp",
    busy: false,
    spinnerFrame: 0,
    scrollOffset: 0,
    mouseCapture: true,
    expandTools: false,
    thoughtMode: "fold",
    composer: new Composer(),
    toast: null,
  };
  const atBottom = renderComposerBlock(baseState, 100, style);
  const scrolledUp = renderComposerBlock({ ...baseState, scrollOffset: 12 }, 100, style);
  assert.equal(scrolledUp.lines.length, atBottom.lines.length);
  assert.ok(stripAnsi(scrolledUp.lines.at(-1)).includes("↓ 12 lines below"));
});
