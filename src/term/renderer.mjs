import fs from "node:fs";
import { sanitizeTerminalRow, truncateAnsi } from "./unicode.mjs";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";
const PASTE_ENABLE = "\x1b[?2004h";
const PASTE_DISABLE = "\x1b[?2004l";
// 1000 = button press/release, 1002 = motion while a button is held (drag
// selection), 1006 = SGR coordinates.
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1002h\x1b[?1006h";
// Disable tracking modes (1000/1002/1003) before encoding modes (1006/1015) so
// an interrupted write can never leave tracking active in legacy X10 mode.
const MOUSE_DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l";
// Alternate Scroll Mode: when mouse tracking is OFF in the alt screen, let the
// terminal keep native drag-select while still translating wheel notches into
// Up/Down bursts that lucid converts back into timeline scrolling.
const ALT_SCROLL_ENABLE = "\x1b[?1007h";
const ALT_SCROLL_DISABLE = "\x1b[?1007l";
// With autowrap off, a row whose width we underestimate (ambiguous-width
// glyphs, unusual emoji) is clipped at the right edge instead of spilling into
// the next row and shifting everything below it.
const AUTOWRAP_DISABLE = "\x1b[?7l";
const AUTOWRAP_ENABLE = "\x1b[?7h";
const RESET_AND_ERASE_LINE = "\x1b[0m\x1b[2K";
const KITTY_KEYS_PUSH = "\x1b[>1u";
const KITTY_KEYS_POP = "\x1b[<u";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";

export class TerminalRenderer {
  constructor(stream = process.stdout) {
    this.stream = stream;
    this.active = false;
    this.mouseEnabled = false;
    this.prevRows = [];
    this.prevRawRows = [];
    this.lastCursorKey = "";
    this.lastCols = 0;
    this.lastRows = 0;
  }

  getSize() {
    const cols = Math.max(40, this.stream.columns || 80);
    const rows = Math.max(12, this.stream.rows || 24);
    return { cols, rows };
  }

  enter({ mouseCapture = true } = {}) {
    if (this.active) return;
    this.active = true;
    this.prevRows = [];
    this.mouseEnabled = Boolean(mouseCapture);

    let seq = ALT_SCREEN_ENTER + AUTOWRAP_DISABLE + PASTE_ENABLE + KITTY_KEYS_PUSH + CURSOR_HIDE + "\x1b[2J\x1b[H";
    if (this.mouseEnabled) {
      seq += ALT_SCROLL_DISABLE + MOUSE_ENABLE;
    } else {
      seq += MOUSE_DISABLE + ALT_SCROLL_ENABLE;
    }
    this.stream.write(seq);
  }

  setMouseCapture(enabled) {
    const target = Boolean(enabled);
    if (!this.active || target === this.mouseEnabled) {
      this.mouseEnabled = target;
      return;
    }
    this.mouseEnabled = target;
    this.stream.write(target ? ALT_SCROLL_DISABLE + MOUSE_ENABLE : MOUSE_DISABLE + ALT_SCROLL_ENABLE);
  }

  invalidate() {
    this.prevRows = [];
    this.prevRawRows = [];
    this.lastCursorKey = "";
  }

  leave({ sync = false } = {}) {
    if (!this.active) return;
    this.active = false;
    this.mouseEnabled = false;
    // Always emit MOUSE_DISABLE on teardown so mouse tracking can never leak
    // back into the parent shell or another CLI.
    const seq =
      MOUSE_DISABLE +
      ALT_SCROLL_DISABLE +
      KITTY_KEYS_POP +
      PASTE_DISABLE +
      "\x1b[0m" +
      AUTOWRAP_ENABLE +
      CURSOR_SHOW +
      ALT_SCREEN_LEAVE;
    try {
      if (sync && typeof this.stream.fd === "number") {
        fs.writeSync(this.stream.fd, seq);
      } else {
        this.stream.write(seq);
      }
    } catch {
      // Ignore broken pipe on teardown
    }
    this.prevRows = [];
  }

  /**
   * Renders an array of ANSI rows to the screen using synchronized row-diffing.
   *
   * Every row is sanitized (no control characters or cursor-moving escapes can
   * reach the terminal), clipped to `cols`, and written after erasing the whole
   * line, so a changed row never leaves residue from the previous frame.
   * Rows whose source string is unchanged reuse the previous frame's output.
   *
   * When `scrollHint` ({ topRow, height, delta }) is provided, shifts the scroll
   * region in-place via VT100 DECSTBM + IL/DL so the terminal moves unchanged
   * rows locally and only the newly revealed rows are sent over SSH.
   */
  render(rows, cursor = null, scrollHint = null) {
    if (!this.active) return;
    const { cols, rows: height } = this.getSize();
    const sizeChanged = cols !== this.lastCols || height !== this.lastRows;
    if (sizeChanged) {
      this.lastCols = cols;
      this.lastRows = height;
      this.prevRows = [];
      this.prevRawRows = [];
    }

    const chunks = [SYNC_START, CURSOR_HIDE];
    if (sizeChanged) {
      chunks.push("\x1b[2J");
    }

    // Optional hardware scroll-region shift for vertical viewport scrolling.
    let appliedScrollShift = false;
    if (
      !sizeChanged &&
      scrollHint &&
      this.prevRows.length === height &&
      this.prevRawRows.length === height
    ) {
      const regionTop = Math.max(0, Math.min(height - 1, scrollHint.topRow | 0));
      const regionHeight = Math.max(0, Math.min(height - regionTop, scrollHint.height | 0));
      const delta = scrollHint.delta | 0;
      const absDelta = Math.abs(delta);
      if (regionHeight >= 4 && absDelta > 0 && absDelta < regionHeight - 1) {
        const regionBottom = regionTop + regionHeight - 1;
        const top1 = regionTop + 1;
        const bottom1 = regionBottom + 1;
        // Reset SGR before IL/DL so newly inserted blank rows keep default background.
        const op = delta > 0 ? "L" : "M";
        chunks.push(`\x1b[0m\x1b[${top1};${bottom1}r\x1b[${top1};1H\x1b[${absDelta}${op}\x1b[r`);

        // Shift cached frame buffers in exact lockstep with the terminal.
        if (delta > 0) {
          for (let y = regionBottom; y >= regionTop + absDelta; y -= 1) {
            this.prevRows[y] = this.prevRows[y - absDelta];
            this.prevRawRows[y] = this.prevRawRows[y - absDelta];
          }
          for (let y = regionTop; y < regionTop + absDelta; y += 1) {
            this.prevRows[y] = null;
            this.prevRawRows[y] = null;
          }
        } else {
          for (let y = regionTop; y <= regionBottom - absDelta; y += 1) {
            this.prevRows[y] = this.prevRows[y + absDelta];
            this.prevRawRows[y] = this.prevRawRows[y + absDelta];
          }
          for (let y = regionBottom - absDelta + 1; y <= regionBottom; y += 1) {
            this.prevRows[y] = null;
            this.prevRawRows[y] = null;
          }
        }
        appliedScrollShift = true;
      }
    }

    const nextRows = new Array(height);
    const nextRawRows = new Array(height);
    for (let y = 0; y < height; y += 1) {
      const raw = (y < rows.length ? rows[y] : "") || "";
      nextRawRows[y] = raw;
      const canReusePrevious = this.prevRows[y] !== undefined && this.prevRows[y] !== null && this.prevRawRows[y] === raw;
      if (canReusePrevious) {
        nextRows[y] = this.prevRows[y];
        continue;
      }
      const safeRow = sanitizeTerminalRow(raw);
      nextRows[y] = `${RESET_AND_ERASE_LINE}${truncateAnsi(safeRow, cols)}\x1b[0m`;
    }

    let dirtyCount = 0;
    for (let y = 0; y < height; y += 1) {
      if (this.prevRows[y] !== nextRows[y]) {
        chunks.push(`\x1b[${y + 1};1H${nextRows[y]}`);
        dirtyCount += 1;
      }
    }

    this.prevRows = nextRows;
    this.prevRawRows = nextRawRows;

    const cursorVisible = Boolean(cursor && cursor.visible && cursor.row >= 0 && cursor.row < height);
    const targetRow = cursorVisible ? cursor.row + 1 : 0;
    const targetCol = cursorVisible ? Math.max(1, Math.min(cols, cursor.col + 1)) : 0;
    const cursorKey = cursorVisible ? `${targetRow};${targetCol}` : "hidden";
    // Nothing changed on screen and the cursor did not move: skip the write entirely.
    if (dirtyCount === 0 && !sizeChanged && !appliedScrollShift && cursorKey === this.lastCursorKey) {
      return;
    }
    this.lastCursorKey = cursorKey;
    if (cursorVisible) {
      chunks.push(`\x1b[${targetRow};${targetCol}H${CURSOR_SHOW}`);
    }

    chunks.push(SYNC_END);
    this.stream.write(chunks.join(""));
  }
}
