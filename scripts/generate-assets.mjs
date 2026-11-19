import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Composer } from "../src/ui/composer.mjs";
import { renderDiffLines } from "../src/ui/diff.mjs";
import { renderMarkdown } from "../src/ui/markdown.mjs";
import { MultiAgentTracker, renderSwarmBoardView } from "../src/ui/swarm.mjs";
import { createThemeStyler, listThemes } from "../src/ui/themes.mjs";
import { renderComposerBlock, renderHeader, renderTimeline } from "../src/ui/views.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(ROOT_DIR, "assets");

const MONO_FONT = "ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
const SANS_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

const ANSI16_DARK = {
  30: "#4c566a",
  31: "#f7768e",
  32: "#9ece6a",
  33: "#e0af68",
  34: "#7aa2f7",
  35: "#bb9af7",
  36: "#7dcfff",
  37: "#c0caf5",
  90: "#737aa2",
  91: "#ff899d",
  92: "#b9f27c",
  93: "#ffd580",
  94: "#89b4fa",
  95: "#d2a8ff",
  96: "#a4e4ff",
  97: "#ffffff",
};

const ANSI16_LIGHT = {
  30: "#073642",
  31: "#dc322f",
  32: "#859900",
  33: "#b58900",
  34: "#268bd2",
  35: "#6c71c4",
  36: "#2aa198",
  37: "#657b83",
  90: "#839496",
  91: "#cb4b16",
  92: "#586e75",
  93: "#657b83",
  94: "#839496",
  95: "#6c71c4",
  96: "#93a1a1",
  97: "#002b36",
};

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function ansi256ToHex(n) {
  if (n < 16) {
    const map = [
      "#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5",
      "#565f89", "#ff899d", "#b9f27c", "#ffd580", "#89b4fa", "#d2a8ff", "#a4e4ff", "#ffffff",
    ];
    return map[n] || "#c0caf5";
  }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    const h = v.toString(16).padStart(2, "0");
    return `#${h}${h}${h}`;
  }
  const idx = n - 16;
  const r = Math.floor(idx / 36);
  const g = Math.floor((idx % 36) / 6);
  const b = idx % 6;
  const steps = [0, 95, 135, 175, 215, 255];
  return `#${steps[r].toString(16).padStart(2, "0")}${steps[g].toString(16).padStart(2, "0")}${steps[b].toString(16).padStart(2, "0")}`;
}

function parseAnsiLineToRuns(line, palette) {
  const runs = [];
  let state = {
    fg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    inverse: false,
    strike: false,
  };

  const re = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let match;

  while ((match = re.exec(line)) !== null) {
    if (match.index > lastIndex) {
      runs.push({ text: line.slice(lastIndex, match.index), ...state });
    }
    const rawParams = match[1];
    const codes = rawParams ? rawParams.split(";").map((x) => Number.parseInt(x, 10) || 0) : [0];
    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i];
      if (code === 0) {
        state = { fg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false };
      } else if (code === 1) {
        state.bold = true;
      } else if (code === 2) {
        state.dim = true;
      } else if (code === 3) {
        state.italic = true;
      } else if (code === 4) {
        state.underline = true;
      } else if (code === 7) {
        state.inverse = true;
      } else if (code === 9) {
        state.strike = true;
      } else if (code === 22) {
        state.bold = false;
        state.dim = false;
      } else if (code === 23) {
        state.italic = false;
      } else if (code === 24) {
        state.underline = false;
      } else if (code === 27) {
        state.inverse = false;
      } else if (code === 29) {
        state.strike = false;
      } else if (code === 39) {
        state.fg = null;
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        state.fg = palette[code] || null;
      } else if (code === 38) {
        if (codes[i + 1] === 2 && i + 4 < codes.length) {
          const r = Math.max(0, Math.min(255, codes[i + 2]));
          const g = Math.max(0, Math.min(255, codes[i + 3]));
          const b = Math.max(0, Math.min(255, codes[i + 4]));
          state.fg = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
          i += 4;
        } else if (codes[i + 1] === 5 && i + 2 < codes.length) {
          state.fg = ansi256ToHex(codes[i + 2]);
          i += 2;
        }
      }
    }
    lastIndex = re.lastIndex;
  }

  if (lastIndex < line.length) {
    runs.push({ text: line.slice(lastIndex), ...state });
  }
  return runs;
}

