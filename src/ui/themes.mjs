import { paint } from "../term/ansi.mjs";

export const THEMES = {
  transparent: {
    name: "transparent",
    label: "Transparent (Adaptive 16-color)",
    description: "Native terminal background & 16-color palette — zero black patches on any theme",
    colors: {
      accent: { ansi16: 36 },
      accentAlt: { ansi16: 34 },
      border: { ansi16: 90 },
      muted: { ansi16: 90 },
      heading: { ansi16: 36 },
      inlineCode: { ansi16: 33 },
      success: { ansi16: 32 },
      warn: { ansi16: 33 },
      error: { ansi16: 31 },
      thought: { ansi16: 35 },
      keyword: { ansi16: 35 },
      string: { ansi16: 32 },
      number: { ansi16: 33 },
      comment: { ansi16: 90 },
      diffAdd: { ansi16: 32 },
      diffDel: { ansi16: 31 },
      diffHunk: { ansi16: 36 },
    },
  },
  "tokyo-night": {
    name: "tokyo-night",
    label: "Tokyo Night (Transparent)",
    description: "Soft Tokyo Night foreground accents over your terminal background",
    colors: {
      accent: { hex: "#7aa2f7", ansi16: 34 },
      accentAlt: { hex: "#7dcfff", ansi16: 36 },
      border: { hex: "#565f89", ansi16: 90 },
      muted: { hex: "#737aa2", ansi16: 90 },
      heading: { hex: "#7dcfff", ansi16: 36 },
      inlineCode: { hex: "#e0af68", ansi16: 33 },
      success: { hex: "#9ece6a", ansi16: 32 },
      warn: { hex: "#e0af68", ansi16: 33 },
      error: { hex: "#f7768e", ansi16: 31 },
      thought: { hex: "#bb9af7", ansi16: 35 },
      keyword: { hex: "#bb9af7", ansi16: 35 },
      string: { hex: "#9ece6a", ansi16: 32 },
      number: { hex: "#ff9e64", ansi16: 33 },
      comment: { hex: "#565f89", ansi16: 90 },
      diffAdd: { hex: "#9ece6a", ansi16: 32 },
      diffDel: { hex: "#f7768e", ansi16: 31 },
      diffHunk: { hex: "#7aa2f7", ansi16: 34 },
    },
  },
  catppuccin: {
    name: "catppuccin",
    label: "Catppuccin Mocha (Transparent)",
    description: "Pastel Catppuccin foreground accents over your terminal background",
    colors: {
      accent: { hex: "#89b4fa", ansi16: 34 },
      accentAlt: { hex: "#94e2d5", ansi16: 36 },
      border: { hex: "#6c7086", ansi16: 90 },
      muted: { hex: "#9399b2", ansi16: 90 },
      heading: { hex: "#89dceb", ansi16: 36 },
      inlineCode: { hex: "#f9e2af", ansi16: 33 },
      success: { hex: "#a6e3a1", ansi16: 32 },
      warn: { hex: "#fab387", ansi16: 33 },
      error: { hex: "#f38ba8", ansi16: 31 },
      thought: { hex: "#cba6f7", ansi16: 35 },
      keyword: { hex: "#cba6f7", ansi16: 35 },
      string: { hex: "#a6e3a1", ansi16: 32 },
      number: { hex: "#fab387", ansi16: 33 },
      comment: { hex: "#6c7086", ansi16: 90 },
      diffAdd: { hex: "#a6e3a1", ansi16: 32 },
      diffDel: { hex: "#f38ba8", ansi16: 31 },
      diffHunk: { hex: "#89b4fa", ansi16: 34 },
    },
  },
  solarized: {
    name: "solarized",
    label: "Solarized (Transparent)",
    description: "Balanced Solarized accents that work on both dark and light terminals",
    colors: {
      accent: { hex: "#268bd2", ansi16: 34 },
      accentAlt: { hex: "#2aa198", ansi16: 36 },
      border: { hex: "#657b83", ansi16: 90 },
      muted: { hex: "#839496", ansi16: 90 },
      heading: { hex: "#2aa198", ansi16: 36 },
      inlineCode: { hex: "#b58900", ansi16: 33 },
      success: { hex: "#859900", ansi16: 32 },
      warn: { hex: "#cb4b16", ansi16: 33 },
      error: { hex: "#dc322f", ansi16: 31 },
      thought: { hex: "#6c71c4", ansi16: 35 },
      keyword: { hex: "#6c71c4", ansi16: 35 },
      string: { hex: "#2aa198", ansi16: 32 },
      number: { hex: "#d33682", ansi16: 35 },
      comment: { hex: "#657b83", ansi16: 90 },
      diffAdd: { hex: "#859900", ansi16: 32 },
      diffDel: { hex: "#dc322f", ansi16: 31 },
      diffHunk: { hex: "#268bd2", ansi16: 34 },
    },
  },
  mono: {
    name: "mono",
    label: "Monochrome (Minimal)",
    description: "Pure typography using only bold, dim, and default terminal colors",
    colors: {
      accent: "default",
      accentAlt: "default",
      border: "default",
      muted: "default",
      heading: "default",
      inlineCode: "default",
      success: "default",
      warn: "default",
      error: "default",
      thought: "default",
      keyword: "default",
      string: "default",
      number: "default",
      comment: "default",
      diffAdd: "default",
      diffDel: "default",
      diffHunk: "default",
    },
  },
};

