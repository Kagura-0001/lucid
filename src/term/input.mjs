import { StringDecoder } from "node:string_decoder";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CURSOR_KEY_MAP = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

const TILDE_KEY_MAP = {
  1: "home",
  3: "delete",
  4: "end",
  5: "pageup",
  6: "pagedown",
  7: "home",
  8: "end",
};

function decodeModifierFlags(modParam) {
  const bits = Math.max(0, (modParam || 1) - 1);
  return {
    shift: Boolean(bits & 1),
    alt: Boolean(bits & 2),
    ctrl: Boolean(bits & 4),
    meta: Boolean(bits & 8),
  };
}

function keyNameFromCsiCode(code) {
  switch (code) {
    case 9:
      return "tab";
    case 13:
      return "enter";
    case 27:
      return "escape";
    case 32:
      return "space";
    case 127:
    case 8:
      return "backspace";
    default:
      if (code >= 32 && code <= 126) {
        return String.fromCharCode(code).toLowerCase();
      }
      return null;
  }
}

export class InputParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.inPaste = false;
    this.pasteBuffer = "";
    this.escTimer = null;
  }

  feed(chunk) {
    const text = typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    if (!text) return;
    this.clearEscTimer();
    this.buffer += text;
    this.processBuffer();
  }

  destroy() {
    this.clearEscTimer();
  }

  clearEscTimer() {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
  }

  emit(event) {
    if (this.onEvent) {
      this.onEvent(event);
    }
  }

  emitKey(name, mods = {}) {
    this.emit({ type: "key", name, ctrl: false, alt: false, shift: false, ...mods });
  }

  processBuffer() {
    while (this.buffer.length > 0) {
      if (this.inPaste) {
        const endIdx = this.buffer.indexOf(PASTE_END);
        if (endIdx === -1) {
          // Hold back up to PASTE_END.length - 1 chars in case marker splits across chunks
          const safeLen = Math.max(0, this.buffer.length - (PASTE_END.length - 1));
          if (safeLen > 0) {
            this.pasteBuffer += this.buffer.slice(0, safeLen);
            this.buffer = this.buffer.slice(safeLen);
          }
          return;
        }
        this.pasteBuffer += this.buffer.slice(0, endIdx);
        this.buffer = this.buffer.slice(endIdx + PASTE_END.length);
        const pasted = this.pasteBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        this.pasteBuffer = "";
        this.inPaste = false;
        if (pasted.length > 0) {
          this.emit({ type: "paste", text: pasted });
        }
        continue;
      }

      if (this.buffer.startsWith(PASTE_START)) {
        this.inPaste = true;
        this.pasteBuffer = "";
        this.buffer = this.buffer.slice(PASTE_START.length);
        continue;
      }

      // Partial prefix of PASTE_START at end of chunk
      if (PASTE_START.startsWith(this.buffer) && this.buffer.length < PASTE_START.length) {
        this.scheduleEscFlush();
        return;
      }

      const first = this.buffer[0];
      if (first === "\x1b") {
        const consumed = this.tryParseEscapeSequence();
        if (consumed === 0) {
          // Incomplete escape sequence; wait briefly for rest of SSH packet
          this.scheduleEscFlush();
          return;
        }
        this.buffer = this.buffer.slice(consumed);
        continue;
      }

      const consumed = this.parseNonEscape();
      this.buffer = this.buffer.slice(consumed);
    }
  }

  scheduleEscFlush() {
    this.clearEscTimer();
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      if (this.buffer === "\x1b") {
        this.buffer = "";
        this.emitKey("escape");
      } else if (this.buffer.startsWith("\x1b[M")) {
        // Incomplete X10 mouse report (for example, two raw high coordinate bytes
        // merged into one UTF-8 character at end of stream). Discard instead of
        // leaking coordinate bytes into the text composer.
        this.buffer = "";
      } else if (this.buffer.startsWith("\x1b")) {
        // Fallback: flush raw escape then continue parsing remainder
        this.buffer = this.buffer.slice(1);
        this.emitKey("escape");
        this.processBuffer();
      }
    }, 35);
  }

  emitMouseButton(button, col, row, pressed) {
    // Strip modifier bits (4 = Shift, 8 = Meta, 16 = Ctrl); 32 marks motion.
    const baseButton = button & ~(4 | 8 | 16);
    const MOTION_BIT = 32;

    if (baseButton === 64) {
      this.emit({ type: "mouse", action: "wheelUp", col, row });
    } else if (baseButton === 65) {
      this.emit({ type: "mouse", action: "wheelDown", col, row });
    } else if (baseButton === MOTION_BIT) {
      this.emit({ type: "mouse", action: "leftDrag", col, row });
    } else if (baseButton === 0 && pressed) {
      this.emit({ type: "mouse", action: "leftDown", col, row });
    } else if ((baseButton === 0 && !pressed) || baseButton === 3) {
      this.emit({ type: "mouse", action: "leftUp", col, row });
    }
  }

  tryParseEscapeSequence() {
    const buf = this.buffer;
    if (buf.length === 1) return 0;

    const second = buf[1];

    // CSI sequences: \x1b[ ...
    if (second === "[") {
      if (buf.length === 2) return 0;

      // X10 / Normal Mouse: \x1b[M <Cb> <Cx> <Cy>
      // Terminals fall back to this format whenever mode 1000/1002 is enabled
      // without SGR mode 1006. Handle it before the generic CSI regex so \x1b[M
      // is never stripped while leaving raw coordinate bytes in the text buffer.
      if (buf[2] === "M") {
        // Valid X10 payload bytes are always >= 0x20, so an ESC means the
        // previous report was shorter (e.g. two high bytes merged by UTF-8
        // decoding) and a new escape sequence has already started.
        const maxEnd = Math.min(buf.length, 6);
        for (let idx = 3; idx < maxEnd; idx += 1) {
          if (buf[idx] === "\x1b") {
            return idx;
          }
        }
        if (buf.length < 6) {
          return 0;
        }
        const cbCode = buf.charCodeAt(3);
        const cxCode = buf.charCodeAt(4);
        const cyCode = buf.charCodeAt(5);
        const allValidCoords =
          cbCode >= 32 &&
          cxCode >= 32 &&
          cyCode >= 32 &&
          cbCode !== 0xfffd &&
          cxCode !== 0xfffd &&
          cyCode !== 0xfffd;
        if (allValidCoords) {
          const button = cbCode - 32;
          const col = cxCode - 32;
          const row = cyCode - 32;
          const isRelease = (button & 3) === 3 && (button & 64) === 0;
          this.emitMouseButton(button, col, row, !isRelease);
        }
        return 6;
      }

      // SGR Mouse: \x1b[<b;x;yM or m
      if (buf[2] === "<") {
        const mouseMatch = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(buf);
        if (!mouseMatch) {
          // Check if still potentially valid prefix
          if (/^\x1b\[<[0-9;]*$/.test(buf) && buf.length < 32) {
            return 0;
          }
          return 3;
        }
        const button = Number.parseInt(mouseMatch[1], 10);
        const col = Number.parseInt(mouseMatch[2], 10);
        const row = Number.parseInt(mouseMatch[3], 10);
        const pressed = mouseMatch[4] === "M";
        this.emitMouseButton(button, col, row, pressed);
        return mouseMatch[0].length;
      }

      // Generic CSI sequence: \x1b[ <params> <final byte 0x40-0x7E>
      const csiMatch = /^\x1b\[([0-9;?:]*)([@A-Za-z~])/.exec(buf);
      if (!csiMatch) {
        if (/^\x1b\[[0-9;?:]*$/.test(buf) && buf.length < 32) {
          return 0;
        }
        return 2;
      }

      const full = csiMatch[0];
      const params = csiMatch[1];
      const finalByte = csiMatch[2];
      this.handleCsi(params, finalByte);
      return full.length;
    }

    // SS3 sequences: \x1bO + one char
    if (second === "O") {
      if (buf.length < 3) return 0;
      const name = CURSOR_KEY_MAP[buf[2]];
      if (name) {
        this.emitKey(name);
      }
      return 3;
    }

    // Double ESC -> escape
    if (second === "\x1b") {
      this.emitKey("escape");
      return 1;
    }

    // Alt + Enter
    if (second === "\r" || second === "\n") {
      this.emitKey("enter", { alt: true });
      return 2;
    }

    // Alt + Backspace
    if (second === "\x7f" || second === "\x08") {
      this.emitKey("backspace", { alt: true });
      return 2;
    }

    // Alt + printable ASCII
    const charCode = second.charCodeAt(0);
    if (charCode >= 32 && charCode <= 126) {
      this.emitKey(second.toLowerCase(), {
        text: second,
        alt: true,
        shift: second >= "A" && second <= "Z",
      });
      return 2;
    }

    return 2;
  }

  handleCsi(params, finalByte) {
    // Kitty / CSI u: \x1b[<codepoint>[:<shifted>[:<base>]];[<modifiers>[:<eventType>]]u
    if (finalByte === "u") {
      const partsRaw = params.split(";");
      const codeSub = (partsRaw[0] || "").split(":");
      const baseCode = Number.parseInt(codeSub[0], 10) || 0;
      const shiftedCode = codeSub[1] ? Number.parseInt(codeSub[1], 10) || 0 : 0;

      const modSub = (partsRaw[1] || "").split(":");
      const modParam = modSub[0] ? Number.parseInt(modSub[0], 10) || 1 : 1;
      const eventType = modSub[1] ? Number.parseInt(modSub[1], 10) || 1 : 1;

      if (eventType === 3) {
        return;
      }

      const mods = decodeModifierFlags(modParam);
      const effectiveCode = mods.shift && shiftedCode >= 32 ? shiftedCode : baseCode;

      if (
        !mods.ctrl &&
        !mods.alt &&
        !mods.meta &&
        effectiveCode >= 32 &&
        effectiveCode !== 127 &&
        effectiveCode <= 0x10ffff
      ) {
        if (effectiveCode <= 126 && mods.shift && !shiftedCode && effectiveCode >= 97 && effectiveCode <= 122) {
          this.emit({ type: "text", text: String.fromCharCode(effectiveCode - 32) });
        } else {
          this.emit({ type: "text", text: String.fromCodePoint(effectiveCode) });
        }
        return;
      }

      const name = keyNameFromCsiCode(baseCode);
      if (name) {
        this.emitKey(name, mods);
      }
      return;
    }

    // Shift+Tab: \x1b[Z
    if (finalByte === "Z") {
      this.emitKey("tab", { shift: true });
      return;
    }

    // Arrow / Home / End with optional modifiers: \x1b[A or \x1b[1;5C
    if (CURSOR_KEY_MAP[finalByte]) {
      const parts = params ? params.split(";").map((p) => Number.parseInt(p, 10)) : [];
      this.emitKey(CURSOR_KEY_MAP[finalByte], decodeModifierFlags(parts[1] || 1));
      return;
    }

    // Tilde sequences: \x1b[3~, \x1b[5~, \x1b[6~, \x1b[27;2;13~ (modifyOtherKeys)
    if (finalByte === "~") {
      const parts = params.split(";").map((p) => Number.parseInt(p, 10));
      if (parts[0] === 27 && parts.length >= 3) {
        const name = keyNameFromCsiCode(parts[2]);
        if (name) {
          this.emitKey(name, decodeModifierFlags(parts[1] || 1));
        }
        return;
      }
      const name = TILDE_KEY_MAP[parts[0]];
      if (name) {
        this.emitKey(name, decodeModifierFlags(parts[1] || 1));
      }
    }
  }

  parseNonEscape() {
    const ch = this.buffer[0];
    const code = ch.charCodeAt(0);

    if (ch === "\r") {
      this.emitKey("enter");
      return 1;
    }
    if (ch === "\n") {
      // Ctrl+J / LF -> newline inside composer
      this.emitKey("j", { ctrl: true });
      return 1;
    }
    if (ch === "\t") {
      this.emitKey("tab");
      return 1;
    }
    if (ch === "\x7f" || ch === "\x08") {
      this.emitKey("backspace");
      return 1;
    }

    // Ctrl+A (1) .. Ctrl+Z (26)
    if (code >= 1 && code <= 26) {
      this.emitKey(String.fromCharCode(code + 96), { ctrl: true });
      return 1;
    }

    // Other control bytes
    if (code < 32) {
      return 1;
    }

    // Batch contiguous printable / UTF-8 characters (including CJK / emoji)
    let end = 0;
    while (end < this.buffer.length) {
      const c = this.buffer.charCodeAt(end);
      if (c < 32 || c === 127) break;
      end += 1;
    }
    const text = this.buffer.slice(0, end);
    if (text.length > 0) {
      this.emit({ type: "text", text });
    }
    return Math.max(1, end);
  }
}