function renderAnsiRowsToSvg(rows, {
  x,
  y,
  fontSize = 12.6,
  charWidth = 7.56,
  lineHeight = 19,
  defaultFg = "#d8e0f3",
  canvasBg = "#151926",
  lightMode = false,
}) {
  const palette = lightMode ? ANSI16_LIGHT : ANSI16_DARK;
  const bgRects = [];
  const textLines = [];

  rows.forEach((rawLine, rowIdx) => {
    const line = String(rawLine || "");
    if (!line) return;

    const runs = parseAnsiLineToRuns(line, palette);
    if (runs.length === 0) return;

    let colCursor = 0;
    const tspans = [];
    const baselineY = (y + rowIdx * lineHeight + fontSize * 1.05).toFixed(1);
    const rectY = (y + rowIdx * lineHeight - 2).toFixed(1);

    for (const run of runs) {
      if (!run.text) continue;
      const charCount = [...run.text].length;
      const fgColor = run.fg || defaultFg;

      if (run.inverse) {
        const rectX = (x + colCursor * charWidth - 1).toFixed(1);
        const rectW = (charCount * charWidth + 2).toFixed(1);
        bgRects.push(
          `<rect x="${rectX}" y="${rectY}" width="${rectW}" height="${(lineHeight - 1).toFixed(1)}" rx="3" fill="${fgColor}" />`,
        );
      }

      const attrs = [];
      attrs.push(`fill="${run.inverse ? canvasBg : fgColor}"`);
      if (run.bold) attrs.push('font-weight="700"');
      if (run.dim && !run.inverse) attrs.push('fill-opacity="0.58"');
      if (run.italic) attrs.push('font-style="italic"');
      if (run.underline && run.strike) attrs.push('text-decoration="underline line-through"');
      else if (run.underline) attrs.push('text-decoration="underline"');
      else if (run.strike) attrs.push('text-decoration="line-through"');

      tspans.push(`<tspan ${attrs.join(" ")}>${escapeXml(run.text)}</tspan>`);
      colCursor += charCount;
    }

    if (tspans.length > 0) {
      textLines.push(
        `<text x="${x.toFixed(1)}" y="${baselineY}" font-family="${MONO_FONT}" font-size="${fontSize}" xml:space="preserve">${tspans.join("")}</text>`,
      );
    }
  });

  return [...bgRects, ...textLines].join("\n  ");
}

function renderTerminalChrome({
  width,
  height,
  title,
  badgeText = "",
  bg = "#141824",
  barBg = "#191e2e",
  border = "#2a334d",
  titleColor = "#9aa5ce",
}) {
  return `
  <defs>
    <linearGradient id="term-chrome-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="${bg}" />
      <stop offset="100%" stop-color="#101420" />
    </linearGradient>
    <radialGradient id="term-glow-top" cx="18%" cy="0%" r="55%">
      <stop offset="0%" stop-color="#7aa2f7" stop-opacity="0.11" />
      <stop offset="100%" stop-color="#7aa2f7" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="term-glow-bot" cx="85%" cy="100%" r="50%">
      <stop offset="0%" stop-color="#7dcfff" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#7dcfff" stop-opacity="0" />
    </radialGradient>
  </defs>
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="14" fill="url(#term-chrome-bg)" stroke="${border}" stroke-width="1.2" />
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="14" fill="url(#term-glow-top)" />
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="14" fill="url(#term-glow-bot)" />
  <path d="M 8 22 Q 8 8 22 8 L ${width - 22} 8 Q ${width - 8} 8 ${width - 8} 22 L ${width - 8} 44 L 8 44 Z" fill="${barBg}" fill-opacity="0.88" />
  <line x1="8" y1="44" x2="${width - 8}" y2="44" stroke="${border}" stroke-width="1" />
  <circle cx="28" cy="26" r="5.5" fill="#f7768e" fill-opacity="0.9" />
  <circle cx="46" cy="26" r="5.5" fill="#e0af68" fill-opacity="0.9" />
  <circle cx="64" cy="26" r="5.5" fill="#9ece6a" fill-opacity="0.9" />
  <text x="${(width / 2).toFixed(1)}" y="30" text-anchor="middle" font-family="${SANS_FONT}" font-size="12" font-weight="600" fill="${titleColor}">${escapeXml(title)}</text>
  ${badgeText ? `<rect x="${width - 154}" y="16" width="132" height="20" rx="6" fill="#7aa2f7" fill-opacity="0.13" stroke="#7aa2f7" stroke-opacity="0.32" stroke-width="1" /><text x="${width - 88}" y="30" text-anchor="middle" font-family="${MONO_FONT}" font-size="10.5" font-weight="600" fill="#7dcfff">${escapeXml(badgeText)}</text>` : ""}`;
}

