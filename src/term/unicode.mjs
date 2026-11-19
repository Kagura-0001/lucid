const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// Matches CSI, OSC (ST or BEL terminated), and simple 2-byte ESC sequences.
const ANSI_REGEX = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

// Fullwidth / East Asian Wide Unicode code point ranges (Unicode 15/16).
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x2fff],
  [0x3000, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x318e],
  [0x3190, 0x31e3],
  [0x31f0, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x4dbf],
  [0x4e00, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const ZERO_WIDTH_REGEX = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const EMOJI_PRESENTATION_REGEX = /\p{Extended_Pictographic}/u;

function isWideCodePoint(codePoint) {
  let low = 0;
  let high = WIDE_RANGES.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [start, end] = WIDE_RANGES[mid];
    if (codePoint < start) {
      high = mid - 1;
    } else if (codePoint > end) {
      low = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

export function stripAnsi(text) {
  if (!text) return "";
  return text.replace(ANSI_REGEX, "");
}

export function splitGraphemes(text) {
  if (!text) return [];
  const result = [];
  for (const item of graphemeSegmenter.segment(text)) {
    result.push(item.segment);
  }
  return result;
}

export function graphemeWidth(grapheme) {
  if (!grapheme) return 0;
  if (grapheme === "\t") return 4;

  const firstCode = grapheme.codePointAt(0);
  if (firstCode === undefined) return 0;

  // Control characters
  if (firstCode <= 0x1f || (firstCode >= 0x7f && firstCode <= 0x9f)) {
    return 0;
  }

  // ASCII fast path
  if (firstCode >= 0x20 && firstCode <= 0x7e && grapheme.length === 1) {
    return 1;
  }

  // Zero-width combining/format characters
  if (grapheme.length === 1 && ZERO_WIDTH_REGEX.test(grapheme)) {
    return 0;
  }

  // Variation selector-16 explicitly forces emoji presentation (width 2)
  if (grapheme.includes("\ufe0f")) {
    return 2;
  }
  // Variation selector-15 forces text presentation (width 1)
  if (grapheme.includes("\ufe0e")) {
    return 1;
  }

  if (isWideCodePoint(firstCode)) {
    return 2;
  }

  // Multi-codepoint ZWJ emoji sequences
  if (grapheme.includes("\u200d") && EMOJI_PRESENTATION_REGEX.test(grapheme)) {
    return 2;
  }

  return 1;
}

export function displayWidth(text) {
  if (!text) return 0;
  const plain = stripAnsi(text);
  let width = 0;
  for (const item of graphemeSegmenter.segment(plain)) {
    width += graphemeWidth(item.segment);
  }
  return width;
}

export function truncateAnsi(text, maxWidth, ellipsis = "") {
  if (!text || maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;

  const ellipsisWidth = ellipsis ? displayWidth(ellipsis) : 0;
  const targetWidth = Math.max(0, maxWidth - ellipsisWidth);

  let output = "";
  let visible = 0;
  let hasAnsi = false;
  let index = 0;

  while (index < text.length) {
    if (text[index] === "\x1b") {
      ANSI_REGEX.lastIndex = index;
      const match = ANSI_REGEX.exec(text);
      if (match && match.index === index) {
        output += match[0];
        hasAnsi = true;
        index += match[0].length;
        continue;
      }
    }

    const nextEsc = text.indexOf("\x1b", index);
    const chunk = nextEsc === -1 ? text.slice(index) : text.slice(index, nextEsc);
    index = nextEsc === -1 ? text.length : nextEsc;

    for (const seg of graphemeSegmenter.segment(chunk)) {
      const w = graphemeWidth(seg.segment);
      if (visible + w > targetWidth) {
        const suffix = ellipsis || "";
        return hasAnsi ? `${output}${suffix}\x1b[0m` : `${output}${suffix}`;
      }
      output += seg.segment;
      visible += w;
    }
  }

  return hasAnsi ? `${output}\x1b[0m` : output;
}

export function padEndVisible(text, targetWidth, fillChar = " ") {
  const current = displayWidth(text);
  if (current >= targetWidth) {
    return truncateAnsi(text, targetWidth);
  }
  return text + fillChar.repeat(targetWidth - current);
}

export function padStartVisible(text, targetWidth, fillChar = " ") {
  const current = displayWidth(text);
  if (current >= targetWidth) {
    return truncateAnsi(text, targetWidth);
  }
  return fillChar.repeat(targetWidth - current) + text;
}

/**
 * Wraps a single ANSI-styled line to at most `maxWidth` columns,
 * preserving active SGR styling across wrapped lines and breaking cleanly
 * on spaces when possible (and per-grapheme for long words / CJK).
 */
export function wrapAnsiLine(line, maxWidth) {
  const widthLimit = Math.max(4, maxWidth);
  if (!line) return [""];
  if (displayWidth(line) <= widthLimit) return [line];

  // Tokenize into ANSI sequences and plain graphemes
  const tokens = [];
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\x1b") {
      ANSI_REGEX.lastIndex = index;
      const match = ANSI_REGEX.exec(line);
      if (match && match.index === index) {
        tokens.push({ ansi: match[0] });
        index += match[0].length;
        continue;
      }
    }
    const nextEsc = line.indexOf("\x1b", index);
    const chunk = nextEsc === -1 ? line.slice(index) : line.slice(index, nextEsc);
    index = nextEsc === -1 ? line.length : nextEsc;
    for (const seg of graphemeSegmenter.segment(chunk)) {
      tokens.push({
        text: seg.segment,
        width: graphemeWidth(seg.segment),
      });
    }
  }

  const lines = [];
  let activeSgr = "";
  let currentParts = [];
  let currentWidth = 0;

  function updateActiveSgr(code) {
    // Only track SGR sequences (\x1b[...m)
    if (!code.startsWith("\x1b[") || !code.endsWith("m")) {
      return;
    }
    if (code === "\x1b[0m" || code === "\x1b[m") {
      activeSgr = "";
    } else {
      activeSgr += code;
    }
  }

  function flushLine() {
    let rendered = currentParts.join("");
    if (activeSgr) {
      rendered += "\x1b[0m";
    }
    lines.push(rendered);
    currentParts = activeSgr ? [activeSgr] : [];
    currentWidth = 0;
  }

  // Group contiguous non-space ASCII word characters to prefer wrapping at word boundaries
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.ansi) {
      updateActiveSgr(token.ansi);
      currentParts.push(token.ansi);
      i += 1;
      continue;
    }

    // Collect an ASCII word run (letters/digits/punctuation without whitespace)
    const isAsciiWordChar = (ch) => /^[\x21-\x7e]$/.test(ch);
    if (isAsciiWordChar(token.text)) {
      let j = i;
      let wordWidth = 0;
      while (j < tokens.length && tokens[j].text && isAsciiWordChar(tokens[j].text)) {
        wordWidth += tokens[j].width;
        j += 1;
      }

      if (currentWidth > 0 && currentWidth + wordWidth > widthLimit && wordWidth <= widthLimit) {
        flushLine();
      }

      for (let k = i; k < j; k += 1) {
        const t = tokens[k];
        if (currentWidth + t.width > widthLimit && currentWidth > 0) {
          flushLine();
        }
        currentParts.push(t.text);
        currentWidth += t.width;
      }
      i = j;
      continue;
    }

    // Skip leading spaces immediately after a soft wrap
    if (token.text === " " && currentWidth === 0 && lines.length > 0) {
      i += 1;
      continue;
    }

    if (currentWidth + token.width > widthLimit && currentWidth > 0) {
      flushLine();
      if (token.text === " ") {
        i += 1;
        continue;
      }
    }

    currentParts.push(token.text);
    currentWidth += token.width;
    i += 1;
  }

  if (currentParts.length > 0 || lines.length === 0) {
    let rendered = currentParts.join("");
    if (activeSgr) {
      rendered += "\x1b[0m";
    }
    lines.push(rendered);
  }

  return lines;
}

export function wrapAnsiText(text, maxWidth) {
  const rawLines = String(text ?? "").split("\n");
  const out = [];
  for (const rawLine of rawLines) {
    const wrapped = wrapAnsiLine(rawLine, maxWidth);
    for (const w of wrapped) {
      out.push(w);
    }
  }
  return out;
}
