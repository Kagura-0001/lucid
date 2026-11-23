import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Reads the multi-agent state that Antigravity (`agy`) persists on disk for a
 * session, so lucid can show live Swarm / Subagent status that the ACP stream
 * does not carry (e.g. a background subagent finishing).
 *
 * Layout under <appDataDir>/brain/<sessionId>/.system_generated/:
 *   subagents/<conversationId>.json  { conversationId, subagentDescriptor{typeName,role}, state }
 *   messages/<id>.json               { sender, content, timestamp, renderDetails{messageTitle} }
 *   swarm/members.json               { title, members{ name: { conversation_id, role, phase, killed, model, ... } } }
 *   swarm/board.jsonl                { seq, agent, text, time, kind } per line
 *   swarm/plan.json                  { goal{title,line}, tasks{ name: text }, threads[] }
 * and every member's own log at <appDataDir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
 */

const TRANSCRIPT_TAIL_BYTES = 192 * 1024;
const PREVIEW_TAIL_BYTES = 256 * 1024;
const PREVIEW_EXPANDED_TAIL_BYTES = 1024 * 1024;
const MAX_BOARD_LINES = 300;
const MAX_MESSAGES = 200;
const MAX_RECENT_STEPS = 48;

export function resolveAgyDataDir(launchArgs = [], configuredDir = "") {
  if (configuredDir) return configuredDir;
  const flagIndex = launchArgs.findIndex((arg) => arg === "--app-data-dir" || arg === "--app_data_dir");
  const flagValue = flagIndex >= 0 ? launchArgs[flagIndex + 1] : "";
  const dirName = flagValue || "antigravity-cli";
  if (path.isAbsolute(dirName)) return dirName;
  return path.join(os.homedir(), ".gemini", dirName);
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function readFileTail(filePath, maxBytes) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      // Drop the partial first line.
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
}

function parseJsonLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Ignore a line that is still being written.
    }
  }
  return out;
}

export function extractUserRequestText(rawContent) {
  if (typeof rawContent !== "string" || !rawContent) return "";
  let text = rawContent;
  const openMatch = /<USER_REQUEST>\s*/i.exec(text);
  if (openMatch) {
    text = text.slice(openMatch.index + openMatch[0].length);
  }
  const closeIdx = text.search(/<\/USER_REQUEST>|<ADDITIONAL_METADATA>|<USER_SETTINGS/i);
  if (closeIdx >= 0) {
    text = text.slice(0, closeIdx);
  }
  return text.replace(/\s+/g, " ").trim();
}

function scanUserPromptsFromTail(text) {
  let userTurnCount = 0;
  let lastUserPrompt = "";
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"USER_INPUT"')) continue;
    try {
      const step = JSON.parse(line);
      if (step && step.type === "USER_INPUT") {
        userTurnCount += 1;
        const cleaned = extractUserRequestText(step.content);
        if (cleaned) {
          lastUserPrompt = cleaned;
        }
      }
    } catch {
      // Ignore truncated or in-flight JSON line
    }
  }
  return { userTurnCount, lastUserPrompt };
}

/**
 * Reads lightweight tail metadata (latest user prompt snippet and turn count)
 * from an Antigravity session transcript on disk so /resume can show what each
 * conversation was actually about without loading full transcripts.
 */
