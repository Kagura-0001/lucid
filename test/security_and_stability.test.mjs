import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { ensureSecureBgDir, listLiveBgSessions, writeBgMeta } from "../src/acp/bg_registry.mjs";
import { StdioJsonRpc } from "../src/acp/jsonrpc.mjs";
import { selectBypassAllowOption } from "../src/acp/permissions.mjs";
import { LucidApp } from "../src/app.mjs";
import { getConfigLoadError, loadUserConfig, saveUserConfig } from "../src/config.mjs";
import { TerminalRenderer } from "../src/term/renderer.mjs";
import { sanitizeUntrustedText, stripAnsi } from "../src/term/unicode.mjs";
import { buildPromptBlocks } from "../src/ui/files.mjs";
import { renderLatexMath } from "../src/ui/math.mjs";
import { createSelection } from "../src/ui/selection.mjs";
import { createThemeStyler } from "../src/ui/themes.mjs";
import { classifyToolItem } from "../src/ui/tool_format.mjs";
import { applyOverlayModal, renderTimeline } from "../src/ui/views.mjs";

test("S1: pasted text starting with ! or / is sent to agent instead of executing locally", () => {
  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};

  let shellCalled = false;
  let cmdCalled = false;
  const sent = [];
  app.runLocalShellCommand = () => {
    shellCalled = true;
  };
  app.invokeLocalCommand = () => {
    cmdCalled = true;
  };
  app.sendUserPrompt = (full, display) => {
    sent.push({ full, display });
  };

  app.state.composer.insertPaste("!echo should-not-run\nline2\nline3\nline4\nline5");
  app.submitComposer();
  assert.equal(shellCalled, false, "pasted ! command must not invoke local shell");
  assert.equal(sent.length, 1);
  assert.ok(sent[0].full.startsWith("!echo should-not-run"));

  app.state.composer.insertPaste("/quit\nline2\nline3\nline4\nline5");
  app.submitComposer();
  assert.equal(cmdCalled, false, "pasted /command must not invoke local command");
  assert.equal(sent.length, 2);

  app.state.composer.setText("!echo typed-directly");
  app.submitComposer();
  assert.equal(shellCalled, true, "directly typed ! command invokes local shell");
});

test("S2: renderer.setTitle and session_info_update strip OSC/BEL control injections", () => {
  const writes = [];
  const sink = { columns: 80, rows: 24, write: (s) => writes.push(s) };
  const renderer = new TerminalRenderer(sink);

  renderer.setTitle("evil\x07\x1b]52;c;YQ==\x07ok");
  assert.equal(writes.length, 1);
  assert.ok(writes[0].startsWith("\x1b]0;lucid — "));
  assert.ok(writes[0].endsWith("\x07"));
  assert.equal(writes[0].includes("52;"), false);
  assert.equal(writes[0].slice(4, -1).includes("\x07"), false);

  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};
  const titleCalls = [];
  app.renderer.setTitle = (t) => titleCalls.push(t);
  app.state.sessionId = "s1";
  app.handleSessionUpdate({
    sessionId: "s1",
    update: { sessionUpdate: "session_info_update", title: "chat\x07\x1b]52;c;bad\x07title" },
  });
  assert.equal(titleCalls.length, 1);
  assert.equal(titleCalls[0].includes("\x1b"), false);
});