export function listThemes() {
  return Object.values(THEMES);
}

export function createThemeStyler(themeName, colorDepth = "truecolor") {
  const theme = THEMES[themeName] || THEMES.transparent;
  const c = theme.colors;
  const isMono = theme.name === "mono";

  return {
    name: theme.name,
    label: theme.label,
    depth: colorDepth,

    text: (s) => String(s ?? ""),
    bold: (s) => paint(s, { bold: true }, colorDepth),
    dim: (s) => paint(s, { dim: true }, colorDepth),
    italic: (s) => paint(s, { italic: true }, colorDepth),
    strike: (s) => paint(s, { strike: true, dim: true }, colorDepth),
    underline: (s) => paint(s, { underline: true }, colorDepth),

    border: (s) => paint(s, { fg: c.border, dim: true }, colorDepth),
    muted: (s) => paint(s, { fg: c.muted, dim: true }, colorDepth),
    accent: (s) => paint(s, { fg: c.accent, bold: isMono }, colorDepth),
    accentBold: (s) => paint(s, { fg: c.accent, bold: true }, colorDepth),
    accentAlt: (s) => paint(s, { fg: c.accentAlt }, colorDepth),

    heading: (s) => paint(s, { fg: c.heading, bold: true }, colorDepth),
    inlineCode: (s) =>
      paint(s, { fg: c.inlineCode, underline: isMono }, colorDepth),

    success: (s) => paint(s, { fg: c.success }, colorDepth),
    successBold: (s) => paint(s, { fg: c.success, bold: true }, colorDepth),
    warn: (s) => paint(s, { fg: c.warn }, colorDepth),
    warnBold: (s) => paint(s, { fg: c.warn, bold: true }, colorDepth),
    error: (s) => paint(s, { fg: c.error }, colorDepth),
    errorBold: (s) => paint(s, { fg: c.error, bold: true }, colorDepth),
    thought: (s) => paint(s, { fg: c.thought, dim: true, italic: true }, colorDepth),

    syntaxKeyword: (s) => paint(s, { fg: c.keyword, bold: isMono }, colorDepth),
    syntaxString: (s) => paint(s, { fg: c.string }, colorDepth),
    syntaxNumber: (s) => paint(s, { fg: c.number }, colorDepth),
    syntaxComment: (s) => paint(s, { fg: c.comment, dim: true, italic: true }, colorDepth),

    diffAdd: (s) => paint(s, { fg: c.diffAdd }, colorDepth),
    diffDel: (s) => paint(s, { fg: c.diffDel }, colorDepth),
    diffHunk: (s) => paint(s, { fg: c.diffHunk, dim: true }, colorDepth),

    selected: (s) => paint(s, { fg: c.accent, bold: true, inverse: true }, colorDepth),
    pill: (s, tone = "accent") => {
      const fg = c[tone] || c.accent;
      return paint(s, { fg, bold: true }, colorDepth);
    },
  };
}
