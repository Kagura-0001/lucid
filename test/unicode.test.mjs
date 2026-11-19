import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth, padEndVisible, stripAnsi, truncateAnsi, wrapAnsiLine } from "../src/term/unicode.mjs";

test("displayWidth accurately counts ASCII, CJK, and ANSI codes", () => {
  assert.equal(displayWidth("hello"), 5);
  assert.equal(displayWidth("中文测试"), 8);
  assert.equal(displayWidth("混合 mixed 文本"), 15);
  assert.equal(displayWidth("\x1b[36m中文\x1b[0m"), 4);
  assert.equal(stripAnsi("\x1b[1;34mhello\x1b[0m"), "hello");
});

test("truncateAnsi clips cleanly at CJK boundaries without breaking ANSI reset", () => {
  const styled = "\x1b[33m中文标题内容很长\x1b[0m";
  const clipped = truncateAnsi(styled, 7, "…");
  assert.ok(displayWidth(clipped) <= 7);
  assert.ok(clipped.endsWith("\x1b[0m"));
  assert.equal(stripAnsi(clipped), "中文标…");
});

test("padEndVisible aligns mixed CJK and ASCII strings to exact column width", () => {
  const a = padEndVisible("中文", 10);
  const b = padEndVisible("test", 10);
  assert.equal(displayWidth(a), 10);
  assert.equal(displayWidth(b), 10);
});

test("wrapAnsiLine wraps mixed ANSI text within maxWidth and preserves style", () => {
  const line = "\x1b[36m这是一段很长的中文和 English words 混排测试\x1b[0m";
  const wrapped = wrapAnsiLine(line, 18);
  assert.ok(wrapped.length >= 2);
  for (const w of wrapped) {
    assert.ok(displayWidth(w) <= 18, `Line exceeded width 18: "${stripAnsi(w)}" (${displayWidth(w)})`);
    assert.ok(w.includes("\x1b[36m"), "Expected SGR color preserved on wrapped line");
    assert.ok(w.endsWith("\x1b[0m"), "Expected SGR reset at end of wrapped line");
  }
});