test("S3: bg_registry enforces 0700 dirs, 0600 files, rejects symlinks, and ignores .spec.json", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-sec-bg-"));
  try {
    const bgDir = path.join(tmpDir, "bg");
    fs.mkdirSync(bgDir, { mode: 0o755 });
    fs.chmodSync(bgDir, 0o755);

    ensureSecureBgDir(bgDir);
    assert.equal(fs.lstatSync(bgDir).mode & 0o777, 0o700);

    const linkPath = path.join(tmpDir, "bg-link");
    fs.symlinkSync(bgDir, linkPath);
    assert.throws(() => ensureSecureBgDir(linkPath), /Unsafe lucid runtime directory/);

    const meta = {
      hostId: "abcd1234abcd",
      pid: 99999999,
      socketPath: path.join(bgDir, "abcd1234abcd.sock"),
      cwd: tmpDir,
      startedAt: Date.now() - 60000,
    };
    writeBgMeta(meta, bgDir);
    const metaPath = path.join(bgDir, "abcd1234abcd.json");
    assert.equal(fs.lstatSync(metaPath).mode & 0o777, 0o600);

    const specPath = path.join(bgDir, "abcd1234abcd.spec.json");
    fs.writeFileSync(specPath, JSON.stringify({ hostId: "abcd1234abcd" }), { mode: 0o600 });

    const listed = listLiveBgSessions({ bgDir, allCwd: true, includeAttached: true });
    assert.equal(listed.length, 0);
    assert.equal(fs.existsSync(specPath), true, ".spec.json must not be parsed or deleted as meta");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("S4: buildPromptBlocks ignores @mentions inside collapsed pastes and blocks outside/symlink paths", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-s4-"));
  const workDir = path.join(tmpRoot, "repo");
  const outsideFile = path.join(tmpRoot, "outside.txt");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "secret.txt"), "PASTED_SECRET", "utf8");
  fs.writeFileSync(path.join(workDir, "ok.txt"), "SAFE_CONTENT", "utf8");
  fs.writeFileSync(outsideFile, "OUTSIDE_SECRET", "utf8");
  fs.symlinkSync(outsideFile, path.join(workDir, "escape.txt"));

  try {
    const pasteOnly = buildPromptBlocks("see @secret.txt details", workDir, {
      mentionSourceText: "see [Pasted text #1 +5 lines]",
    });
    assert.deepEqual(pasteOnly.attachedPaths, []);
    assert.equal(pasteOnly.blocks.length, 1);

    const typedTraversal = buildPromptBlocks("read @../outside.txt and @escape.txt and @ok.txt", workDir);
    assert.deepEqual(typedTraversal.attachedPaths, ["ok.txt"]);
    assert.equal(typedTraversal.blocks.length, 2);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("S5: sanitizeUntrustedText strips SGR-8 and bidi controls; permission preview indicates truncated lines", () => {
  const cleaned = sanitizeUntrustedText("ls \x1b[8mhidden\x1b[28m\u202eevil\nnext\tcol\x1b]52;c;YQ==\x07");
  assert.equal(cleaned, "ls hiddenevil\nnext\tcol");

  const style = createThemeStyler("tokyo-night", "truecolor");
  const viewport = new Array(20).fill("");
  const modal = {
    type: "permission",
    title: "Permission Approval",
    params: {
      title: "Run command",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
    },
    detailPreview: "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8",
    selected: 0,
  };
  const rendered = applyOverlayModal(viewport, 90, modal, style).map(stripAnsi).join("\n");
  assert.ok(rendered.includes("(+3 more lines)"), rendered);
});

test("S6/S7: selectBypassAllowOption prefers allow_once and rejects negative phrases; applyHostSnapshot resets bypass", () => {
  const picked = selectBypassAllowOption([
    { optionId: "dont", name: "Don't allow", kind: "reject_once" },
    { optionId: "always", name: "Allow always", kind: "allow_always" },
    { optionId: "once", name: "Allow once", kind: "allow_once" },
  ]);
  assert.equal(picked?.optionId, "once");

  const rejectedNegative = selectBypassAllowOption([
    { optionId: "deny", name: "Don't allow this tool" },
  ]);
  assert.equal(rejectedNegative, null);

  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};
  app.setSessionBypass(true);
  assert.equal(app.state.bypassPermissions, true);

  app.applyHostSnapshot({
    sessionId: "non-bypass-sess",
    bypassPermissions: false,
    eventLog: [],
  });
  assert.equal(app.state.sessionBypass, false);
  assert.equal(app.state.bypassPermissions, false);
});

test("R1/R11/R12: /resume failure catches cleanly and rolls back previous session; /new resets selection and mode", async () => {
  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};
  let closed = [];
  let modeCalls = [];
  let cancelledPerm = 0;

  app.state.connected = true;
  app.state.sessionId = "sess-prev";
  app.state.items = [{ type: "user", text: "keep me" }];
  app.state.modes = [{ id: "default", name: "Default" }, { id: "auto", name: "Auto" }];
  app.state.modeId = "default";
  app.startupOverridesApplied = true;
  app.userConfig.mode = "auto";

  app.acp = {
    agentCapabilities: { loadSession: true, sessionCapabilities: { list: true, load: true } },
    supportsSessionList: () => true,
    supportsSessionLoad: () => true,
    supportsSessionResume: () => false,
    listSessions: async () => [{ sessionId: "bad-id", title: "Broken" }],
    loadSession: async () => {
      throw new Error("corrupt session");
    },
    closeSession: async (id) => closed.push(id),
    createSession: async () => ({ sessionId: "sess-fresh", modes: { currentModeId: "default", availableModes: app.state.modes } }),
    setMode: async (_sid, id) => {
      modeCalls.push(id);
      return {};
    },
  };

  app.state.composer.setText("/resume bad-id");
  app.submitComposer();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(app.state.sessionId, "sess-prev");
  assert.equal(closed.length, 0, "failed switch must not close previous session");
  assert.ok(app.state.items.some((i) => i.text === "keep me"));
  assert.ok(app.state.items.some((i) => i.type === "notice" && i.text.includes("corrupt session")));

  app.selection = createSelection(1, 0);
  app.permissionQueue.push({ cancel: () => { cancelledPerm += 1; }, selectOption: () => {}, params: {} });
  await app.runLocalCommand("new", "");
  assert.equal(app.state.sessionId, "sess-fresh");
  assert.equal(app.selection, null);
  assert.equal(cancelledPerm, 1);
  assert.deepEqual(modeCalls, ["auto"]);
});

