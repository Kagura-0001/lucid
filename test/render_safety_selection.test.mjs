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
import { createSelection, extractSelectionText, highlightSelectionInViewport } from "../src/ui/selection.mjs";
import { createThemeStyler } from "../src/ui/themes.mjs";
import { renderTimeline } from "../src/ui/views.mjs";

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
