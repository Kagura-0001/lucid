import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgyStateWatcher, resolveAgyDataDir, summarizePlan, summarizeTranscriptTail } from "../src/acp/agy_state.mjs";
import { stripAnsi } from "../src/term/unicode.mjs";
import { MultiAgentTracker, renderMemberTimeline, renderSwarmBoardView, renderSwarmDock } from "../src/ui/swarm.mjs";
import { createThemeStyler } from "../src/ui/themes.mjs";

const SESSION = "11111111-aaaa-bbbb-cccc-000000000001";
const SUBAGENT = "22222222-aaaa-bbbb-cccc-000000000002";
const WORKER_A = "33333333-aaaa-bbbb-cccc-000000000003";
const WORKER_B = "44444444-aaaa-bbbb-cccc-000000000004";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writeTranscript(dataDir, conversationId, steps) {
  const filePath = path.join(dataDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, steps.map((step) => JSON.stringify(step)).join("\n") + "\n");
}

/** Builds a fixture with the same layout agy writes (verified against a live session). */
function buildFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-agy-"));
  const sys = path.join(dataDir, "brain", SESSION, ".system_generated");

  writeJson(path.join(sys, "subagents", `${SUBAGENT}.json`), {
    conversationId: SUBAGENT,
    subagentDescriptor: { typeName: "research", role: "Tmp Lister" },
    state: "SUBAGENT_STATE_ALIVE",
  });
  // Swarm workers are also registered as subagents; they must not be listed twice.
  writeJson(path.join(sys, "subagents", `${WORKER_A}.json`), {
    conversationId: WORKER_A,
    subagentDescriptor: { typeName: "swarm_worker", role: "Swarm Worker (parser)" },
    state: "SUBAGENT_STATE_ALIVE",
  });
  writeJson(path.join(sys, "messages", "m1.json"), {
    id: "m1",
    recipient: SESSION,
    sender: SUBAGENT,
    timestamp: "2026-11-21T14:35:46.5Z",
    renderDetails: { messageTitle: "Message from Tmp Lister (research)" },
    content: "TMP-OK",
  });
  writeJson(path.join(sys, "messages", "m2.json"), {
    id: "m2",
    sender: "system",
    timestamp: "2026-11-21T14:36:17Z",
    content: "[Notice] stopped",
  });
  writeJson(path.join(sys, "swarm", "members.json"), {
    title: "parser rewrite",
    members: {
      coordinator: { conversation_id: SESSION, role: "coordinator", phase: "RUNNING" },
      parser: { conversation_id: WORKER_A, role: "worker", phase: "RUNNING", killed: false, model: "neon" },
      verifier: { conversation_id: WORKER_B, role: "worker", phase: "RUNNING", killed: false, model: "neon" },
      docs: { conversation_id: "55555555-x", role: "worker", phase: "KILLED", killed: true },
    },
  });
  writeJson(path.join(sys, "swarm", "plan.json"), { goal: { title: "Rewrite" }, tasks: { parser: "Fix lexer" } });
  fs.writeFileSync(
    path.join(sys, "swarm", "board.jsonl"),
    [
      { seq: 1, agent: "coordinator", text: "@parser You own src/parser.rs", time: "2026-11-21 22:30:20", kind: "brief" },
      { seq: 2, agent: "parser", text: "@coordinator [done] lexer fixed", time: "2026-11-21 22:31:00" },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n",
  );

  // Subagent finished its turn after replying.
  writeTranscript(dataDir, SUBAGENT, [
    { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "send_message", args: { Message: "\"TMP-OK\"" } }] },
    { step_index: 2, type: "GENERIC", status: "DONE" },
    { step_index: 3, type: "PLANNER_RESPONSE", content: "TMP-OK" },
  ]);
  // parser is running a command right now.
  writeTranscript(dataDir, WORKER_A, [
    { step_index: 4, type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "\"cargo test -p parser\"" } }] },
  ]);
  // verifier is parked on the board.
  writeTranscript(dataDir, WORKER_B, [
    { step_index: 9, type: "PLANNER_RESPONSE", tool_calls: [{ name: "swarm_wait", args: { since: "2" } }] },
  ]);
  return dataDir;
}

test("summarizeTranscriptTail distinguishes working, waiting and idle", () => {
  assert.equal(summarizeTranscriptTail([{ type: "PLANNER_RESPONSE", content: "done" }]).phase, "idle");
  const parked = summarizeTranscriptTail([{ type: "PLANNER_RESPONSE", tool_calls: [{ name: "swarm_wait", args: {} }] }]);
  assert.equal(parked.phase, "waiting");
  const reading = summarizeTranscriptTail([
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "read_file", args: { AbsolutePath: "\"/repo/src/app.mjs\"" } }] },
  ]);
  assert.equal(reading.phase, "working");
  assert.equal(reading.activity, "read_file app.mjs");
  assert.equal(summarizeTranscriptTail([{ type: "GENERIC", status: "DONE" }]).activity, "thinking");

  // Compact transcripts truncate long arguments, leaving invalid JSON strings.
  const truncated = summarizeTranscriptTail([
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "\"python - <<'PY'\\nimport os, json" } }] },
  ]);
  assert.equal(truncated.activity, "run_command python - <<'PY'");
});

