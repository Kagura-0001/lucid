import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { displayWidth, stripAnsi } from "../src/term/unicode.mjs";
import {
  buildPromptBlocks,
  loadImageAttachment,
  normalizeDroppedPath,
  tryLoadDroppedImage,
} from "../src/ui/files.mjs";
import { MultiAgentTracker, renderSwarmBoardView, renderSwarmDock } from "../src/ui/swarm.mjs";
import { createThemeStyler, listThemes } from "../src/ui/themes.mjs";

const OPAQUE_BG_REGEX = /\x1b\[(?:4[0-7]|48;|10[0-7])/;

// Minimal valid 1x1 transparent PNG
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test("image path normalization, drag-drop detection, and ACP image prompt blocks", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-img-"));
  const imgPath = path.join(tmpDir, "shot 1.png");
  fs.writeFileSync(imgPath, Buffer.from(TINY_PNG_BASE64, "base64"));

  try {
    assert.equal(normalizeDroppedPath(`'${imgPath}'`), imgPath);
    assert.equal(normalizeDroppedPath(`file://${encodeURI(imgPath)}`), imgPath);
    assert.equal(normalizeDroppedPath(imgPath.replace(" ", "\\ ")), imgPath);

    const dropped = tryLoadDroppedImage(`"${imgPath}"`, tmpDir);
    assert.ok(dropped);
    assert.equal(dropped.mimeType, "image/png");
    assert.equal(dropped.data, TINY_PNG_BASE64);

    const staged = loadImageAttachment("shot 1.png", tmpDir);
    const { blocks, attachedImages } = buildPromptBlocks("看一下这张截图", tmpDir, {
      supportsEmbeddedContext: true,
      supportsImage: true,
      stagedImages: [staged],
    });
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { type: "text", text: "看一下这张截图" });
    assert.deepEqual(blocks[1], {
      type: "image",
      mimeType: "image/png",
      data: TINY_PNG_BASE64,
    });
    assert.equal(attachedImages.length, 1);

    // Also test @image.png mention directly in text
    const simpleImg = path.join(tmpDir, "chart.png");
    fs.writeFileSync(simpleImg, Buffer.from(TINY_PNG_BASE64, "base64"));
    const mentionRes = buildPromptBlocks("分析 @chart.png 的问题", tmpDir, {
      supportsEmbeddedContext: true,
      supportsImage: true,
    });
    assert.equal(mentionRes.blocks.length, 2);
    assert.equal(mentionRes.blocks[1].type, "image");
    assert.equal(mentionRes.blocks[1].mimeType, "image/png");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("MultiAgentTracker tracks Swarm, Subagents, Board messages, and Artifacts with transparent multi-pane rendering", () => {
  const tracker = new MultiAgentTracker();

  tracker.ingestToolUpdate({
    toolCallId: "t_title",
    name: "swarm",
    rawInput: { action: "title", title: "Eval Pipeline" },
    status: "completed",
  });

  tracker.ingestToolUpdate({
    toolCallId: "t_add",
    name: "swarm",
    rawInput: {
      action: "add",
      name: "worker",
      tasks: ["Fix markdown table", "Verify tmux colors"],
      model: "gemini-4-neon",
      workspace: "share",
      brief: "Audit and fix rendering",
    },
    status: "completed",
  });

  tracker.ingestToolUpdate({
    toolCallId: "t_sub",
    name: "invoke_subagent",
    rawInput: {
      TypeName: "research",
      Role: "Codebase Researcher",
      Model: "inherit",
      Prompt: "Inspect ACP schema in src/acp",
    },
    status: "in_progress",
  });

  tracker.ingestToolUpdate({
    toolCallId: "t_art",
    name: "write_file",
    rawInput: {
      Path: "/tmp/brain/sess-1/implementation_plan.md",
      ArtifactMetadata: {
        Summary: "TUI architecture and protocol verification plan",
        UserFacing: true,
        RequestFeedback: false,
      },
    },
    status: "completed",
  });

  const counts = tracker.getSummaryCounts();
  assert.equal(counts.swarmTitle, "Eval Pipeline");
  assert.equal(counts.swarmCount, 2);
  assert.equal(counts.working, 2);
  assert.equal(counts.subagentsRunning, 1);
  assert.equal(counts.boardCount, 3); // 2 worker briefs + 1 subagent prompt
  assert.equal(counts.artifactCount, 1);

  for (const theme of listThemes()) {
    const style = createThemeStyler(theme.name, "truecolor");

    const dockRows = renderSwarmDock(tracker, 100, style, 1);
    assert.ok(dockRows.length > 0);
    for (const row of dockRows) {
      assert.equal(OPAQUE_BG_REGEX.test(row), false);
      assert.ok(displayWidth(row) <= 100);
    }

    // Wide split-pane board
    const wide = renderSwarmBoardView(tracker, { selectedIdx: 1, tab: "detail", scrollOffset: 0 }, 104, 24, style, 2);
    assert.equal(wide.rows.length, 24);
    for (const row of wide.rows) {
      assert.equal(OPAQUE_BG_REGEX.test(row), false, `Opaque bg in wide board (${theme.name})`);
      assert.ok(displayWidth(row) <= 104, `Wide board overflow: ${stripAnsi(row)}`);
    }

    // Narrow stacked board
    const narrow = renderSwarmBoardView(tracker, { selectedIdx: 0, tab: "board", scrollOffset: 0 }, 68, 20, style, 2);
    assert.equal(narrow.rows.length, 20);
    for (const row of narrow.rows) {
      assert.equal(OPAQUE_BG_REGEX.test(row), false, `Opaque bg in narrow board (${theme.name})`);
      assert.ok(displayWidth(row) <= 68, `Narrow board overflow: ${stripAnsi(row)}`);
    }
  }
});
