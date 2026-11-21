import { graphemeWidth, splitGraphemes } from "../term/unicode.mjs";

export const PASTED_TOKEN_REGEX = /\[Pasted text #\d+ [^\]]+\]/g;
const LONG_PASTE_LINE_THRESHOLD = 4;
const LONG_PASTE_CHAR_THRESHOLD = 300;
const MAX_PASTED_REGISTRY = 100;

export class Composer {
  constructor() {
    this.text = "";
    this.cursor = 0; // index in graphemes
    this.history = [];
    this.historyIndex = -1;
    this.historyDraft = "";
    this.scrollTop = 0;
    this.pastedRegistry = new Map();
    this.nextPasteId = 1;
  }

  getGraphemes() {
    return splitGraphemes(this.text);
  }

  setText(newText, cursorAtEnd = true) {
    this.text = String(newText ?? "");
    const graphemes = this.getGraphemes();
    this.cursor = cursorAtEnd ? graphemes.length : 0;
    this.scrollTop = 0;
  }

  clear() {
    this.text = "";
    this.cursor = 0;
    this.historyIndex = -1;
    this.historyDraft = "";
    this.scrollTop = 0;
  }

  isEmpty() {
    return this.text.length === 0;
  }

  pushHistory(entry) {
    const trimmed = entry.trim();
    if (!trimmed) return;
    if (this.history[this.history.length - 1] !== trimmed) {
      this.history.push(trimmed);
      if (this.history.length > 200) {
        this.history.shift();
      }
    }
    this.historyIndex = -1;
    this.historyDraft = "";
  }

  insert(str) {
    if (!str) return;
    const normalized = String(str).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const graphemes = this.getGraphemes();
    const inserted = splitGraphemes(normalized);
    graphemes.splice(this.cursor, 0, ...inserted);
    this.text = graphemes.join("");
    this.cursor += inserted.length;
    this.historyIndex = -1;
  }

  /**
   * Inserts bracketed-paste content. Long or multi-line pastes are collapsed
   * into a compact placeholder chip (like Claude Code / Codex) while the full
   * text is kept in `pastedRegistry` and expanded on submit.
   */
  insertPaste(str) {
    if (!str) {
      return { collapsed: false, token: null, lineCount: 0, charCount: 0 };
    }
    const normalized = String(str).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lineCount = normalized.split("\n").length;
    const charCount = normalized.length;

    if (lineCount >= LONG_PASTE_LINE_THRESHOLD || charCount >= LONG_PASTE_CHAR_THRESHOLD) {
      const id = this.nextPasteId;
      this.nextPasteId += 1;
      const summary = lineCount >= 2 ? `+${lineCount - 1} lines` : `${charCount} chars`;
      const token = `[Pasted text #${id} ${summary}]`;
      this.pastedRegistry.set(token, normalized);
      if (this.pastedRegistry.size > MAX_PASTED_REGISTRY) {
        const oldestKey = this.pastedRegistry.keys().next().value;
        this.pastedRegistry.delete(oldestKey);
      }
      this.insert(token);
      return { collapsed: true, token, lineCount, charCount };
    }

    this.insert(normalized);
    return { collapsed: false, token: null, lineCount, charCount };
  }

  /**
   * Expands any collapsed `[Pasted text #N ...]` placeholders back to their
   * original full text before sending to the agent.
   */
  expandText(sourceText = this.text) {
    const raw = String(sourceText ?? "");
    if (this.pastedRegistry.size === 0 || !raw.includes("[Pasted text #")) {
      return raw;
    }
    return raw.replace(PASTED_TOKEN_REGEX, (match) =>
      this.pastedRegistry.has(match) ? this.pastedRegistry.get(match) : match,
    );
  }

  findPastedTokenBoundary(graphemes, direction) {
    if (this.pastedRegistry.size === 0) return null;
    for (const token of this.pastedRegistry.keys()) {
      const tokenLen = token.length; // tokens are pure ASCII
      if (direction === "before") {
        const start = this.cursor - tokenLen;
        if (start >= 0 && graphemes.slice(start, this.cursor).join("") === token) {
          return { start, length: tokenLen };
        }
      } else {
        const end = this.cursor + tokenLen;
        if (end <= graphemes.length && graphemes.slice(this.cursor, end).join("") === token) {
          return { start: this.cursor, length: tokenLen };
        }
      }
    }
    return null;
  }

  backspace() {
    if (this.cursor <= 0) return false;
    const graphemes = this.getGraphemes();
    const tokenHit = this.findPastedTokenBoundary(graphemes, "before");
    if (tokenHit) {
      graphemes.splice(tokenHit.start, tokenHit.length);
      this.text = graphemes.join("");
      this.cursor = tokenHit.start;
      this.historyIndex = -1;
      return true;
    }
    graphemes.splice(this.cursor - 1, 1);
    this.text = graphemes.join("");
    this.cursor -= 1;
    this.historyIndex = -1;
    return true;
  }

  deleteForward() {
    const graphemes = this.getGraphemes();
    if (this.cursor >= graphemes.length) return false;
    const tokenHit = this.findPastedTokenBoundary(graphemes, "after");
    if (tokenHit) {
      graphemes.splice(tokenHit.start, tokenHit.length);
      this.text = graphemes.join("");
      this.historyIndex = -1;
      return true;
    }
    graphemes.splice(this.cursor, 1);
    this.text = graphemes.join("");
    this.historyIndex = -1;
    return true;
  }

  deleteWordBackward() {
    if (this.cursor <= 0) return false;
    const graphemes = this.getGraphemes();
    let idx = this.cursor;
    while (idx > 0 && /\s/.test(graphemes[idx - 1])) idx -= 1;
    while (idx > 0 && !/\s/.test(graphemes[idx - 1])) idx -= 1;
    graphemes.splice(idx, this.cursor - idx);
    this.text = graphemes.join("");
    this.cursor = idx;
    this.historyIndex = -1;
    return true;
  }

  killToLineStart() {
    if (this.cursor <= 0) return false;
    const graphemes = this.getGraphemes();
    let idx = this.cursor;
    while (idx > 0 && graphemes[idx - 1] !== "\n") idx -= 1;
    if (idx === this.cursor) return false;
    graphemes.splice(idx, this.cursor - idx);
    this.text = graphemes.join("");
    this.cursor = idx;
    this.historyIndex = -1;
    return true;
  }

  killToLineEnd() {
    const graphemes = this.getGraphemes();
    let idx = this.cursor;
    while (idx < graphemes.length && graphemes[idx] !== "\n") idx += 1;
    if (idx === this.cursor) return false;
    graphemes.splice(this.cursor, idx - this.cursor);
    this.text = graphemes.join("");
    this.historyIndex = -1;
    return true;
  }

  moveLeft() {
    if (this.cursor > 0) this.cursor -= 1;
  }

  moveRight() {
    const len = this.getGraphemes().length;
    if (this.cursor < len) this.cursor += 1;
  }

  moveWordLeft() {
    const graphemes = this.getGraphemes();
    let idx = this.cursor;
    while (idx > 0 && /\s/.test(graphemes[idx - 1])) idx -= 1;
    while (idx > 0 && !/\s/.test(graphemes[idx - 1])) idx -= 1;
    this.cursor = idx;
  }

  moveWordRight() {
    const graphemes = this.getGraphemes();
    let idx = this.cursor;
    while (idx < graphemes.length && /\s/.test(graphemes[idx])) idx += 1;
    while (idx < graphemes.length && !/\s/.test(graphemes[idx])) idx += 1;
    this.cursor = idx;
  }

  moveLineStart() {
    const graphemes = this.getGraphemes();
    let idx = this.cursor;
    while (idx > 0 && graphemes[idx - 1] !== "\n") idx -= 1;
    this.cursor = idx;
  }

  moveLineEnd() {
    const graphemes = this.getGraphemes();
    let idx = this.cursor;
    while (idx < graphemes.length && graphemes[idx] !== "\n") idx += 1;
    this.cursor = idx;
  }

  moveUpOrHistory(contentWidth) {
    const layout = this.computeWrappedLines(contentWidth);
    if (layout.cursorRow > 0) {
      const targetLine = layout.lines[layout.cursorRow - 1];
      this.cursor = this.findGraphemeIndexAtColumn(targetLine, layout.cursorCol);
      return true;
    }
    return this.historyPrev();
  }

  moveDownOrHistory(contentWidth) {
    const layout = this.computeWrappedLines(contentWidth);
    if (layout.cursorRow < layout.lines.length - 1) {
      const targetLine = layout.lines[layout.cursorRow + 1];
      this.cursor = this.findGraphemeIndexAtColumn(targetLine, layout.cursorCol);
      return true;
    }
    return this.historyNext();
  }

  historyPrev() {
    if (this.history.length === 0) return false;
    if (this.historyIndex === -1) {
      this.historyDraft = this.text;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return false;
    }
    this.setText(this.history[this.historyIndex], true);
    return true;
  }

  historyNext() {
    if (this.historyIndex === -1) return false;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.setText(this.history[this.historyIndex], true);
    } else {
      this.historyIndex = -1;
      this.setText(this.historyDraft, true);
    }
    return true;
  }

  findGraphemeIndexAtColumn(lineMeta, targetCol) {
    let col = 0;
    for (let i = 0; i < lineMeta.graphemes.length; i += 1) {
      const w = graphemeWidth(lineMeta.graphemes[i]);
      if (col + w > targetCol) {
        return lineMeta.startIdx + i;
      }
      col += w;
    }
    return lineMeta.endIdx;
  }

  /**
   * Detects active `/` slash command completion when editing the leading token.
   */
  getSlashTrigger() {
    if (!this.text.startsWith("/") || this.text.includes("\n")) return null;
    const graphemes = this.getGraphemes();
    const beforeCursor = graphemes.slice(0, this.cursor).join("");
    if (beforeCursor.includes(" ")) return null;
    return {
      query: beforeCursor.slice(1),
      startIdx: 0,
      endIdx: this.cursor,
    };
  }

  /**
   * Detects active `@path` file mention right before the cursor.
   */
  getFileTrigger() {
    const graphemes = this.getGraphemes();
    let idx = this.cursor;
    while (idx > 0 && !/\s/.test(graphemes[idx - 1])) {
      idx -= 1;
    }
    const token = graphemes.slice(idx, this.cursor).join("");
    if (!token.startsWith("@")) return null;
    return {
      query: token.slice(1),
      startIdx: idx,
      endIdx: this.cursor,
    };
  }

  replaceRange(startIdx, endIdx, replacement) {
    const graphemes = this.getGraphemes();
    const inserted = splitGraphemes(replacement);
    graphemes.splice(startIdx, endIdx - startIdx, ...inserted);
    this.text = graphemes.join("");
    this.cursor = startIdx + inserted.length;
    this.historyIndex = -1;
  }

  computeWrappedLines(maxWidth) {
    const widthLimit = Math.max(8, maxWidth);
    const graphemes = this.getGraphemes();
    const lines = [];

    let lineGraphemes = [];
    let lineStart = 0;
    let lineWidth = 0;
    let cursorRow = 0;
    let cursorCol = 0;
    let cursorPlaced = false;

    for (let i = 0; i < graphemes.length; i += 1) {
      if (i === this.cursor) {
        cursorRow = lines.length;
        cursorCol = lineWidth;
        cursorPlaced = true;
      }

      const g = graphemes[i];
      if (g === "\n") {
        lines.push({
          text: lineGraphemes.join(""),
          graphemes: lineGraphemes,
          startIdx: lineStart,
          endIdx: i,
        });
        lineGraphemes = [];
        lineStart = i + 1;
        lineWidth = 0;
        continue;
      }

      const w = graphemeWidth(g);
      if (lineWidth + w > widthLimit && lineGraphemes.length > 0) {
        lines.push({
          text: lineGraphemes.join(""),
          graphemes: lineGraphemes,
          startIdx: lineStart,
          endIdx: i,
        });
        lineGraphemes = [g];
        lineStart = i;
        lineWidth = w;
        if (i === this.cursor) {
          cursorRow = lines.length;
          cursorCol = 0;
        }
        continue;
      }

      lineGraphemes.push(g);
      lineWidth += w;
    }

    if (!cursorPlaced) {
      cursorRow = lines.length;
      cursorCol = lineWidth;
    }

    lines.push({
      text: lineGraphemes.join(""),
      graphemes: lineGraphemes,
      startIdx: lineStart,
      endIdx: graphemes.length,
    });

    return { lines, cursorRow, cursorCol };
  }

  layout(maxWidth, maxVisibleRows = 6) {
    const wrapped = this.computeWrappedLines(maxWidth);
    const visibleHeight = Math.min(maxVisibleRows, Math.max(1, wrapped.lines.length));

    if (wrapped.cursorRow < this.scrollTop) {
      this.scrollTop = wrapped.cursorRow;
    } else if (wrapped.cursorRow >= this.scrollTop + visibleHeight) {
      this.scrollTop = wrapped.cursorRow - visibleHeight + 1;
    }

    const maxScroll = Math.max(0, wrapped.lines.length - visibleHeight);
    if (this.scrollTop > maxScroll) {
      this.scrollTop = maxScroll;
    }

    const visibleLines = wrapped.lines.slice(this.scrollTop, this.scrollTop + visibleHeight);
    return {
      lines: visibleLines.map((l) => l.text),
      totalLines: wrapped.lines.length,
      cursorRow: wrapped.cursorRow - this.scrollTop,
      cursorCol: wrapped.cursorCol,
    };
  }
}