test("resolveAgyDataDir honours --app-data-dir and config override", () => {
  assert.equal(resolveAgyDataDir([], "/custom"), "/custom");
  assert.equal(resolveAgyDataDir(["acp", "--app-data-dir", "/abs/dir"]), "/abs/dir");
  assert.ok(resolveAgyDataDir(["acp"]).endsWith(path.join(".gemini", "antigravity-cli")));
});

test("AgyStateWatcher reads live swarm + subagent state and the strip names members", () => {
  const dataDir = buildFixture();
  try {
    const watcher = new AgyStateWatcher({ dataDir });
    watcher.setSession(SESSION);
    const snapshot = watcher.poll();
    assert.ok(snapshot);
    assert.equal(watcher.poll(), null, "an unchanged directory produces no new snapshot");

    assert.equal(snapshot.swarmTitle, "parser rewrite");
    assert.equal(snapshot.planSummary.totalTasks, 1);
    assert.equal(snapshot.planSummary.doneTasks, 1);
    const workerStates = Object.fromEntries(snapshot.workers.map((worker) => [worker.name, worker.state]));
    assert.deepEqual(workerStates, { parser: "working", verifier: "waiting", docs: "killed" });
    assert.equal(snapshot.workers.find((worker) => worker.name === "parser").activity, "run_command cargo test -p parser");

    assert.equal(snapshot.subagents.length, 1, "swarm workers are not duplicated as subagents");
    assert.equal(snapshot.subagents[0].role, "Tmp Lister");
    assert.equal(snapshot.subagents[0].state, "completed");
    assert.equal(snapshot.subagents[0].reply, "TMP-OK");
    assert.equal(snapshot.messages.length, 1, "system notices are not shown as agent messages");

    const tracker = new MultiAgentTracker();
    // The invoke_subagent tool call arrives first via ACP; it must merge with the disk entry.
    tracker.ingestToolUpdate({
      toolCallId: "call_1",
      name: "invoke_subagent",
      rawInput: { TypeName: "research", Role: "Tmp Lister", Prompt: "Reply TMP-OK" },
      status: "completed",
    });
    assert.equal([...tracker.subagents.values()][0].state, "running", "launch completing does not mean the subagent finished");

    tracker.applyAgyState(snapshot);
    assert.equal(tracker.subagents.size, 1);
    const sub = [...tracker.subagents.values()][0];
    assert.equal(sub.brief, "Reply TMP-OK");
    assert.equal(sub.state, "completed");
    assert.equal(tracker.workers.get("parser").brief, "You own src/parser.rs");
    assert.deepEqual(tracker.boardMessages.map((message) => message.from), ["coordinator", "parser", "Tmp Lister"]);

    const style = createThemeStyler("tokyo-night", "truecolor");
    const dock = renderSwarmDock(tracker, 140, style, 0).map(stripAnsi).join("\n");
    assert.ok(dock.includes('Swarm "parser rewrite"'), dock);
    assert.ok(dock.includes("1/1 tasks"), dock);
    assert.ok(dock.includes("parser"), dock);
    assert.ok(dock.includes("run_command cargo test"), dock);
    assert.ok(dock.includes("verifier"), dock);
    assert.ok(dock.includes("Tmp Lister"), dock);
    assert.equal(dock.includes("docs"), false, "killed workers are left off the dock");

    const board = renderSwarmBoardView(tracker, { selectedIdx: 1, tab: "detail", scrollOffset: 0 }, 120, 20, style, 0);
    const boardText = board.rows.map(stripAnsi).join("\n");
    assert.ok(boardText.includes("Now: run_command cargo test -p parser"), boardText);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("summarizePlan derives string-task and thread progress from board.jsonl posts", () => {
  const plan = {
    goal: { title: "Ship feature", line: "Build, test, document." },
    tasks: { a: "Build module", b: "Run e2e suite", c: "Write docs" },
    threads: [
      { id: "t1", title: "Core", goal: "Build and test", tasks: ["a", "b"] },
      { id: "t2", title: "Docs", goal: "Update reference", tasks: ["c"] },
    ],
  };
  const board = [
    { seq: 1, kind: "brief", agent: "coordinator", text: "@a build" },
    { seq: 2, kind: "brief", agent: "coordinator", text: "@c docs" },
    { seq: 3, agent: "a", text: "@coordinator [done] built module" },
    { seq: 4, agent: "b", text: "@coordinator [blocked] missing fixture" },
    { seq: 5, agent: "c", text: "@coordinator [done] draft ready" },
    { seq: 6, kind: "brief", agent: "coordinator", text: "@c expand examples" },
  ];
  const workers = [
    { name: "a", state: "waiting" },
    { name: "b", state: "waiting" },
    { name: "c", state: "working" },
  ];
  const summary = summarizePlan(plan, board, workers);
  assert.equal(summary.totalTasks, 3);
  assert.equal(summary.doneTasks, 1);
  assert.equal(summary.blockedTasks, 1);
  assert.equal(summary.threads[0].status, "failed");
  assert.equal(summary.threads[0].detail, "Build and test");
  assert.equal(summary.threads[1].status, "working");
});

test("non-RUNNING workers keep transcript steps/output, dock shows [done] summary, and board sticks to bottom", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucid-swarm-res-"));
  try {
    const sys = path.join(dataDir, "brain", SESSION, ".system_generated");
    writeJson(path.join(sys, "swarm", "members.json"), {
      title: "telemetry",
      members: {
        alpha: { conversation_id: WORKER_A, role: "worker", phase: "WAITING", killed: false, model: "neon" },
      },
    });
    writeJson(path.join(sys, "swarm", "plan.json"), {
      goal: { title: "Add telemetry" },
      tasks: { alpha: "Implement exporter" },
    });
    const boardLines = [
      { seq: 1, agent: "coordinator", text: "@alpha Build exporter", time: "2026-11-22 10:00:00", kind: "brief" },
      ...Array.from({ length: 28 }, (_, i) => ({
        seq: i + 2,
        agent: "alpha",
        text: `@coordinator progress step ${i + 2}`,
        time: "2026-11-22 10:01:00",
      })),
      { seq: 30, agent: "alpha", text: "@coordinator [done] Built exporter + tests", time: "2026-11-22 10:05:00" },
    ];
    fs.writeFileSync(
      path.join(sys, "swarm", "board.jsonl"),
      boardLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    );
    writeTranscript(dataDir, WORKER_A, [
      { step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "read_file", args: { Path: "\"src/exp.mjs\"" } }] },
      { step_index: 2, type: "GENERIC", status: "DONE" },
      { step_index: 3, type: "PLANNER_RESPONSE", content: "Exporter implemented cleanly." },
    ]);

    const watcher = new AgyStateWatcher({ dataDir });
    watcher.setSession(SESSION);
    const snapshot = watcher.poll();
    assert.ok(snapshot);
    assert.equal(snapshot.workers[0].state, "waiting");
    assert.equal(snapshot.workers[0].activity, "");
    assert.ok(snapshot.workers[0].recentSteps.length >= 2);
    assert.equal(snapshot.workers[0].lastText, "Exporter implemented cleanly.");

    const tracker = new MultiAgentTracker();
    tracker.applyAgyState(snapshot);
    const style = createThemeStyler("transparent", "truecolor");

    const dockText = renderSwarmDock(tracker, 100, style, 0).map(stripAnsi).join("\n");
    assert.ok(dockText.includes("[done] Built exporter + tests"), dockText);

    const alpha = tracker.getMemberById("swarm:alpha");
    const memberTimeline = renderMemberTimeline(alpha, 100, style, 0).map(stripAnsi).join("\n");
    assert.ok(memberTimeline.includes("Latest Board Post"), memberTimeline);
    assert.ok(memberTimeline.includes("Built exporter + tests"), memberTimeline);
    assert.ok(memberTimeline.includes("Exporter implemented cleanly."), memberTimeline);

    const detailBoard = renderSwarmBoardView(tracker, { selectedIdx: 1, tab: "detail", scrollOffset: 0 }, 110, 24, style, 0);
    const detailText = detailBoard.rows.map(stripAnsi).join("\n");
    assert.ok(detailText.includes("Latest Board Post"), detailText);
    assert.ok(detailText.includes("Built exporter + tests"), detailText);

    const feedBoard = renderSwarmBoardView(
      tracker,
      { selectedIdx: 0, tab: "board", scrollOffset: 0, stickToBottom: true },
      110,
      16,
      style,
      0,
    );
    assert.ok(feedBoard.maxDetailScroll > 0);
    assert.equal(feedBoard.scrollOffset, feedBoard.maxDetailScroll);
    const feedText = feedBoard.rows.map(stripAnsi).join("\n");
    assert.ok(feedText.includes("[done] Built exporter + tests"), feedText);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("agy-sync probe_agy.mjs --no-live-acp --json produces structured output", () => {
  const out = execFileSync(
    process.execPath,
    [".agents/skills/agy-sync/scripts/probe_agy.mjs", "--no-live-acp", "--json"],
    { cwd: path.resolve("."), encoding: "utf8" },
  );
  const parsed = JSON.parse(out);
  assert.ok(Array.isArray(parsed.current?.acpFlags));
  assert.ok(Array.isArray(parsed.current?.cliSubcommands));
  assert.equal(typeof parsed.diffs?.hasChanges, "boolean");
});

test("subagent state flips to killed when agy rewrites its state file", () => {
  const dataDir = buildFixture();
  try {
    const watcher = new AgyStateWatcher({ dataDir });
    watcher.setSession(SESSION);
    watcher.poll();
    const recordPath = path.join(dataDir, "brain", SESSION, ".system_generated", "subagents", `${SUBAGENT}.json`);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.state = "SUBAGENT_STATE_KILLED";
    fs.writeFileSync(recordPath, JSON.stringify(record));
    const next = watcher.poll();
    assert.ok(next, "state change is detected even without a directory mtime change");
    assert.equal(next.subagents[0].state, "killed");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("define_subagent / manage_subagents never become phantom subagents, parked swarm_wait is waiting, and duplicate tool-call subagents reconcile", () => {
  // 1. Completed swarm_wait GENERIC step must report waiting, not thinking/working.
  const parked = summarizeTranscriptTail([
    { type: "PLANNER_RESPONSE", tool_calls: [{ name: "swarm_wait", args: { since: "69" } }] },
    { type: "GENERIC", status: "DONE", content: "Waiting for any message posted after #69." },
  ]);
  assert.equal(parked.phase, "waiting");
  assert.equal(parked.activity, "waiting on board");

  // 2. Server-restart notice must report idle, not thinking.
  const stopped = summarizeTranscriptTail([
    { type: "SYSTEM_MESSAGE", status: "DONE", content: "[Notice] All your subagents and background tasks have been stopped due to server restart." },
  ]);
  assert.equal(stopped.phase, "idle");

  // 3. define_subagent and manage_subagents must not create phantom running subagents.
  const tracker = new MultiAgentTracker();
  tracker.ingestToolUpdate({
    toolCallId: "def_1",
    name: "define_subagent",
    title: "Run define_subagent",
    status: "completed",
  });
  tracker.ingestToolUpdate({
    toolCallId: "mgr_1",
    name: "manage_subagents",
    title: "Run manage_subagents",
    rawInput: { Action: "list" },
    status: "completed",
  });
  assert.equal(tracker.subagents.size, 0);

  // 4. Reconciling tool-call subagent whose conversationId was already parsed OR already exists under conv:.
  tracker.ingestToolUpdate({
    toolCallId: "sub_call_1",
    name: "invoke_subagent",
    title: "Run invoke_subagent",
    rawInput: { TypeName: "research", Role: "RL Surveyor", Prompt: "Audit PO" },
    content: [{ type: "text", text: 'conversationId: "7eb23c3d-1111-2222-3333-444444444444"' }],
    status: "completed",
  });
  tracker.applyAgyState({
    swarmTitle: "Codec WDS",
    workers: [],
    subagents: [
      {
        conversationId: "7eb23c3d-1111-2222-3333-444444444444",
        role: "RL Surveyor",
        typeName: "research",
        state: "completed",
        activity: "",
        reply: "Done",
        startedAt: Date.now() - 60000,
        updatedAt: Date.now() - 10000,
      },
    ],
    board: [],
    messages: [],
  });
  assert.equal(tracker.subagents.size, 1);
  assert.equal(tracker.getSummaryCounts().subagentsRunning, 0);
  const reconciled = [...tracker.subagents.values()][0];
  assert.equal(reconciled.state, "completed");
  assert.equal(reconciled.brief, "Audit PO");
});

test("backgrounded run_command tools left in_progress by agy finalize cleanly when the turn ends", async () => {
  const { LucidApp } = await import("../src/app.mjs");
  const app = new LucidApp({ cwd: "/tmp", direct: true });
  app.scheduleRender = () => {};
  app.state.sessionId = "sess-bg-tool";
  app.state.busy = true;
  app.state.activePromptCount = 1;

  app.handleSessionUpdate({
    sessionId: "sess-bg-tool",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc-bg-1",
      name: "run_command",
      title: "Profile hotSwapAcpClient",
      status: "in_progress",
    },
  });
  app.handleSessionUpdate({
    sessionId: "sess-bg-tool",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-bg-1",
      status: "in_progress",
      content: { type: "text", text: "Tool is running as a background task with task id: sess-bg-tool/task-59" },
    },
  });
  assert.equal(app.hasRunningTools(), true);

  // Turn completes without agy ever sending a terminal tool_call_update for tc-bg-1.
  app.finishPromptTurn(0);
  assert.equal(app.state.busy, false);
  assert.equal(app.hasRunningTools(), false, "no tool spinner should remain active after turn finishes");
  assert.equal(app.toolMap.get("tc-bg-1")?.status, "completed");
});
