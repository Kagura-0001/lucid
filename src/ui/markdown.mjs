import { osc8Link } from "../term/ansi.mjs";
import { displayWidth, padEndVisible, wrapAnsiLine, wrapAnsiText } from "../term/unicode.mjs";
import { renderLatexMath } from "./math.mjs";

const KEYWORD_SETS = {
  js: new Set([
    "async", "await", "break", "case", "catch", "class", "const", "continue", "default",
    "delete", "do", "else", "export", "extends", "false", "finally", "for", "from",
    "function", "if", "import", "in", "instanceof", "let", "new", "null", "of", "return",
    "static", "super", "switch", "this", "throw", "true", "try", "typeof", "undefined",
    "var", "void", "while", "yield", "interface", "type", "enum", "implements", "readonly",
  ]),
  py: new Set([
    "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
    "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
    "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
    "return", "try", "while", "with", "yield", "match", "case",
  ]),
  sh: new Set([
    "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until",
    "case", "esac", "function", "export", "local", "return", "exit", "set", "unset",
    "true", "false", "sudo", "cd", "echo", "grep", "awk", "sed", "tmux",
  ]),
  rust: new Set([
    "as", "async", "await", "break", "const", "continue", "crate", "else", "enum",
    "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod",
    "move", "mut", "pub", "ref", "return", "self", "Self", "static", "struct", "super",
    "trait", "true", "type", "unsafe", "use", "where", "while",
  ]),
  go: new Set([
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
    "for", "func", "go", "goto", "if", "import", "interface", "map", "package", "range",
    "return", "select", "struct", "switch", "type", "var", "true", "false", "nil",
  ]),
  c: new Set([
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double",
    "else", "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long",
    "namespace", "nullptr", "public", "private", "protected", "return", "short", "signed",
    "sizeof", "static", "struct", "switch", "template", "typedef", "typename", "union",
    "unsigned", "using", "virtual", "void", "volatile", "while", "true", "false", "class",
  ]),
  sql: new Set([
    "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP",
    "BY", "ORDER", "LIMIT", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE",
    "TABLE", "DROP", "ALTER", "AS", "AND", "OR", "NOT", "NULL", "IN", "IS", "DISTINCT",
    "select", "from", "where", "join", "left", "right", "on", "group", "by", "order", "limit",
  ]),
};

function normalizeLang(lang) {
  const l = (lang || "").trim().toLowerCase();
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx", "javascript", "typescript"].includes(l)) return "js";
  if (["py", "python", "python3"].includes(l)) return "py";
  if (["sh", "bash", "zsh", "shell", "tmux"].includes(l)) return "sh";
  if (["rs", "rust"].includes(l)) return "rust";
  if (["go", "golang"].includes(l)) return "go";
  if (["c", "cc", "cpp", "cxx", "h", "hpp", "cuda", "cu"].includes(l)) return "c";
  if (["sql", "sqlite", "postgres"].includes(l)) return "sql";
  if (["json", "jsonc"].includes(l)) return "json";
  if (["diff", "patch"].includes(l)) return "diff";
  if (["yaml", "yml", "toml"].includes(l)) return "yaml";
  return "";
}

function highlightCodeLine(line, lang, style) {
  const family = normalizeLang(lang);
  if (!family) return style.text(line);

  if (family === "diff") {
    if (line.startsWith("+") && !line.startsWith("+++")) return style.diffAdd(line);
    if (line.startsWith("-") && !line.startsWith("---")) return style.diffDel(line);
    if (line.startsWith("@@")) return style.diffHunk(line);
    return style.muted(line);
  }

  const hashComment = family === "py" || family === "sh" || family === "yaml";
  const slashComment = family === "js" || family === "rust" || family === "go" || family === "c" || family === "json";
  const keywords = KEYWORD_SETS[family] || null;

  let out = "";
  let i = 0;
  const len = line.length;

  while (i < len) {
    const ch = line[i];

    // Comments
    if (hashComment && ch === "#") {
      out += style.syntaxComment(line.slice(i));
      break;
    }
    if (slashComment && ch === "/" && line[i + 1] === "/") {
      out += style.syntaxComment(line.slice(i));
      break;
    }

    // Strings
    if (ch === '"' || ch === "'" || (family === "js" && ch === "`")) {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      const token = line.slice(i, j);
      // JSON property keys vs string values
      if (family === "json" && /^\s*:/.test(line.slice(j))) {
        out += style.accentAlt(token);
      } else {
        out += style.syntaxString(token);
      }
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]))) {
      const numMatch = /^(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(line.slice(i));
      if (numMatch) {
        out += style.syntaxNumber(numMatch[0]);
        i += numMatch[0].length;
        continue;
      }
    }

    // Identifiers / keywords
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[A-Za-z0-9_]/.test(line[j])) {
        j += 1;
      }
      const word = line.slice(i, j);
      if (family === "json" && (word === "true" || word === "false" || word === "null")) {
        out += style.syntaxKeyword(word);
      } else if (family === "yaml" && /^\s*:/.test(line.slice(j))) {
        out += style.accentAlt(word);
      } else if (keywords && keywords.has(word)) {
        out += style.syntaxKeyword(word);
      } else {
        out += word;
      }
      i = j;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

