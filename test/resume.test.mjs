import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractUserRequestText, readSessionTranscriptPreview } from "../src/acp/agy_state.mjs";
import { LucidApp } from "../src/app.mjs";
import { parseCliArgs } from "../src/config.mjs";
import { stripAnsi } from "../src/term/unicode.mjs";
import { createThemeStyler } from "../src/ui/themes.mjs";
import { applyOverlayModal } from "../src/ui/views.mjs";

const SAMPLE_SESSIONS = [
  {
    sessionId: "sess-alpha",
    cwd: "/tmp/demo",
    title: "Alpha discussion",
    updatedAt: "2026-11-19T12:00:00Z",
  },
  {
    sessionId: "sess-beta-99",
    cwd: "/tmp/demo",
    title: "Beta cleanup",
    updatedAt: "2026-11-19T11:00:00Z",
  },
];

function createTestApp(cliOptions = {}, { sessions = SAMPLE_SESSIONS } = {}) {
  const app = new LucidApp({ cwd: "/tmp/demo", ...cliOptions });
  app.scheduleRender = () => {};

  const calls = {
    created: 0,
    loaded: [],
    resumed: [],
    closed: [],
  };

  app.acp = {
    agentCapabilities: {},
    supportsSessionList: () => true,
    supportsSessionLoad: () => true,
    supportsSessionResume: () => true,
    listSessions: async () => sessions,
    createSession: async () => {
      calls.created += 1;
      return { sessionId: `sess-new-${calls.created}` };
    },
    loadSession: async (sessionId) => {
      calls.loaded.push(sessionId);
      return {};
    },
    resumeSession: async (sessionId) => {
      calls.resumed.push(sessionId);
      return {};
    },
    closeSession: async (sessionId) => {
      calls.closed.push(sessionId);
    },
    setMode: async () => ({}),
    setModel: async () => ({}),
  };
  app.state.connected = true;

  return { app, calls };
}

test("parseCliArgs parses -r, --resume, --resume=<id>, -c, and -s cleanly", () => {
  assert.equal(parseCliArgs(["-r"]).resumePicker, true);
  assert.equal(parseCliArgs(["-r"]).session, undefined);

  assert.equal(parseCliArgs(["--resume"]).resumePicker, true);

  const withNextFlag = parseCliArgs(["--resume", "--theme", "tokyo-night"]);
  assert.equal(withNextFlag.resumePicker, true);
  assert.equal(withNextFlag.session, undefined);
  assert.equal(withNextFlag.theme, "tokyo-night");

  const shortWithId = parseCliArgs(["-r", "sess-123"]);
  assert.equal(shortWithId.session, "sess-123");
  assert.equal(Boolean(shortWithId.resumePicker), false);

  const longWithId = parseCliArgs(["--resume", "sess-123"]);
  assert.equal(longWithId.session, "sess-123");
  assert.equal(Boolean(longWithId.resumePicker), false);

  const eqWithId = parseCliArgs(["--resume=sess-123"]);
  assert.equal(eqWithId.session, "sess-123");
  assert.equal(Boolean(eqWithId.resumePicker), false);

  const eqEmpty = parseCliArgs(["--resume="]);
  assert.equal(eqEmpty.resumePicker, true);
  assert.equal(eqEmpty.session, undefined);

  assert.equal(parseCliArgs(["-c"]).continueLatest, true);
  assert.equal(parseCliArgs(["-s", "sess-999"]).session, "sess-999");
});

test("slash autocomplete popup exposes both /resume and /sessions", () => {
  const { app } = createTestApp();

  app.state.composer.setText("/res");
  app.updatePopupState();
  assert.equal(app.popup?.kind, "slash");
  assert.ok(app.popup.items.some((item) => item.label === "/resume"));

  app.state.composer.setText("/ses");
  app.updatePopupState();
  assert.equal(app.popup?.kind, "slash");
  assert.ok(app.popup.items.some((item) => item.label === "/sessions"));
});

test("/resume opens picker, supports exact/prefix session ID, and pre-filters by title", async () => {
  const { app, calls } = createTestApp();
  app.state.sessionId = "sess-initial";

  await app.runLocalCommand("resume", "");
  assert.equal(app.modal?.type, "picker");
  assert.equal(app.modal?.title, "Resume Conversation");
  assert.equal(app.modal?.filteredItems.length, 2);

  app.modal = null;
  await app.runLocalCommand("resume", "sess-alpha");
  assert.equal(app.modal, null);
  assert.equal(app.state.sessionId, "sess-alpha");
  assert.deepEqual(calls.loaded, ["sess-alpha"]);
  assert.deepEqual(calls.closed, ["sess-initial"]);

  await app.runLocalCommand("resume", "sess-b");
  assert.equal(app.modal, null);
  assert.equal(app.state.sessionId, "sess-beta-99");
  assert.deepEqual(calls.loaded, ["sess-alpha", "sess-beta-99"]);

  await app.runLocalCommand("resume", "Alpha");
  assert.equal(app.modal?.type, "picker");
  assert.equal(app.modal?.filter, "Alpha");
  assert.equal(app.modal?.filteredItems.length, 1);
  assert.equal(app.modal?.filteredItems[0].value, "sess-alpha");
});

