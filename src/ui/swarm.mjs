import path from "node:path";
import { displayWidth, padEndVisible, truncateAnsi, wrapAnsiLine, wrapAnsiText } from "../term/unicode.mjs";
import { renderMarkdown } from "./markdown.mjs";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatClock(ts) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function formatAge(startedAt, endedAt) {
  if (!startedAt) return "";
  const ms = Math.max(0, (endedAt || Date.now()) - startedAt);
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m${secs % 60}s`;
}

function normalizeRawInput(rawInput) {
  if (!rawInput) return null;
  if (typeof rawInput === "object") return rawInput;
  if (typeof rawInput === "string") {
    try {
      return JSON.parse(rawInput);
    } catch {
      return null;
    }
  }
  return null;
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
  return parts.join("\n").trim();
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
    if (!body || !String(body).trim()) return;
    const text = String(body).trim();
    const last = this.boardMessages[this.boardMessages.length - 1];
    if (last && last.from === from && last.to === to && last.body === text) {
      return;
    }
    this.boardMessages.push({
      id: `msg_${this.boardMessages.length + 1}`,
      time: Date.now(),
      from: from || "coordinator",
      to: to || "all",
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
    const title = String(update.title || "");
    const titleLower = title.toLowerCase();
    const input = normalizeRawInput(update.rawInput);
    const output = extractOutputText(update);
    const status = update.status || "";

    // 1. Track Swarm tool calls
    if (toolName === "swarm" || titleLower.startsWith("swarm") || (input && typeof input.action === "string" && ["add", "status", "kill", "title", "model"].includes(input.action) && (input.brief || input.title || input.name || titleLower.includes("swarm")))) {
      this.handleSwarmTool(toolCallId, input, output, status);
      return;
    }

    // 2. Track Subagent invocations
    if (
      toolName === "invoke_subagent" ||
      titleLower.includes("subagent") ||
      (input && input.TypeName && input.Role && input.Prompt)
    ) {
      this.handleSubagentTool(toolCallId, title, input, output, status);
      return;
    }

    // 3. Track inter-agent / board messages
    if (toolName === "send_message" || (input && input.Recipient && input.Message)) {
      this.handleSendMessageTool(toolCallId, input, output);
      return;
    }

    // 3b. Native swarm board posts by the coordinator
    if (toolName === "post_message" && input && typeof input.text === "string") {
      const mention = /^@([a-z0-9][a-z0-9_#-]*)/i.exec(input.text.trim());
      this.pushBoardMessage({
        from: "coordinator",
        to: mention ? `@${mention[1]}` : input.channel ? `#${input.channel}` : "all",
        body: input.text,
      });
      return;
    }

    // 4. Track manage_subagents kill
    if (toolName === "manage_subagents" && input) {
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
        const worker = existing || {
          id: `swarm:${wName}`,
          kind: "swarm",
          name: wName,
          model: input.model || "inherited",
          workspace: input.workspace || "inherit",
          state: "working",
          brief: fullBrief,
          output: "",
          startedAt: Date.now(),
          updatedAt: Date.now(),
          endedAt: null,
        };
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
    // Try parsing worker states from status tables/lines like "worker-1  waiting  model"
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const stateMatch = /\b([a-z0-9][a-z0-9_-]{0,23})\b.*\b(working|waiting|stopped|killed)\b/i.exec(line);
      if (stateMatch) {
        const wName = stateMatch[1];
        const wState = stateMatch[2].toLowerCase();
        const w = this.workers.get(wName);
        if (w) {
          w.state = wState;
          w.updatedAt = Date.now();
          if (wState === "killed" || wState === "stopped") {
            w.endedAt = w.endedAt || Date.now();
          }
        }
      }
    }

    if (hintName && this.workers.has(hintName)) {
      const w = this.workers.get(hintName);
      w.output = output;
      w.updatedAt = Date.now();
      if (status === "failed" || status === "error") {
        w.state = "failed";
        w.endedAt = Date.now();
      }
    }
  }

  handleSubagentTool(toolCallId, title, input, output, status) {
    const key = toolCallId || `sub_${this.subagents.size + 1}`;
    let sub = this.subagents.get(key);
    if (!sub) {
      sub = {
        id: `sub:${key}`,
        kind: "subagent",
        name: input?.Role || title || "Subagent",
        role: input?.Role || title || "Subagent",
        typeName: input?.TypeName || "subagent",
        model: input?.Model || "inherit",
        workspace: input?.Workspace || "inherit",
        state: "working",
        brief: input?.Prompt || "",
        output: "",
        conversationId: "",
        startedAt: Date.now(),
        updatedAt: Date.now(),
        endedAt: null,
      };
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
      this.swarmTitle = snapshot.swarmTitle;
    }
    if (snapshot.planSummary !== undefined) {
      this.planSummary = snapshot.planSummary;
    }

    // Briefs posted to the board: "@name ..." lines of kind "brief".
    const briefByWorker = new Map();
    for (const line of snapshot.board || []) {
      const mention = /^@([a-z0-9][a-z0-9_-]*)/i.exec(String(line.text || ""));
      if (line.kind === "brief" && mention) {
        briefByWorker.set(mention[1], String(line.text).replace(/^@\S+\s*/, ""));
      }
    }

    for (const diskWorker of snapshot.workers || []) {
      const existing = this.workers.get(diskWorker.name);
      const worker = existing || {
        id: `swarm:${diskWorker.name}`,
        kind: "swarm",
        name: diskWorker.name,
        brief: "",
        output: "",
        recentSteps: [],
        startedAt: Date.now(),
        endedAt: null,
      };
      worker.model = diskWorker.model || worker.model || "";
      worker.workspace = diskWorker.workspace || worker.workspace || "";
      worker.state = diskWorker.state;
      worker.activity = diskWorker.activity;
      worker.task = diskWorker.task;
      worker.conversationId = diskWorker.conversationId;
      worker.transcriptPath = diskWorker.transcriptPath;
      worker.recentSteps = Array.isArray(diskWorker.recentSteps) ? diskWorker.recentSteps : worker.recentSteps || [];
      worker.brief = worker.brief || briefByWorker.get(diskWorker.name) || diskWorker.task || "";
      if (diskWorker.lastText) worker.output = diskWorker.lastText;
      worker.updatedAt = diskWorker.updatedAt || Date.now();
      if (diskWorker.startedAt) worker.startedAt = diskWorker.startedAt;
      const isFinished = worker.state === "killed" || worker.state === "stopped";
      worker.endedAt = isFinished ? worker.endedAt || Date.now() : null;
      this.workers.set(diskWorker.name, worker);
    }

    for (const diskSub of snapshot.subagents || []) {
      const key = `conv:${diskSub.conversationId}`;
      let sub = this.subagents.get(key);
      if (!sub) {
        // Adopt the entry created from the invoke_subagent tool call (same role),
        // so its prompt/brief and start time carry over.
        let adoptedKey = null;
        for (const [candidateKey, candidate] of this.subagents) {
          const isToolCallEntry = !candidateKey.startsWith("conv:");
          if (isToolCallEntry && candidate.role === diskSub.role && !candidate.conversationId) {
            adoptedKey = candidateKey;
            break;
          }
        }
        sub = adoptedKey ? this.subagents.get(adoptedKey) : null;
        if (adoptedKey) this.subagents.delete(adoptedKey);
        sub = sub || {
          id: `sub:${key}`,
          kind: "subagent",
          name: diskSub.role,
          role: diskSub.role,
          typeName: diskSub.typeName,
          model: "inherit",
          workspace: "inherit",
          brief: "",
          output: "",
          recentSteps: [],
          startedAt: Date.now(),
          endedAt: null,
        };
        this.subagents.set(key, sub);
      }
      sub.conversationId = diskSub.conversationId;
      sub.typeName = diskSub.typeName || sub.typeName;
      sub.state = diskSub.state;
      sub.activity = diskSub.activity;
      sub.transcriptPath = diskSub.transcriptPath;
      sub.recentSteps = Array.isArray(diskSub.recentSteps) ? diskSub.recentSteps : sub.recentSteps || [];
      sub.output = diskSub.reply || diskSub.lastText || sub.output;
      sub.updatedAt = diskSub.updatedAt || Date.now();
      if (diskSub.startedAt) sub.startedAt = diskSub.startedAt;
      const isFinished = ["completed", "killed", "failed", "idle"].includes(sub.state);
      sub.endedAt = isFinished ? sub.endedAt || Date.now() : null;
    }

    // The board feed becomes the real swarm board plus messages from subagents.
    const roleByConversation = new Map();
    for (const [, sub] of this.subagents) {
      if (sub.conversationId) roleByConversation.set(sub.conversationId, sub.role);
    }
    const feed = [];
    for (const line of snapshot.board || []) {
      const text = String(line.text || "");
      const mention = /^@([a-z0-9][a-z0-9_#-]*)/i.exec(text);
      feed.push({
        id: `board_${line.seq}`,
        time: Date.parse(String(line.time || "").replace(" ", "T")) || Date.now(),
        from: line.agent || "coordinator",
        to: mention ? `@${mention[1]}` : "all",
        body: text,
        seq: line.seq,
      });
    }
    for (const message of snapshot.messages || []) {
      feed.push({
        id: `msg_${message.id || message.timestamp}`,
        time: Date.parse(message.timestamp || "") || Date.now(),
        from: roleByConversation.get(message.sender) || message.renderDetails?.messageTitle || message.sender,
        to: "coordinator",
        body: message.content,
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
  const spin = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
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
    const fallback = renderSwarmStrip(tracker, cols, style, spinnerFrame);
    return fallback ? [fallback] : [];
  }

  // Build top summary bar of the dock
  const icon = counts.working > 0 || counts.subagentsRunning > 0
    ? style.warn(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length])
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

  const leftW = displayWidth(leftHeader);
  const rightW = displayWidth(rightHint);
  let headerRow;
  if (leftW + rightW + 3 <= maxWidth) {
    headerRow = ` ${leftHeader}${" ".repeat(maxWidth - leftW - rightW)}${rightHint}`;
  } else {
    headerRow = ` ${truncateAnsi(leftHeader, maxWidth, "…")}`;
  }

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
    const age = member.startedAt ? formatAge(member.startedAt, member.endedAt) : "";
    const ageText = age ? style.muted(age) : "";
    const ageWidth = displayWidth(ageText);

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
        if (taskBudget >= 8) {
          bodyStr = `${actText}  ${style.muted(truncateAnsi(taskRaw, taskBudget, "…"))}`;
        } else {
          bodyStr = actText;
        }
      } else {
        bodyStr = actText;
      }
    } else {
      const mutedAct = taskRaw && member.state === "waiting"
        ? `${activityRaw} · ${taskRaw}`
        : activityRaw;
      bodyStr = style.muted(truncateAnsi(mutedAct, bodyBudget, "…"));
    }

    const leftCombined = `${prefixPart}${bodyStr}`;
    const leftCombinedW = displayWidth(leftCombined);
    if (ageWidth > 0 && leftCombinedW + ageWidth + 2 <= maxWidth + 1) {
      const gap = Math.max(2, maxWidth + 1 - leftCombinedW - ageWidth);
      rows.push(`${leftCombined}${" ".repeat(gap)}${ageText}`);
    } else {
      rows.push(truncateAnsi(leftCombined, cols, "…"));
    }
  }

  if (hiddenCount > 0) {
    rows.push(`   ${style.muted(`+${hiddenCount} more agents · press ^B for full board`)}`);
  }

  return rows;
}

