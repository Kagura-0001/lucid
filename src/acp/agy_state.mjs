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
const MAX_BOARD_LINES = 300;
const MAX_MESSAGES = 200;

export function resolveAgyDataDir(launchArgs = [], configuredDir = "") {
  if (configuredDir) return configuredDir;
  const flagIndex = launchArgs.findIndex((arg) => arg === "--app-data-dir" || arg === "--app_data_dir");
  const flagValue = flagIndex >= 0 ? launchArgs[flagIndex + 1] : "";
  const dirName = flagValue || "antigravity-cli";
  if (path.isAbsolute(dirName)) return dirName;
  return path.join(os.homedir(), ".gemini", dirName);
}

function safeStatMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function safeStatBirth(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.birthtimeMs || stats.ctimeMs || 0;
  } catch {
    return 0;
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

/**
 * Derives what a member is doing from the tail of its transcript.
 *   working: mid-turn (thinking, or a tool call is pending)
 *   waiting: parked on swarm_wait / waiting for messages
 *   idle:    its last step was a final answer (turn finished)
 */
export function summarizeTranscriptTail(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { activity: "", phase: "working", lastText: "", lastAt: 0 };
  }
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
      return { activity: "", phase: "idle", lastText, lastAt };
    }
    const pending = toolCalls[toolCalls.length - 1];
    const isParked = /^(swarm_wait|wait|read_board)$/.test(pending.name || "");
    return {
      activity: describeToolCall(pending),
      phase: isParked ? "waiting" : "working",
      lastText,
      lastAt,
    };
  }

  if (last.status === "RUNNING") {
    // A tool step is executing; name it from the planner step that requested it.
    for (let i = steps.length - 2; i >= 0; i -= 1) {
      const step = steps[i];
      if (step.type === "PLANNER_RESPONSE" && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        const runningCall = step.tool_calls[step.tool_calls.length - 1];
        const isParked = /^(swarm_wait|wait|read_board)$/.test(runningCall.name || "");
        return {
          activity: describeToolCall(runningCall),
          phase: isParked ? "waiting" : "working",
          lastText,
          lastAt,
        };
      }
    }
    return { activity: "running", phase: "working", lastText, lastAt };
  }
  // A tool result, system message or user input arrived: the model is thinking.
  return { activity: "thinking", phase: "working", lastText, lastAt };
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
    const mtime = safeStatMtime(filePath);
    const previous = this.fileMtimes.get(key);
    this.fileMtimes.set(key, mtime);
    return previous !== mtime;
  }

  readTranscriptSummary(conversationId) {
    const transcriptPath = path.join(this.systemDir(conversationId), "logs", "transcript.jsonl");
    const mtime = safeStatMtime(transcriptPath);
    const cached = this.transcriptCache.get(conversationId);
    if (cached && cached.mtime === mtime) {
      return { summary: cached.summary, changed: false };
    }
    const steps = mtime ? parseJsonLines(readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES)) : [];
    const startedAt = safeStatBirth(transcriptPath);
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
    const memberEntriesForFilter = members && members.members && typeof members.members === "object" ? members.members : {};
    const swarmConversationIds = new Set(
      Object.values(memberEntriesForFilter)
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
      };
    });

    const workers = [];
    const memberEntries = members && members.members && typeof members.members === "object" ? members.members : {};
    for (const [name, member] of Object.entries(memberEntries)) {
      if (!member || member.role === "coordinator") continue;
      if (member.conversation_id === this.sessionId) continue;
      const phase = String(member.phase || "").toUpperCase();
      const isKilled = member.killed || phase === "KILLED";
      let state;
      let activity = "";
      let lastText = "";
      let updatedAt = 0;
      let startedAt = 0;
      let transcriptPath = "";
      if (isKilled) {
        state = "killed";
      } else if (phase && phase !== "RUNNING") {
        state = phase.toLowerCase();
      } else if (member.conversation_id) {
        const { summary, changed: transcriptChanged } = this.readTranscriptSummary(member.conversation_id);
        if (transcriptChanged) changed = true;
        // A swarm worker whose turn ended is asleep on the board, i.e. waiting.
        state = summary.phase === "idle" ? "waiting" : summary.phase;
        activity = summary.activity;
        lastText = summary.lastText;
        updatedAt = summary.updatedAt;
        startedAt = summary.startedAt;
        transcriptPath = summary.transcriptPath;
      } else {
        state = "working";
      }
      workers.push({
        name,
        conversationId: member.conversation_id || "",
        model: member.model || member.applied_model || "",
        workspace: member.workspace_mode || "",
        state,
        activity,
        lastText,
        task: plan?.tasks?.[name] || "",
        updatedAt,
        startedAt,
        transcriptPath,
      });
    }

    if (!changed) return null;
    this.snapshot = {
      sessionId: this.sessionId,
      subagentSignature,
      swarmTitle: members?.title || plan?.goal?.title || "",
      goal: plan?.goal || null,
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
