import { truncateAnsi } from "./unicode.mjs";

const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_LEAVE = "\x1b[?1049l";
const PASTE_ENABLE = "\x1b[?2004h";
const PASTE_DISABLE = "\x1b[?2004l";
const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
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

    let seq = ALT_SCREEN_ENTER + PASTE_ENABLE + KITTY_KEYS_PUSH + CURSOR_HIDE + "\x1b[2J\x1b[H";
    if (this.mouseEnabled) {
      seq += MOUSE_ENABLE;
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
    this.stream.write(target ? MOUSE_ENABLE : MOUSE_DISABLE);
  }

  invalidate() {
    this.prevRows = [];
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    let seq = "";
    if (this.mouseEnabled) {
      seq += MOUSE_DISABLE;
    }
    seq += KITTY_KEYS_POP + PASTE_DISABLE + "\x1b[0m" + CURSOR_SHOW + ALT_SCREEN_LEAVE;
    try {
      this.stream.write(seq);
    } catch {
      // Ignore broken pipe on teardown
    }
    this.prevRows = [];
  }

  /**
   * Renders an array of ANSI rows to the screen using synchronized row-diffing.
   * Each row is clipped to `cols` visible characters and cleared to EOL with default background.
   */
  render(rows, cursor = null) {
    if (!this.active) return;
    const { cols, rows: height } = this.getSize();
    const sizeChanged = cols !== this.lastCols || height !== this.lastRows;
    if (sizeChanged) {
      this.lastCols = cols;
      this.lastRows = height;
      this.prevRows = [];
    }

    const nextRows = new Array(height);
    for (let y = 0; y < height; y += 1) {
      const raw = y < rows.length ? rows[y] : "";
      // Clip strictly to viewport width and reset attributes before clearing EOL (transparent bg)
      nextRows[y] = `${truncateAnsi(raw || "", cols)}\x1b[0m\x1b[K`;
    }

    const chunks = [SYNC_START, CURSOR_HIDE];
    if (sizeChanged) {
      chunks.push("\x1b[2J");
    }

    let dirtyCount = 0;
    for (let y = 0; y < height; y += 1) {
      if (this.prevRows[y] !== nextRows[y]) {
        chunks.push(`\x1b[${y + 1};1H${nextRows[y]}`);
        dirtyCount += 1;
      }
    }

    this.prevRows = nextRows;

    if (cursor && cursor.visible && cursor.row >= 0 && cursor.row < height) {
      const targetRow = cursor.row + 1;
      const targetCol = Math.max(1, Math.min(cols, cursor.col + 1));
      chunks.push(`\x1b[${targetRow};${targetCol}H${CURSOR_SHOW}`);
    } else if (dirtyCount === 0 && !cursor) {
      return;
    }

    chunks.push(SYNC_END);
    this.stream.write(chunks.join(""));
  }
}
