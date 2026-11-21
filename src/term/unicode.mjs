const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]*$/;

// Matches CSI (any parameter bytes 0x30-0x3F, e.g. "38:2:..." or ">1"), OSC
// (ST or BEL terminated), and simple 2-byte ESC sequences.
const ANSI_SOURCE = "\\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)|[@-Z\\\\-_])";
const ANSI_REGEX = new RegExp(ANSI_SOURCE, "g");
// Sticky variant: only matches exactly at lastIndex, never scans forward.
const ANSI_AT_INDEX_REGEX = new RegExp(ANSI_SOURCE, "y");

const SGR_SEQUENCE_RE = /^\x1b\[[0-9;:]*m$/;
const OSC8_PREFIX = "\x1b]8;";
// C0 controls (incl. ESC, TAB, LF, CR), DEL and C1 controls.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f-\x9f]/;
const CONTROL_CHAR_GLOBAL_RE = /[\x00-\x1f\x7f-\x9f]/g;
const LINE_BREAK_MARKER = " ⏎ ";
const TAB_REPLACEMENT = "    ";

// Intl.Segmenter iteration is quadratic on long strings in Node 20
// (30k chars ≈ 280 ms). Long non-ASCII runs are therefore segmented in
// bounded pieces, cut only where a new grapheme is guaranteed to start.
const SEGMENT_PIECE_LENGTH = 256;
const SEGMENT_PIECE_SEARCH_LIMIT = SEGMENT_PIECE_LENGTH * 16;

/**
 * Returns the ANSI escape sequence starting exactly at `index`, or null.
 */
function matchAnsiAt(text, index) {
  ANSI_AT_INDEX_REGEX.lastIndex = index;
  const match = ANSI_AT_INDEX_REGEX.exec(text);
  return match ? match[0] : null;
}

function isPrintableAsciiCode(code) {
  return code >= 0x20 && code <= 0x7e;
}

/**
 * Code points that never join the preceding grapheme cluster: CJK ideographs,
 * CJK symbols/punctuation (minus the combining tone marks) and fullwidth forms.
 */
function isSafeGraphemeStart(code) {
  if (code >= 0x4e00 && code <= 0x9fff) return true;
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  if (code >= 0x3000 && code <= 0x303f) {
    const isCombiningToneMark = code >= 0x302a && code <= 0x302f;
    return !isCombiningToneMark;
  }
  if (code >= 0xff01 && code <= 0xff60) return true;
  return false;
}

function pushSegmentedGraphemes(text, out) {
  for (const item of graphemeSegmenter.segment(text)) {
    out.push(item.segment);
  }
}

/**
 * Segments a run without printable ASCII, splitting long runs into pieces so the
 * segmenter only ever sees short strings.
 */
function pushComplexRunGraphemes(run, out) {
  let pieceStart = 0;
  while (pieceStart < run.length) {
    let pieceEnd = run.length;
    if (run.length - pieceStart > SEGMENT_PIECE_LENGTH) {
      pieceEnd = run.length;
      const searchEnd = Math.min(run.length, pieceStart + SEGMENT_PIECE_SEARCH_LIMIT);
      for (let pos = pieceStart + SEGMENT_PIECE_LENGTH; pos < searchEnd; pos += 1) {
        if (isSafeGraphemeStart(run.charCodeAt(pos))) {
          pieceEnd = pos;
          break;
        }
      }
    }
    pushSegmentedGraphemes(run.slice(pieceStart, pieceEnd), out);
    pieceStart = pieceEnd;
  }
}

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

/**
 * Splits text into grapheme clusters in linear time.
 *
 * Printable ASCII characters always start a new grapheme, so ASCII runs are split
 * per character and only the remaining runs go through Intl.Segmenter. The last
 * ASCII character before a non-ASCII run is handed to the segmenter together with
 * that run, because it may carry combining marks (e.g. "e\u0301").
 */
export function splitGraphemes(text) {
  if (!text) return [];
  if (PRINTABLE_ASCII_RE.test(text)) return text.split("");

  const result = [];
  const length = text.length;
  let index = 0;
  while (index < length) {
    let asciiEnd = index;
    while (asciiEnd < length && isPrintableAsciiCode(text.charCodeAt(asciiEnd))) {
      asciiEnd += 1;
    }

    let complexStart = asciiEnd;
    const asciiRunIsFollowedByComplex = asciiEnd < length && asciiEnd > index;
    if (asciiRunIsFollowedByComplex) {
      complexStart = asciiEnd - 1;
    }
    for (let k = index; k < complexStart; k += 1) {
      result.push(text[k]);
    }

    let complexEnd = asciiEnd;
    while (complexEnd < length && !isPrintableAsciiCode(text.charCodeAt(complexEnd))) {
      complexEnd += 1;
    }
    if (complexEnd > complexStart) {
      pushComplexRunGraphemes(text.slice(complexStart, complexEnd), result);
    }
    index = complexEnd;
  }
  return result;
}

/**
 * Makes a single screen row safe to write to the terminal.
 *
 * Only SGR styling and OSC 8 hyperlinks are kept; every other escape sequence
 * (cursor movement, erase, title, …) is dropped. Line breaks are shown as "⏎",
 * tabs become four spaces, and remaining control characters are removed, so the
 * terminal cursor can never leave the row it was positioned on.
 */
export function sanitizeTerminalRow(text) {
  if (!text) return "";
  if (!CONTROL_CHAR_RE.test(text)) return text;

  let output = "";
  let plainStart = 0;
  CONTROL_CHAR_GLOBAL_RE.lastIndex = 0;
  let match = CONTROL_CHAR_GLOBAL_RE.exec(text);
  while (match) {
    const index = match.index;
    output += text.slice(plainStart, index);
    const ch = text[index];
    let consumed = 1;

    if (ch === "\x1b") {
      const sequence = matchAnsiAt(text, index);
      if (sequence) {
        const keepSequence = SGR_SEQUENCE_RE.test(sequence) || sequence.startsWith(OSC8_PREFIX);
        if (keepSequence) {
          output += sequence;
        }
        consumed = sequence.length;
      }
    } else if (ch === "\t") {
      output += TAB_REPLACEMENT;
    } else if (ch === "\r" || ch === "\n") {
      const isCrLf = ch === "\r" && text[index + 1] === "\n";
      if (isCrLf) {
        consumed = 2;
      }
      output += LINE_BREAK_MARKER;
    }

    plainStart = index + consumed;
    CONTROL_CHAR_GLOBAL_RE.lastIndex = plainStart;
    match = CONTROL_CHAR_GLOBAL_RE.exec(text);
  }
  output += text.slice(plainStart);
  return output;
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
  if (!text.includes("\x1b") && PRINTABLE_ASCII_RE.test(text)) {
    return text.length;
  }
  const plain = text.includes("\x1b") ? stripAnsi(text) : text;
  if (PRINTABLE_ASCII_RE.test(plain)) {
    return plain.length;
  }
  let width = 0;
  for (const grapheme of splitGraphemes(plain)) {
    width += graphemeWidth(grapheme);
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
      const sequence = matchAnsiAt(text, index);
      if (sequence) {
        output += sequence;
        hasAnsi = true;
        index += sequence.length;
        continue;
      }
    }

    const nextEsc = text.indexOf("\x1b", index + 1);
    const chunk = nextEsc === -1 ? text.slice(index) : text.slice(index, nextEsc);
    index = nextEsc === -1 ? text.length : nextEsc;

    for (const grapheme of splitGraphemes(chunk)) {
      const w = graphemeWidth(grapheme);
      if (visible + w > targetWidth) {
        const suffix = ellipsis || "";
        return hasAnsi ? `${output}${suffix}\x1b[0m` : `${output}${suffix}`;
      }
      output += grapheme;
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

const ASCII_WORD_CHAR_RE = /^[\x21-\x7e]$/;

function isAsciiWordChar(ch) {
  return ASCII_WORD_CHAR_RE.test(ch);
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
      const sequence = matchAnsiAt(line, index);
      if (sequence) {
        tokens.push({ ansi: sequence });
        index += sequence.length;
        continue;
      }
    }
    const nextEsc = line.indexOf("\x1b", index + 1);
    const chunk = nextEsc === -1 ? line.slice(index) : line.slice(index, nextEsc);
    index = nextEsc === -1 ? line.length : nextEsc;
    for (const grapheme of splitGraphemes(chunk)) {
      tokens.push({
        text: grapheme,
        width: graphemeWidth(grapheme),
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

/**
 * Returns the plain text shown in screen columns [fromCol, toCol) of a styled row.
 * A wide grapheme is included when its first column falls inside the range.
 */
export function sliceVisibleColumns(text, fromCol, toCol) {
  if (!text || toCol <= fromCol) return "";
  if (!text.includes("\x1b") && PRINTABLE_ASCII_RE.test(text)) {
    const start = Math.max(0, fromCol);
    const end = Math.min(text.length, toCol);
    return start < end ? text.slice(start, end) : "";
  }
  const plain = stripAnsi(sanitizeTerminalRow(text));
  if (PRINTABLE_ASCII_RE.test(plain)) {
    const start = Math.max(0, fromCol);
    const end = Math.min(plain.length, toCol);
    return start < end ? plain.slice(start, end) : "";
  }
  let column = 0;
  let output = "";
  for (const grapheme of splitGraphemes(plain)) {
    if (column >= toCol) break;
    if (column >= fromCol) {
      output += grapheme;
    }
    column += graphemeWidth(grapheme);
  }
  return output;
}

const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";

/**
 * Highlights screen columns [fromCol, toCol) of a styled row with reverse video
 * while keeping the row's own colors. Inverse is re-applied after every SGR
 * sequence inside the range because a reset ("\x1b[0m") would cancel it.
 */
export function highlightVisibleColumns(text, fromCol, toCol) {
  const row = sanitizeTerminalRow(text || "");
  if (toCol <= fromCol) return row;

  // Fast path for plain printable ASCII rows (no ANSI escapes, 1 col per char).
  if (!row.includes("\x1b") && PRINTABLE_ASCII_RE.test(row)) {
    const start = Math.max(0, fromCol);
    const end = Math.min(row.length, toCol);
    if (start > row.length) return row;
    const before = row.slice(0, start);
    const selected = row.slice(start, end);
    const after = row.slice(end);
    const tailPad = row.length < toCol && row.length >= fromCol ? " " : "";
    if (!selected && !tailPad) return row;
    return `${before}${INVERSE_ON}${selected}${tailPad}${INVERSE_OFF}${after}`;
  }

  let output = "";
  let column = 0;
  let inverseActive = false;
  let index = 0;

  while (index < row.length) {
    if (row[index] === "\x1b") {
      const sequence = matchAnsiAt(row, index);
      if (sequence) {
        output += sequence;
        index += sequence.length;
        const isSgr = SGR_SEQUENCE_RE.test(sequence);
        if (inverseActive && isSgr) {
          output += INVERSE_ON;
        }
        continue;
      }
    }

    const nextEsc = row.indexOf("\x1b", index + 1);
    const chunk = nextEsc === -1 ? row.slice(index) : row.slice(index, nextEsc);
    index = nextEsc === -1 ? row.length : nextEsc;

    for (const grapheme of splitGraphemes(chunk)) {
      const insideRange = column >= fromCol && column < toCol;
      if (insideRange && !inverseActive) {
        output += INVERSE_ON;
        inverseActive = true;
      } else if (!insideRange && inverseActive) {
        output += INVERSE_OFF;
        inverseActive = false;
      }
      output += grapheme;
      column += graphemeWidth(grapheme);
    }
  }

  // Selection extends past the end of the text (whole-line or empty-line selection):
  // show one highlighted cell so the selected line stays visible.
  const selectionReachesPastText = column < toCol && column >= fromCol;
  if (selectionReachesPastText) {
    if (!inverseActive) {
      output += INVERSE_ON;
      inverseActive = true;
    }
    output += " ";
  }
  if (inverseActive) {
    output += INVERSE_OFF;
  }
  return output;
}
