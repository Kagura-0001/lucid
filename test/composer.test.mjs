import assert from "node:assert/strict";
import test from "node:test";
import { Composer } from "../src/ui/composer.mjs";

test("Composer handles CJK editing, multiline newlines, and cursor wrapping", () => {
  const composer = new Composer();
  composer.insert("你好世界");
  assert.equal(composer.cursor, 4);

  composer.moveLeft();
  composer.moveLeft();
  composer.insert("，");
  assert.equal(composer.text, "你好，世界");

  composer.backspace();
  assert.equal(composer.text, "你好世界");

  composer.moveLineEnd();
  composer.insert("\n第二行内容");
  const layout = composer.layout(20, 6);
  assert.equal(layout.lines.length, 2);
  assert.equal(layout.cursorRow, 1);
  assert.equal(layout.cursorCol, 10); // 5 CJK chars * 2 cols
});

test("Composer detects slash and @file triggers cleanly", () => {
  const composer = new Composer();
  composer.setText("/mo");
  assert.deepEqual(composer.getSlashTrigger(), { query: "mo", startIdx: 0, endIdx: 3 });

  composer.setText("check @src/app");
  assert.equal(composer.getSlashTrigger(), null);
  assert.deepEqual(composer.getFileTrigger(), { query: "src/app", startIdx: 6, endIdx: 14 });
});