const HTML_BR_AT_INDEX_RE = /<br\s*\/?>/iy;

/**
 * Splits a line on HTML <br> tags, leaving tags inside `code spans` untouched
 * (e.g. "cells with `<br>` now split" stays one line).
 */
function splitOnHtmlBreaks(line) {
  if (!/<br/i.test(line)) return [line];
  const parts = [];
  let current = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      let ticks = 1;
      while (line[index + ticks] === "`") ticks += 1;
      const delimiter = "`".repeat(ticks);
      const closeIndex = line.indexOf(delimiter, index + ticks);
      if (closeIndex !== -1) {
        current += line.slice(index, closeIndex + ticks);
        index = closeIndex + ticks;
        continue;
      }
    }
    HTML_BR_AT_INDEX_RE.lastIndex = index;
    const brMatch = HTML_BR_AT_INDEX_RE.exec(line);
    if (brMatch) {
      parts.push(current);
      current = "";
      index += brMatch[0].length;
      continue;
    }
    current += line[index];
    index += 1;
  }
  parts.push(current);
  return parts;
}

function findClosingInlineMathDollar(text, contentStart) {
  const len = text.length;
  for (let pos = contentStart; pos < len; pos += 1) {
    if (text[pos] === "\\" && pos + 1 < len) {
      pos += 1;
      continue;
    }
    if (text[pos] === "$") {
      // Closing $ must not be preceded by whitespace, must not be followed by a digit
      // (protects currency like "$5 and $10"), and must not be part of "$$".
      if (pos === contentStart) return -1;
      if (/\s/.test(text[pos - 1])) continue;
      if (pos + 1 < len && /[0-9$]/.test(text[pos + 1])) continue;
      return pos;
    }
  }
  return -1;
}

/**
 * Formats inline Markdown (code spans, math, links, bold, italic, strike) without
 * painting any opaque background colors.
 */
