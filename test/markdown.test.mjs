import assert from "node:assert/strict";
import test from "node:test";
import { displayWidth, stripAnsi } from "../src/term/unicode.mjs";
import { computeLineDiff, renderDiffLines } from "../src/ui/diff.mjs";
import { renderMarkdown } from "../src/ui/markdown.mjs";
import { createThemeStyler, listThemes } from "../src/ui/themes.mjs";

// Regex that detects ANY opaque background ANSI sequence (40-47, 48;*, 100-107)
const OPAQUE_BG_REGEX = /\x1b\[(?:4[0-7]|48;|10[0-7])/;

test("all themes render markdown with zero opaque background patches and fit maxWidth", () => {
  const sample = [
    "# 渲染测试 Heading",
    "",
    "普通正文包含 `inline_code`、**加粗**、*斜体* 和 [链接](https://example.com)。",
    "",
    "```python",
    "def greet(name: str) -> str:",
    '    # 注释 comment',
    '    return f"hello {name}"',
    "```",
    "",
    "| 方案 | 特点 | 状态 |",
    "| :--- | :--- | :--- |",
    "| `agy acp` | 官方 JSON-RPC 2.0 协议，复用登录态与模型 | 推荐 |",
    "| `stream-json` | 非交互式 NDJSON，适合脚本与评测 | 备选 |",
    "",
    "> 引用段落：支持中文自动折行与窄终端适配。",
    "",
    "- 第一项列表内容",
    "- 第二项包含 `tmux-256color` 配置说明",
  ].join("\n");

  const maxWidth = 64;

  for (const theme of listThemes()) {
    const style = createThemeStyler(theme.name, "truecolor");
    const lines = renderMarkdown(sample, maxWidth, style);
    assert.ok(lines.length > 10);

    for (const line of lines) {
      assert.equal(
        OPAQUE_BG_REGEX.test(line),
        false,
        `Theme "${theme.name}" emitted an opaque background ANSI sequence in line: ${JSON.stringify(line)}`,
      );
      assert.ok(
        displayWidth(line) <= maxWidth,
        `Theme "${theme.name}" overflowed maxWidth ${maxWidth} (got ${displayWidth(line)}): ${stripAnsi(line)}`,
      );
    }
  }
});

test("streaming unclosed code fence renders cleanly without throwing", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const lines = renderMarkdown("```bash\necho hello\ntmux info", 50, style);
  assert.ok(lines.some((l) => stripAnsi(l).includes("echo hello")));
  assert.ok(lines.some((l) => stripAnsi(l).includes("…")));
});

test("computeLineDiff and renderDiffLines produce clean transparent diffs", () => {
  const oldText = "line1\nline2\nline3\nline4\n";
  const newText = "line1\nline2_changed\nline3\nline4\nline5\n";

  const diff = computeLineDiff(oldText, newText);
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 1);

  const style = createThemeStyler("transparent", "truecolor");
  const rendered = renderDiffLines({
    pathLabel: "src/example.mjs",
    oldText,
    newText,
    maxWidth: 70,
    style,
  });

  assert.ok(rendered.lines.length >= 4);
  for (const line of rendered.lines) {
    assert.equal(OPAQUE_BG_REGEX.test(line), false);
    assert.ok(displayWidth(line) <= 70);
  }
});
