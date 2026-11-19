import assert from "node:assert/strict";
import test from "node:test";
import { LucidApp } from "../src/app.mjs";
import { parseCliArgs } from "../src/config.mjs";

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
