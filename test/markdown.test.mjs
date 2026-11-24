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

test("renders LaTeX inline/block formulas and HTML <br> breaks cleanly inside tables", () => {
  const sample = [
    "| 做法 | 每个 bin 的分母 $N_i$ | 短 QA 拿到的梯度份额 | 跳绳拿到的梯度份额 |",
    "| :--- | :--- | :--- | :--- |",
    "| 纯 bin：1 个纯短 QA bin + 1 个纯跳绳 bin | 短 QA bin $N_1 = 40$<br>跳绳 bin $N_2 = 1200$ | 50%（1 个完整 bin 份额）<br>单 token 权重 $\\propto \\frac{1}{40}$ | 50%（1 个完整 bin 份额）<br>单 token 权重 $\\propto \\frac{1}{1200}$ |",
    "| 混打 bin：2 个 bin，每个装 2 短 QA + 2 跳绳 | 每个 bin 都是<br>$N_{\\text{混}} = 20 + 600 = 620$ | 3.2%（$\\frac{20}{620}$，暴跌 15.5 倍）<br>单 token 权重 $\\propto \\frac{1}{620}$ | 96.8%（$\\frac{600}{620}$，暴涨 1.94 倍）<br>单 token 权重 $\\propto \\frac{1}{620}$ |",
    "",
    "$$",
    "L = \\sum_{i=1}^{n} \\frac{1}{N_i} \\cdot \\ell_i",
    "$$",
    "",
    "价格对比：原价 $5 和 $10 不应误判为公式，变量 \\$HOME 也应原样保留。",
  ].join("\n");

  const style = createThemeStyler("tokyo-night", "truecolor");
  const lines = renderMarkdown(sample, 140, style);
  const plain = lines.map(stripAnsi).join("\n");

  assert.equal(plain.includes("<br>"), false, "HTML <br> should split into lines, not render literally");
  assert.equal(plain.includes("\\frac"), false, "LaTeX \\frac should be rendered");
  assert.equal(plain.includes("\\propto"), false, "LaTeX \\propto should be rendered");
  assert.equal(plain.includes("\\text"), false, "LaTeX \\text should be rendered");
  assert.ok(plain.includes("Nᵢ"), plain);
  assert.ok(plain.includes("N₁ = 40"), plain);
  assert.ok(plain.includes("N₂ = 1200"), plain);
  assert.ok(plain.includes("N_混 = 20 + 600 = 620"), plain);
  assert.ok(plain.includes("∝ 1/40"), plain);
  assert.ok(plain.includes("20/620"), plain);
  assert.ok(plain.includes("∑ᵢ₌₁ⁿ"), plain);
  assert.ok(plain.includes("$5 和 $10"), "currency should not be mangled as math");
  assert.ok(plain.includes("$HOME"), "escaped dollar should remain literal");

  for (const line of lines) {
    assert.ok(displayWidth(line) <= 140, `overflowed: ${stripAnsi(line)}`);
  }
});

test("<br> inside inline code is kept literally instead of splitting the line", () => {
  const style = createThemeStyler("tokyo-night", "truecolor");
  const plain = renderMarkdown("Tables with `<br>` cells now split.<br>Second line", 100, style).map(stripAnsi);
  assert.deepEqual(plain, ["Tables with <br> cells now split.", "Second line"]);
});

test("renders file:// links as editor-clickable path:line without broken OSC 8, and closes/reopens OSC 8 on wrapped web links", async () => {
  const { truncateAnsi, wrapAnsiLine } = await import("../src/term/unicode.mjs");
  const style = createThemeStyler("tokyo-night", "truecolor");

  // 1. file:// links with #L62-L87 render as clean relative path:line (no OSC 8 file:// that fails over SSH/VS Code)
  const fileLine = renderMarkdown(
    "修复了 [session.mjs](file:///vlm/lws/repos/lucid/src/app/session.mjs#L62-L87) 和 [配置文件](file:///root/.config/lucid/config.json)。",
    120,
    style,
    { cwd: "/vlm/lws/repos" },
  ).join("\n");
  assert.equal(fileLine.includes("\x1b]8;"), false, "file:// links should not emit broken OSC 8 file:// URIs");
  assert.ok(stripAnsi(fileLine).includes("lucid/src/app/session.mjs:62"));
  assert.ok(stripAnsi(fileLine).includes("配置文件 (/root/.config/lucid/config.json)"));

  // 2. Non-web custom scheme (conversation://) never emits OSC 8
  const customLine = renderMarkdown("见 [上次会话](conversation://1e920f2e-cb08)", 120, style).join("\n");
  assert.equal(customLine.includes("\x1b]8;"), false);
  assert.equal(stripAnsi(customLine), "见 上次会话");

  // 3. Web links with balanced parentheses and bare https:// URLs emit proper OSC 8 with id=
  const webLine = renderMarkdown(
    "参考 [Wiki](https://en.wikipedia.org/wiki/Foo_(bar)) 和 https://github.com/Kagura-0001/lucid。",
    140,
    style,
  ).join("\n");
  assert.ok(webLine.includes(";https://en.wikipedia.org/wiki/Foo_(bar)\x1b\\"));
  assert.ok(webLine.includes(";https://github.com/Kagura-0001/lucid\x1b\\"));
  assert.ok(stripAnsi(webLine).includes("Wiki"));
  assert.ok(stripAnsi(webLine).includes("https://github.com/Kagura-0001/lucid。"));

  // 4. Wrapping a long OSC 8 hyperlink closes OSC 8 on line 1 and reopens the exact same OSC 8 on line 2
  const longLink = renderMarkdown("[a-very-long-hyperlink-label-that-wraps](https://example.com/path)", 24, style);
  assert.ok(longLink.length >= 2);
  for (const row of longLink) {
    const opens = (row.match(/\x1b\]8;id=[^;]+;https:\/\/example\.com\/path\x1b\\/g) || []).length;
    const closes = (row.match(/\x1b\]8;;\x1b\\/g) || []).length;
    assert.equal(opens, 1, `wrapped row must open OSC 8 once: ${JSON.stringify(row)}`);
    assert.equal(closes, 1, `wrapped row must close OSC 8 once: ${JSON.stringify(row)}`);
  }

  // 5. Truncating mid-OSC 8 hyperlink always closes OSC 8 cleanly
  const truncated = truncateAnsi(wrapAnsiLine(longLink[0], 100)[0], 10, "…");
  assert.ok(truncated.includes("\x1b]8;;\x1b\\"), "truncated OSC 8 link must be closed");
});