test("R2/R3/R4: JSON-RPC handles null and stdin errors safely; deep/prototype math & themes do not crash", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const rpc = new StdioJsonRpc(stdin, stdout);

  let closedErr = null;
  rpc.on("close", (err) => {
    closedErr = err;
  });

  stdout.write("null\n");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rpc.closed, false);

  stdin.destroy(new Error("EPIPE simulated"));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(rpc.closed, true);
  assert.ok(closedErr?.message.includes("EPIPE simulated"));

  const deepExpr = "{".repeat(5000) + "x" + "}".repeat(5000);
  assert.doesNotThrow(() => renderLatexMath(deepExpr));
  assert.equal(renderLatexMath("\\constructor"), "constructor");
  assert.equal(createThemeStyler("constructor").name, "transparent");
});

test("R10/R13/R14/perf: UTF-8 shell, cumulative tool updates, corrupt config protection, read-only guard, cached timeline", async () => {
  const app = new LucidApp({ cwd: "/tmp" });
  app.scheduleRender = () => {};

  // R10: UTF-8 CJK shell output
  app.state.composer.setText("!printf '你好世界\\n'");
  app.submitComposer();
  const deadline = Date.now() + 3000;
  while (app.activeLocalShell && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 15));
  }
  const shItem = app.state.items.find((i) => i.type === "shell");
  assert.equal(shItem?.output.trim(), "你好世界");

  // R13: cumulative tool_call_update replaces instead of duplicating
  app.applyToolUpdate({
    toolCallId: "cum1",
    name: "run_command",
    status: "in_progress",
    content: [{ type: "text", text: "step 1\nstep 2" }],
  });
  app.applyToolUpdate({
    toolCallId: "cum1",
    name: "run_command",
    status: "completed",
    content: [{ type: "text", text: "step 1\nstep 2\nstep 3" }],
  });
  assert.equal(app.toolMap.get("cum1")?.outputText, "step 1\nstep 2\nstep 3");

  // R14: corrupt config.json is never overwritten by saveUserConfig
  const tmpConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-cfg-"));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = tmpConfigHome;
    const cfgDir = path.join(tmpConfigHome, "lucid");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, "config.json");
    const broken = "{ \"customAgents\": { }, }";
    fs.writeFileSync(cfgPath, broken, "utf8");

    const loaded = loadUserConfig();
    assert.ok(getConfigLoadError(loaded));
    assert.equal(saveUserConfig(loaded), false);
    assert.equal(fs.readFileSync(cfgPath, "utf8"), broken);
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    fs.rmSync(tmpConfigHome, { recursive: true, force: true });
  }

  // Read-only explore guard on mutating commands
  for (const dangerous of [
    "find . -name '*.tmp' -delete",
    "sed -n -i 's/a/b/' file.txt",
    "git branch -D old-branch",
    "cat a 2>err.log",
  ]) {
    const info = classifyToolItem({ name: "run_command", kind: "execute", title: dangerous, status: "completed" });
    assert.equal(info.isExplore, false, `${dangerous} must not be classified as read-only explore`);
  }

  // Performance: 500 completed tools render fast on warm frames
  const items = [{ type: "user", text: "first turn" }];
  for (let i = 0; i < 500; i += 1) {
    items.push({
      type: "tool",
      toolCallId: `p_${i}`,
      title: `Read file_${i}.mjs`,
      kind: "read",
      status: "completed",
      durationMs: 10,
      outputText: "line\n".repeat(20),
      _rev: 0,
    });
  }
  items.push({ type: "user", text: "second turn" }, { type: "assistant", streaming: false, text: "Done." });
  const style = createThemeStyler("tokyo-night", "truecolor");
  const state = { cwd: "/tmp", items, thoughtMode: "fold", expandTools: false, spinnerFrame: 0 };
  renderTimeline(state, 100, style);
  const t0 = performance.now();
  renderTimeline(state, 100, style);
  const warmMs = performance.now() - t0;
  assert.ok(warmMs < 20, `Expected warm renderTimeline for 500 tools < 20ms, got ${warmMs.toFixed(2)}ms`);
});
