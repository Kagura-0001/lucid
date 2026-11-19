import assert from "node:assert/strict";
import test from "node:test";
import { InputParser } from "../src/term/input.mjs";

test("InputParser parses bracketed paste split across chunks", () => {
  const events = [];
  const parser = new InputParser((e) => events.push(e));

  parser.feed("\x1b[200~第一行\r\n第二");
  parser.feed("行\nthird\x1b[201~");
  parser.destroy();

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "paste",
    text: "第一行\n第二行\nthird",
  });
});

test("InputParser parses SGR mouse wheel and CSI-u / Shift+Tab keys", () => {
  const events = [];
  const parser = new InputParser((e) => events.push(e));

  parser.feed("\x1b[<64;10;5M"); // wheelUp
  parser.feed("\x1b[<65;10;5M"); // wheelDown
  parser.feed("\x1b[13;2u"); // Shift+Enter
  parser.feed("\x1b[Z"); // Shift+Tab
  parser.feed("\x1b[1;5C"); // Ctrl+Right
  parser.feed("\x1b[5~"); // PageUp
  parser.destroy();

  assert.deepEqual(events[0], { type: "mouse", action: "wheelUp", col: 10, row: 5 });
  assert.deepEqual(events[1], { type: "mouse", action: "wheelDown", col: 10, row: 5 });
  assert.equal(events[2].name, "enter");
  assert.equal(events[2].shift, true);
  assert.equal(events[3].name, "tab");
  assert.equal(events[3].shift, true);
  assert.equal(events[4].name, "right");
  assert.equal(events[4].ctrl, true);
  assert.equal(events[5].name, "pageup");
});

test("InputParser handles UTF-8 CJK text and lone Escape timeout", async () => {
  const events = [];
  const parser = new InputParser((e) => events.push(e));

  parser.feed(Buffer.from("你好世界", "utf8"));
  parser.feed("\x1b");
  await new Promise((r) => setTimeout(r, 60));
  parser.destroy();

  assert.deepEqual(events[0], { type: "text", text: "你好世界" });
  assert.equal(events[1].type, "key");
  assert.equal(events[1].name, "escape");
});
