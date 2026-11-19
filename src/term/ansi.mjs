export const RESET = "\x1b[0m";

export function detectColorDepth(env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") {
    return "none";
  }
  if (env.FORCE_COLOR === "0") {
    return "none";
  }

  const colorTerm = (env.COLORTERM || "").toLowerCase();
  const term = (env.TERM || "").toLowerCase();

  if (colorTerm.includes("truecolor") || colorTerm.includes("24bit")) {
    return "truecolor";
  }
  if (
    term.includes("direct") ||
    term.includes("kitty") ||
    term.includes("ghostty") ||
    term.includes("wezterm") ||
    term.includes("alacritty")
  ) {
    return "truecolor";
  }
  if (term.includes("256color")) {
    return "ansi256";
  }
  if (term && term !== "dumb") {
    return "ansi16";
  }
  return "none";
}

function parseHexColor(hex) {
  const clean = hex.startsWith("#") ? hex.slice(1) : hex;
  if (clean.length !== 6) return null;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return [r, g, b];
}

function rgbToAnsi256(r, g, b) {
  // Grayscale ramp check
  if (Math.abs(r - g) < 8 && Math.abs(g - b) < 8) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const ri = Math.round((r / 255) * 5);
  const gi = Math.round((g / 255) * 5);
  const bi = Math.round((b / 255) * 5);
  return 16 + 36 * ri + 6 * gi + bi;
}

export function fgCode(colorSpec, depth) {
  if (!colorSpec || depth === "none") return "";

  // Explicit default foreground
  if (colorSpec === "default") return "\x1b[39m";

  // ANSI-16 color numbers (30-37, 90-97)
  if (typeof colorSpec === "number") {
    return `\x1b[${colorSpec}m`;
  }

  // Object with adaptive fallback: { hex, ansi16, ansi256 }
  if (typeof colorSpec === "object") {
    if (depth === "truecolor" && colorSpec.hex) {
      const rgb = parseHexColor(colorSpec.hex);
      if (rgb) return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    }
    if (depth === "ansi256") {
      if (typeof colorSpec.ansi256 === "number") {
        return `\x1b[38;5;${colorSpec.ansi256}m`;
      }
      if (colorSpec.hex) {
        const rgb = parseHexColor(colorSpec.hex);
        if (rgb) return `\x1b[38;5;${rgbToAnsi256(rgb[0], rgb[1], rgb[2])}m`;
      }
    }
    if (typeof colorSpec.ansi16 === "number") {
      return `\x1b[${colorSpec.ansi16}m`;
    }
    return "";
  }

  if (typeof colorSpec === "string" && colorSpec.startsWith("#")) {
    const rgb = parseHexColor(colorSpec);
    if (!rgb) return "";
    if (depth === "truecolor") {
      return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    }
    if (depth === "ansi256") {
      return `\x1b[38;5;${rgbToAnsi256(rgb[0], rgb[1], rgb[2])}m`;
    }
    return "";
  }

  return "";
}

export function paint(text, options = {}, depth = "truecolor") {
  if (text === "" || text === null || text === undefined) return "";
  const str = String(text);
  if (depth === "none") return str;

  const codes = [];
  if (options.bold) codes.push("\x1b[1m");
  if (options.dim) codes.push("\x1b[2m");
  if (options.italic) codes.push("\x1b[3m");
  if (options.underline) codes.push("\x1b[4m");
  if (options.inverse) codes.push("\x1b[7m");
  if (options.strike) codes.push("\x1b[9m");
  if (options.fg) {
    const fg = fgCode(options.fg, depth);
    if (fg) codes.push(fg);
  }
  if (codes.length === 0) return str;
  return `${codes.join("")}${str}${RESET}`;
}

export function osc8Link(label, url) {
  if (!url) return label;
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

/**
 * Copies UTF-8 text to the user's local system clipboard using OSC 52.
 * Works over Remote SSH and inside tmux (when tmux clipboard/passthrough is enabled).
 */
export function copyToClipboardOsc52(text, stream = process.stdout) {
  if (!stream || !stream.writable) return false;
  const encoded = Buffer.from(String(text ?? ""), "utf8").toString("base64");
  const osc52 = `\x1b]52;c;${encoded}\x07`;

  if (process.env.TMUX) {
    // Emit both standard OSC 52 (tmux natively handles set-clipboard) and DCS passthrough
    const passthrough = `\x1bPtmux;\x1b${osc52}\x1b\\`;
    stream.write(osc52 + passthrough);
  } else {
    stream.write(osc52);
  }
  return true;
}