function generateHeroSvg() {
  const width = 920;
  const height = 272;

  const pills = [
    { label: "Zero Opaque Blocks", color: "#7dcfff" },
    { label: "Zero Dependencies", color: "#9ece6a" },
    { label: "SSH + tmux Native", color: "#7aa2f7" },
    { label: "Universal ACP", color: "#bb9af7" },
  ];

  let pillX = 188;
  const pillSvg = pills
    .map((p) => {
      const w = p.label.length * 7.6 + 26;
      const out = `
    <rect x="${pillX}" y="182" width="${w.toFixed(1)}" height="28" rx="14" fill="${p.color}" fill-opacity="0.10" stroke="${p.color}" stroke-opacity="0.34" stroke-width="1" />
    <circle cx="${(pillX + 14).toFixed(1)}" cy="196" r="3" fill="${p.color}" />
    <text x="${(pillX + 23).toFixed(1)}" y="200.2" font-family="${SANS_FONT}" font-size="12" font-weight="600" fill="#dce4f8">${escapeXml(p.label)}</text>`;
      pillX += w + 10;
      return out;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="lucid hero banner">
  <defs>
    <linearGradient id="hero-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0d121d" />
      <stop offset="55%" stop-color="#131b2c" />
      <stop offset="100%" stop-color="#171d32" />
    </linearGradient>
    <linearGradient id="hero-border" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#7dcfff" stop-opacity="0.45" />
      <stop offset="50%" stop-color="#7aa2f7" stop-opacity="0.32" />
      <stop offset="100%" stop-color="#bb9af7" stop-opacity="0.45" />
    </linearGradient>
    <radialGradient id="orb-cyan" cx="14%" cy="32%" r="44%">
      <stop offset="0%" stop-color="#7dcfff" stop-opacity="0.22" />
      <stop offset="100%" stop-color="#7dcfff" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="orb-violet" cx="86%" cy="74%" r="46%">
      <stop offset="0%" stop-color="#bb9af7" stop-opacity="0.18" />
      <stop offset="100%" stop-color="#bb9af7" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="gem-top" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#a4e4ff" />
      <stop offset="100%" stop-color="#7aa2f7" />
    </linearGradient>
    <linearGradient id="gem-bot" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#7aa2f7" />
      <stop offset="100%" stop-color="#bb9af7" />
    </linearGradient>
    <linearGradient id="wordmark-grad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#f4f8ff" />
      <stop offset="65%" stop-color="#dbeafe" />
      <stop offset="100%" stop-color="#a5f3fc" />
    </linearGradient>
  </defs>

  <rect x="6" y="6" width="${width - 12}" height="${height - 12}" rx="18" fill="url(#hero-bg)" stroke="url(#hero-border)" stroke-width="1.4" />
  <rect x="6" y="6" width="${width - 12}" height="${height - 12}" rx="18" fill="url(#orb-cyan)" />
  <rect x="6" y="6" width="${width - 12}" height="${height - 12}" rx="18" fill="url(#orb-violet)" />

  <!-- Subtle architectural grid lines -->
  <line x1="6" y1="68" x2="${width - 6}" y2="68" stroke="#7aa2f7" stroke-opacity="0.06" stroke-width="1" />
  <line x1="6" y1="226" x2="${width - 6}" y2="226" stroke="#7aa2f7" stroke-opacity="0.06" stroke-width="1" />
  <line x1="164" y1="6" x2="164" y2="${height - 6}" stroke="#7aa2f7" stroke-opacity="0.06" stroke-width="1" />

  <!-- Crystal diamond prism emblem -->
  <g transform="translate(54, 72)">
    <rect x="-10" y="-10" width="102" height="102" rx="22" fill="#7aa2f7" fill-opacity="0.08" stroke="#7dcfff" stroke-opacity="0.24" stroke-width="1.1" />
    <polygon points="41,6 74,41 41,41" fill="url(#gem-top)" fill-opacity="0.92" />
    <polygon points="41,6 8,41 41,41" fill="#7dcfff" fill-opacity="0.72" />
    <polygon points="41,76 74,41 41,41" fill="url(#gem-bot)" fill-opacity="0.86" />
    <polygon points="41,76 8,41 41,41" fill="#7aa2f7" fill-opacity="0.58" />
    <polygon points="41,17 61,41 41,65 21,41" fill="#ffffff" fill-opacity="0.16" stroke="#e0f2fe" stroke-opacity="0.55" stroke-width="1" />
  </g>

  <!-- Title & Tagline -->
  <text x="188" y="114" font-family="${SANS_FONT}" font-size="52" font-weight="800" letter-spacing="-1.2" fill="url(#wordmark-grad)">lucid</text>
  <rect x="318" y="84" width="66" height="24" rx="12" fill="#7dcfff" fill-opacity="0.12" stroke="#7dcfff" stroke-opacity="0.35" stroke-width="1" />
  <text x="351" y="100" text-anchor="middle" font-family="${MONO_FONT}" font-size="12" font-weight="700" fill="#7dcfff">v0.1.0</text>

  <text x="188" y="150" font-family="${SANS_FONT}" font-size="18.5" font-weight="500" fill="#b7c3e3">Transparent, flicker-free terminal UI for Antigravity &amp; ACP coding agents</text>
  ${pillSvg}

  <!-- Bottom subtle CLI snippet -->
  <text x="188" y="246" font-family="${MONO_FONT}" font-size="11.5" fill="#7c8bb5" xml:space="preserve">$ lucid --theme tokyo-night    # fresh session    |    $ lucid -r    # resume session</text>
</svg>
`;
}

function generatePreviewMainSvg() {
  const cols = 104;
  const style = createThemeStyler("tokyo-night", "truecolor");
  const composer = new Composer();
  composer.setText("Add graceful shutdown and verify /healthz");

  const state = {
    cwd: "/workspace/api-gateway",
    agentLabel: "Antigravity ACP Server 1.5.12",
    connected: true,
    connecting: false,
    sessionId: "sess-preview-01",
    modelLabel: "Gemini 4 Neon",
    effortLabel: "High",
    modeId: "auto",
    usage: { used: 18400, size: 1048576 },
    quotaText: "5h 94% · wk 98%",
    busy: false,
    spinnerFrame: 2,
    scrollOffset: 0,
    mouseCapture: true,
    showThoughts: false,
    expandTools: false,
    composer,
    stagedImages: [],
    multiAgent: new MultiAgentTracker(),
    toast: null,
    items: [
      {
        type: "user",
        text: "Wire graceful SIGTERM shutdown into @src/server.ts and add an idle timeout",
        attachedPaths: ["src/server.ts"],
      },
      {
        type: "thought",
        text: "Inspecting server.ts to ensure HTTP keep-alive sockets drain cleanly before process exit and health probes return 503 during shutdown.",
        streaming: false,
        durationMs: 1200,
      },
      {
        type: "tool",
        toolCallId: "t_edit_1",
        title: "Edit src/server.ts",
        kind: "edit",
        status: "completed",
        durationMs: 320,
        diffs: [
          {
            path: "/workspace/api-gateway/src/server.ts",
            oldText: "app.listen(port, () => console.log(\"ready\"));\n",
            newText: "const server = app.listen(port, () => console.log(\"ready\"));\nserver.keepAliveTimeout = 65_000;\n",
          },
        ],
      },
      {
        type: "assistant",
        streaming: false,
        text: [
          "### Graceful shutdown enabled",
          "",
          "Updated `src/server.ts` with a `65s` keep-alive timeout and clean `SIGTERM` draining:",
          "",
          "| Setting | Value | Purpose |",
          "| :--- | :--- | :--- |",
          "| `keepAliveTimeout` | `65_000 ms` | Prevent premature 502s behind ALB |",
          "| `SIGTERM` hook | `server.close()` | Drain in-flight requests cleanly |",
          "",
          "```ts",
          "process.on(\"SIGTERM\", () => server.close(() => process.exit(0)));",
          "```",
        ].join("\n"),
      },
    ],
  };

  const headerLines = renderHeader(state, cols, style);
  const timelineLines = renderTimeline(state, cols, style);
  const composerBlock = renderComposerBlock(state, cols, style);
  const allRows = [...headerLines, ...timelineLines, ...composerBlock.lines];

  const fontSize = 12.6;
  const charWidth = 7.56;
  const lineHeight = 19;
  const gridWidth = cols * charWidth; // ~786.2
  const innerX = (920 - gridWidth) / 2;
  const startY = 58;
  const width = 920;
  const height = Math.ceil(startY + allRows.length * lineHeight + 22);

  const terminalContent = renderAnsiRowsToSvg(allRows, {
    x: innerX,
    y: startY,
    fontSize,
    charWidth,
    lineHeight,
    defaultFg: "#d5ddf5",
    canvasBg: "#141824",
  });

  // Render subtle terminal block cursor inside composer prompt
  const cursorRow = headerLines.length + timelineLines.length + composerBlock.cursorOffsetRow;
  const cursorX = (innerX + composerBlock.cursorCol * charWidth).toFixed(1);
  const cursorY = (startY + cursorRow * lineHeight - 1).toFixed(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="lucid live terminal preview">
  ${renderTerminalChrome({
    width,
    height,
    title: "lucid — api-gateway (zsh · tmux)",
    badgeText: "tokyo-night · 24-bit",
  })}
  ${terminalContent}
  <rect x="${cursorX}" y="${cursorY}" width="7.2" height="16" rx="1.2" fill="#7dcfff" fill-opacity="0.72" />
</svg>
`;
}

function generateBeforeAfterSvg() {
  const width = 920;
  const height = 456;
  const cardBg = "#1c253b"; // Tinted slate-indigo terminal backdrop to expose opaque patches
  const leftX = 16;
  const rightX = 468;
  const cardW = 436;
  const cardY = 14;
  const cardH = 428;

  // Right side: real lucid output rendered with transparent bg on the exact same #1c253b canvas
  const style = createThemeStyler("tokyo-night", "truecolor");
  const subCols = 52;
  const diffRes = renderDiffLines({
    pathLabel: "server.ts",
    oldText: "const timeout = 5000;\n",
    newText: "const timeout = 65_000;\n",
    maxWidth: subCols - 4,
    style,
  });
  const mdLines = renderMarkdown(
    [
      "Updated `timeout` in `server.ts`:",
      "",
      "```ts",
      "server.keepAliveTimeout = 65_000;",
      "```",
    ].join("\n"),
    subCols - 4,
    style,
  );

  const lucidRows = [
    ` ${style.accentBold("◆ lucid")} ${style.border("·")} ${style.bold("api")} ${style.border("·")} ${style.accentAlt("Gemini 4")} ${style.border("·")} ${style.successBold("auto")}`,
    style.border("─".repeat(subCols)),
    "",
    ` ${style.accentBold("❯")} Raise keepAliveTimeout in @server.ts`,
    "",
    ` ${style.success("✓")} ${style.bold("Edit server.ts")} ${style.muted("[edit] · 0.2s")}`,
    ...diffRes.lines.map((l) => `   ${l}`),
    "",
    ...mdLines.map((l) => (l ? ` ${l}` : "")),
    "",
    style.border("─".repeat(subCols)),
    ` ${style.accentBold("❯")} ${style.muted("Message agent... (/help)")}`,
    style.border("─".repeat(subCols)),
  ];

  const lucidSvg = renderAnsiRowsToSvg(lucidRows, {
    x: rightX + 18,
    y: cardY + 58,
    fontSize: 11.8,
    charWidth: 7.08,
    lineHeight: 18,
    defaultFg: "#d8e0f5",
    canvasBg: cardBg,
  });

  // Left side: conventional TUI with clashing opaque background blocks stamped over #1c253b
  const lx = leftX + 18;
  const ly = cardY + 58;
  const lh = 18;
  const rowY = (idx) => (ly + idx * lh + 12.2).toFixed(1);
  const boxY = (idx) => (ly + idx * lh - 3).toFixed(1);

  const leftOverlay = `
  <!-- Clashing opaque header strip -->
  <rect x="${lx - 4}" y="${boxY(0)}" width="406" height="22" rx="4" fill="#0d0f17" />
  <text x="${lx + 4}" y="${rowY(0)}" font-family="${MONO_FONT}" font-size="11.8" font-weight="700" fill="#d0d7de" xml:space="preserve"> agy-tui  api  Gemini 4  auto</text>

  <!-- User bubble with dark opaque block -->
  <rect x="${lx - 4}" y="${boxY(2.8)}" width="406" height="24" rx="5" fill="#252936" />
  <text x="${lx + 4}" y="${rowY(3)}" font-family="${MONO_FONT}" font-size="11.8" fill="#e6edf3" xml:space="preserve">&gt; Raise keepAliveTimeout in @server.ts</text>

  <!-- Opaque diff block -->
  <rect x="${lx - 4}" y="${boxY(5)}" width="406" height="72" rx="5" fill="#11131a" />
  <rect x="${lx + 2}" y="${boxY(6.1)}" width="394" height="17" rx="2" fill="#3a1920" />
  <rect x="${lx + 2}" y="${boxY(7.2)}" width="394" height="17" rx="2" fill="#173322" />
  <text x="${lx + 6}" y="${rowY(5.2)}" font-family="${MONO_FONT}" font-size="11.8" font-weight="700" fill="#9ece6a" xml:space="preserve">Edit server.ts</text>
  <text x="${lx + 6}" y="${rowY(6.3)}" font-family="${MONO_FONT}" font-size="11.8" fill="#ffa198" xml:space="preserve">- const timeout = 5000;</text>
  <text x="${lx + 6}" y="${rowY(7.4)}" font-family="${MONO_FONT}" font-size="11.8" fill="#7ee787" xml:space="preserve">+ const timeout = 65_000;</text>

  <!-- Inline code with clashing gray pill boxes -->
  <rect x="${lx + 56}" y="${boxY(10.8)}" width="58" height="17" rx="3" fill="#2f3545" />
  <rect x="${lx + 142}" y="${boxY(10.8)}" width="74" height="17" rx="3" fill="#2f3545" />
  <text x="${lx}" y="${rowY(11)}" font-family="${MONO_FONT}" font-size="11.8" fill="#c9d1d9" xml:space="preserve">Updated  timeout  in  server.ts :</text>

  <!-- Opaque black code block -->
  <rect x="${lx - 4}" y="${boxY(12.8)}" width="406" height="46" rx="5" fill="#090b10" />
  <text x="${lx + 6}" y="${rowY(13)}" font-family="${MONO_FONT}" font-size="10.5" fill="#6e7681" xml:space="preserve">ts</text>
  <text x="${lx + 6}" y="${rowY(14.1)}" font-family="${MONO_FONT}" font-size="11.8" fill="#a5d6ff" xml:space="preserve">server.keepAliveTimeout = 65_000;</text>

  <!-- Opaque dark input box -->
  <rect x="${lx - 4}" y="${boxY(16.7)}" width="406" height="34" rx="6" fill="#0f1119" stroke="#30363d" stroke-width="1" />
  <text x="${lx + 6}" y="${rowY(17.2)}" font-family="${MONO_FONT}" font-size="11.8" fill="#6e7681" xml:space="preserve">&gt; Message agent...</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Before and after transparent background comparison">
  <!-- Left Card: Conventional TUI -->
  <rect x="${leftX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="12" fill="${cardBg}" stroke="#4b3b4e" stroke-width="1.3" />
  <path d="M ${leftX} ${cardY + 12} Q ${leftX} ${cardY} ${leftX + 12} ${cardY} L ${leftX + cardW - 12} ${cardY} Q ${leftX + cardW} ${cardY} ${leftX + cardW} ${cardY + 12} L ${leftX + cardW} ${cardY + 42} L ${leftX} ${cardY + 42} Z" fill="#161c2e" />
  <line x1="${leftX}" y1="${cardY + 42}" x2="${leftX + cardW}" y2="${cardY + 42}" stroke="#354060" stroke-width="1" />
  <rect x="${leftX + 16}" y="${cardY + 10}" width="188" height="22" rx="11" fill="#f7768e" fill-opacity="0.14" stroke="#f7768e" stroke-opacity="0.4" stroke-width="1" />
  <text x="${leftX + 110}" y="${cardY + 25}" text-anchor="middle" font-family="${SANS_FONT}" font-size="11.5" font-weight="700" fill="#ff9db0">✗  Conventional TUI</text>
  <text x="${leftX + cardW - 16}" y="${cardY + 25}" text-anchor="end" font-family="${SANS_FONT}" font-size="11" fill="#8b97ba">Opaque black/gray patches</text>
  ${leftOverlay}

  <!-- Right Card: lucid -->
  <rect x="${rightX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="12" fill="${cardBg}" stroke="#44628d" stroke-width="1.3" />
  <path d="M ${rightX} ${cardY + 12} Q ${rightX} ${cardY} ${rightX + 12} ${cardY} L ${rightX + cardW - 12} ${cardY} Q ${rightX + cardW} ${cardY} ${rightX + cardW} ${cardY + 12} L ${rightX + cardW} ${cardY + 42} L ${rightX} ${cardY + 42} Z" fill="#161c2e" />
  <line x1="${rightX}" y1="${cardY + 42}" x2="${rightX + cardW}" y2="${cardY + 42}" stroke="#354060" stroke-width="1" />
  <rect x="${rightX + 16}" y="${cardY + 10}" width="214" height="22" rx="11" fill="#9ece6a" fill-opacity="0.14" stroke="#9ece6a" stroke-opacity="0.4" stroke-width="1" />
  <text x="${rightX + 123}" y="${cardY + 25}" text-anchor="middle" font-family="${SANS_FONT}" font-size="11.5" font-weight="700" fill="#b9f27c">✓  lucid (Zero Opaque Bg)</text>
  <text x="${rightX + cardW - 16}" y="${cardY + 25}" text-anchor="end" font-family="${SANS_FONT}" font-size="11" fill="#8b97ba">Native terminal canvas</text>
  ${lucidSvg}
</svg>
`;
}