export function renderInlineMarkdown(text, style) {
  if (!text) return "";
  let out = "";
  let i = 0;
  const len = text.length;

  while (i < len) {
    // LaTeX inline \( ... \) and display \[ ... \]
    if (text[i] === "\\" && i + 1 < len && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const closeDelim = text[i + 1] === "(" ? "\\)" : "\\]";
      const closeIdx = text.indexOf(closeDelim, i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        const rendered = renderLatexMath(text.slice(i + 2, closeIdx));
        if (rendered) {
          out += style.accentAlt(rendered);
        }
        i = closeIdx + 2;
        continue;
      }
    }

    // Escaped markdown/math punctuation
    if (text[i] === "\\" && i + 1 < len && /[\\`*_{}[\]()#+\-.!~|$]/.test(text[i + 1])) {
      out += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code: `code` (transparent background, crisp accent foreground)
    if (text[i] === "`") {
      let ticks = 1;
      while (text[i + ticks] === "`") ticks += 1;
      const delim = "`".repeat(ticks);
      const closeIdx = text.indexOf(delim, i + ticks);
      if (closeIdx !== -1) {
        const inner = text.slice(i + ticks, closeIdx);
        out += style.inlineCode(inner);
        i = closeIdx + ticks;
        continue;
      }
    }

    // Inline display math: $$expr$$
    if (text[i] === "$" && text[i + 1] === "$") {
      const closeIdx = text.indexOf("$$", i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        const rendered = renderLatexMath(text.slice(i + 2, closeIdx));
        if (rendered) {
          out += style.accentAlt(rendered);
        }
        i = closeIdx + 2;
        continue;
      }
    }

    // Inline math: $expr$ (opening $ cannot be followed by whitespace or preceded by digit/backslash)
    if (text[i] === "$" && i + 1 < len && !/\s/.test(text[i + 1]) && text[i + 1] !== "$") {
      const closeIdx = findClosingInlineMathDollar(text, i + 1);
      if (closeIdx !== -1) {
        const inner = text.slice(i + 1, closeIdx);
        // Avoid treating plain shell vars or currency like "$100" without math structure
        const looksLikeCurrency = /^\d[\d,.\s]*$/.test(inner.trim());
        if (!looksLikeCurrency) {
          const rendered = renderLatexMath(inner);
          if (rendered) {
            out += style.accentAlt(rendered);
          }
          i = closeIdx + 1;
          continue;
        }
      }
    }

    // Markdown link: [label](url)
    if (text[i] === "[") {
      const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (linkMatch) {
        const label = renderInlineMarkdown(linkMatch[1], style);
        const url = linkMatch[2];
        out += osc8Link(style.accent(style.underline(label)), url);
        i += linkMatch[0].length;
        continue;
      }
    }

    // Bold: **text** or __text__
    if ((text[i] === "*" && text[i + 1] === "*") || (text[i] === "_" && text[i + 1] === "_")) {
      const delim = text.slice(i, i + 2);
      const closeIdx = text.indexOf(delim, i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        out += style.bold(renderInlineMarkdown(text.slice(i + 2, closeIdx), style));
        i = closeIdx + 2;
        continue;
      }
    }

    // Strikethrough: ~~text~~
    if (text[i] === "~" && text[i + 1] === "~") {
      const closeIdx = text.indexOf("~~", i + 2);
      if (closeIdx !== -1 && closeIdx > i + 2) {
        out += style.strike(text.slice(i + 2, closeIdx));
        i = closeIdx + 2;
        continue;
      }
    }

    // Italic: *text* (only when not preceded/followed by whitespace awkwardly)
    if (text[i] === "*" && text[i + 1] !== "*" && text[i + 1] !== " ") {
      const closeIdx = text.indexOf("*", i + 1);
      if (closeIdx !== -1 && closeIdx > i + 1 && text[closeIdx - 1] !== " ") {
        out += style.italic(renderInlineMarkdown(text.slice(i + 1, closeIdx), style));
        i = closeIdx + 1;
        continue;
      }
    }

    out += text[i];
    i += 1;
  }

  return out;
}

function isTableSeparatorLine(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  const cells = splitTableRow(trimmed);
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()));
}

