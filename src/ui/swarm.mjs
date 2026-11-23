import path from "node:path";
import { displayWidth, padEndVisible, sanitizeUntrustedText, truncateAnsi, wrapAnsiText } from "../term/unicode.mjs";
import { alignLeftRight, formatElapsed, sliceCenteredWindow, spinnerChar } from "./format.mjs";
import { safeRenderMarkdown } from "./markdown.mjs";
import { normalizeToolRawInput } from "./tool_format.mjs";

function formatClock(ts) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function extractOutputText(update) {
  const parts = [];
  const blocks = Array.isArray(update.content) ? update.content : update.content ? [update.content] : [];
  for (const b of blocks) {
    if (!b) continue;
    if (typeof b.text === "string") parts.push(b.text);
    else if (b.content && typeof b.content.text === "string") parts.push(b.content.text);
  }
  if (parts.length === 0 && update.rawOutput) {
    parts.push(typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput));
  }
  return sanitizeUntrustedText(parts.join("\n")).trim();
}

function createMemberRecord(kind, fields) {
  const now = Date.now();
  return {
    kind,
    model: "inherit",
    workspace: "inherit",
    state: "working",
    brief: "",
    output: "",
    latestPost: null,
    recentSteps: [],
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    ...fields,
  };
}

export class MultiAgentTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.swarmTitle = "";
    this.planSummary = null;
    this.workers = new Map(); // name -> { id, kind: "swarm", name, model, workspace, state, brief, output, recentSteps, startedAt, updatedAt, endedAt }
    this.subagents = new Map(); // toolCallId -> { id, kind: "subagent", name, role, typeName, model, workspace, state, brief, output, recentSteps, conversationId, startedAt, updatedAt, endedAt }
    this.boardMessages = []; // { id, time, from, to, body }
    this.artifacts = new Map(); // path -> { path, title, summary, updatedAt }
    this.toolCallBinding = new Map(); // toolCallId -> { category, targetKey }
  }

  getInspectableMembers() {
    return [...this.workers.values(), ...this.subagents.values()]
      .filter((member) => member.state !== "killed")
      .sort((a, b) => (STRIP_STATE_ORDER[a.state] ?? 9) - (STRIP_STATE_ORDER[b.state] ?? 9));
  }

  getMemberById(memberId) {
    if (!memberId) return null;
    for (const [, w] of this.workers) {
      if (w.id === memberId) return w;
    }
    for (const [, s] of this.subagents) {
      if (s.id === memberId) return s;
    }
    return null;
  }

  hasActivity() {
    return (
      this.workers.size > 0 ||
      this.subagents.size > 0 ||
      this.boardMessages.length > 0 ||
      this.artifacts.size > 0
    );
  }

  hasRunningMembers() {
    for (const member of [...this.workers.values(), ...this.subagents.values()]) {
      if (ACTIVE_STATES.has(member.state)) return true;
    }
    return false;
  }

  getSummaryCounts() {
    let working = 0;
    let waiting = 0;
    let done = 0;
    for (const [, w] of this.workers) {
      if (w.state === "working") working += 1;
      else if (w.state === "waiting") waiting += 1;
      else done += 1;
    }

    let subagentsRunning = 0;
    let subagentsTotal = 0;
    for (const [, s] of this.subagents) {
      subagentsTotal += 1;
      if (s.state === "working" || s.state === "running") subagentsRunning += 1;
    }

    return {
      swarmTitle: this.swarmTitle,
      swarmCount: this.workers.size,
      working,
      waiting,
      done,
      subagentsRunning,
      subagentsTotal,
      boardCount: this.boardMessages.length,
      artifactCount: this.artifacts.size,
    };
  }

  getRosterEntries() {
    const entries = [];
    if (this.workers.size > 0 || this.boardMessages.length > 0) {
      entries.push({
        id: "__board__",
        kind: "board",
        name: this.swarmTitle ? `Board · ${this.swarmTitle}` : "Shared Message Board",
        state: "board",
        model: `${this.boardMessages.length} msgs`,
      });
    }

    for (const [, w] of this.workers) {
      entries.push(w);
    }

    for (const [, s] of this.subagents) {
      entries.push(s);
    }

    return entries;
  }

  getArtifactsList() {
    return [...this.artifacts.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  pushBoardMessage({ from, to, body }) {
    const text = sanitizeUntrustedText(body || "").trim();
    if (!text) return;
    const last = this.boardMessages[this.boardMessages.length - 1];
    if (last && last.from === from && last.to === to && last.body === text) {
      return;
    }
    this.boardMessages.push({
      id: `msg_${this.boardMessages.length + 1}`,
      time: Date.now(),
      from: sanitizeUntrustedText(from || "coordinator"),
      to: sanitizeUntrustedText(to || "all"),
      body: text,
    });
    if (this.boardMessages.length > 300) {
      this.boardMessages.shift();
    }
  }

  ingestToolUpdate(update) {
    if (!update || typeof update !== "object") return;
    const toolCallId = update.toolCallId || "";
    const toolName = (update.name || "").toLowerCase();
    const title = sanitizeUntrustedText(update.title || "");
    const titleLower = title.toLowerCase();
    const input = normalizeToolRawInput(update.rawInput);
    const output = extractOutputText(update);
    const status = update.status || "";

    // 1. Track Swarm tool calls
    if (toolName === "swarm" || titleLower.startsWith("swarm") || (input && typeof input.action === "string" && ["add", "status", "kill", "title", "model"].includes(input.action) && (input.brief || input.title || input.name || titleLower.includes("swarm")))) {
      this.handleSwarmTool(toolCallId, input, output, status);
      return;
    }

    // 2. Ignore define_subagent and handle manage_subagents BEFORE subagent
    // invocation checks so titles like "Run define_subagent" / "Run manage_subagents"
    // never get recorded as phantom running subagents.
    if (toolName === "define_subagent" || titleLower.includes("define_subagent")) {
      return;
    }

    if (toolName === "manage_subagents" || titleLower.includes("manage_subagents")) {
      if (input) {
        if (input.Action === "kill_all") {
          for (const [, sub] of this.subagents) {
            if (sub.state === "working" || sub.state === "running") {
              sub.state = "killed";
              sub.endedAt = Date.now();
            }
          }
        } else if (input.Action === "kill" && Array.isArray(input.ConversationIds)) {
          for (const [, sub] of this.subagents) {
            if (sub.conversationId && input.ConversationIds.includes(sub.conversationId)) {
              sub.state = "killed";
              sub.endedAt = Date.now();
            }
          }
        }
      }
      return;
    }

    // 3. Track Subagent invocations
    if (
      toolName === "invoke_subagent" ||
      titleLower.includes("invoke_subagent") ||
      (input && input.TypeName && input.Role && input.Prompt)
    ) {
      this.handleSubagentTool(toolCallId, title, input, output, status);
      return;
    }

    // 4. Track inter-agent / board messages
    if (toolName === "send_message" || (input && input.Recipient && input.Message)) {
      this.handleSendMessageTool(toolCallId, input, output);
      return;
    }

    // 4b. Native swarm board posts by the coordinator
    if (toolName === "post_message" && input && typeof input.text === "string") {
      const mention = /^@([a-z0-9][a-z0-9_#-]*)/i.exec(input.text.trim());
      this.pushBoardMessage({
        from: "coordinator",
        to: mention ? `@${mention[1]}` : input.channel ? `#${input.channel}` : "all",
        body: input.text,
      });
      return;
    }

    // 5. Track updates to previously bound toolCallIds
    if (toolCallId && this.toolCallBinding.has(toolCallId)) {
      const bound = this.toolCallBinding.get(toolCallId);
      if (bound.category === "subagent") {
        const sub = this.subagents.get(bound.targetKey);
        if (sub) {
          this.updateSubagentStatus(sub, output, status);
        }
      } else if (bound.category === "swarm") {
        this.applySwarmOutput(bound.targetKey, output, status);
      }
    }

    // 6. Track Artifacts created or edited
    this.maybeTrackArtifact(input, update);
  }

  handleSwarmTool(toolCallId, input, output, status) {
    const action = input?.action;
    if (action === "title" && input.title) {
      this.swarmTitle = String(input.title);
    }

    if (action === "add" && input.name) {
      const baseName = String(input.name);
      const workerNames = [];
      if (Array.isArray(input.tasks) && input.tasks.length > 0) {
        input.tasks.forEach((_, idx) => workerNames.push(`${baseName}-${idx + 1}`));
      } else if (typeof input.n === "number" && input.n > 1) {
        for (let i = 1; i <= input.n; i += 1) {
          workerNames.push(`${baseName}-${i}`);
        }
      } else {
        workerNames.push(baseName);
      }

      workerNames.forEach((wName, idx) => {
        const taskSuffix = Array.isArray(input.tasks) && input.tasks[idx] ? `\n\nSlice: ${input.tasks[idx]}` : "";
        const fullBrief = `${input.brief || ""}${taskSuffix}`.trim();
        const existing = this.workers.get(wName);
        const worker = existing || createMemberRecord("swarm", {
          id: `swarm:${wName}`,
          name: wName,
          model: input.model || "inherited",
          workspace: input.workspace || "inherit",
          brief: fullBrief,
        });
        worker.model = input.model || worker.model;
        worker.workspace = input.workspace || worker.workspace;
        if (fullBrief) worker.brief = fullBrief;
        worker.state = "working";
        worker.updatedAt = Date.now();
        this.workers.set(wName, worker);

        if (fullBrief) {
          this.pushBoardMessage({
            from: "coordinator",
            to: `@${wName}`,
            body: fullBrief,
          });
        }
      });

      if (toolCallId) {
        this.toolCallBinding.set(toolCallId, { category: "swarm", targetKey: workerNames[0] });
      }
    }

    if (action === "model" && input.name) {
      const w = this.workers.get(String(input.name));
      if (w && input.model) {
        w.model = String(input.model);
        w.updatedAt = Date.now();
      }
    }

    if (action === "kill" && input.name) {
      const w = this.workers.get(String(input.name));
      if (w) {
        w.state = "killed";
        w.endedAt = Date.now();
        w.updatedAt = Date.now();
      }
    }

    if (output) {
      this.applySwarmOutput(input?.name || "", output, status);
    }
  }

  applySwarmOutput(hintName, output, status) {
    if (!output) return;
    const cleanOutput = sanitizeUntrustedText(output);
    const lines = cleanOutput.split(/\r?\n/);
    const workerMatchers = [];
    for (const [wName, w] of this.workers) {
      const escaped = wName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      workerMatchers.push({
        worker: w,
        regex: new RegExp(`(?:^|[^a-z0-9_-])${escaped}(?:$|[^a-z0-9_-])`, "i"),
      });
    }
    const now = Date.now();
    for (const line of lines) {
      const stateMatch = /\b(working|waiting|stopped|killed)\b/i.exec(line);
      if (!stateMatch) continue;
      const wState = stateMatch[1].toLowerCase();
      for (const { worker, regex } of workerMatchers) {
        if (regex.test(line)) {
          worker.state = wState;
          worker.updatedAt = now;
          if (wState === "killed" || wState === "stopped") {
            worker.endedAt = worker.endedAt || now;
          }
        }
      }
    }

    if (hintName && this.workers.has(hintName)) {
      const w = this.workers.get(hintName);
      w.output = cleanOutput;
      w.updatedAt = now;
      if (status === "failed" || status === "error") {
        w.state = "failed";
        w.endedAt = now;
      }
    }
  }

  handleSubagentTool(toolCallId, title, input, output, status) {
    const key = toolCallId || `sub_${this.subagents.size + 1}`;
    let sub = this.subagents.get(key);
    if (!sub) {
      sub = createMemberRecord("subagent", {
        id: `sub:${key}`,
        name: input?.Role || title || "Subagent",
        role: input?.Role || title || "Subagent",
        typeName: input?.TypeName || "subagent",
        model: input?.Model || "inherit",
        workspace: input?.Workspace || "inherit",
        brief: input?.Prompt || "",
        conversationId: "",
      });
      this.subagents.set(key, sub);
      if (toolCallId) {
        this.toolCallBinding.set(toolCallId, { category: "subagent", targetKey: key });
      }
      if (sub.brief) {
        this.pushBoardMessage({
          from: "coordinator",
          to: sub.role,
          body: sub.brief,
        });
      }
    }

    this.updateSubagentStatus(sub, output, status);
  }

  updateSubagentStatus(sub, output, status) {
    if (output) {
      sub.output = output;
      const cidMatch = /conversationId["'\s:=]+([a-zA-Z0-9_-]{8,})/i.exec(output);
      if (cidMatch) {
        sub.conversationId = cidMatch[1];
      }
    }
    if (status === "completed") {
      // invoke_subagent returns as soon as the background subagent is *launched*;
      // the subagent itself keeps running. Real completion comes from agy's
      // on-disk state (applyAgyState) or a later kill.
      if (sub.state === "working") {
        sub.state = "running";
      }
    } else if (status === "failed" || status === "error") {
      sub.state = "failed";
      sub.endedAt = sub.endedAt || Date.now();
    } else if (status === "cancelled") {
      sub.state = "killed";
      sub.endedAt = sub.endedAt || Date.now();
    }
    sub.updatedAt = Date.now();
  }

  handleSendMessageTool(toolCallId, input, output) {
    if (input && input.Message) {
      const recipient = String(input.Recipient || "agent");
      // Map conversationId back to role if known
      let targetLabel = recipient;
      for (const [, sub] of this.subagents) {
        if (sub.conversationId && sub.conversationId === recipient) {
          targetLabel = sub.role;
          break;
        }
      }
      this.pushBoardMessage({
        from: "coordinator",
        to: targetLabel,
        body: String(input.Message),
      });
    }
    if (output && toolCallId) {
      // Optionally capture response if informative
      const trimmed = output.trim();
      if (trimmed.length > 40 && !trimmed.startsWith("{")) {
        this.pushBoardMessage({
          from: "agent",
          to: "coordinator",
          body: trimmed.slice(0, 800),
        });
      }
    }
  }

  /**
   * Merges the authoritative state agy persists on disk (see acp/agy_state.mjs).
   * Swarm workers and subagents found there replace the guesses made from tool
   * calls; briefs captured from tool calls are kept.
   */
  applyAgyState(snapshot) {
    if (!snapshot) return;
    this.diskBacked = true;
    if (snapshot.swarmTitle) {
      this.swarmTitle = sanitizeUntrustedText(snapshot.swarmTitle);
    }
    if (snapshot.planSummary !== undefined) {
      this.planSummary = snapshot.planSummary;
    }

    // Briefs posted to the board ("@name ..." of kind "brief") and latest status posts per worker.
    const briefByWorker = new Map();
    const latestPostByWorker = new Map();
    for (const line of snapshot.board || []) {
      const lineText = sanitizeUntrustedText(line.text || "");
      if (line.kind === "brief") {
        const mention = /^@([a-z0-9][a-z0-9_-]*)/i.exec(lineText);
        if (mention) briefByWorker.set(mention[1], lineText.replace(/^@\S+\s*/, ""));
        continue;
      }
      const sender = sanitizeUntrustedText(line.agent || "").trim();
      if (!sender || sender === "coordinator" || !lineText.trim()) continue;
      const bodyWithoutMention = lineText.replace(/^@\S+\s*/, "").trim();
      const firstLine = bodyWithoutMention.split(/\r?\n/).find((l) => l.trim())?.trim() || "";
      latestPostByWorker.set(sender, {
        seq: line.seq,
        text: lineText.trim(),
        summary: firstLine,
        isDone: /^\[done\]/i.test(bodyWithoutMention),
      });
    }

    for (const diskWorker of snapshot.workers || []) {
      const existing = this.workers.get(diskWorker.name);
      const worker = existing || createMemberRecord("swarm", {
        id: `swarm:${diskWorker.name}`,
        name: diskWorker.name,
        model: "",
        workspace: "",
      });
      worker.model = sanitizeUntrustedText(diskWorker.model || worker.model || "");
      worker.workspace = sanitizeUntrustedText(diskWorker.workspace || worker.workspace || "");
      worker.state = diskWorker.state;
      worker.activity = sanitizeUntrustedText(diskWorker.activity || "");
      worker.task = sanitizeUntrustedText(diskWorker.task || "");
      worker.conversationId = diskWorker.conversationId;
      worker.transcriptPath = diskWorker.transcriptPath;
      worker.recentSteps = Array.isArray(diskWorker.recentSteps) ? diskWorker.recentSteps : worker.recentSteps || [];
      worker.brief = worker.brief || briefByWorker.get(diskWorker.name) || worker.task || "";
      worker.latestPost = latestPostByWorker.get(diskWorker.name) || worker.latestPost || null;
      if (diskWorker.lastText) worker.output = sanitizeUntrustedText(diskWorker.lastText);
      worker.updatedAt = diskWorker.updatedAt || Date.now();
      if (diskWorker.startedAt) worker.startedAt = diskWorker.startedAt;
      const isFinished = worker.state === "killed" || worker.state === "stopped" || worker.state === "waiting";
      worker.endedAt = isFinished ? worker.endedAt || diskWorker.updatedAt || Date.now() : null;
      this.workers.set(diskWorker.name, worker);
    }

    for (const diskSub of snapshot.subagents || []) {
      const key = `conv:${diskSub.conversationId}`;
      let sub = this.subagents.get(key);

      // Always reconcile any tool-call placeholder entry matching this conversationId
      // or role (even if `conv:` already existed) so no duplicate ghost stays running.
      let adopted = null;
      for (const [candidateKey, candidate] of [...this.subagents]) {
        if (candidateKey.startsWith("conv:")) continue;
        const sameConv = candidate.conversationId && candidate.conversationId === diskSub.conversationId;
        const sameRoleUnbound = !candidate.conversationId && candidate.role === diskSub.role;
        if (sameConv || sameRoleUnbound) {
          if (!adopted) adopted = candidate;
          this.subagents.delete(candidateKey);
        }
      }

      if (!sub) {
        sub = adopted || createMemberRecord("subagent", {
          id: `sub:${key}`,
          name: sanitizeUntrustedText(diskSub.role),
          role: sanitizeUntrustedText(diskSub.role),
          typeName: sanitizeUntrustedText(diskSub.typeName),
        });
        sub.id = `sub:${key}`;
        this.subagents.set(key, sub);
      } else if (adopted && !sub.brief && adopted.brief) {
        sub.brief = adopted.brief;
      }

      sub.conversationId = diskSub.conversationId;
      sub.typeName = sanitizeUntrustedText(diskSub.typeName || sub.typeName);
      sub.state = diskSub.state;
      sub.activity = sanitizeUntrustedText(diskSub.activity || "");
      sub.transcriptPath = diskSub.transcriptPath;
      sub.recentSteps = Array.isArray(diskSub.recentSteps) ? diskSub.recentSteps : sub.recentSteps || [];
      const replyOrLast = diskSub.reply || diskSub.lastText;
      if (replyOrLast) sub.output = sanitizeUntrustedText(replyOrLast);
      sub.updatedAt = diskSub.updatedAt || Date.now();
      if (diskSub.startedAt) sub.startedAt = diskSub.startedAt;
      const isFinished = ["completed", "killed", "failed", "idle"].includes(sub.state);
      sub.endedAt = isFinished ? sub.endedAt || diskSub.updatedAt || Date.now() : null;
    }

    // Reconcile orphaned tool-call-only subagent entries once disk state is authoritative:
    // agy creates subagents/<cid>.json within ~1-2s of invoke_subagent, so any older
    // unbound tool-call entry (e.g. replayed from session history) is stale.
    const now = Date.now();
    for (const [candidateKey, candidate] of [...this.subagents]) {
      if (candidateKey.startsWith("conv:")) continue;
      if (now - (candidate.updatedAt || candidate.startedAt || 0) > 15_000) {
        this.subagents.delete(candidateKey);
      }
    }

    // The board feed becomes the real swarm board plus messages from subagents.
    const roleByConversation = new Map();
    for (const [, sub] of this.subagents) {
      if (sub.conversationId) roleByConversation.set(sub.conversationId, sub.role);
    }
    const feed = [];
    for (const line of snapshot.board || []) {
      const text = sanitizeUntrustedText(line.text || "");
      const mention = /^@([a-z0-9][a-z0-9_#-]*)/i.exec(text);
      feed.push({
        id: `board_${line.seq}`,
        time: Date.parse(String(line.time || "").replace(" ", "T")) || Date.now(),
        from: sanitizeUntrustedText(line.agent || "coordinator"),
        to: mention ? `@${mention[1]}` : "all",
        body: text,
        seq: line.seq,
      });
    }
    for (const message of snapshot.messages || []) {
      feed.push({
        id: `msg_${message.id || message.timestamp}`,
        time: Date.parse(message.timestamp || "") || Date.now(),
        from: sanitizeUntrustedText(
          roleByConversation.get(message.sender) || message.renderDetails?.messageTitle || message.sender,
        ),
        to: "coordinator",
        body: sanitizeUntrustedText(message.content || ""),
      });
    }
    if (feed.length > 0) {
      feed.sort((a, b) => a.time - b.time);
      this.boardMessages = feed.slice(-300);
    }
  }

  maybeTrackArtifact(input, update) {
    const filePath =
      input?.Path ||
      input?.path ||
      (Array.isArray(update.content) && update.content.find((c) => c?.type === "diff")?.path) ||
      "";

    if (!filePath || typeof filePath !== "string") return;

    const hasMeta = Boolean(input && input.ArtifactMetadata);
    const inBrainDir = filePath.includes("/brain/") && filePath.endsWith(".md");
    if (!hasMeta && !inBrainDir) return;

    const meta = input?.ArtifactMetadata || {};
    this.artifacts.set(filePath, {
      path: filePath,
      title: path.basename(filePath),
      summary: meta.Summary || "",
      userFacing: meta.UserFacing !== false,
      updatedAt: Date.now(),
    });
  }
}

function statusBadge(state, style, spinnerFrame) {
  const spin = spinnerChar(spinnerFrame);
  switch (state) {
    case "board":
      return style.accentBold("◈");
    case "working":
    case "running":
      return style.warn(spin);
    case "waiting":
      return style.accentAlt("◌");
    case "idle":
      return style.muted("◌");
    case "completed":
      return style.success("✓");
    case "done":
      return style.muted("•");
    case "failed":
    case "error":
      return style.error("✗");
    case "killed":
    case "stopped":
      return style.muted("○");
    default:
      return style.muted("·");
  }
}

const ACTIVE_STATES = new Set(["working", "running"]);
const STRIP_STATE_ORDER = { working: 0, running: 0, waiting: 1, idle: 2, completed: 3, failed: 4, stopped: 5, killed: 6 };

function memberColorFn(name, style) {
  const palette = [style.accent, style.accentAlt, style.success, style.warn, style.thought];
  let hash = 0;
  const text = String(name || "");
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

function formatPlanProgressTag(planSummary) {
  if (!planSummary || planSummary.totalTasks <= 0) return "";
  const base = `${planSummary.doneTasks}/${planSummary.totalTasks} tasks`;
  return planSummary.blockedTasks > 0 ? `${base} (${planSummary.blockedTasks} blocked)` : base;
}

function formatMemberActivityLabel(member) {
  if (member.activity) return member.activity;
  if (member.state === "waiting") return "waiting on board";
  if (member.state === "completed") return "done";
  if (member.state === "idle") return "idle";
  if (member.state === "failed" || member.state === "error") return "failed";
  if (member.state === "working" || member.state === "running") return "working";
  return member.state || "";
}

/**
 * Multi-line transparent dock rendered below the composer when Swarm workers
 * or Subagents are active. Mirrors Claude Code's persistent teammate progress
 * bar while keeping zero opaque backgrounds.
 */
export function renderSwarmDock(tracker, cols, style, spinnerFrame, options = {}) {
  if (!tracker || !tracker.hasActivity()) return [];
  const members = tracker.getInspectableMembers();
  const counts = tracker.getSummaryCounts();
  const maxWidth = Math.max(20, cols - 2);
  const collapsed = Boolean(options.collapsed);
  const focusedMemberId = options.focusedMemberId || "";
  const maxVisibleMembers = Math.max(1, options.maxVisibleMembers || 5);

  if (members.length === 0) {
    // Only artifacts or board messages remain — keep a single quiet line.
    const bits = [];
    if (counts.artifactCount > 0) bits.push(style.accentAlt(`◇ ${counts.artifactCount} (/artifacts)`));
    if (counts.boardCount > 0) bits.push(style.muted(`${counts.boardCount} board msgs`));
    if (bits.length === 0) return [];
    bits.push(style.muted("^B board"));
    return [` ${truncateAnsi(bits.join(style.border(" · ")), maxWidth, "…")}`];
  }

  // Build top summary bar of the dock
  const icon = counts.working > 0 || counts.subagentsRunning > 0
    ? style.warn(spinnerChar(spinnerFrame))
    : style.accent("◈");
  const titleText = counts.swarmCount > 0
    ? (counts.swarmTitle ? `Swarm "${counts.swarmTitle}"` : "Swarm")
    : "Agents";

  const statusBits = [];
  const planTag = formatPlanProgressTag(tracker.planSummary);
  if (planTag) statusBits.push(planTag);
  const activeCount = counts.working + counts.subagentsRunning;
  if (activeCount > 0) statusBits.push(`${activeCount} running`);
  else if (counts.waiting > 0) statusBits.push(`${counts.waiting} waiting`);
  else statusBits.push(`${members.length} done`);
  if (counts.artifactCount > 0) statusBits.push(`◇ ${counts.artifactCount}`);

  const leftHeader = `${icon} ${style.bold(titleText)}${statusBits.length > 0 ? style.muted(` · ${statusBits.join(" · ")}`) : ""}`;
  const rightHint = collapsed
    ? style.muted("Alt+B expand · ^B board")
    : style.muted("Alt+[/] inspect · ^B board · Alt+B fold");
  const headerRow = ` ${alignLeftRight(leftHeader, rightHint, maxWidth, 3)}`;

  if (collapsed) {
    return [headerRow];
  }

  const rows = [headerRow];
  const visible = members.slice(0, maxVisibleMembers);
  const hiddenCount = members.length - visible.length;
  const nameColWidth = Math.max(10, Math.min(18, Math.max(...visible.map((m) => displayWidth(m.name))) + 1));

  for (const member of visible) {
    const isFocused = Boolean(focusedMemberId && member.id === focusedMemberId);
    const badge = statusBadge(member.state, style, spinnerFrame);
    const paintName = memberColorFn(member.name, style);
    const pointer = isFocused ? style.accentBold("▸") : " ";
    const nameStr = padEndVisible(paintName(truncateAnsi(member.name, nameColWidth, "…")), nameColWidth);
    const age = member.startedAt ? formatElapsed(member.startedAt, member.endedAt) : "";
    const ageText = age ? style.muted(age) : "";
    const ageWidth = ageText ? displayWidth(ageText) : 0;

    const activityRaw = formatMemberActivityLabel(member);
    const taskRaw = member.task && member.task !== activityRaw ? member.task : "";

    // Layout: " <pointer><badge> <name>  <activity>   <task?>   <age>"
    const prefixPart = ` ${pointer}${badge} ${nameStr} `;
    const prefixW = displayWidth(prefixPart);
    const reservedRight = ageWidth > 0 ? ageWidth + 2 : 0;
    const bodyBudget = Math.max(8, maxWidth + 1 - prefixW - reservedRight);

    let bodyStr = "";
    if (ACTIVE_STATES.has(member.state)) {
      const actCap = taskRaw && bodyBudget > 36 ? Math.floor(bodyBudget * 0.62) : bodyBudget;
      const actText = style.text(truncateAnsi(activityRaw, actCap, "…"));
      if (taskRaw && bodyBudget > 36) {
        const taskBudget = bodyBudget - displayWidth(actText) - 3;
        bodyStr = taskBudget >= 8 ? `${actText}  ${style.muted(truncateAnsi(taskRaw, taskBudget, "…"))}` : actText;
      } else {
        bodyStr = actText;
      }
    } else if (member.latestPost?.summary) {
      const paintPost = member.latestPost.isDone ? style.success : style.muted;
      bodyStr = paintPost(truncateAnsi(member.latestPost.summary, bodyBudget, "…"));
    } else {
      const mutedAct = taskRaw && member.state === "waiting" ? `${activityRaw} · ${taskRaw}` : activityRaw;
      bodyStr = style.muted(truncateAnsi(mutedAct, bodyBudget, "…"));
    }

    rows.push(alignLeftRight(`${prefixPart}${bodyStr}`, ageText, maxWidth + 1, 2));
  }

  if (hiddenCount > 0) {
    rows.push(`   ${style.muted(`+${hiddenCount} more agents · press ^B for full board`)}`);
  }

  return rows;
}

function renderMemberHeader(member, width, style, spinnerFrame, { live }) {
  const out = [];
  const badge = statusBadge(member.state, style, spinnerFrame);
  const nameText = live ? memberColorFn(member.name, style)(member.name) : style.bold(member.name);
  const age = live && member.startedAt ? ` · ${formatElapsed(member.startedAt, member.endedAt)}` : "";
  out.push(truncateAnsi(`${badge} ${nameText}  ${style.muted(`[${member.kind} · ${member.state}${age}]`)}`, width, "…"));

  const meta = [];
  if (member.model) meta.push(`model${live ? " " : ": "}${member.model}`);
  if (member.workspace) meta.push(`workspace${live ? " " : ": "}${member.workspace}`);
  if (!live && member.startedAt) meta.push(`elapsed: ${formatElapsed(member.startedAt, member.endedAt)}`);
  if (live && member.updatedAt) meta.push(`updated ${formatElapsed(member.updatedAt, Date.now())} ago`);
  if (meta.length > 0) {
    out.push(style.muted(truncateAnsi(meta.join(live ? " · " : "  ·  "), width, "…")));
  }

  if (live) {
    out.push(style.muted("Alt+[/] switch agent · Esc back to main conversation · ^B full board"));
  } else {
    if (member.activity && (ACTIVE_STATES.has(member.state) || member.state === "waiting")) {
      out.push(`${style.accent("Now:")} ${truncateAnsi(member.activity, Math.max(16, width - 6), "…")}`);
    }
    if (member.transcriptPath && member.updatedAt) {
      out.push(style.muted(`last activity ${formatElapsed(member.updatedAt, Date.now())} ago`));
    }
    if (member.transcriptPath) {
      out.push(style.muted(truncateAnsi(`log: ${member.transcriptPath}`, width, "…")));
    }
  }
  out.push(style.border("─".repeat(Math.min(width, live ? 72 : 64))));
  return out;
}

const boardMessageMdCache = new WeakMap();

function renderCachedBoardMessageBody(msg, width, style) {
  const key = `${width}|${style.name}|${style.depth}|${msg.body}`;
  const cached = boardMessageMdCache.get(msg);
  if (cached && cached.key === key) {
    return cached.lines;
  }
  const lines = safeRenderMarkdown(msg.body, width, style);
  boardMessageMdCache.set(msg, { key, lines });
  return lines;
}

const memberSectionMdCache = new WeakMap();

function renderCachedMemberMarkdown(owner, slotKey, text, width, style) {
  let slots = memberSectionMdCache.get(owner);
  if (!slots) {
    slots = new Map();
    memberSectionMdCache.set(owner, slots);
  }
  const cacheKey = `${width}|${style.name}|${style.depth}|${text}`;
  const cached = slots.get(slotKey);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.lines;
  }
  const lines = safeRenderMarkdown(text, width, style);
  slots.set(slotKey, { cacheKey, lines });
  return lines;
}

function pushMarkdownSection(out, owner, slotKey, heading, text, width, style) {
  out.push(style.accent(heading));
  for (const ml of renderCachedMemberMarkdown(owner, slotKey, text, Math.max(16, width - 2), style)) {
    out.push(ml ? `  ${ml}` : "");
  }
}

function renderMemberSections(member, width, style, spinnerFrame, { live }) {
  const out = [];
  if (!live && member.latestPost?.text) {
    pushMarkdownSection(out, member, "latestPost", "Latest Board Post", member.latestPost.text, width, style);
    out.push("");
  }

  if (member.brief) {
    out.push(style.accent(live ? "Assignment" : "Assignment / Brief"));
    const paintBrief = live ? style.muted : style.text;
    for (const bl of wrapAnsiText(paintBrief(member.brief), Math.max(16, width - 2))) {
      out.push(`  ${bl}`);
    }
    out.push("");
  }

  const rawSteps = Array.isArray(member.recentSteps) ? member.recentSteps : [];
  const steps = live ? rawSteps : rawSteps.filter((s) => s.kind === "tool").slice(-10);

  if (steps.length > 0) {
    out.push(style.accent(live ? "Live Activity" : "Recent Steps"));
    for (let sIdx = 0; sIdx < steps.length; sIdx += 1) {
      const step = steps[sIdx];
      if (step.kind === "tool") {
        const icon = statusBadge(step.status, style, spinnerFrame);
        const label = truncateAnsi(step.activity || step.name || "tool", Math.max(16, width - 6), "…");
        const styled = live && step.status === "running" ? style.text(label) : style.muted(label);
        out.push(`  ${icon} ${styled}`);
      } else if (live && step.kind === "message" && step.text) {
        out.push("");
        for (const ml of renderCachedMemberMarkdown(step, "msg", step.text, Math.max(16, width - 2), style)) {
          out.push(ml ? `  ${ml}` : "");
        }
        out.push("");
      }
    }
    if (!live) out.push("");
  }

  const lastMessageStep = [...steps].reverse().find((s) => s.kind === "message");
  const showLatestOutput = Boolean(
    member.output &&
      (!live || (member.output !== lastMessageStep?.text && member.output !== member.latestPost?.text)),
  );
  if (showLatestOutput) {
    pushMarkdownSection(out, member, "output", "Latest Output", member.output, width, style);
    if (live && member.latestPost?.text) out.push("");
  }

  if (live && member.latestPost?.text) {
    pushMarkdownSection(out, member, "latestPost", "Latest Board Post", member.latestPost.text, width, style);
  }

  if (!showLatestOutput && !member.latestPost?.text && (!live || steps.length === 0)) {
    out.push(style.muted(live ? "Waiting for transcript activity…" : "Waiting for output updates…"));
  }
  return out;
}

function formatRosterRow(entry, isSelected, width, style, spinnerFrame, includeAge) {
  const icon = statusBadge(entry.state, style, spinnerFrame);
  const age = includeAge && entry.startedAt ? ` ${formatElapsed(entry.startedAt, entry.endedAt)}` : "";
  const rawName = truncateAnsi(entry.name, Math.max(8, width - displayWidth(age) - 4), "…");
  return isSelected
    ? style.selected(` ▸ ${rawName}${age} `)
    : ` ${icon} ${style.text(rawName)}${age ? style.muted(age) : ""}`;
}

function sliceScrollableLines(lines, rawOffset, height, stickToBottom = false) {
  const maxDetailScroll = Math.max(0, lines.length - height);
  const offset = stickToBottom ? maxDetailScroll : Math.max(0, Math.min(rawOffset || 0, maxDetailScroll));
  return { maxDetailScroll, scrollOffset: offset, slice: lines.slice(offset, offset + height) };
}

/**
 * Renders an inspected agent's live transcript (Codex-style recent steps + brief
 * + latest reply) for display inside the main viewport via Alt+[ / Alt+].
 */
export function renderMemberTimeline(member, cols, style, spinnerFrame) {
  if (!member) return [];
  const contentWidth = Math.max(24, cols - 4);
  const body = [
    ...renderMemberHeader(member, contentWidth, style, spinnerFrame, { live: true }),
    "",
    ...renderMemberSections(member, contentWidth, style, spinnerFrame, { live: true }),
  ];
  if (member.activity && ACTIVE_STATES.has(member.state)) {
    body.push("", `${style.warn(spinnerChar(spinnerFrame))} ${style.text(truncateAnsi(member.activity, Math.max(16, contentWidth - 4), "…"))}`);
  }
  return ["", ...body.map((l) => (l ? `  ${l}` : "")), ""];
}

/**
 * Renders the full-viewport transparent-background Swarm & Subagent Multi-Pane Board.
 */
export function renderSwarmBoardView(tracker, boardState, cols, height, style, spinnerFrame) {
  const entries = tracker.getRosterEntries();
  const safeHeight = Math.max(6, height);

  if (entries.length === 0) {
    const lines = [
      "",
      `  ${style.accentBold("◈ Swarm & Subagent Board")}`,
      "",
      `  ${style.muted("No Swarm workers or Subagents in this session yet.")}`,
      `  ${style.muted("Start a /swarm or delegate subagents in chat — roster, briefs, and board messages appear here live.")}`,
      "",
      `  ${style.muted("Press Ctrl+B or Esc to return to conversation.")}`,
    ];
    while (lines.length < safeHeight) lines.push("");
    return { rows: lines.slice(0, safeHeight), maxDetailScroll: 0, scrollOffset: 0 };
  }

  const selectedIdx = Math.max(0, Math.min(boardState.selectedIdx || 0, entries.length - 1));
  const selectedEntry = entries[selectedIdx];
  const activeTab = selectedEntry.kind === "board" ? "board" : (boardState.tab || "detail");
  const stickToBottom = Boolean(boardState.stickToBottom && activeTab === "board");

  const useSplit = cols >= 84;
  const contentHeight = Math.max(4, safeHeight - 2); // reserve top bar + bottom hint

  const buildRightContent = (rightWidth) => {
    if (activeTab === "board") {
      const out = [];
      if (tracker.planSummary) {
        const ps = tracker.planSummary;
        const progress = formatPlanProgressTag(ps);
        const goalHeader = ps.goalTitle
          ? `${style.accentBold("Overview")}  ${style.bold(ps.goalTitle)}${progress ? style.muted(` · ${progress}`) : ""}`
          : `${style.accentBold("Overview")}${progress ? style.muted(` · ${progress}`) : ""}`;
        out.push(truncateAnsi(goalHeader, rightWidth, "…"));
        if (ps.goalLine) {
          out.push(style.muted(truncateAnsi(ps.goalLine, rightWidth, "…")));
        }
        for (const thread of (ps.threads || []).slice(0, 6)) {
          const tIcon = statusBadge(thread.status, style, spinnerFrame);
          const detail = thread.detail ? `  ${style.muted(thread.detail)}` : "";
          out.push(truncateAnsi(`  ${tIcon} ${style.text(thread.name)}${detail}`, rightWidth, "…"));
        }
        out.push(style.border("─".repeat(Math.min(rightWidth, 64))));
      }

      const msgs = tracker.boardMessages;
      if (msgs.length === 0) {
        out.push("", style.muted("No shared board messages recorded yet."));
        return out;
      }
      for (const msg of msgs) {
        const header = `${style.accentBold(msg.from)} ${style.muted("→")} ${style.accentAlt(msg.to)}  ${style.muted(formatClock(msg.time))}`;
        out.push(truncateAnsi(header, rightWidth, "…"));
        const bodyLines = renderCachedBoardMessageBody(msg, Math.max(16, rightWidth - 2), style);
        for (const bl of bodyLines) {
          out.push(bl ? `  ${bl}` : "");
        }
        out.push(style.border("·".repeat(Math.min(28, rightWidth))));
      }
      return out;
    }

    // Member detail view
    return [
      ...renderMemberHeader(selectedEntry, rightWidth, style, spinnerFrame, { live: false }),
      ...renderMemberSections(selectedEntry, rightWidth, style, spinnerFrame, { live: false }),
    ];
  };

  const tabBar =
    activeTab === "board"
      ? `${style.selected(" Board Feed ")}  ${style.muted("Member Detail")}`
      : `${style.muted("Board Feed")}  ${style.selected(" Member Detail ")}`;

  const topTitle = tracker.swarmTitle
    ? `◈ Swarm · ${tracker.swarmTitle}`
    : "◈ Swarm & Subagents";

  const topHeader = ` ${style.accentBold(topTitle)}   ${tabBar}`;
  const bottomHint = ` ${style.muted("↑/↓")} select  ${style.border("·")}  ${style.muted("Tab")} switch view  ${style.border("·")}  ${style.muted("PgUp/PgDn")} scroll  ${style.border("·")}  ${style.muted("^B / Esc")} back to chat`;

  if (useSplit) {
    const leftWidth = Math.max(24, Math.min(34, Math.floor(cols * 0.31)));
    const rightWidth = Math.max(24, cols - leftWidth - 5);

    const leftLines = [];
    leftLines.push(style.muted(`Roster (${entries.length})`));
    leftLines.push(style.border("─".repeat(leftWidth)));

    const maxRosterRows = Math.max(1, contentHeight - 2);
    const { start: rStart, slice: rSlice } = sliceCenteredWindow(entries, selectedIdx, maxRosterRows);

    for (let i = 0; i < rSlice.length; i += 1) {
      const row = formatRosterRow(rSlice[i], rStart + i === selectedIdx, leftWidth, style, spinnerFrame, true);
      leftLines.push(padEndVisible(row, leftWidth));
    }

    const { maxDetailScroll, scrollOffset, slice: rightSlice } = sliceScrollableLines(
      buildRightContent(rightWidth),
      boardState.scrollOffset,
      contentHeight,
      stickToBottom,
    );

    const rows = [truncateAnsi(topHeader, cols)];
    for (let y = 0; y < contentHeight; y += 1) {
      const lText = padEndVisible(leftLines[y] || "", leftWidth);
      const rText = truncateAnsi(rightSlice[y] || "", rightWidth);
      rows.push(` ${lText} ${style.border("│")} ${rText}`);
    }
    rows.push(truncateAnsi(bottomHint, cols));
    return { rows, maxDetailScroll, scrollOffset };
  }

  // Narrow terminal stacked layout
  const innerWidth = Math.max(20, cols - 2);
  const rosterCap = Math.min(4, entries.length);
  const { start: rStart, slice: narrowRoster } = sliceCenteredWindow(entries, selectedIdx, rosterCap, 1);
  const rosterRows = narrowRoster.map((entry, idx) => {
    const isSel = rStart + idx === selectedIdx;
    const row = formatRosterRow(entry, isSel, innerWidth - 2, style, spinnerFrame, false);
    return isSel ? ` ${row}` : row;
  });

  const detailHeight = Math.max(2, contentHeight - rosterRows.length - 1);
  const { maxDetailScroll, scrollOffset, slice: detailSlice } = sliceScrollableLines(
    buildRightContent(innerWidth),
    boardState.scrollOffset,
    detailHeight,
    stickToBottom,
  );
  while (detailSlice.length < detailHeight) detailSlice.push("");

  const rows = [
    truncateAnsi(topHeader, cols),
    ...rosterRows,
    ` ${style.border("─".repeat(innerWidth))}`,
    ...detailSlice.map((l) => ` ${truncateAnsi(l, innerWidth)}`),
    truncateAnsi(bottomHint, cols),
  ];
  return { rows: rows.slice(0, safeHeight), maxDetailScroll, scrollOffset };
}