function buildThemeSampleRows(themeName, cols, style) {
  const diff = renderDiffLines({
    pathLabel: "auth.ts",
    oldText: "return token;\n",
    newText: "return verify(token);\n",
    maxWidth: cols - 2,
    style,
  });
  const md = renderMarkdown(
    [
      "Run `npm test` to verify:",
      "```js",
      "const ok = verify(token);",
      "```",
    ].join("\n"),
    cols - 2,
    style,
  );
  return [
    `${style.accentBold("◆ lucid")} ${style.border("·")} ${style.bold("app")} ${style.border("·")} ${style.accentAlt("Gemini 4")} ${style.border("·")} ${style.successBold("auto")}`,
    style.border("─".repeat(cols)),
    ...diff.lines,
    ...md,
  ];
}

function generateThemesSvg() {
  const width = 920;
  const height = 564;
  const themes = new Map(listThemes().map((t) => [t.name, t]));

  const cards = [
    {
      name: "tokyo-night",
      subtitle: "TrueColor dark canvas",
      x: 16,
      y: 14,
      w: 286,
      h: 260,
      cols: 37,
      bg: "#161a26",
      border: "#323b59",
      barBg: "#1b2030",
      fg: "#c0caf5",
      badgeBg: "#7aa2f7",
      lightMode: false,
    },
    {
      name: "catppuccin",
      subtitle: "Pastel Mocha accents",
      x: 317,
      y: 14,
      w: 286,
      h: 260,
      cols: 37,
      bg: "#1e1e2e",
      border: "#3d405b",
      barBg: "#242438",
      fg: "#cdd6f4",
      badgeBg: "#89b4fa",
      lightMode: false,
    },
    {
      name: "transparent",
      subtitle: "Adaptive ANSI-16 default",
      x: 618,
      y: 14,
      w: 286,
      h: 260,
      cols: 37,
      bg: "#18212e",
      border: "#2e4159",
      barBg: "#1c2737",
      fg: "#d8dee9",
      badgeBg: "#7dcfff",
      lightMode: false,
    },
    {
      name: "solarized",
      subtitle: "Works on Light & Dark terminals",
      x: 16,
      y: 290,
      w: 436,
      h: 260,
      cols: 57,
      bg: "#fdf6e3",
      border: "#d9d0b8",
      barBg: "#eee8d5",
      fg: "#586e75",
      badgeBg: "#268bd2",
      lightMode: true,
    },
    {
      name: "mono",
      subtitle: "Pure typography, zero color",
      x: 468,
      y: 290,
      w: 436,
      h: 260,
      cols: 57,
      bg: "#141414",
      border: "#363636",
      barBg: "#1c1c1c",
      fg: "#e5e5e5",
      badgeBg: "#a3a3a3",
      lightMode: false,
    },
  ];

  const renderedCards = cards
    .map((card) => {
      const themeObj = themes.get(card.name);
      const style = createThemeStyler(card.name, "truecolor");
      const rows = buildThemeSampleRows(card.name, card.cols, style).slice(0, 10);
      const textSvg = renderAnsiRowsToSvg(rows, {
        x: card.x + 14,
        y: card.y + 52,
        fontSize: 11.2,
        charWidth: 6.72,
        lineHeight: 19,
        defaultFg: card.fg,
        canvasBg: card.bg,
        lightMode: card.lightMode,
      });

      const titleColor = card.lightMode ? "#073642" : "#e2e8f0";
      const subColor = card.lightMode ? "#657b83" : "#8b97ba";

      return `
  <rect x="${card.x}" y="${card.y}" width="${card.w}" height="${card.h}" rx="12" fill="${card.bg}" stroke="${card.border}" stroke-width="1.2" />
  <path d="M ${card.x} ${card.y + 12} Q ${card.x} ${card.y} ${card.x + 12} ${card.y} L ${card.x + card.w - 12} ${card.y} Q ${card.x + card.w} ${card.y} ${card.x + card.w} ${card.y + 12} L ${card.x + card.w} ${card.y + 38} L ${card.x} ${card.y + 38} Z" fill="${card.barBg}" />
  <line x1="${card.x}" y1="${card.y + 38}" x2="${card.x + card.w}" y2="${card.y + 38}" stroke="${card.border}" stroke-width="1" />
  <text x="${card.x + 14}" y="${card.y + 24}" font-family="${MONO_FONT}" font-size="12" font-weight="700" fill="${titleColor}">${escapeXml(themeObj?.name || card.name)}</text>
  <text x="${card.x + card.w - 14}" y="${card.y + 23.5}" text-anchor="end" font-family="${SANS_FONT}" font-size="10.8" fill="${subColor}">${escapeXml(card.subtitle)}</text>
  ${textSvg}`;
    })
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Five transparent themes in lucid">
  ${renderedCards}
</svg>
`;
}

function generateSwarmBoardSvg() {
  const cols = 104;
  const boardHeight = 19;
  const style = createThemeStyler("tokyo-night", "truecolor");
  const tracker = new MultiAgentTracker();

  tracker.ingestToolUpdate({
    toolCallId: "sw-title",
    name: "swarm",
    status: "completed",
    rawInput: { action: "title", title: "Release Audit" },
  });
  tracker.ingestToolUpdate({
    toolCallId: "sw-1",
    name: "swarm",
    status: "completed",
    rawInput: {
      action: "add",
      name: "researcher",
      model: "Gemini 4",
      workspace: "inherit",
      brief: "Audit all ACP protocol handlers and capabilities in src/acp/.",
    },
    rawOutput: "researcher  waiting  Gemini 4",
  });
  tracker.ingestToolUpdate({
    toolCallId: "sw-2",
    name: "swarm",
    status: "completed",
    rawInput: {
      action: "add",
      name: "reviewer",
      model: "Gemini 4 Neon",
      workspace: "share",
      brief: "Verify zero opaque background SGR codes across all 5 themes.",
    },
    rawOutput: "reviewer  working  Gemini 4 Neon",
  });
  tracker.ingestToolUpdate({
    toolCallId: "sw-3",
    name: "swarm",
    status: "completed",
    rawInput: {
      action: "add",
      name: "verifier",
      model: "Gemini 4 Flash",
      workspace: "inherit",
      brief: "Run node --test suite and verify CLI flags.",
    },
    rawOutput: "verifier  waiting  Gemini 4 Flash",
  });
  tracker.ingestToolUpdate({
    toolCallId: "sub-1",
    name: "invoke_subagent",
    status: "completed",
    rawInput: {
      TypeName: "research",
      Role: "Docs Auditor",
      Prompt: "Check README keybindings against src/app.mjs.",
    },
    content: [{ type: "text", text: "All keybindings and slash commands verified." }],
  });
  tracker.ingestToolUpdate({
    toolCallId: "msg-1",
    name: "send_message",
    status: "completed",
    rawInput: {
      Recipient: "reviewer",
      Message: "render_preview passed across all 5 themes (0 opaque bg).",
    },
  });

  const headerLines = renderHeader(
    {
      cwd: "/workspace/lucid",
      modelLabel: "Gemini 4 Neon",
      effortLabel: "High",
      modeId: "auto",
      usage: { used: 31200, size: 1048576 },
      quotaText: "5h 93%",
    },
    cols,
    style,
  );

  const renderedBoard = renderSwarmBoardView(
    tracker,
    { selectedIdx: 0, tab: "board", scrollOffset: 0 },
    cols,
    boardHeight,
    style,
    3,
  );

  const allRows = [...headerLines, ...renderedBoard.rows];
  const fontSize = 12.6;
  const charWidth = 7.56;
  const lineHeight = 19;
  const innerX = (920 - cols * charWidth) / 2;
  const startY = 58;
  const width = 920;
  const height = Math.ceil(startY + allRows.length * lineHeight + 22);

  const contentSvg = renderAnsiRowsToSvg(allRows, {
    x: innerX,
    y: startY,
    fontSize,
    charWidth,
    lineHeight,
    defaultFg: "#d5ddf5",
    canvasBg: "#141824",
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="lucid Swarm and Subagent Board">
  ${renderTerminalChrome({
    width,
    height,
    title: "lucid — Swarm & Subagent Board (Ctrl+B)",
    badgeText: "multi-agent · live",
  })}
  ${contentSvg}
</svg>
`;
}

function validateSvg(filename, svg) {
  if (!svg.startsWith("<svg ") || !svg.trim().endsWith("</svg>")) {
    throw new Error(`${filename}: invalid SVG root wrapper`);
  }
  if (/<foreignObject/i.test(svg) || /<script/i.test(svg)) {
    throw new Error(`${filename}: disallowed <foreignObject> or <script> tag`);
  }
  if (/\bNaN\b|\bundefined\b/.test(svg)) {
    throw new Error(`${filename}: contains NaN or undefined`);
  }
}

function main() {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const outputs = [
    ["hero.svg", generateHeroSvg()],
    ["preview-main.svg", generatePreviewMainSvg()],
    ["before-after.svg", generateBeforeAfterSvg()],
    ["themes.svg", generateThemesSvg()],
    ["swarm-board.svg", generateSwarmBoardSvg()],
  ];

  for (const [name, content] of outputs) {
    validateSvg(name, content);
    const outPath = path.join(ASSETS_DIR, name);
    fs.writeFileSync(outPath, content, "utf8");
    const sizeKb = (Buffer.byteLength(content, "utf8") / 1024).toFixed(1);
    console.log(`Generated ${path.relative(ROOT_DIR, outPath)} (${sizeKb} KB)`);
  }
}

main();