export function readSessionTranscriptPreview(dataDir, sessionId) {
  if (!dataDir || !sessionId) return null;
  const transcriptPath = path.join(dataDir, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
  const stats = safeStat(transcriptPath);
  if (!stats || stats.size <= 0) return null;

  let readBytes = PREVIEW_TAIL_BYTES;
  let scanned = scanUserPromptsFromTail(readFileTail(transcriptPath, readBytes));
  if (!scanned.lastUserPrompt && stats.size > readBytes) {
    readBytes = PREVIEW_EXPANDED_TAIL_BYTES;
    scanned = scanUserPromptsFromTail(readFileTail(transcriptPath, readBytes));
  }

  return {
    lastUserPrompt: scanned.lastUserPrompt,
    userTurnCount: scanned.userTurnCount,
    exactTurnCount: stats.size <= readBytes,
    mtimeMs: stats.mtimeMs || 0,
  };
}

/**
 * Tool arguments in transcripts are JSON-encoded strings ("\"value\""). Long
 * values are truncated in the compact transcript, so JSON.parse can fail; fall
 * back to stripping the quote and unescaping by hand.
 */
function decodeArgValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    if (!value.startsWith("\"")) return value;
    return value
      .slice(1)
      .replace(/"$/, "")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, " ")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
}

const ACTIVITY_ARG_KEYS = ["CommandLine", "AbsolutePath", "Path", "TargetFile", "Query", "query", "Url", "Recipient", "Prompt", "text"];

function describeToolCall(toolCall) {
  if (!toolCall || !toolCall.name) return "";
  const args = toolCall.args || {};
  for (const key of ACTIVITY_ARG_KEYS) {
    if (args[key] === undefined) continue;
    const value = decodeArgValue(args[key]);
    if (typeof value !== "string" || !value.trim()) continue;
    let shown = value.trim().split("\n")[0];
    const looksLikePath = key.toLowerCase().includes("path") || key === "TargetFile";
    if (looksLikePath) shown = path.basename(shown);
    return `${toolCall.name} ${shown}`;
  }
  return toolCall.name;
}

function extractRecentSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return [];
  const timeline = [];
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    const at = Date.parse(step.created_at || "") || 0;
    if (step.type === "PLANNER_RESPONSE") {
      if (typeof step.content === "string" && step.content.trim()) {
        timeline.push({
          kind: "message",
          text: step.content.trim(),
          time: at,
        });
      }
      const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
      for (const call of toolCalls) {
        if (!call || !call.name) continue;
        timeline.push({
          kind: "tool",
          name: call.name,
          activity: describeToolCall(call),
          status: "done",
          time: at,
        });
      }
    } else if (step.status === "RUNNING" && timeline.length > 0) {
      const prev = timeline[timeline.length - 1];
      if (prev.kind === "tool") prev.status = "running";
    } else if ((step.status === "ERROR" || step.status === "FAILED") && timeline.length > 0) {
      const prev = timeline[timeline.length - 1];
      if (prev.kind === "tool") prev.status = "failed";
    }
  }
  return timeline.slice(-MAX_RECENT_STEPS);
}

function extractBoardAgentProgress(board) {
  const statusByAgent = new Map();
  for (const line of Array.isArray(board) ? board : []) {
    const text = String(line?.text || "").trim();
    if (line?.kind === "brief") {
      const targetMatch = /^@([a-z0-9][a-z0-9_-]*)/i.exec(text);
      if (targetMatch) {
        statusByAgent.set(targetMatch[1], "working");
      }
      continue;
    }
    const sender = String(line?.agent || "").trim();
    if (!sender || sender === "coordinator") continue;
    const body = text.replace(/^@\S+\s*/, "").trim();
    if (/^\[done\]/i.test(body)) {
      statusByAgent.set(sender, "done");
    } else if (/^\[(?:blocked|stall)\]/i.test(body)) {
      statusByAgent.set(sender, "blocked");
    }
  }
  return statusByAgent;
}

function resolveTaskStatus(taskKey, taskValue, boardStatus, workerStateMap) {
  if (taskValue && typeof taskValue === "object") {
    const explicit = String(taskValue.status || taskValue.state || "").toLowerCase();
    if (explicit) return explicit;
  }
  const fromBoard = boardStatus.get(taskKey);
  if (fromBoard) return fromBoard;
  const wState = workerStateMap.get(taskKey);
  if (wState === "failed" || wState === "error") return "failed";
  if (wState === "completed") return "done";
  return "";
}

function countTaskStatuses(items) {
  let doneTasks = 0;
  let blockedTasks = 0;
  for (const item of items) {
    const st = String(item?.status || item?.state || "").toLowerCase();
    if (["done", "completed", "finished"].includes(st)) doneTasks += 1;
    else if (["blocked", "failed", "error"].includes(st)) blockedTasks += 1;
  }
  return { totalTasks: items.length, doneTasks, blockedTasks };
}