/**
 * Renders an inspected agent's live transcript (Codex-style recent steps + brief
 * + latest reply) for display inside the main viewport via Alt+[ / Alt+].
 */
export function renderMemberTimeline(member, cols, style, spinnerFrame) {
  if (!member) return [];
  const contentWidth = Math.max(24, cols - 4);
  const lines = [""];

  const badge = statusBadge(member.state, style, spinnerFrame);
  const paintName = memberColorFn(member.name, style);
  const age = member.startedAt ? ` · ${formatAge(member.startedAt, member.endedAt)}` : "";
  const banner = `${badge} ${paintName(member.name)}  ${style.muted(`[${member.kind} · ${member.state}${age}]`)}`;
  lines.push(`  ${truncateAnsi(banner, contentWidth, "…")}`);

  const metaBits = [];
  if (member.model) metaBits.push(`model ${member.model}`);
  if (member.workspace) metaBits.push(`workspace ${member.workspace}`);
  if (member.updatedAt) metaBits.push(`updated ${formatAge(member.updatedAt, Date.now())} ago`);
  if (metaBits.length > 0) {
    lines.push(`  ${style.muted(truncateAnsi(metaBits.join(" · "), contentWidth, "…"))}`);
  }
  lines.push(`  ${style.muted("Alt+[/] switch agent · Esc back to main conversation · ^B full board")}`);
  lines.push(`  ${style.border("─".repeat(Math.min(contentWidth, 72)))}`);
  lines.push("");

  if (member.brief) {
    lines.push(`  ${style.accent("Assignment")}`);
    for (const bl of wrapAnsiText(style.muted(member.brief), Math.max(16, contentWidth - 2))) {
      lines.push(`    ${bl}`);
    }
    lines.push("");
  }

  const steps = Array.isArray(member.recentSteps) ? member.recentSteps : [];
  if (steps.length > 0) {
    lines.push(`  ${style.accent("Live Activity")}`);
    for (const step of steps) {
      if (step.kind === "tool") {
        const icon = step.status === "running"
          ? style.warn(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length])
          : step.status === "failed"
            ? style.error("✗")
            : step.status === "waiting"
              ? style.accentAlt("◌")
              : style.muted("•");
        const text = truncateAnsi(step.activity || step.name || "tool", Math.max(16, contentWidth - 4), "…");
        lines.push(`  ${icon} ${step.status === "running" ? style.text(text) : style.muted(text)}`);
      } else if (step.kind === "message" && step.text) {
        lines.push("");
        for (const ml of renderMarkdown(step.text, Math.max(16, contentWidth - 2), style)) {
          lines.push(ml ? `  ${ml}` : "");
        }
        lines.push("");
      }
    }
  } else if (member.output) {
    lines.push(`  ${style.accent("Latest Output")}`);
    for (const ml of renderMarkdown(member.output, Math.max(16, contentWidth - 2), style)) {
      lines.push(ml ? `  ${ml}` : "");
    }
  } else {
    lines.push(`  ${style.muted("Waiting for transcript activity…")}`);
  }

  if (member.activity && ACTIVE_STATES.has(member.state)) {
    const spin = style.warn(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]);
    lines.push("");
    lines.push(`  ${spin} ${style.text(truncateAnsi(member.activity, Math.max(16, contentWidth - 4), "…"))}`);
  }

  lines.push("");
  return lines;
}