test("startup --resume opens picker without creating a session, and Escape falls back to fresh session", async () => {
  const { app, calls } = createTestApp({ resumePicker: true });

  await app.openInitialSession();
  assert.equal(calls.created, 0);
  assert.equal(app.state.sessionId, null);
  assert.equal(app.modal?.type, "picker");
  assert.equal(app.modal?.title, "Resume Conversation");

  app.handleModalInput({ type: "key", name: "escape" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(app.modal, null);
  assert.equal(calls.created, 1);
  assert.equal(app.state.sessionId, "sess-new-1");
});

test("/resume sorts strictly by updatedAt descending, keeps cursor at newest, and toggles cwd/all via Tab and Ctrl+A", async () => {
  const mixedSessions = [
    { sessionId: "sess-old-here", cwd: "/tmp/demo", title: "Older local", updatedAt: "2026-11-19T10:00:00Z" },
    { sessionId: "sess-mid-here", cwd: "/tmp/demo", title: "Middle local", updatedAt: "2026-11-21T10:00:00Z" },
    { sessionId: "sess-new-other", cwd: "/tmp/other", title: "Newest elsewhere", updatedAt: "2026-11-23T12:00:00Z" },
    { sessionId: "sess-mid-other", cwd: "/tmp/other", title: "Mid elsewhere", updatedAt: "2026-11-20T10:00:00Z" },
  ];
  const { app } = createTestApp({}, { sessions: mixedSessions });
  app.state.sessionId = "sess-old-here";

  await app.runLocalCommand("resume", "");
  assert.equal(app.modal?.type, "picker");
  assert.equal(app.modal?.layout, "cards");
  // Default scope filters to current cwd, sorted strictly newest first, cursor at 0 even when active is older.
  assert.equal(app.modal.scopeFilter?.active, "cwd");
  assert.deepEqual(
    app.modal.filteredItems.map((i) => i.value),
    ["sess-mid-here", "sess-old-here"],
  );
  assert.equal(app.modal.selected, 0);

  // Tab toggles to all dirs, strictly sorted by recency across directories.
  app.handleModalInput({ type: "key", name: "tab" });
  assert.equal(app.modal.scopeFilter?.active, "all");
  assert.deepEqual(
    app.modal.filteredItems.map((i) => i.value),
    ["sess-new-other", "sess-mid-here", "sess-mid-other", "sess-old-here"],
  );
  assert.equal(app.modal.selected, 0);

  // Ctrl+A toggles back to current dir.
  app.handleModalInput({ type: "key", name: "a", ctrl: true });
  assert.equal(app.modal.scopeFilter?.active, "cwd");
  assert.deepEqual(
    app.modal.filteredItems.map((i) => i.value),
    ["sess-mid-here", "sess-old-here"],
  );
});

test("/resume falls back to all dirs when current workspace has no saved sessions", async () => {
  const onlyOther = [
    { sessionId: "sess-other-1", cwd: "/tmp/other", title: "Other dir work", updatedAt: "2026-11-22T09:00:00Z" },
  ];
  const { app } = createTestApp({}, { sessions: onlyOther });

  await app.runLocalCommand("resume", "");
  assert.equal(app.modal?.scopeFilter?.active, "all");
  assert.equal(app.modal?.filteredItems.length, 1);
  assert.equal(app.modal?.filteredItems[0].value, "sess-other-1");
});

test("extractUserRequestText and readSessionTranscriptPreview enrich /resume cards and search", async () => {
  assert.equal(
    extractUserRequestText(
      "<USER_REQUEST>\nFix /resume ordering\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>",
    ),
    "Fix /resume ordering",
  );

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-resume-preview-"));
  try {
    const logDir = path.join(tmpRoot, "brain", "sess-alpha", ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "transcript.jsonl"),
      [
        JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>\nFirst question\n</USER_REQUEST>" }),
        JSON.stringify({ type: "PLANNER_RESPONSE", content: "Sure" }),
        JSON.stringify({
          type: "USER_INPUT",
          content: "<USER_REQUEST>\nCodec WDS 合并进 OV2.1 的报错怎么修\n</USER_REQUEST>\n<ADDITIONAL_METADATA>t</ADDITIONAL_METADATA>",
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const preview = readSessionTranscriptPreview(tmpRoot, "sess-alpha");
    assert.equal(preview?.userTurnCount, 2);
    assert.equal(preview?.exactTurnCount, true);
    assert.equal(preview?.lastUserPrompt, "Codec WDS 合并进 OV2.1 的报错怎么修");

    const { app } = createTestApp();
    app.agyStateWatcher = { dataDir: tmpRoot };
    await app.runLocalCommand("resume", "");

    const first = app.modal.filteredItems[0];
    assert.equal(first.preview, "Codec WDS 合并进 OV2.1 的报错怎么修");
    assert.deepEqual(first.metaParts, ["2 msgs"]);

    // Multi-word filter matches across title and latest user prompt preview
    app.handleModalInput({ type: "text", text: "wds 报错" });
    assert.equal(app.modal.filteredItems.length, 1);
    assert.equal(app.modal.filteredItems[0].value, "sess-alpha");

    // Ctrl+U clears filter cleanly
    app.handleModalInput({ type: "key", name: "u", ctrl: true });
    assert.equal(app.modal.filter, "");
    assert.equal(app.modal.filteredItems.length, 2);

    // Card layout renders 2-line items with preview and footer cleanly
    const style = createThemeStyler("transparent", 24);
    const frame = applyOverlayModal(new Array(24).fill(""), 100, app.modal, style);
    const plain = frame.map(stripAnsi).join("\n");
    assert.match(plain, /Alpha discussion/);
    assert.match(plain, /2 msgs/);
    assert.match(plain, /Codec WDS 合并进 OV2\.1/);
    assert.match(plain, /Enter resume/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("-c / --continue picks the newest session in current cwd by updatedAt even if list is unsorted", async () => {
  const unsorted = [
    { sessionId: "sess-older", cwd: "/tmp/demo", title: "Older", updatedAt: "2026-11-19T10:00:00Z" },
    { sessionId: "sess-other-newest", cwd: "/tmp/other", title: "Other newest", updatedAt: "2026-11-23T15:00:00Z" },
    { sessionId: "sess-here-newest", cwd: "/tmp/demo", title: "Here newest", updatedAt: "2026-11-22T18:00:00Z" },
  ];
  const { app, calls } = createTestApp({ continueLatest: true }, { sessions: unsorted });

  await app.openInitialSession();
  assert.deepEqual(calls.loaded, ["sess-here-newest"]);
});

test("switchToSession reports -32002 cleanly without resumeSession fallback, and readSessionTranscriptPreview caches by mtime/size", async () => {
  const { switchToSession } = await import("../src/app/session.mjs");
  const app = new LucidApp({ cwd: "/tmp/demo" });
  app.scheduleRender = () => {};
  app.state.sessionId = "sess-prev";
  app.state.items = [{ type: "user", text: "Existing item" }];

  let resumeCalls = 0;
  app.acp = {
    supportsSessionLoad: () => true,
    supportsSessionResume: () => true,
    loadSession: async () => {
      const err = new Error("Session not found");
      err.code = -32002;
      throw err;
    },
    resumeSession: async () => {
      resumeCalls += 1;
      return {};
    },
  };

  await assert.rejects(
    () => switchToSession(app, "missing-sess-123"),
    (err) => err?.code === -32002 && /was not found/i.test(err.message),
  );
  assert.equal(resumeCalls, 0, "-32002 must not trigger redundant resumeSession fallback");
  assert.equal(app.state.sessionId, "sess-prev", "previous session state must be restored");
  assert.equal(app.state.items.length, 1);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-preview-cache-"));
  try {
    const logDir = path.join(tmpRoot, "brain", "sess-cache", ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, "transcript.jsonl");
    fs.writeFileSync(
      logPath,
      JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>\nFirst prompt\n</USER_REQUEST>" }) + "\n",
      "utf8",
    );

    const p1 = readSessionTranscriptPreview(tmpRoot, "sess-cache");
    const p2 = readSessionTranscriptPreview(tmpRoot, "sess-cache");
    assert.equal(p2, p1, "unchanged transcript should return cached preview object");

    fs.appendFileSync(
      logPath,
      JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>\nSecond prompt\n</USER_REQUEST>" }) + "\n",
      "utf8",
    );
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(logPath, future, future);

    const p3 = readSessionTranscriptPreview(tmpRoot, "sess-cache");
    assert.notEqual(p3, p1);
    assert.equal(p3?.userTurnCount, 2);
    assert.equal(p3?.lastUserPrompt, "Second prompt");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