export function summarizePlan(plan, board = [], workers = []) {
  if (!plan || typeof plan !== "object") return null;
  const goalTitle = typeof plan.goal === "string" ? plan.goal : plan.goal?.title || "";
  const goalLine = typeof plan.goal === "object" ? plan.goal?.line || "" : "";
  const boardStatus = extractBoardAgentProgress(board);
  const workerStateMap = new Map((workers || []).map((w) => [w.name, w.state]));

  const threads = [];
  for (const t of Array.isArray(plan.threads) ? plan.threads : []) {
    if (!t || typeof t !== "object") continue;
    const name = t.title || t.name || t.label || t.id || "thread";
    let status = String(t.status || t.state || "").toLowerCase();
    if (!status && Array.isArray(t.tasks) && t.tasks.length > 0) {
      const memberStatuses = t.tasks.map((taskKey) =>
        resolveTaskStatus(String(taskKey), plan.tasks?.[taskKey], boardStatus, workerStateMap),
      );
      if (memberStatuses.some((s) => s === "blocked" || s === "failed" || s === "error")) {
        status = "failed";
      } else if (memberStatuses.every((s) => s === "done" || s === "completed" || s === "finished")) {
        status = "completed";
      } else if (t.tasks.some((taskKey) => ["working", "running"].includes(workerStateMap.get(String(taskKey))))) {
        status = "working";
      } else {
        status = "waiting";
      }
    } else if (!status) {
      status = "working";
    }
    const detail = t.detail || t.summary || t.goal || t.line || t.worker || "";
    threads.push({ name: String(name), status, detail: String(detail) });
  }

  let counts = { totalTasks: 0, doneTasks: 0, blockedTasks: 0 };
  if (Array.isArray(plan.tasks)) {
    counts = countTaskStatuses(plan.tasks);
  } else if (plan.tasks && typeof plan.tasks === "object") {
    const resolvedEntries = Object.entries(plan.tasks).map(([key, value]) => ({
      status: resolveTaskStatus(key, value, boardStatus, workerStateMap),
    }));
    counts = countTaskStatuses(resolvedEntries);
  }
  if (counts.totalTasks === 0 && threads.length > 0) {
    counts = countTaskStatuses(threads);
  }

  if (!goalTitle && counts.totalTasks === 0 && threads.length === 0) return null;
  return { goalTitle, goalLine, ...counts, threads };
}

function describePendingToolCall(call, lastText, lastAt, recentSteps) {
  const isParked = /^(swarm_wait|wait|read_board)$/.test(call.name || "");
  return {
    activity: describeToolCall(call),
    phase: isParked ? "waiting" : "working",
    lastText,
    lastAt,
    recentSteps,
    isParked,
  };
}

/**
 * Derives what a member is doing from the tail of its transcript.
 *   working: mid-turn (thinking, or a tool call is pending)
 *   waiting: parked on swarm_wait / waiting for messages
 *   idle:    its last step was a final answer (turn finished)
 */
export function summarizeTranscriptTail(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { activity: "", phase: "working", lastText: "", lastAt: 0, recentSteps: [] };
  }
  const recentSteps = extractRecentSteps(steps);
  const last = steps[steps.length - 1];
  const lastAt = Date.parse(last.created_at || "") || 0;

  let lastText = "";
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step.type === "PLANNER_RESPONSE" && typeof step.content === "string" && step.content.trim()) {
      lastText = step.content.trim();
      break;
    }
  }

  if (last.type === "PLANNER_RESPONSE") {
    const toolCalls = Array.isArray(last.tool_calls) ? last.tool_calls : [];
    if (toolCalls.length === 0) {
      return { activity: "", phase: "idle", lastText, lastAt, recentSteps };
    }
    const { isParked, ...result } = describePendingToolCall(toolCalls[toolCalls.length - 1], lastText, lastAt, recentSteps);
    if (recentSteps.length > 0 && recentSteps[recentSteps.length - 1].kind === "tool") {
      recentSteps[recentSteps.length - 1].status = isParked ? "waiting" : "running";
    }
    return result;
  }

  if (last.status === "RUNNING") {
    for (let i = steps.length - 2; i >= 0; i -= 1) {
      const step = steps[i];
      if (step.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        const { isParked: _ignored, ...result } = describePendingToolCall(
          step.tool_calls[step.tool_calls.length - 1],
          lastText,
          lastAt,
          recentSteps,
        );
        return result;
      }
    }
    return { activity: "running", phase: "working", lastText, lastAt, recentSteps };
  }

  // A completed swarm_wait/wait tool response ("Waiting for any message posted
  // after #N.") means the worker is parked asleep on the board, not thinking.
  const lastContent = typeof last.content === "string" ? last.content : "";
  if (last.type === "SYSTEM_MESSAGE" && /subagents and background tasks have been stopped/i.test(lastContent)) {
    return { activity: "", phase: "idle", lastText, lastAt, recentSteps };
  }
  if (last.type === "GENERIC") {
    if (/\bWaiting for\b/i.test(lastContent)) {
      return { activity: "waiting on board", phase: "waiting", lastText, lastAt, recentSteps };
    }
    for (let i = steps.length - 2; i >= 0; i -= 1) {
      const step = steps[i];
      if (step.type === "PLANNER_RESPONSE") {
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        const prevCall = calls[calls.length - 1];
        if (prevCall && /^(swarm_wait|wait)$/.test(prevCall.name || "")) {
          return { activity: "waiting on board", phase: "waiting", lastText, lastAt, recentSteps };
        }
        break;
      }
    }
  }
  return { activity: "thinking", phase: "working", lastText, lastAt, recentSteps };
}

