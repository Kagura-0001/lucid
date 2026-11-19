import assert from "node:assert/strict";
import { displayWidth, stripAnsi } from "../src/term/unicode.mjs";
import { Composer } from "../src/ui/composer.mjs";
import { createThemeStyler, listThemes } from "../src/ui/themes.mjs";
import {
  applyOverlayModal,
  renderComposerBlock,
  renderHeader,
  renderTimeline,
} from "../src/ui/views.mjs";

const OPAQUE_BG_REGEX = /\x1b\[(?:4[0-7]|48;|10[0-7])/;

function buildMockState() {
  const composer = new Composer();
  composer.setText("帮我把 tmux 配置改成 TrueColor");
  return {
    cwd: "/workspace/demo-app",
    agentLabel: "Antigravity ACP Server 1.5.12",
    connected: true,
    connecting: false,
    sessionId: "demo-1",
    modelLabel: "Gemini 4 Neon",
    effortLabel: "High",
    modeId: "auto",
    usage: { used: 18400, size: 1048576 },
    quotaText: "5h 92%",
    busy: false,
    spinnerFrame: 2,
    scrollOffset: 0,
    mouseCapture: true,
    showThoughts: false,
    expandTools: false,
    composer,
    toast: null,
    items: [
      { type: "user", text: "检查一下当前目录的 tmux 配置并修好 TrueColor", attachedPaths: ["src/config.mjs"] },
      { type: "thought", text: "需要先检查 ~/.tmux.conf 和 terminfo，确认 tmux-256color 是否可用。", streaming: false, durationMs: 1400 },
      {
        type: "tool",
        toolCallId: "t1",
        title: "Edit ~/.tmux.conf",
        kind: "edit",
        status: "completed",
        durationMs: 320,
        diffs: [
          {
            path: "/workspace/demo-app/.tmux.conf",
            oldText: 'set -g default-terminal "screen"\n',
            newText: 'set -g default-terminal "tmux-256color"\nset -as terminal-features ",xterm*:RGB"\n',
          },
        ],
      },
      {
        type: "assistant",
        streaming: false,
        text: [
          "### 已完成配置",
          "",
          "已经把 `default-terminal` 切到 `tmux-256color`，并补上了 `RGB` 和 `Tc` 特性：",
          "",
          "| 配置项 | 生效值 | 作用 |",
          "| :--- | :--- | :--- |",
          "| `default-terminal` | `tmux-256color` | 启用 256 色与现代 terminfo |",
          "| `terminal-features` | `,xterm*:RGB` | 开启 24-bit TrueColor |",
          "",
          "```bash",
          "tmux display -p '#{client_termfeatures}'",
          "```",
        ].join("\n"),
      },
    ],
  };
}

const cols = 100;
const rows = 34;

for (const theme of listThemes()) {
  const style = createThemeStyler(theme.name, "truecolor");
  const state = buildMockState();

  const header = renderHeader(state, cols, style);
  const composerBlock = renderComposerBlock(state, cols, style);
  const viewportHeight = rows - header.length - composerBlock.lines.length;
  const timeline = renderTimeline(state, cols, style);
  const viewport = timeline.slice(Math.max(0, timeline.length - viewportHeight));
  while (viewport.length < viewportHeight) viewport.push("");

  const frame = [...header, ...viewport, ...composerBlock.lines];
  assert.equal(frame.length, rows, `Expected ${rows} rows for theme ${theme.name}`);

  for (const line of frame) {
    assert.equal(OPAQUE_BG_REGEX.test(line), false, `Opaque background detected in theme ${theme.name}: ${JSON.stringify(line)}`);
    assert.ok(displayWidth(line) <= cols, `Row overflow (${displayWidth(line)} > ${cols}): ${stripAnsi(line)}`);
  }

  // Also test modal overlay rendering with zero opaque backgrounds
  const withModal = applyOverlayModal(
    viewport,
    cols,
    {
      type: "permission",
      title: "Permission Approval",
      params: {
        title: "Run shell command",
        description: "Execute `tmux source-file ~/.tmux.conf`",
        options: [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      },
      selected: 0,
    },
    style,
  );
  for (const line of withModal) {
    assert.equal(OPAQUE_BG_REGEX.test(line), false, `Opaque background in modal (${theme.name})`);
    assert.ok(displayWidth(line) <= cols, `Modal overflow (${displayWidth(line)} > ${cols})`);
  }
}

// Print plain-text layout preview for inspection
const previewStyle = createThemeStyler("transparent", "none");
const previewState = buildMockState();
const hdr = renderHeader(previewState, cols, previewStyle);
const comp = renderComposerBlock(previewState, cols, previewStyle);
const vh = rows - hdr.length - comp.lines.length;
const tl = renderTimeline(previewState, cols, previewStyle);
const vp = tl.slice(Math.max(0, tl.length - vh));
while (vp.length < vh) vp.push("");

console.log("=== RENDER PREVIEW (100x34, all 5 themes verified: 0 opaque bg, 0 width overflow) ===");
for (const line of [...hdr, ...vp, ...comp.lines]) {
  console.log(stripAnsi(line));
}