/**
 * Compact 1-line transparent indicator shown above composer ONLY when
 * Swarm workers, Subagents, or Artifacts are active in this session.
 * Lists members by name (active ones first) so their state is visible
 * without opening the board.
 */
export function renderSwarmStrip(tracker, cols, style, spinnerFrame) {
  if (!tracker || !tracker.hasActivity()) return null;
  const counts = tracker.getSummaryCounts();
  const maxWidth = Math.max(20, cols - 2);

  const members = [...tracker.workers.values(), ...tracker.subagents.values()]
    .filter((member) => member.state !== "killed")
    .sort((a, b) => (STRIP_STATE_ORDER[a.state] ?? 9) - (STRIP_STATE_ORDER[b.state] ?? 9));

  const prefixParts = [];
  if (counts.swarmCount > 0) {
    // Per-member badges already show working / waiting / done, so the prefix
    // only names the swarm; that leaves room for member names.
    const titlePart = counts.swarmTitle ? `Swarm "${counts.swarmTitle}"` : "Swarm";
    const icon = counts.working > 0
      ? style.warn(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length])
      : style.accent("◈");
    prefixParts.push(`${icon} ${style.bold(titlePart)}`);
  } else if (counts.subagentsTotal > 0) {
    prefixParts.push(style.muted(`${counts.subagentsRunning}/${counts.subagentsTotal} subagents running`));
  }

  const suffixParts = [];
  if (counts.artifactCount > 0) {
    suffixParts.push(style.accentAlt(`◇ ${counts.artifactCount} (/artifacts)`));
  }
  suffixParts.push(style.muted("^B board"));

  const separator = style.border("  ·  ");
  const separatorWidth = 5;
  const prefix = prefixParts.join(separator);
  const suffix = suffixParts.join(separator);
  // Leading space + prefix + suffix + the two separators around the member list.
  const fixedWidth = 1 + displayWidth(prefix) + displayWidth(suffix) + separatorWidth * (prefix ? 2 : 1);
  const memberBudget = Math.max(0, maxWidth - fixedWidth);

  // Names first: show as many members as fit (reserving room for "+N"), then give
  // whatever width is left to the first active member's current action.
  const namePieces = members.map((member) => `${statusBadge(member.state, style, spinnerFrame)} ${member.name}`);
  let shownCount = 0;
  let usedWidth = 0;
  for (let i = 0; i < namePieces.length; i += 1) {
    const pieceWidth = displayWidth(namePieces[i]) + (shownCount > 0 ? 2 : 0);
    const remainingAfter = namePieces.length - i - 1;
    const overflowTagWidth = remainingAfter > 0 ? 2 + String(remainingAfter).length + 1 : 0;
    if (usedWidth + pieceWidth + overflowTagWidth > memberBudget) break;
    usedWidth += pieceWidth;
    shownCount += 1;
  }
  const hiddenCount = members.length - shownCount;
  if (hiddenCount > 0) usedWidth += 2 + String(hiddenCount).length + 1;

  const memberPieces = namePieces.slice(0, shownCount);
  const activeIndex = members.slice(0, shownCount).findIndex((member) => ACTIVE_STATES.has(member.state) && member.activity);
  const activityRoom = memberBudget - usedWidth - 1;
  if (activeIndex >= 0 && activityRoom >= 8) {
    const activity = truncateAnsi(members[activeIndex].activity, Math.min(activityRoom, 40), "…");
    memberPieces[activeIndex] = `${memberPieces[activeIndex]} ${style.muted(activity)}`;
  }
  if (hiddenCount > 0) {
    memberPieces.push(style.muted(`+${hiddenCount}`));
  }

  const parts = [prefix, memberPieces.join("  "), suffix].filter(Boolean);
  if (parts.length === 0) return null;
  return ` ${truncateAnsi(parts.join(separator), maxWidth, "…")}`;
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
    return { rows: lines.slice(0, safeHeight), maxDetailScroll: 0 };
  }

  const selectedIdx = Math.max(0, Math.min(boardState.selectedIdx || 0, entries.length - 1));
  const selectedEntry = entries[selectedIdx];
  const activeTab = selectedEntry.kind === "board" ? "board" : (boardState.tab || "detail");

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
        const bodyLines = renderMarkdown(msg.body, Math.max(16, rightWidth - 2), style);
        for (const bl of bodyLines) {
          out.push(bl ? `  ${bl}` : "");
        }
        out.push(style.border("·".repeat(Math.min(28, rightWidth))));
      }
      return out;
    }

    // Member detail view
    const m = selectedEntry;
    const out = [];
    const badge = statusBadge(m.state, style, spinnerFrame);
    out.push(`${badge} ${style.bold(m.name)}  ${style.muted(`[${m.kind} · ${m.state}]`)}`);
    const metaParts = [];
    if (m.model) metaParts.push(`model: ${m.model}`);
    if (m.workspace) metaParts.push(`workspace: ${m.workspace}`);
    if (m.startedAt) metaParts.push(`elapsed: ${formatAge(m.startedAt, m.endedAt)}`);
    if (metaParts.length > 0) {
      out.push(style.muted(metaParts.join("  ·  ")));
    }
    if (m.activity && (m.state === "working" || m.state === "running" || m.state === "waiting")) {
      out.push(`${style.accent("Now:")} ${truncateAnsi(m.activity, Math.max(16, rightWidth - 6), "…")}`);
    }
    if (m.transcriptPath && m.updatedAt) {
      out.push(style.muted(`last activity ${formatAge(m.updatedAt, Date.now())} ago`));
    }
    if (m.transcriptPath) {
      out.push(style.muted(truncateAnsi(`log: ${m.transcriptPath}`, rightWidth, "…")));
    }
    out.push(style.border("─".repeat(Math.min(rightWidth, 64))));

    if (m.brief) {
      out.push(style.accent("Assignment / Brief"));
      for (const bl of wrapAnsiText(style.text(m.brief), Math.max(16, rightWidth - 2))) {
        out.push(`  ${bl}`);
      }
      out.push("");
    }

    const recentTools = (m.recentSteps || []).filter((s) => s.kind === "tool").slice(-10);
    if (recentTools.length > 0) {
      out.push(style.accent("Recent Steps"));
      for (const st of recentTools) {
        const sIcon = st.status === "running"
          ? style.warn(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length])
          : st.status === "failed"
            ? style.error("✗")
            : style.muted("•");
        out.push(`  ${sIcon} ${style.muted(truncateAnsi(st.activity || st.name, Math.max(16, rightWidth - 6), "…"))}`);
      }
      out.push("");
    }

    if (m.output) {
      out.push(style.accent("Latest Output"));
      for (const ol of renderMarkdown(m.output, Math.max(16, rightWidth - 2), style)) {
        out.push(ol ? `  ${ol}` : "");
      }
    } else {
      out.push(style.muted("Waiting for output updates…"));
    }
    return out;
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
    const rStart = Math.max(0, Math.min(selectedIdx - Math.floor(maxRosterRows / 2), entries.length - maxRosterRows));
    const rSlice = entries.slice(rStart, rStart + maxRosterRows);

    for (let i = 0; i < rSlice.length; i += 1) {
      const entry = rSlice[i];
      const isSel = rStart + i === selectedIdx;
      const icon = statusBadge(entry.state, style, spinnerFrame);
      const age = entry.startedAt ? ` ${formatAge(entry.startedAt, entry.endedAt)}` : "";
      const rawName = truncateAnsi(entry.name, Math.max(8, leftWidth - displayWidth(age) - 4), "…");
      const rowText = isSel
        ? style.selected(` ▸ ${rawName}${age} `)
        : ` ${icon} ${style.text(rawName)}${style.muted(age)}`;
      leftLines.push(padEndVisible(rowText, leftWidth));
    }

    const rightAll = buildRightContent(rightWidth);
    const maxDetailScroll = Math.max(0, rightAll.length - contentHeight);
    const scrollOffset = Math.max(0, Math.min(boardState.scrollOffset || 0, maxDetailScroll));
    const rightSlice = rightAll.slice(scrollOffset, scrollOffset + contentHeight);

    const rows = [truncateAnsi(topHeader, cols)];
    for (let y = 0; y < contentHeight; y += 1) {
      const lText = padEndVisible(leftLines[y] || "", leftWidth);
      const rText = truncateAnsi(rightSlice[y] || "", rightWidth);
      rows.push(` ${lText} ${style.border("│")} ${rText}`);
    }
    rows.push(truncateAnsi(bottomHint, cols));
    return { rows, maxDetailScroll };
  }

  // Narrow terminal stacked layout
  const innerWidth = Math.max(20, cols - 2);
  const rosterCap = Math.min(4, entries.length);
  const rStart = Math.max(0, Math.min(selectedIdx - 1, entries.length - rosterCap));
  const rosterRows = entries.slice(rStart, rStart + rosterCap).map((entry, idx) => {
    const isSel = rStart + idx === selectedIdx;
    const icon = statusBadge(entry.state, style, spinnerFrame);
    const label = truncateAnsi(entry.name, innerWidth - 6, "…");
    return isSel ? ` ${style.selected(` ▸ ${label} `)}` : ` ${icon} ${style.text(label)}`;
  });

  const detailHeight = Math.max(2, contentHeight - rosterRows.length - 1);
  const detailAll = buildRightContent(innerWidth);
  const maxDetailScroll = Math.max(0, detailAll.length - detailHeight);
  const scrollOffset = Math.max(0, Math.min(boardState.scrollOffset || 0, maxDetailScroll));
  const detailSlice = detailAll.slice(scrollOffset, scrollOffset + detailHeight);
  while (detailSlice.length < detailHeight) detailSlice.push("");

  const rows = [
    truncateAnsi(topHeader, cols),
    ...rosterRows,
    ` ${style.border("─".repeat(innerWidth))}`,
    ...detailSlice.map((l) => ` ${truncateAnsi(l, innerWidth)}`),
    truncateAnsi(bottomHint, cols),
  ];
  return { rows: rows.slice(0, safeHeight), maxDetailScroll };
}