export class AgyStateWatcher {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.sessionId = "";
    this.fileMtimes = new Map();
    this.transcriptCache = new Map(); // conversationId -> { mtime, summary }
    this.seenMessageFiles = new Map(); // fileName -> parsed message
    this.snapshot = null;
  }

  setSession(sessionId) {
    if (sessionId === this.sessionId) return;
    this.sessionId = sessionId || "";
    this.fileMtimes.clear();
    this.transcriptCache.clear();
    this.seenMessageFiles.clear();
    this.snapshot = null;
  }

  systemDir(conversationId) {
    return path.join(this.dataDir, "brain", conversationId, ".system_generated");
  }

  /** Records a path's mtime; returns true when it changed since the last poll. */
  trackChange(key, filePath) {
    const mtime = safeStat(filePath)?.mtimeMs || 0;
    const previous = this.fileMtimes.get(key);
    this.fileMtimes.set(key, mtime);
    return previous !== mtime;
  }

  readTranscriptSummary(conversationId) {
    const transcriptPath = path.join(this.systemDir(conversationId), "logs", "transcript.jsonl");
    const stats = safeStat(transcriptPath);
    const mtime = stats?.mtimeMs || 0;
    const cached = this.transcriptCache.get(conversationId);
    if (cached && cached.mtime === mtime) {
      return { summary: cached.summary, changed: false };
    }
    const steps = mtime ? parseJsonLines(readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES)) : [];
    const startedAt = stats?.birthtimeMs || stats?.ctimeMs || 0;
    const summary = { ...summarizeTranscriptTail(steps), transcriptPath, updatedAt: mtime, startedAt };
    this.transcriptCache.set(conversationId, { mtime, summary });
    return { summary, changed: true };
  }

  readMessages(messagesDir) {
    let names = [];
    try {
      names = fs.readdirSync(messagesDir).filter((name) => name.endsWith(".json") && name !== "read.json");
    } catch {
      return [];
    }
    for (const name of names) {
      if (this.seenMessageFiles.has(name)) continue;
      const message = readJsonFile(path.join(messagesDir, name));
      if (message && typeof message.content === "string") {
        this.seenMessageFiles.set(name, message);
      }
    }
    const messages = [...this.seenMessageFiles.values()]
      .filter((message) => message.sender && message.sender !== "system")
      .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
    return messages.slice(-MAX_MESSAGES);
  }

  /**
   * Re-reads whatever changed. Returns the new snapshot when anything changed,
   * or null when nothing did (so callers can skip re-rendering).
   */
  poll() {
    if (!this.sessionId || !this.dataDir) return null;
    const baseDir = this.systemDir(this.sessionId);
    let changed = false;

    const subagentsDir = path.join(baseDir, "subagents");
    const messagesDir = path.join(baseDir, "messages");
    const swarmDir = path.join(baseDir, "swarm");
    const membersPath = path.join(swarmDir, "members.json");
    const boardPath = path.join(swarmDir, "board.jsonl");
    const planPath = path.join(swarmDir, "plan.json");

    const subagentsChanged = this.trackChange("subagents", subagentsDir);
    const messagesChanged = this.trackChange("messages", messagesDir);
    const membersChanged = this.trackChange("members", membersPath);
    const boardChanged = this.trackChange("board", boardPath);
    const planChanged = this.trackChange("plan", planPath);
    changed = subagentsChanged || messagesChanged || membersChanged || boardChanged || planChanged || !this.snapshot;

    const previous = this.snapshot || {};

    // Subagent state files are rewritten in place (ALIVE -> KILLED), which does not
    // always bump the directory mtime, so read the (small) files every poll and
    // compare their states with the previous poll.
    const subagentRecords = [];
    try {
      for (const name of fs.readdirSync(subagentsDir)) {
        if (!name.endsWith(".json")) continue;
        const record = readJsonFile(path.join(subagentsDir, name));
        if (record && record.conversationId) subagentRecords.push(record);
      }
    } catch {
      // No subagents yet.
    }
    const subagentSignature = subagentRecords
      .map((record) => `${record.conversationId}:${record.state}`)
      .sort()
      .join("|");
    if (subagentSignature !== previous.subagentSignature) {
      changed = true;
    }

    const messages = messagesChanged || !previous.messages ? this.readMessages(messagesDir) : previous.messages;
    const members = membersChanged || !previous.membersFile ? readJsonFile(membersPath) : previous.membersFile;
    const plan = planChanged || previous.plan === undefined ? readJsonFile(planPath) : previous.plan;
    const board = boardChanged || !previous.board
      ? parseJsonLines(readFileTail(boardPath, 512 * 1024)).slice(-MAX_BOARD_LINES)
      : previous.board;

    const latestMessageBySender = new Map();
    for (const message of messages) {
      latestMessageBySender.set(message.sender, message);
    }

    // Swarm workers are also registered as subagents ("Swarm Worker (name)");
    // list them once, as swarm members.
    const memberEntries = members && members.members && typeof members.members === "object" ? members.members : {};
    const swarmConversationIds = new Set(
      Object.values(memberEntries)
        .map((member) => member && member.conversation_id)
        .filter(Boolean),
    );

    const subagents = subagentRecords
      .filter((record) => !swarmConversationIds.has(record.conversationId))
      .map((record) => {
      const isKilled = /KILLED/.test(record.state || "");
      const { summary, changed: transcriptChanged } = this.readTranscriptSummary(record.conversationId);
      if (transcriptChanged) changed = true;
      const reply = latestMessageBySender.get(record.conversationId);
      let state = summary.phase;
      if (isKilled) state = "killed";
      else if (summary.phase === "idle") state = reply ? "completed" : "idle";
      return {
        conversationId: record.conversationId,
        role: record.subagentDescriptor?.role || "Subagent",
        typeName: record.subagentDescriptor?.typeName || "subagent",
        state,
        activity: isKilled ? "" : summary.activity,
        lastText: summary.lastText,
        reply: reply ? reply.content : "",
        updatedAt: summary.updatedAt,
        startedAt: summary.startedAt,
        transcriptPath: summary.transcriptPath,
        recentSteps: summary.recentSteps || [],
      };
    });

    const workers = [];
    for (const [name, member] of Object.entries(memberEntries)) {
      if (!member || member.role === "coordinator") continue;
      if (member.conversation_id === this.sessionId) continue;
      const phase = String(member.phase || "").toUpperCase();
      const isKilled = member.killed || phase === "KILLED";
      const summaryRes = member.conversation_id ? this.readTranscriptSummary(member.conversation_id) : null;
      if (summaryRes?.changed) changed = true;
      const summary = summaryRes?.summary || null;

      const wakeMode = String(member.wake_mode || "").toLowerCase();
      const isParkedByWakeMode = wakeMode === "mentions" || wakeMode === "anything";
      let state;
      let activity = "";
      if (isKilled) {
        state = "killed";
      } else if (phase && phase !== "RUNNING") {
        state = phase.toLowerCase();
      } else if (isParkedByWakeMode) {
        // agy's members.json explicitly records wake_mode ("mentions" / "anything")
        // when the worker is parked asleep on the board, vs "working" when active.
        state = "waiting";
        activity = summary?.phase === "waiting" ? summary.activity : "waiting on board";
      } else if (summary) {
        // A swarm worker whose turn ended is asleep on the board, i.e. waiting.
        state = summary.phase === "idle" ? "waiting" : summary.phase;
        activity = summary.activity || "";
      } else {
        state = "working";
      }
      const rawTask = plan?.tasks?.[name];
      const taskText = typeof rawTask === "string" ? rawTask : rawTask?.title || rawTask?.text || "";
      workers.push({
        name,
        conversationId: member.conversation_id || "",
        model: member.model || member.applied_model || "",
        workspace: member.workspace_mode || "",
        state,
        activity: !isKilled && (!phase || phase === "RUNNING") ? activity : "",
        lastText: summary?.lastText || "",
        task: taskText,
        updatedAt: summary?.updatedAt || 0,
        startedAt: summary?.startedAt || 0,
        transcriptPath: summary?.transcriptPath || "",
        recentSteps: summary?.recentSteps || [],
      });
    }

    if (!changed) return null;
    const planSummary = summarizePlan(plan, board, workers);
    this.snapshot = {
      sessionId: this.sessionId,
      subagentSignature,
      swarmTitle: members?.title || plan?.goal?.title || "",
      goal: plan?.goal || null,
      planSummary,
      workers,
      subagents,
      board,
      messages,
      membersFile: members,
      plan,
    };
    return this.snapshot;
  }
}