function splitTableRow(line) {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

function renderTableBlock(rawLines, maxWidth, style) {
  const headerCells = splitTableRow(rawLines[0]);
  const bodyRows = rawLines.slice(2).map(splitTableRow);
  const colCount = Math.max(
    headerCells.length,
    ...bodyRows.map((r) => r.length),
  );
  if (colCount === 0) return [];

  const splitCellLines = (rawCell, isHeader) =>
    splitOnHtmlBreaks(String(rawCell || ""))
      .map((part) => {
        const formatted = renderInlineMarkdown(part.trim(), style);
        return isHeader ? style.bold(formatted) : formatted;
      });

  const styledHeader = Array.from({ length: colCount }, (_, idx) =>
    splitCellLines(headerCells[idx] || "", true),
  );
  const styledRows = bodyRows.map((row) =>
    Array.from({ length: colCount }, (_, idx) =>
      splitCellLines(row[idx] || "", false),
    ),
  );

  // Measure natural width of each column using the longest sub-line per cell
  const naturalWidths = new Array(colCount).fill(3);
  for (let c = 0; c < colCount; c += 1) {
    for (const sub of styledHeader[c]) {
      naturalWidths[c] = Math.max(naturalWidths[c], displayWidth(sub));
    }
    for (const r of styledRows) {
      for (const sub of r[c]) {
        naturalWidths[c] = Math.max(naturalWidths[c], displayWidth(sub));
      }
    }
  }

  // Fit total table width (borders + 1-space padding on each side = 3*colCount + 1)
  const overhead = colCount * 3 + 1;
  const availForCells = Math.max(colCount * 4, maxWidth - overhead);
  const colWidths = [...naturalWidths];
  let sum = colWidths.reduce((a, b) => a + b, 0);

  while (sum > availForCells) {
    // Shrink widest column above min width
    let widestIdx = -1;
    let widestVal = 4;
    for (let c = 0; c < colCount; c += 1) {
      if (colWidths[c] > widestVal) {
        widestVal = colWidths[c];
        widestIdx = c;
      }
    }
    if (widestIdx === -1) break;
    colWidths[widestIdx] -= 1;
    sum -= 1;
  }

  const borderLine = (left, mid, right) =>
    style.border(`${left}${colWidths.map((w) => "─".repeat(w + 2)).join(mid)}${right}`);

  const renderRow = (cells) => {
    const wrappedCols = cells.map((subLines, idx) => {
      const cellWrapped = [];
      for (const subLine of subLines) {
        cellWrapped.push(...wrapAnsiLine(subLine, colWidths[idx]));
      }
      return cellWrapped.length > 0 ? cellWrapped : [""];
    });
    const rowHeight = Math.max(1, ...wrappedCols.map((w) => w.length));
    const rendered = [];
    for (let lineIdx = 0; lineIdx < rowHeight; lineIdx += 1) {
      const parts = [];
      for (let c = 0; c < colCount; c += 1) {
        const piece = wrappedCols[c][lineIdx] || "";
        parts.push(` ${padEndVisible(piece, colWidths[c])} `);
      }
      rendered.push(`${style.border("│")}${parts.join(style.border("│"))}${style.border("│")}`);
    }
    return rendered;
  };

  const out = [];
  out.push(borderLine("┌", "┬", "┐"));
  out.push(...renderRow(styledHeader));
  out.push(borderLine("├", "┼", "┤"));
  for (let rIdx = 0; rIdx < styledRows.length; rIdx += 1) {
    out.push(...renderRow(styledRows[rIdx]));
  }
  out.push(borderLine("└", "┴", "┘"));
  return out;
}

function pushListItem(out, indentLen, marker, bodyText, width, style) {
  const indent = " ".repeat(indentLen);
  const contLen = indentLen + marker.length + 1;
  const contIndent = " ".repeat(contLen);
  const wrapped = wrapAnsiLine(renderInlineMarkdown(bodyText, style), Math.max(12, width - contLen));
  wrapped.forEach((w, idx) => {
    out.push(idx === 0 ? `${indent}${style.accent(marker)} ${w}` : `${contIndent}${w}`);
  });
}

/**
 * Renders full Markdown document to ANSI lines wrapped to `maxWidth`.
 * Designed to stay clean and flicker-free while streaming partial tokens.
 */
export function renderMarkdown(markdownText, maxWidth, style) {
  const width = Math.max(20, maxWidth);
  const rawLines = String(markdownText ?? "").replace(/\r\n/g, "\n").split("\n");
  const out = [];

  let i = 0;
  let blankStreak = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];
    const trimmed = line.trim();

    // Collapse excessive blank lines
    if (trimmed === "") {
      if (out.length > 0 && blankStreak === 0) {
        out.push("");
        blankStreak += 1;
      }
      i += 1;
      continue;
    }
    blankStreak = 0;

    // Fenced code block: ```lang
    const fenceMatch = /^(`{3,}|~{3,})\s*([^\s`]*)/.exec(trimmed);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[1];
      const fenceChar = fenceMarker[0];
      const fenceLen = fenceMarker.length;
      const lang = fenceMatch[2] || "";
      const codeLines = [];
      i += 1;
      let closed = false;
      while (i < rawLines.length) {
        const closeCheck = rawLines[i].trim();
        if (closeCheck.startsWith(fenceChar.repeat(fenceLen)) && closeCheck.replaceAll(fenceChar, "").trim() === "") {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(rawLines[i]);
        i += 1;
      }

      const headerLabel = lang ? ` ${style.muted(lang)}` : "";
      out.push(`${style.border("╭─")}${headerLabel}`);
      const codeWidth = Math.max(12, width - 3);
      for (const codeLine of codeLines) {
        const expanded = codeLine.replace(/\t/g, "    ");
        const highlighted = highlightCodeLine(expanded, lang, style);
        const wrapped = wrapAnsiLine(highlighted, codeWidth);
        for (const w of wrapped) {
          out.push(`${style.border("│")} ${w}`);
        }
      }
      if (closed) {
        out.push(style.border("╰─"));
      } else {
        out.push(`${style.border("│")} ${style.muted("…")}`);
      }
      continue;
    }

    // Display math block: $$ ... $$ or \[ ... \]
    if (trimmed.startsWith("$$") || trimmed.startsWith("\\[")) {
      const isBracket = trimmed.startsWith("\\[");
      const openLen = 2;
      const closeToken = isBracket ? "\\]" : "$$";
      const mathLines = [];

      const afterOpen = trimmed.slice(openLen);
      const sameLineClose = afterOpen.indexOf(closeToken);
      if (sameLineClose !== -1) {
        const inner = afterOpen.slice(0, sameLineClose).trim();
        if (inner) mathLines.push(inner);
        i += 1;
      } else {
        if (afterOpen.trim()) mathLines.push(afterOpen.trim());
        i += 1;
        while (i < rawLines.length) {
          const cur = rawLines[i];
          const closePos = cur.indexOf(closeToken);
          if (closePos !== -1) {
            const beforeClose = cur.slice(0, closePos).trim();
            if (beforeClose) mathLines.push(beforeClose);
            i += 1;
            break;
          }
          mathLines.push(cur);
          i += 1;
        }
      }

      const combined = mathLines.join("\n").trim();
      if (combined) {
        const exprRows = combined.split(/\\\\|\n/).map((part) => part.trim()).filter(Boolean);
        const mathWidth = Math.max(12, width - 2);
        for (const exprRow of exprRows) {
          const rendered = style.accentAlt(renderLatexMath(exprRow));
          for (const w of wrapAnsiLine(rendered, mathWidth)) {
            out.push(`  ${w}`);
          }
        }
      }
      continue;
    }

    // Markdown table: header + separator + rows
    if (line.includes("|") && i + 1 < rawLines.length && isTableSeparatorLine(rawLines[i + 1])) {
      const tableLines = [line, rawLines[i + 1]];
      i += 2;
      while (i < rawLines.length && rawLines[i].includes("|") && rawLines[i].trim() !== "") {
        tableLines.push(rawLines[i]);
        i += 1;
      }
      out.push(...renderTableBlock(tableLines, width, style));
      continue;
    }

    // Horizontal rule
    if (/^(?:[-*_]\s*){3,}$/.test(trimmed)) {
      out.push(style.border("─".repeat(Math.min(width, 64))));
      i += 1;
      continue;
    }

    // Headings
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = renderInlineMarkdown(headingMatch[2], style);
      const styledHeading =
        level <= 2
          ? style.heading(content)
          : level === 3
            ? style.bold(content)
            : `${style.muted("▸")} ${style.bold(content)}`;
      const wrapped = wrapAnsiLine(styledHeading, width);
      out.push(...wrapped);
      i += 1;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith(">")) {
      const quoteContent = trimmed.replace(/^>\s?/, "");
      const styled = style.muted(renderInlineMarkdown(quoteContent, style));
      const wrapped = wrapAnsiLine(styled, Math.max(12, width - 3));
      for (const w of wrapped) {
        out.push(`${style.border("│")} ${w}`);
      }
      i += 1;
      continue;
    }

    // Unordered list item
    const bulletMatch = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    if (bulletMatch) {
      pushListItem(out, Math.min(8, bulletMatch[1].length), "•", bulletMatch[3], width, style);
      i += 1;
      continue;
    }

    // Ordered list item
    const orderedMatch = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line);
    if (orderedMatch) {
      pushListItem(out, Math.min(8, orderedMatch[1].length), orderedMatch[2], orderedMatch[3], width, style);
      i += 1;
      continue;
    }

    // Regular paragraph line (split explicit HTML <br> tags onto new lines)
    for (const part of splitOnHtmlBreaks(line)) {
      const formatted = renderInlineMarkdown(part, style);
      out.push(...wrapAnsiLine(formatted, width));
    }
    i += 1;
  }

  return out;
}

export function safeRenderMarkdown(text, maxWidth, style) {
  try {
    return renderMarkdown(text || "", maxWidth, style);
  } catch {
    return wrapAnsiText(String(text || ""), Math.max(16, maxWidth));
  }
}
