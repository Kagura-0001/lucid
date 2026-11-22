import { spawn } from "node:child_process";
import fs from "node:fs";
import { AgyStateWatcher, resolveAgyDataDir } from "./acp/agy_state.mjs";
import { findLiveBgSession, listLiveBgSessions } from "./acp/bg_registry.mjs";
import { AcpClient, fetchAgyQuota } from "./acp/client.mjs";
import { HostAcpClient, spawnSessionHost } from "./acp/host_client.mjs";
import { loadUserConfig, resolveAgentLaunch, saveUserConfig } from "./config.mjs";
import { copyToClipboardOsc52, detectColorDepth } from "./term/ansi.mjs";
import { InputParser } from "./term/input.mjs";
import { TerminalRenderer } from "./term/renderer.mjs";
import { Composer } from "./ui/composer.mjs";
import {
  WorkspaceFileIndex,
  buildPromptBlocks,
  formatBytes,
  loadImageAttachment,
  tryLoadDroppedImage,
  tryReadClipboardImage,
} from "./ui/files.mjs";
import {
  cloneSelection,
  createSelection,
  extractSelectionText,
  highlightSelectionInViewport,
  isSelectionEmpty,
  patchSelectionInFrame,
} from "./ui/selection.mjs";
import { MultiAgentTracker, renderMemberTimeline, renderSwarmBoardView } from "./ui/swarm.mjs";
import { createThemeStyler, listThemes } from "./ui/themes.mjs";
import { extractCleanOutputPreview, parseExitCode } from "./ui/tool_format.mjs";
import {
  applyOverlayModal,
  renderAutocompletePopup,
  renderComposerBlock,
  renderHeader,
  renderTimeline,
} from "./ui/views.mjs";

// lucid's session-level bypass: agent "auto" mode plus auto-approval of every
// tool permission request. Lives only in this lucid process, never persisted.
const BYPASS_MODE_ID = "bypass";

const LOCAL_COMMANDS = [
  { name: "model", description: "Switch active model", local: true },
  { name: "effort", description: "Switch thinking / reasoning level", local: true },
  { name: "mode", description: "Switch mode (default / accept-edits / auto / plan / bypass)", local: true },
  { name: "resume", description: "Resume a live background or saved conversation (/resume [id|filter])", local: true },
  { name: "sessions", description: "Browse & load existing conversations (alias of /resume)", local: true },
  { name: "bg", description: "Move session to background (/bg [prompt]) — resume via /resume", local: true },
  { name: "new", description: "Start a fresh conversation session", local: true },
  { name: "board", description: "Open Swarm & Subagent multi-pane board (Ctrl+B)", local: true },
  { name: "dock", description: "Fold or expand the bottom multi-agent progress dock (Alt+B)", local: true },
  { name: "artifacts", description: "Browse & read session Markdown artifacts", local: true },
  { name: "image", description: "Attach an image file (/image <path>)", local: true },
  { name: "unattach", description: "Clear staged image attachments", local: true },
  { name: "theme", description: "Switch transparent color theme", local: true },
  { name: "copy", description: "Copy latest assistant reply (OSC 52)", local: true },
  { name: "mouse", description: "Toggle mouse wheel capture (OFF = native drag-select)", local: true },
  { name: "expand", description: "Toggle expanded tool outputs & diffs", local: true },
  { name: "thoughts", description: "Toggle, fold, or hide thinking blocks (/thoughts [fold|show|hide])", local: true },
  { name: "usage", description: "Show context usage & Antigravity quota", local: true },
  { name: "quota", description: "Check Antigravity quota (alias of /usage)", local: true },
  { name: "clear", description: "Clear visible timeline (keeps session alive)", local: true },
  { name: "help", description: "Show keyboard shortcuts & commands", local: true },
  { name: "quit", description: "Exit lucid cleanly", local: true },
];

function extractChunkText(update) {
  if (!update) return "";
  if (typeof update.text === "string") return update.text;
  const content = update.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    if (typeof content.text === "string") return content.text;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part?.content && typeof part.content.text === "string") return part.content.text;
        return "";
      })
      .join("");
  }
  return "";
}

function summarizeRawInput(rawInput) {
  if (!rawInput) return "";
  if (typeof rawInput === "string") return rawInput.slice(0, 300);
  if (typeof rawInput === "object") {
    if (typeof rawInput.CommandLine === "string") return `$ ${rawInput.CommandLine}`;
    if (typeof rawInput.command === "string") return `$ ${rawInput.command}`;
    if (typeof rawInput.Path === "string") return rawInput.Path;
    if (typeof rawInput.path === "string") return rawInput.path;
    try {
      return JSON.stringify(rawInput).slice(0, 300);
    } catch {
      return "";
    }
  }
  return "";
}

function formatRelativeTime(isoString) {
  if (!isoString) return "";
  const ts = Date.parse(isoString);
  if (Number.isNaN(ts)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function findSessionByIdOrPrefix(sessions, query) {
  const qLower = String(query || "").trim().toLowerCase();
  if (!qLower || !Array.isArray(sessions) || sessions.length === 0) return null;
  const exact = sessions.find((s) => String(s.sessionId || "").toLowerCase() === qLower);
  if (exact) return exact;
  if (qLower.length >= 4) {
    const prefixMatches = sessions.filter((s) => String(s.sessionId || "").toLowerCase().startsWith(qLower));
    if (prefixMatches.length === 1) return prefixMatches[0];
  }
  return null;
}

export class LucidApp {
  constructor(cliOptions = {}) {
    this.cliOptions = cliOptions;
    this.userConfig = loadUserConfig();
    this.cwd = cliOptions.cwd || process.cwd();
    this.colorDepth = detectColorDepth();

    const themeName = cliOptions.theme || this.userConfig.theme || "transparent";
    this.style = createThemeStyler(themeName, this.colorDepth);

    this.launchSpec = resolveAgentLaunch(cliOptions, this.userConfig);
    this.renderer = new TerminalRenderer(process.stdout);
    this.inputParser = null;
    this.acp = null;
    this.fileIndex = new WorkspaceFileIndex(this.cwd);

    const thoughtMode = ["fold", "expanded", "hidden"].includes(this.userConfig.thoughtMode)
      ? this.userConfig.thoughtMode
      : this.userConfig.showThoughts
        ? "expanded"
        : "fold";

    this.state = {
      cwd: this.cwd,
      agentLabel: this.launchSpec.name,
      // launchBypass: agy itself was started with --dangerously-skip-permissions.
      // sessionBypass: user switched to the Bypass mode inside this session.
      launchBypass: (this.launchSpec.args || []).includes("--dangerously-skip-permissions"),
      sessionBypass: false,
      bypassPermissions: (this.launchSpec.args || []).includes("--dangerously-skip-permissions"),
      connected: false,
      connecting: true,
      sessionId: null,
      modelLabel: "",
      effortLabel: "",
      modeId: "",
      modes: [],
      models: [],
      configOptions: [],
      agentCommands: [],
      usage: null,
      quotaText: "",
      items: [],
      busy: false,
      activePromptCount: 0,
      turnStartedAt: 0,
      spinnerFrame: 0,
      scrollOffset: 0,
      maxScrollOffset: 0,
      mouseCapture: cliOptions.noMouse ? false : Boolean(this.userConfig.mouseCapture),
      thoughtMode,
      showThoughts: thoughtMode === "expanded",
      expandTools: Boolean(this.userConfig.expandTools),
      composer: new Composer(),
      stagedImages: [],
      multiAgent: new MultiAgentTracker(),
      swarmDockCollapsed: false,
      focusedAgentId: null,
      focusedAgentName: "",
      toast: null,
    };

    this.toolMap = new Map();
    this.activePlanItem = null;
    this.permissionQueue = [];
    this.modal = null;
    this.popup = null;
    this.dismissedPopupKey = null;
    this.boardOpen = false;
    this.boardState = { selectedIdx: 0, tab: "board", scrollOffset: 0, maxDetailScroll: 0 };
    this.activeLocalShell = null;

    // Mouse selection over the timeline (see ui/selection.mjs) and the layout of the
    // last rendered frame, used to map screen rows to timeline lines and patch
    // selection highlights incrementally without rebuilding the timeline.
    this.selection = null;
    this.timelineLayout = null;
    this.selectionPatchQueued = false;
    this.selectionPatchTimer = null;
    this.lastSelectionPatchAt = 0;
    this.scrollFlushQueued = false;
    this.scrollFlushTimer = null;
    this.lastScrollFlushAt = 0;
    this.lastAltScrollAt = 0;
    this.pendingChunkEvents = null;

    // agy persists live Swarm / Subagent state on disk; the ACP stream does not
    // report e.g. a background subagent finishing, so poll that state.
    const launchesAgy = /(^|\/)agy$/.test(this.launchSpec.command || "");
    this.agyStateWatcher = launchesAgy
      ? new AgyStateWatcher({
          dataDir: resolveAgyDataDir(this.launchSpec.args || [], this.userConfig.agyDataDir || ""),
        })
      : null;
    this.agyStateTimer = null;

    this.renderTimer = null;
    this.renderPriority = false;
    this.spinnerTimer = null;
    this.lastCtrlCAt = 0;
    this.exiting = false;
    this.exitNotice = "";
    this.replayingSnapshot = false;
    this.startupOverridesApplied = false;
  }

  async run() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("lucid requires an interactive TTY terminal.");
    }

    this.setupTerminal();
    this.fileIndex.refresh();
    this.renderNow();

    if (this.agyStateWatcher) {
      this.agyStateTimer = setInterval(() => {
        this.pollAgyState();
      }, 1000);
    }

    this.spinnerTimer = setInterval(() => {
      const hasToastExpired = this.state.toast && Date.now() >= this.state.toast.expiresAt;
      if (hasToastExpired) {
        this.state.toast = null;
        this.scheduleRender();
      }
      if (this.state.connecting || this.state.busy || this.hasRunningTools() || this.hasMultiAgentActivity()) {
        this.state.spinnerFrame = (this.state.spinnerFrame + 1) % 10;
        this.scheduleRender();
      }
    }, 120);

    await this.connectAndStartSession();

    // Keep process alive until shutdown() resolves
    await new Promise((resolve) => {
      this.resolveRun = resolve;
    });
  }

  pollAgyState() {
    if (!this.agyStateWatcher || this.exiting) return;
    this.agyStateWatcher.setSession(this.state.sessionId);
    let snapshot = null;
    try {
      snapshot = this.agyStateWatcher.poll();
    } catch {
      // On-disk state is best-effort; never let it break the UI.
      return;
    }
    if (snapshot) {
      this.state.multiAgent.applyAgyState(snapshot);
      this.scheduleRender();
    }
  }

  hasMultiAgentActivity() {
    for (const member of [...this.state.multiAgent.workers.values(), ...this.state.multiAgent.subagents.values()]) {
      if (member.state === "working" || member.state === "running") return true;
    }
    return false;
  }

  hasRunningTools() {
    for (const [, tool] of this.toolMap) {
      if (tool.status !== "completed" && tool.status !== "failed" && tool.status !== "error" && tool.status !== "cancelled") {
        return true;
      }
    }
    return false;
  }

  setupTerminal() {
    process.stdin.setRawMode(true);
    process.stdin.resume();

    this.renderer.enter({ mouseCapture: this.state.mouseCapture });

    this.inputParser = new InputParser((event) => {
      if (this.pendingChunkEvents) {
        this.pendingChunkEvents.push(event);
      } else {
        this.handleInputEvent(event);
      }
    });

    this.onStdinData = (chunk) => {
      const batch = [];
      this.pendingChunkEvents = batch;
      try {
        this.inputParser.feed(chunk);
      } finally {
        this.pendingChunkEvents = null;
      }
      if (batch.length > 0) {
        this.dispatchInputBatch(batch);
      }
    };
    process.stdin.on("data", this.onStdinData);

    this.onResize = () => {
      this.renderer.invalidate();
      this.scheduleRender();
    };
    process.stdout.on("resize", this.onResize);

    this.onSignal = () => {
      this.shutdown(0);
    };
    this.onSighup = () => {
      // SSH disconnect or terminal close: detach hosted sessions so work keeps running.
      if (this.acp?.isHosted && (this.state.busy || this.state.items.length > 0)) {
        this.detachToBackground({ silent: true });
      } else {
        this.shutdown(0);
      }
    };
    this.onProcessExit = () => {
      this.restoreTerminalSync();
    };
    process.once("SIGINT", this.onSignal);
    process.once("SIGTERM", this.onSignal);
    process.once("SIGHUP", this.onSighup);
    process.on("exit", this.onProcessExit);
  }

  restoreTerminalSync() {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      // Ignore
    }
    this.renderer.leave({ sync: true });
  }

  bindAcpClient(client) {
    client.on("sessionUpdate", (params) => {
      if (client !== this.acp) return;
      this.handleSessionUpdate(params);
    });

    client.on("permissionRequest", (req) => {
      if (client !== this.acp) return;
      this.enqueuePermissionRequest(req);
    });

    client.on("promptDone", (info) => {
      if (client !== this.acp) return;
      if (info?.stopReason === "cancelled") {
        this.pushNotice("info", "Turn cancelled.");
      } else if (info?.error) {
        this.pushNotice("error", info.error);
      }
      this.state.activePromptCount = typeof info?.activePromptCount === "number"
        ? info.activePromptCount
        : Math.max(0, this.state.activePromptCount - 1);
      if (this.state.activePromptCount === 0) {
        this.state.busy = false;
        this.finalizeAllStreaming();
      }
      this.scheduleRender();
    });

    client.on("detached", (reason) => {
      if (client !== this.acp || this.exiting) return;
      this.exitNotice = reason ? `Detached: ${reason}` : "Detached from session host.";
      this.shutdown(0, { detach: true });
    });

    client.on("disconnect", () => {
      if (client !== this.acp || this.exiting) return;
      this.state.connected = false;
      this.state.busy = false;
      this.pushNotice("error", "ACP backend disconnected. Use /quit or restart lucid.");
      this.scheduleRender();
    });
  }

  applyHostSnapshot(snapshot) {
    if (!snapshot) return;
    const info = snapshot.agentInfo || snapshot.initResult?.agentInfo;
    if (info?.name) {
      this.state.agentLabel = info.version ? `${info.name} ${info.version}` : info.name;
    }

    this.state.items = [];
    this.toolMap.clear();
    this.state.multiAgent.reset();
    this.state.stagedImages = [];
    this.permissionQueue = [];
    this.modal = null;
    this.boardOpen = false;
    this.activePlanItem = null;
    this.state.scrollOffset = 0;

    this.state.sessionId = snapshot.sessionId || "";
    this.state.sessionTitle = snapshot.sessionTitle || "";
    this.state.usage = snapshot.usage || null;
    this.applySessionMetadata(snapshot.sessionMeta || {});
    if (snapshot.modelLabel) this.state.modelLabel = snapshot.modelLabel;
    if (snapshot.modeId) this.state.modeId = snapshot.modeId;
    if (snapshot.bypassPermissions && !this.state.launchBypass) {
      this.state.sessionBypass = true;
      this.state.bypassPermissions = true;
    }

    // Replay buffered conversation events silently in one pass.
    this.replayingSnapshot = true;
    try {
      for (const ev of snapshot.eventLog || []) {
        if (ev.type === "userPrompt") {
          this.finalizeAllStreaming();
          this.state.items.push({
            type: "user",
            text: ev.text || "(image attachment)",
            displayText: ev.displayText || undefined,
            attachedPaths: ev.attachedPaths || [],
            attachedImages: ev.attachedImages || [],
          });
        } else if (ev.type === "sessionUpdate") {
          this.handleSessionUpdate(ev.params);
        } else if (ev.type === "notice") {
          this.pushNotice(ev.level || "info", ev.text || "");
        }
      }
      if (!snapshot.busy) {
        this.finalizeAllStreaming();
      }
    } finally {
      this.replayingSnapshot = false;
    }

    this.state.busy = Boolean(snapshot.busy);
    this.state.activePromptCount = snapshot.activePromptCount || (snapshot.busy ? 1 : 0);
    this.state.turnStartedAt = snapshot.turnStartedAt || 0;

    if (Array.isArray(snapshot.pendingPermissions) && this.acp?.makePermissionHandle) {
      for (const perm of snapshot.pendingPermissions) {
        this.enqueuePermissionRequest(this.acp.makePermissionHandle(perm.permId, perm.params));
      }
    }

    if (this.state.sessionTitle) {
      try {
        process.stdout.write(`\x1b]0;lucid — ${this.state.sessionTitle}\x07`);
      } catch {
        // Ignore terminal title write errors
      }
    }
    this.pollAgyState();
    this.scheduleRender(true);
  }

  async attachToBgHost(bgMeta, { keepPreviousHost = false } = {}) {
    const nextClient = new HostAcpClient({
      hostId: bgMeta.hostId,
      socketPath: bgMeta.socketPath,
      launchSpec: this.launchSpec,
    });
    const prevClient = this.acp;
    const prevSessionId = this.state.sessionId;
    const prevHadWork = Boolean(this.state.busy || this.state.items.length > 0);

    const snapshot = await nextClient.start(15000);
    this.acp = nextClient;
    this.bindAcpClient(nextClient);
    this.state.connected = true;
    this.applyHostSnapshot(snapshot);

    if (prevClient && prevClient !== nextClient) {
      if (keepPreviousHost && prevClient.isHosted && prevHadWork) {
        await prevClient.detach();
      } else {
        await prevClient.stop(prevSessionId);
      }
    }

    const statusTag = snapshot.busy ? "running" : "resumed";
    this.showToast(`Attached to live session ${bgMeta.hostId} (${statusTag})`);
    this.scheduleRender(true);
  }

  async startHostedOrDirectClient() {
    if (!this.cliOptions.direct) {
      try {
        const spawned = spawnSessionHost({
          cwd: this.cwd,
          launchSpec: this.launchSpec,
          addDirs: this.cliOptions.addDirs || [],
          bypassPermissions: this.state.bypassPermissions,
        });
        const client = new HostAcpClient({
          hostId: spawned.hostId,
          socketPath: spawned.socketPath,
          launchSpec: this.launchSpec,
        });
        this.acp = client;
        this.bindAcpClient(client);
        return await client.start(20000);
      } catch {
        // Fall back to direct child process if spawning/binding the host fails.
      }
    }
    const direct = new AcpClient(this.launchSpec);
    this.acp = direct;
    this.bindAcpClient(direct);
    return direct.start();
  }

  async connectAndStartSession() {
    this.state.connecting = true;
    this.scheduleRender();

    try {
      // Check whether --session or --continue targets a live background session first.
      let liveTarget = null;
      if (!this.cliOptions.direct) {
        if (this.cliOptions.session) {
          liveTarget = findLiveBgSession(this.cliOptions.session);
        } else if (this.cliOptions.continueLatest) {
          const liveForCwd = listLiveBgSessions({ cwd: this.cwd });
          if (liveForCwd.length > 0) {
            liveTarget = liveForCwd[0];
          }
        }
      }

      if (liveTarget) {
        await this.attachToBgHost(liveTarget);
        this.startupOverridesApplied = true;
      } else {
        const initResult = await this.startHostedOrDirectClient();
        const info = initResult?.agentInfo || initResult?.initResult?.agentInfo;
        if (info?.name) {
          this.state.agentLabel = info.version ? `${info.name} ${info.version}` : info.name;
        }
        this.state.connected = true;

        await this.openInitialSession();
        await this.applyStartupOverrides();
      }

      this.state.connecting = false;
      this.scheduleRender();

      // Non-blocking background quota check for Antigravity
      if (this.launchSpec.supportsQuotaCli) {
        fetchAgyQuota(15000).then((quota) => {
          if (quota?.badge && !this.exiting) {
            this.state.quotaText = quota.badge;
            this.scheduleRender();
          }
        });
      }
    } catch (err) {
      this.state.connecting = false;
      this.state.connected = false;
      this.pushNotice("error", `Failed to connect to ${this.launchSpec.command}: ${err.message}`);
      if (this.launchSpec.loginArgs) {
        this.pushNotice("info", `If authentication is needed, run: ${this.launchSpec.command} ${this.launchSpec.loginArgs.join(" ")}`);
      }
      this.scheduleRender();
    }
  }

  async createFreshSession() {
    const created = await this.acp.createSession(this.cwd, this.cliOptions.addDirs || []);
    this.state.sessionId = created.sessionId;
    this.applySessionMetadata(created);
    if (this.startupOverridesApplied) {
      await this.applyPreferredMode({ silentIfUnavailable: true });
    }
  }

  resolveModeId(requestedMode) {
    const raw = String(requestedMode || "").trim().toLowerCase();
    if (!raw) return "";
    if (this.state.modes.length === 0) return raw;
    const exact = this.state.modes.find((m) => String(m.id || "").toLowerCase() === raw);
    if (exact) return exact.id;
    if (raw === "bypass" || raw === "yolo") {
      const bypassMatch = this.state.modes.find((m) => /bypass|auto/i.test(String(m.id || "")));
      if (bypassMatch) return bypassMatch.id;
    }
    return "";
  }

  async applyPreferredMode({ explicitMode = "", silentIfUnavailable = false } = {}) {
    if (!this.state.sessionId) return;
    const requested = explicitMode || this.userConfig.mode || "";
    if (!requested) return;
    const resolvedId = this.resolveModeId(requested);
    if (!resolvedId) {
      if (!silentIfUnavailable) {
        this.pushNotice("warn", `Unknown mode "${requested}". Available: ${this.state.modes.map((m) => m.id).join(", ")}`);
      }
      return;
    }
    if (resolvedId === this.state.modeId) return;
    try {
      const res = await this.acp.setMode(this.state.sessionId, resolvedId);
      this.applySessionMetadata(res);
      this.state.modeId = resolvedId;
    } catch (err) {
      if (!silentIfUnavailable) {
        this.pushNotice("warn", `Could not set mode "${requested}": ${err.message}`);
      }
    }
  }

  async applyStartupOverrides() {
    if (this.startupOverridesApplied || !this.state.sessionId) return;
    this.startupOverridesApplied = true;

    const explicitMode = this.cliOptions.mode || "";
    await this.applyPreferredMode({
      explicitMode,
      silentIfUnavailable: !explicitMode,
    });

    if (this.cliOptions.model) {
      try {
        const res = await this.acp.setModel(this.state.sessionId, this.cliOptions.model, this.hasConfigOption("model"));
        this.applySessionMetadata(res);
      } catch (err) {
        this.pushNotice("warn", `Could not set model "${this.cliOptions.model}": ${err.message}`);
      }
    }
  }

  async resolveSessionReference(ref) {
    const trimmed = String(ref || "").trim();
    if (!trimmed) return { sessionId: "", title: "" };
    if (this.acp.supportsSessionList()) {
      try {
        const sessions = await this.acp.listSessions(this.cwd);
        const match = findSessionByIdOrPrefix(sessions, trimmed);
        if (match) {
          return { sessionId: match.sessionId, title: match.title || "" };
        }
      } catch {
        // Fallback to raw session ID
      }
    }
    return { sessionId: trimmed, title: "" };
  }

  async openInitialSession() {
    if (this.cliOptions.session) {
      const resolved = await this.resolveSessionReference(this.cliOptions.session);
      await this.switchToSession(resolved.sessionId, resolved.title || "Resumed session");
      return;
    }

    if (this.cliOptions.resumePicker) {
      await this.openResumePicker({ startup: true });
      return;
    }

    if (this.cliOptions.continueLatest && this.acp.supportsSessionList()) {
      try {
        const sessions = await this.acp.listSessions(this.cwd);
        if (sessions.length > 0) {
          await this.switchToSession(sessions[0].sessionId, sessions[0].title || "Latest session");
          return;
        }
      } catch {
        // Fallback to creating a fresh session
      }
    }

    await this.createFreshSession();
  }

  async openResumePicker({ query = "", startup = false } = {}) {
    const q = (query || "").trim();
    const liveBg = this.cliOptions.direct
      ? []
      : listLiveBgSessions({ cwd: this.cwd, excludeHostId: this.acp?.hostId || "" });

    // Direct match against a live background session ID or ACP session ID
    if (q && liveBg.length > 0) {
      const ql = q.toLowerCase();
      const liveMatch =
        liveBg.find((s) => s.hostId.toLowerCase() === ql || String(s.sessionId || "").toLowerCase() === ql) ||
        (ql.length >= 3
          ? liveBg.find((s) => s.hostId.toLowerCase().startsWith(ql) || String(s.sessionId || "").toLowerCase().startsWith(ql))
          : null);
      if (liveMatch) {
        await this.attachToBgHost(liveMatch, { keepPreviousHost: !startup });
        return;
      }
    }

    const canListSaved = Boolean(this.acp && this.acp.supportsSessionList());
    if (!canListSaved && liveBg.length === 0) {
      if (!startup && q && (this.acp.supportsSessionLoad() || this.acp.supportsSessionResume())) {
        await this.switchToSession(q, q);
        return;
      }
      this.pushNotice("warn", "Connected ACP agent does not advertise session/list.");
      if (startup) {
        await this.createFreshSession();
      }
      this.scheduleRender();
      return;
    }

    try {
      if (!startup) {
        this.showToast("Loading sessions…");
      }
      const sessions = canListSaved ? await this.acp.listSessions(this.cwd) : [];
      if (sessions.length === 0 && liveBg.length === 0) {
        this.pushNotice("info", `No saved sessions found for ${this.cwd}.`);
        if (startup) {
          await this.createFreshSession();
        }
        this.scheduleRender();
        return;
      }

      if (q && sessions.length > 0) {
        const match = findSessionByIdOrPrefix(sessions, q);
        if (match) {
          await this.switchToSession(match.sessionId, match.title || match.sessionId.slice(0, 12));
          if (startup) {
            await this.applyStartupOverrides();
          }
          return;
        }
      }

      const liveSessionIds = new Set(liveBg.map((s) => s.sessionId).filter(Boolean));
      const formatBgTag = (status) => {
        if (status === "waiting_permission") return "⚠ [bg permission]";
        if (status === "running" || status === "starting") return "● [bg running]";
        if (status === "done") return "✓ [bg done]";
        return "◌ [bg idle]";
      };

      const liveItems = liveBg.map((s) => ({
        label: `${formatBgTag(s.status)} ${s.title || s.hostId}`,
        value: `bg:${s.hostId}`,
        description: `${formatRelativeTime(new Date(s.updatedAt || s.startedAt).toISOString())} · ${s.hostId}`,
        active: false,
        bgMeta: s,
      }));

      const savedItems = sessions
        .filter((s) => !liveSessionIds.has(s.sessionId))
        .map((s) => ({
          label: s.title || s.sessionId.slice(0, 12),
          value: s.sessionId,
          description: `${formatRelativeTime(s.updatedAt)} · ${s.sessionId.slice(0, 8)}`,
          active: s.sessionId === this.state.sessionId,
        }));

      this.openPickerModal({
        title: liveItems.length > 0 ? "Resume Conversation (Live Background First)" : "Resume Conversation",
        initialFilter: q,
        items: [...liveItems, ...savedItems],
        onSelect: async (chosen) => {
          if (chosen.bgMeta) {
            await this.attachToBgHost(chosen.bgMeta, { keepPreviousHost: !startup });
            return;
          }
          await this.switchToSession(chosen.value, chosen.label);
          if (startup) {
            await this.applyStartupOverrides();
          }
        },
        onCancel: startup
          ? async () => {
              if (!this.state.sessionId) {
                await this.createFreshSession();
                await this.applyStartupOverrides();
                this.showToast("Started new conversation");
                this.scheduleRender();
              }
            }
          : null,
      });
    } catch (err) {
      this.pushNotice("error", `Failed to list sessions: ${err.message}`);
      if (startup) {
        await this.createFreshSession();
      }
      this.scheduleRender();
    }
  }

  async switchToSession(sessionId, titleLabel = "") {
    if (this.state.sessionId && this.state.sessionId === sessionId) {
      this.showToast("Already in this session");
      return;
    }
    if (this.state.sessionId && this.state.sessionId !== sessionId) {
      await this.acp.closeSession(this.state.sessionId);
    }

    this.state.items = [];
    this.toolMap.clear();
    this.state.multiAgent.reset();
    this.state.stagedImages = [];
    this.boardOpen = false;
    this.activePlanItem = null;
    this.state.usage = null;
    this.state.sessionTitle = titleLabel || "";
    this.state.scrollOffset = 0;
    this.state.sessionId = sessionId;

    let res = null;
    if (this.acp.supportsSessionLoad()) {
      try {
        res = await this.acp.loadSession(sessionId, this.cwd);
      } catch {
        if (this.acp.supportsSessionResume()) {
          res = await this.acp.resumeSession(sessionId, this.cwd);
        } else {
          throw new Error(`Could not load session ${sessionId}`);
        }
      }
    } else if (this.acp.supportsSessionResume()) {
      res = await this.acp.resumeSession(sessionId, this.cwd);
    }

    this.finalizeAllStreaming();
    this.applySessionMetadata(res);
    if (this.state.items.length === 0) {
      this.pushNotice("info", `Connected to session ${titleLabel || sessionId.slice(0, 8)} (history not replayed).`);
    } else {
      this.showToast(`Loaded session: ${titleLabel || sessionId.slice(0, 8)}`);
    }
    this.scheduleRender();
  }

  applySessionMetadata(payload) {
    if (!payload || typeof payload !== "object") return;

    if (Array.isArray(payload.configOptions)) {
      this.state.configOptions = payload.configOptions;
    }

    if (payload.modes) {
      if (Array.isArray(payload.modes.availableModes)) {
        this.state.modes = payload.modes.availableModes;
      }
      if (payload.modes.currentModeId) {
        this.state.modeId = payload.modes.currentModeId;
      }
    }

    if (payload.models) {
      if (Array.isArray(payload.models.availableModels)) {
        this.state.models = payload.models.availableModels;
      }
      if (payload.models.currentModelId) {
        const match = this.state.models.find((m) => m.modelId === payload.models.currentModelId);
        this.state.modelLabel = match ? match.name : payload.models.currentModelId;
      }
    }

    // Derive canonical labels from configOptions when present (Antigravity separates model & thought_level)
    const modelOpt = this.getConfigOption("model");
    if (modelOpt) {
      const optMatch = (modelOpt.options || []).find((o) => o.value === modelOpt.currentValue);
      this.state.modelLabel = optMatch ? optMatch.name : modelOpt.currentValue || this.state.modelLabel;
    }

    const effortOpt = this.getConfigOption("thought_level") || this.getConfigOption("effort");
    if (effortOpt) {
      const optMatch = (effortOpt.options || []).find((o) => o.value === effortOpt.currentValue);
      this.state.effortLabel = optMatch ? optMatch.name : effortOpt.currentValue || "";
    }

    const modeOpt = this.getConfigOption("mode");
    if (modeOpt) {
      if (modeOpt.currentValue) {
        this.state.modeId = modeOpt.currentValue;
      }
      if (Array.isArray(modeOpt.options) && modeOpt.options.length > 0) {
        this.state.modes = modeOpt.options.map((o) => ({
          id: o.value,
          name: o.name || o.value,
          description: o.description || "",
        }));
      }
    }
  }

  getConfigOption(idOrCategory) {
    return this.state.configOptions.find(
      (opt) => opt.id === idOrCategory || opt.category === idOrCategory,
    );
  }

  hasConfigOption(idOrCategory) {
    return Boolean(this.getConfigOption(idOrCategory));
  }

  handleSessionUpdate(params) {
    if (!params) return;
    if (this.state.sessionId && params.sessionId && params.sessionId !== this.state.sessionId) {
      return;
    }
    const update = params.update;
    if (!update || typeof update !== "object") return;

    const kind = update.sessionUpdate;

    if (kind === "available_commands_update") {
      this.state.agentCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      this.updatePopupState();
      this.scheduleRender();
      return;
    }

    if (kind === "usage_update") {
      if (typeof update.used === "number" && typeof update.size === "number") {
        this.state.usage = { used: update.used, size: update.size };
        this.scheduleRender();
      }
      return;
    }

    if (kind === "session_info_update") {
      if (typeof update.title === "string" && update.title.trim()) {
        this.state.sessionTitle = update.title.trim();
        try {
          process.stdout.write(`\x1b]0;lucid — ${this.state.sessionTitle}\x07`);
        } catch {
          // Ignore terminal title write errors
        }
        this.scheduleRender();
      }
      return;
    }

    if (kind === "current_mode_update") {
      const nextMode = update.currentModeId || update.modeId;
      if (nextMode) {
        this.state.modeId = nextMode;
        this.scheduleRender();
      }
      return;
    }

    if (kind === "config_option_update") {
      if (Array.isArray(update.configOptions)) {
        this.applySessionMetadata({ configOptions: update.configOptions });
      } else if (update.configOption) {
        const idx = this.state.configOptions.findIndex((c) => c.id === update.configOption.id);
        if (idx >= 0) {
          this.state.configOptions[idx] = update.configOption;
        } else {
          this.state.configOptions.push(update.configOption);
        }
        this.applySessionMetadata({ configOptions: this.state.configOptions });
      }
      this.scheduleRender();
      return;
    }

    if (kind === "user_message_chunk") {
      const chunk = extractChunkText(update);
      if (!chunk) return;
      const last = this.state.items[this.state.items.length - 1];
      if (last && last.type === "user" && last.fromReplay) {
        last.text += chunk;
        last._rev = (last._rev || 0) + 1;
      } else {
        this.finalizeAllStreaming();
        this.state.items.push({ type: "user", text: chunk, fromReplay: true, _rev: 0 });
      }
      this.scheduleRender();
      return;
    }

    if (kind === "agent_thought_chunk") {
      const chunk = extractChunkText(update);
      if (!chunk) return;
      const last = this.state.items[this.state.items.length - 1];
      if (last && last.type === "thought" && last.streaming) {
        last.text += chunk;
        last.durationMs = Date.now() - last.startedAt;
        last._rev = (last._rev || 0) + 1;
      } else {
        this.finalizeAssistantStreaming();
        this.state.items.push({
          type: "thought",
          text: chunk,
          streaming: true,
          startedAt: Date.now(),
          durationMs: 0,
          _rev: 0,
        });
      }
      this.scheduleRender();
      return;
    }

    if (kind === "agent_message_chunk") {
      const chunk = extractChunkText(update);
      if (!chunk) return;
      this.finalizeThoughtStreaming();
      const last = this.state.items[this.state.items.length - 1];
      if (last && last.type === "assistant" && last.streaming) {
        last.text += chunk;
        last._rev = (last._rev || 0) + 1;
      } else {
        this.state.items.push({
          type: "assistant",
          text: chunk,
          streaming: true,
          _rev: 0,
        });
      }
      this.scheduleRender();
      return;
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      this.finalizeThoughtStreaming();
      this.finalizeAssistantStreaming();
      this.applyToolUpdate(update);
      this.state.multiAgent.ingestToolUpdate(update);
      this.scheduleRender();
      return;
    }

    if (kind === "plan" || kind === "plan_update") {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      if (this.activePlanItem && this.state.items.includes(this.activePlanItem)) {
        this.activePlanItem.entries = entries;
        this.activePlanItem._rev = (this.activePlanItem._rev || 0) + 1;
      } else {
        this.activePlanItem = { type: "plan", entries, _rev: 0 };
        this.state.items.push(this.activePlanItem);
      }
      this.scheduleRender();
    }
  }

  applyToolUpdate(update) {
    const id = update.toolCallId || `tool_${this.toolMap.size + 1}`;
    let item = this.toolMap.get(id);
    if (!item) {
      item = {
        type: "tool",
        toolCallId: id,
        title: update.title || update.name || "Tool call",
        name: update.name || "",
        kind: update.kind || "",
        status: update.status || "in_progress",
        startedAt: Date.now(),
        durationMs: 0,
        diffs: [],
        outputText: "",
        outputPreview: "",
        rawInput: update.rawInput ?? null,
        rawInputSummary: "",
        exitCode: null,
        _rev: 0,
      };
      this.toolMap.set(id, item);
      this.state.items.push(item);
    }

    item._rev = (item._rev || 0) + 1;

    if (update.title) item.title = update.title;
    if (update.name) item.name = update.name;
    if (update.kind) item.kind = update.kind;
    if (update.status) {
      item.status = update.status;
      if (["completed", "failed", "error", "cancelled"].includes(update.status)) {
        item.durationMs = Date.now() - item.startedAt;
      }
    }
    if (update.rawInput) {
      item.rawInput = update.rawInput;
      item.rawInputSummary = summarizeRawInput(update.rawInput);
    }

    const contentBlocks = Array.isArray(update.content)
      ? update.content
      : update.content
        ? [update.content]
        : [];

    for (const block of contentBlocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "diff") {
        const existingIdx = item.diffs.findIndex((d) => d.path === block.path);
        const diffObj = {
          path: block.path || "",
          oldText: block.oldText ?? "",
          newText: block.newText ?? "",
        };
        if (existingIdx >= 0) {
          item.diffs[existingIdx] = diffObj;
        } else {
          item.diffs.push(diffObj);
        }
      } else {
        const text =
          typeof block.text === "string"
            ? block.text
            : block.content && typeof block.content.text === "string"
              ? block.content.text
              : "";
        if (text) {
          item.outputText = item.outputText ? `${item.outputText}\n${text}` : text;
          const parsedCode = parseExitCode(item.outputText);
          if (parsedCode !== null) {
            item.exitCode = parsedCode;
          }
          item.outputPreview = extractCleanOutputPreview(item.outputText);
        }
      }
    }

    if (!item.outputText && update.rawOutput) {
      const rawStr = typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput);
      if (rawStr) {
        item.outputText = rawStr.slice(0, 4000);
        const parsedCode = parseExitCode(item.outputText);
        if (parsedCode !== null) {
          item.exitCode = parsedCode;
        }
        item.outputPreview = extractCleanOutputPreview(item.outputText) || rawStr.split(/\r?\n/)[0].slice(0, 120);
      }
    }
  }

  finalizeThoughtStreaming() {
    for (let i = this.state.items.length - 1; i >= 0; i -= 1) {
      const item = this.state.items[i];
      if (item.type === "thought" && item.streaming) {
        item.streaming = false;
        item.durationMs = Date.now() - item.startedAt;
        item._rev = (item._rev || 0) + 1;
      }
    }
  }

  finalizeAssistantStreaming() {
    for (let i = this.state.items.length - 1; i >= 0; i -= 1) {
      const item = this.state.items[i];
      if (item.type === "assistant" && item.streaming) {
        item.streaming = false;
        item._rev = (item._rev || 0) + 1;
      }
    }
  }

  finalizeAllStreaming() {
    this.finalizeThoughtStreaming();
    this.finalizeAssistantStreaming();
    for (const item of this.state.items) {
      if (item.fromReplay) item.fromReplay = false;
    }
  }

  enqueuePermissionRequest(req) {
    // Bypass mode: agy already auto-approves, but if any agent still asks, answer
    // with its own "allow" option instead of interrupting the user.
    if (this.state.bypassPermissions && this.autoApprovePermission(req)) {
      return;
    }
    this.permissionQueue.push(req);
    if (!this.modal || this.modal.type !== "permission") {
      this.openNextPermissionModal();
    }
  }

  /**
   * Answers a permission request with the agent's own "allow" option.
   * Returns false when the request offers no allow-like option.
   */
  autoApprovePermission(req) {
    const options = Array.isArray(req.params?.options) ? req.params.options : [];
    const allowOption =
      options.find((option) => option.kind === "allow_always") ||
      options.find((option) => option.kind === "allow_once") ||
      options.find((option) => /allow|approve|yes/i.test(`${option.optionId} ${option.name || ""}`));
    if (!allowOption) return false;
    req.selectOption(allowOption.optionId);
    return true;
  }

  /**
   * Approves every queued permission request (used when switching to Bypass while
   * a permission dialog is already open).
   */
  approvePendingPermissions() {
    const stillPending = [];
    for (const req of this.permissionQueue) {
      if (!this.autoApprovePermission(req)) {
        stillPending.push(req);
      }
    }
    this.permissionQueue = stillPending;
    const permissionModalOpen = this.modal && this.modal.type === "permission";
    if (permissionModalOpen) {
      this.modal = null;
      this.openNextPermissionModal();
    }
  }

  openNextPermissionModal() {
    if (this.permissionQueue.length === 0) return;
    const req = this.permissionQueue[0];
    const params = req.params || {};
    const toolCallId = params.toolCall?.toolCallId || params.subject?.toolCall?.toolCallId;
    const matchedTool = toolCallId ? this.toolMap.get(toolCallId) : null;
    const detailPreview =
      matchedTool?.rawInputSummary ||
      summarizeRawInput(params.toolCall?.rawInput) ||
      "";

    this.modal = {
      type: "permission",
      title: "Permission Approval",
      params,
      detailPreview,
      selected: 0,
      req,
    };
    this.scheduleRender();
  }

  resolveActivePermission(optionIndex) {
    if (!this.modal || this.modal.type !== "permission") return;
    const { req, params } = this.modal;
    const options = Array.isArray(params.options) ? params.options : [];
    this.permissionQueue.shift();
    this.modal = null;

    if (optionIndex === null || optionIndex < 0 || optionIndex >= options.length) {
      req.cancel();
      this.showToast("Permission cancelled");
    } else {
      const chosen = options[optionIndex];
      req.selectOption(chosen.optionId);
      this.showToast(`Selected: ${chosen.name || chosen.optionId}`);
    }

    if (this.permissionQueue.length > 0) {
      this.openNextPermissionModal();
    }
    this.scheduleRender();
  }

  pushNotice(level, text) {
    this.state.items.push({ type: "notice", level, text });
  }

  showToast(text, level = "info", durationMs = 2600) {
    this.state.toast = {
      text,
      level,
      expiresAt: Date.now() + durationMs,
    };
    this.scheduleRender();
  }

  /**
   * Dispatches a synchronous stdin batch. When mouse capture is OFF, terminals
   * in Alternate Scroll Mode (?1007h) translate wheel notches into bursts of
   * plain Up/Down arrow keys; detect those bursts and scroll the timeline
   * instead of sliding the composer cursor or cycling prompt history.
   */
  dispatchInputBatch(events) {
    const isPlainVerticalArrow = (ev) =>
      ev &&
      ev.type === "key" &&
      !ev.ctrl &&
      !ev.alt &&
      !ev.shift &&
      (ev.name === "up" || ev.name === "down");

    let i = 0;
    while (i < events.length) {
      const ev = events[i];
      if (!this.state.mouseCapture && !this.modal && !this.boardOpen && !this.popup && isPlainVerticalArrow(ev)) {
        let j = i + 1;
        while (j < events.length && isPlainVerticalArrow(events[j]) && events[j].name === ev.name) {
          j += 1;
        }
        const runLen = j - i;
        const now = Date.now();
        const continuingAltScroll = now - this.lastAltScrollAt < 180;
        // In an empty composer, Up/Down has nothing to move through, so treat even a
        // single arrow as a wheel line. Terminals like VS Code (xterm.js) send one
        // arrow per scrolled line, so slow trackpad starts arrive as single arrows.
        // Prompt history stays available via Ctrl+P / Ctrl+N.
        const composerIsEmpty = this.state.composer.isEmpty();

        if (runLen >= 2 || continuingAltScroll || composerIsEmpty) {
          const direction = ev.name === "up" ? 1 : -1;
          this.lastAltScrollAt = now;
          this.scrollBy(direction * runLen);
          i = j;
          continue;
        }
      }

      this.handleInputEvent(ev);
      i += 1;
    }
  }

  handleInputEvent(event) {
    if (this.exiting) return;

    if (event.type === "mouse") {
      this.handleMouseEvent(event);
      return;
    }

    if (event.type === "paste") {
      if (this.modal && this.modal.type === "picker") {
        this.modal.filter = (this.modal.filter || "") + event.text.replace(/\n/g, " ");
        this.refreshPickerFilter();
        this.scheduleRender(true);
        return;
      }
      if (!this.modal) {
        if (this.boardOpen) {
          this.boardOpen = false;
        }
        const droppedImg = tryLoadDroppedImage(event.text, this.cwd);
        if (droppedImg) {
          this.state.stagedImages.push(droppedImg);
          this.showToast(`Attached image: ${droppedImg.label} (${formatBytes(droppedImg.sizeBytes)})`);
          this.scheduleRender(true);
          return;
        }
        const pasted = this.state.composer.insertPaste(event.text);
        if (pasted.collapsed) {
          this.showToast(`Pasted ${pasted.lineCount} lines (${pasted.charCount} chars) — full text sent on Enter`);
        }
        this.updatePopupState();
        this.scheduleRender(true);
      }
      return;
    }

    if (this.modal) {
      this.handleModalInput(event);
      return;
    }

    if (this.boardOpen) {
      this.handleBoardInput(event);
      return;
    }

    if (event.type === "text") {
      this.state.composer.insert(event.text);
      this.dismissedPopupKey = null;
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }

    if (event.type === "key") {
      this.handleMainKey(event);
    }
  }

  handleMouseEvent(event) {
    if (this.modal) {
      if (this.modal.type === "artifact") {
        const maxScroll = this.modal.maxScroll || 0;
        if (event.action === "wheelUp") {
          this.modal.scrollOffset = Math.max(0, (this.modal.scrollOffset || 0) - 3);
          this.scheduleRender(true);
        } else if (event.action === "wheelDown") {
          this.modal.scrollOffset = Math.min(maxScroll, (this.modal.scrollOffset || 0) + 3);
          this.scheduleRender(true);
        }
        return;
      }
      if (this.modal.type === "picker") {
        const count = (this.modal.filteredItems || []).length;
        if (count > 0) {
          if (event.action === "wheelUp") {
            this.modal.selected = Math.max(0, this.modal.selected - 1);
            this.scheduleRender(true);
          } else if (event.action === "wheelDown") {
            this.modal.selected = Math.min(count - 1, this.modal.selected + 1);
            this.scheduleRender(true);
          }
        }
      }
      return;
    }

    if (this.boardOpen) {
      const maxScroll = this.boardState.maxDetailScroll || 0;
      if (event.action === "wheelUp") {
        this.boardState.scrollOffset = Math.max(0, this.boardState.scrollOffset - 3);
        this.scheduleRender(true);
      } else if (event.action === "wheelDown") {
        this.boardState.scrollOffset = Math.min(maxScroll, this.boardState.scrollOffset + 3);
        this.scheduleRender(true);
      }
      return;
    }

    if (event.action === "wheelUp") {
      this.scrollBy(3);
    } else if (event.action === "wheelDown") {
      this.scrollBy(-3);
    } else if (event.action === "leftDown" || event.action === "leftDrag" || event.action === "leftUp") {
      this.handleSelectionMouse(event);
    }
  }

  /**
   * Maps a 1-based screen row to a timeline line index. Rows above or below the
   * timeline viewport are clamped to its first/last row when `clamp` is set.
   */
  screenRowToTimelineLine(screenRow, clamp) {
    const layout = this.timelineLayout;
    if (!layout) return null;
    let viewportRow = screenRow - 1 - layout.topRow;
    const outside = viewportRow < 0 || viewportRow >= layout.height;
    if (outside && !clamp) return null;
    viewportRow = Math.max(0, Math.min(layout.height - 1, viewportRow));
    return layout.firstLineIndex + viewportRow;
  }

  scheduleSelectionPatch() {
    if (this.exiting || this.selectionPatchQueued || this.selectionPatchTimer) return;
    // Leading-edge + trailing-edge pacing (~45 fps cap): first drag event paints
    // at 0ms on the current tick; rapid sweeping coalesces into ~22ms frames so
    // SSH PTY buffers never back up with queued highlight writes.
    const minIntervalMs = 22;
    const elapsed = Date.now() - this.lastSelectionPatchAt;
    if (elapsed >= minIntervalMs) {
      this.selectionPatchQueued = true;
      queueMicrotask(() => {
        this.selectionPatchQueued = false;
        this.flushSelectionPatch();
      });
    } else {
      this.selectionPatchTimer = setTimeout(() => {
        this.selectionPatchTimer = null;
        this.flushSelectionPatch();
      }, minIntervalMs - elapsed);
    }
  }

  flushSelectionPatch() {
    if (this.selectionPatchTimer) {
      clearTimeout(this.selectionPatchTimer);
      this.selectionPatchTimer = null;
    }
    if (this.exiting) return;
    const layout = this.timelineLayout;
    if (!layout || this.modal || this.boardOpen) {
      this.scheduleRender(true);
      return;
    }
    const { cols, rows } = this.renderer.getSize();
    if (cols !== layout.cols || rows !== layout.rows) {
      this.renderNow();
      return;
    }
    const touched = patchSelectionInFrame({
      frameRows: layout.frameRows,
      viewportRawRows: layout.viewportRawRows,
      topRow: layout.topRow,
      firstLineIndex: layout.firstLineIndex,
      prevSelection: layout.renderedSelection,
      nextSelection: this.selection,
    });
    layout.renderedSelection = cloneSelection(this.selection);
    if (touched > 0) {
      this.lastSelectionPatchAt = Date.now();
      this.renderer.render(layout.frameRows, layout.cursor);
    }
  }

  handleSelectionMouse(event) {
    const col = Math.max(0, event.col - 1);

    if (event.action === "leftDown") {
      const hadVisibleSelection = !isSelectionEmpty(this.selection);
      const line = this.screenRowToTimelineLine(event.row, false);
      this.selection = line === null ? null : createSelection(line, col);
      if (hadVisibleSelection) {
        this.scheduleSelectionPatch();
      }
      return;
    }

    if (!this.selection || !this.selection.dragging) return;

    if (event.action === "leftDrag") {
      // Dragging past the top or bottom edge scrolls the timeline one line at a time.
      const layout = this.timelineLayout;
      const prevScroll = this.state.scrollOffset;
      if (layout) {
        const viewportRow = event.row - 1 - layout.topRow;
        if (viewportRow < 0) {
          this.scrollBy(1);
        } else if (viewportRow >= layout.height) {
          this.scrollBy(-1);
        }
      }
      const scrolled = this.state.scrollOffset !== prevScroll;
      const line = this.screenRowToTimelineLine(event.row, true);
      let headChanged = false;
      if (line !== null) {
        const prevHead = this.selection.head;
        if (prevHead.line !== line || prevHead.col !== col) {
          this.selection.head = { line, col };
          headChanged = true;
        }
      }
      if (scrolled) {
        this.scheduleRender(true);
      } else if (headChanged) {
        this.scheduleSelectionPatch();
      }
      return;
    }

    // leftUp: finish the drag. A plain click (no movement) clears the selection;
    // a real selection is copied right away, like terminal copy-on-select.
    const hadVisibleSelection = !isSelectionEmpty(this.selection);
    const line = this.screenRowToTimelineLine(event.row, true);
    if (line !== null) {
      this.selection.head = { line, col };
    }
    this.selection.dragging = false;
    if (isSelectionEmpty(this.selection)) {
      this.selection = null;
      if (hadVisibleSelection) {
        this.scheduleSelectionPatch();
      }
    } else {
      this.flushSelectionPatch();
      this.copySelection({ clearAfterCopy: false });
    }
  }

  /**
   * Copies the current mouse selection to the local clipboard via OSC 52.
   * Returns true when something was copied.
   */
  copySelection({ clearAfterCopy }) {
    const layout = this.timelineLayout;
    if (!this.selection || !layout) return false;
    const text = extractSelectionText(layout.lines, this.selection);
    if (clearAfterCopy) {
      this.selection = null;
      this.flushSelectionPatch();
    }
    if (!text) return false;
    copyToClipboardOsc52(text, process.stdout);
    const lineCount = text.split("\n").length;
    this.showToast(`Copied ${text.length} chars (${lineCount} lines) via OSC 52`);
    this.scheduleRender(true);
    return true;
  }

  scrollBy(deltaLines) {
    const next = Math.max(0, Math.min(this.state.maxScrollOffset, this.state.scrollOffset + deltaLines));
    if (next !== this.state.scrollOffset) {
      this.state.scrollOffset = next;
      this.scheduleScrollFlush();
    }
  }

  /**
   * Fast-path viewport scroll: leading-edge 0ms on the first wheel notch,
   * coalescing rapid wheel bursts at ~24ms (~40 fps) so SSH PTY buffers never
   * back up, and using VT100 scroll-region shifting to transmit only newly
   * revealed rows instead of the whole viewport.
   */
  scheduleScrollFlush() {
    if (this.exiting || this.scrollFlushQueued || this.scrollFlushTimer) return;
    const minIntervalMs = 24;
    const elapsed = Date.now() - this.lastScrollFlushAt;
    if (elapsed >= minIntervalMs) {
      this.scrollFlushQueued = true;
      queueMicrotask(() => {
        this.scrollFlushQueued = false;
        this.flushScroll();
      });
    } else {
      this.scrollFlushTimer = setTimeout(() => {
        this.scrollFlushTimer = null;
        this.flushScroll();
      }, minIntervalMs - elapsed);
    }
  }

  flushScroll() {
    if (this.scrollFlushTimer) {
      clearTimeout(this.scrollFlushTimer);
      this.scrollFlushTimer = null;
    }
    if (this.exiting) return;
    const layout = this.timelineLayout;
    if (!layout || this.modal || this.boardOpen) {
      this.scheduleRender(true);
      return;
    }
    const { cols, rows } = this.renderer.getSize();
    if (cols !== layout.cols || rows !== layout.rows) {
      this.renderNow();
      return;
    }

    const timelineLines = layout.lines;
    const viewportHeight = layout.height;
    const maxScroll = Math.max(0, timelineLines.length - viewportHeight);
    this.state.maxScrollOffset = maxScroll;
    if (this.state.scrollOffset > maxScroll) {
      this.state.scrollOffset = maxScroll;
    }

    const delta = this.state.scrollOffset - layout.renderedScrollOffset;
    if (delta === 0) return;

    const endIdx = timelineLines.length - this.state.scrollOffset;
    const startIdx = Math.max(0, endIdx - viewportHeight);
    const rawViewportRows = timelineLines.slice(startIdx, endIdx);
    while (rawViewportRows.length < viewportHeight) {
      rawViewportRows.push("");
    }
    const visibleRows = highlightSelectionInViewport(rawViewportRows, startIdx, this.selection);

    for (let offset = 0; offset < viewportHeight; offset += 1) {
      layout.frameRows[layout.topRow + offset] = visibleRows[offset];
    }

    // Update fixed footer line in-place when no toast is active.
    const hasActiveToast = Boolean(this.state.toast && Date.now() < this.state.toast.expiresAt);
    if (!hasActiveToast && layout.frameRows.length > 0 && layout.defaultFooterLine) {
      layout.frameRows[layout.frameRows.length - 1] =
        this.state.scrollOffset > 0
          ? ` ${this.style.accentAlt(`↓ ${this.state.scrollOffset} lines below · End / Esc to jump to bottom`)}`
          : layout.defaultFooterLine;
    }

    layout.firstLineIndex = startIdx;
    layout.viewportRawRows = rawViewportRows;
    layout.renderedScrollOffset = this.state.scrollOffset;
    layout.renderedSelection = cloneSelection(this.selection);

    this.lastScrollFlushAt = Date.now();
    this.renderer.render(layout.frameRows, layout.cursor, {
      topRow: layout.topRow,
      height: viewportHeight,
      delta,
    });
  }

  handleModalInput(event) {
    if (this.modal.type === "help") {
      if (event.type === "key" && (event.name === "escape" || event.name === "enter" || (event.ctrl && event.name === "c"))) {
        this.modal = null;
        this.scheduleRender(true);
      }
      return;
    }

    if (this.modal.type === "artifact") {
      if (event.type === "key") {
        const maxScroll = this.modal.maxScroll || 0;
        if (event.name === "escape" || (event.ctrl && event.name === "c")) {
          this.modal = null;
          this.scheduleRender(true);
        } else if (event.name === "up") {
          this.modal.scrollOffset = Math.max(0, (this.modal.scrollOffset || 0) - 1);
          this.scheduleRender(true);
        } else if (event.name === "down") {
          this.modal.scrollOffset = Math.min(maxScroll, (this.modal.scrollOffset || 0) + 1);
          this.scheduleRender(true);
        } else if (event.name === "pageup") {
          this.modal.scrollOffset = Math.max(0, (this.modal.scrollOffset || 0) - 10);
          this.scheduleRender(true);
        } else if (event.name === "pagedown") {
          this.modal.scrollOffset = Math.min(maxScroll, (this.modal.scrollOffset || 0) + 10);
          this.scheduleRender(true);
        } else if (event.ctrl && event.name === "y") {
          copyToClipboardOsc52(this.modal.content || "", process.stdout);
          this.showToast(`Copied artifact (${(this.modal.content || "").length} chars)`);
        }
      }
      return;
    }

    if (this.modal.type === "permission") {
      if (event.type === "text") {
        if (/^[1-9]$/.test(event.text)) {
          const idx = Number.parseInt(event.text, 10) - 1;
          const options = Array.isArray(this.modal.params?.options) ? this.modal.params.options : [];
          if (idx < options.length) {
            this.resolveActivePermission(idx);
          }
        } else {
          this.showToast("Permission dialog active — press 1-9 / Enter to choose, or Esc to deny", "error", 3200);
          this.scheduleRender(true);
        }
        return;
      }
      if (event.type === "key") {
        const options = Array.isArray(this.modal.params?.options) ? this.modal.params.options : [];
        if (event.name === "escape" || (event.ctrl && event.name === "c")) {
          this.resolveActivePermission(null);
        } else if (event.name === "up" && options.length > 0) {
          this.modal.selected = (this.modal.selected - 1 + options.length) % options.length;
          this.scheduleRender(true);
        } else if (event.name === "down" && options.length > 0) {
          this.modal.selected = (this.modal.selected + 1) % options.length;
          this.scheduleRender(true);
        } else if (event.name === "enter" && options.length > 0) {
          this.resolveActivePermission(this.modal.selected);
        }
      }
      return;
    }

    if (this.modal.type === "picker") {
      if (event.type === "text") {
        this.modal.filter = (this.modal.filter || "") + event.text;
        this.refreshPickerFilter();
        this.scheduleRender(true);
        return;
      }
      if (event.type === "key") {
        const items = this.modal.filteredItems || [];
        if (event.name === "escape" || (event.ctrl && event.name === "c")) {
          const onCancel = this.modal.onCancel;
          this.modal = null;
          this.scheduleRender(true);
          if (onCancel) {
            Promise.resolve(onCancel()).catch((err) => {
              this.pushNotice("error", err.message);
              this.scheduleRender();
            });
          }
        } else if (event.name === "backspace") {
          this.modal.filter = (this.modal.filter || "").slice(0, -1);
          this.refreshPickerFilter();
          this.scheduleRender(true);
        } else if (event.name === "up" && items.length > 0) {
          this.modal.selected = (this.modal.selected - 1 + items.length) % items.length;
          this.scheduleRender(true);
        } else if (event.name === "down" && items.length > 0) {
          this.modal.selected = (this.modal.selected + 1) % items.length;
          this.scheduleRender(true);
        } else if (event.name === "enter" && items.length > 0) {
          const chosen = items[this.modal.selected];
          const onSelect = this.modal.onSelect;
          this.modal = null;
          this.scheduleRender(true);
          if (onSelect && chosen) {
            Promise.resolve(onSelect(chosen)).catch((err) => {
              this.pushNotice("error", err.message);
              this.scheduleRender();
            });
          }
        }
      }
    }
  }

  refreshPickerFilter() {
    if (!this.modal || this.modal.type !== "picker") return;
    const q = (this.modal.filter || "").trim().toLowerCase();
    const all = this.modal.allItems || [];
    const filtered = q
      ? all.filter(
          (item) =>
            (item.label || "").toLowerCase().includes(q) ||
            (item.description || "").toLowerCase().includes(q) ||
            String(item.value || "").toLowerCase().includes(q),
        )
      : all;
    this.modal.filteredItems = filtered;
    this.modal.selected = Math.min(this.modal.selected, Math.max(0, filtered.length - 1));
  }

  openPickerModal({ title, items, onSelect, initialFilter = "", onCancel = null }) {
    const activeIdx = Math.max(0, items.findIndex((i) => i.active));
    this.modal = {
      type: "picker",
      title,
      allItems: items,
      filteredItems: items,
      filter: initialFilter,
      selected: activeIdx,
      onSelect,
      onCancel,
    };
    if (initialFilter) {
      this.refreshPickerFilter();
    }
    this.scheduleRender();
  }

  handleMainKey(key) {
    const { cols } = this.renderer.getSize();
    const inputWidth = Math.max(12, cols - 4);

    // An active mouse selection takes priority: Ctrl+C copies it, Esc dismisses it.
    if (this.selection && key.ctrl && key.name === "c") {
      this.copySelection({ clearAfterCopy: true });
      return;
    }
    if (this.selection && key.name === "escape") {
      this.selection = null;
      this.scheduleSelectionPatch();
      return;
    }

    // Global shortcuts
    if (key.ctrl && key.name === "c") {
      if (!this.state.composer.isEmpty()) {
        this.state.composer.clear();
        this.popup = null;
        this.scheduleRender(true);
        return;
      }
      if (this.activeLocalShell) {
        this.cancelLocalShell();
        return;
      }
      if (this.state.busy && this.state.sessionId) {
        this.acp.cancelTurn(this.state.sessionId);
        this.showToast("Cancellation requested…");
        return;
      }
      const now = Date.now();
      if (now - this.lastCtrlCAt < 1500) {
        this.shutdown(0);
      } else {
        this.lastCtrlCAt = now;
        this.showToast("Press Ctrl+C again to exit", "info", 1500);
      }
      return;
    }

    if (key.ctrl && key.name === "d") {
      if (this.state.composer.isEmpty()) {
        this.shutdown(0);
      } else {
        this.state.composer.deleteForward();
        this.updatePopupState();
        this.scheduleRender(true);
      }
      return;
    }

    if (key.ctrl && key.name === "o") {
      this.state.expandTools = !this.state.expandTools;
      this.userConfig.expandTools = this.state.expandTools;
      saveUserConfig(this.userConfig);
      this.showToast(this.state.expandTools ? "Tool details: expanded" : "Tool details: compact");
      this.scheduleRender(true);
      return;
    }

    if (key.ctrl && key.name === "t") {
      const next = this.state.thoughtMode === "expanded" ? "fold" : "expanded";
      this.setThoughtMode(next);
      return;
    }

    if (key.ctrl && key.name === "y") {
      this.copyLastAssistantReply();
      return;
    }

    if (key.ctrl && key.name === "g") {
      this.toggleMouseCapture();
      return;
    }

    if (key.ctrl && key.name === "b") {
      this.toggleSwarmBoard();
      return;
    }

    if (key.alt && key.name === "b") {
      this.toggleSwarmDock();
      return;
    }

    if (key.alt && key.name === "[") {
      this.cycleFocusedAgent(-1);
      return;
    }

    if (key.alt && key.name === "]") {
      this.cycleFocusedAgent(1);
      return;
    }

    if (key.shift && !key.ctrl && !key.alt && this.state.composer.isEmpty() && (key.name === "left" || key.name === "right")) {
      if (this.state.multiAgent.getInspectableMembers().length > 0) {
        this.cycleFocusedAgent(key.name === "right" ? 1 : -1);
        return;
      }
    }

    if (key.ctrl && key.name === "v") {
      this.attachFromClipboard();
      return;
    }

    if (key.ctrl && key.name === "l") {
      this.renderer.invalidate();
      this.scheduleRender();
      return;
    }

    // Shift+Tab cycles agent mode
    if (key.shift && key.name === "tab") {
      this.cycleMode();
      return;
    }

    // Escape: close popup -> leave agent inspect view -> cancel busy turn -> jump to bottom
    if (key.name === "escape") {
      if (this.popup) {
        this.dismissedPopupKey = this.popup.triggerKey;
        this.popup = null;
        this.scheduleRender(true);
        return;
      }
      if (this.state.focusedAgentId) {
        this.state.focusedAgentId = null;
        this.state.focusedAgentName = "";
        this.state.scrollOffset = 0;
        this.showToast("Returned to main conversation");
        this.scheduleRender(true);
        return;
      }
      if (this.state.composer.text.startsWith("!")) {
        this.state.composer.clear();
        this.scheduleRender(true);
        return;
      }
      if (this.activeLocalShell) {
        this.cancelLocalShell();
        return;
      }
      if (this.state.busy && this.state.sessionId) {
        this.acp.cancelTurn(this.state.sessionId);
        this.showToast("Cancelling turn…");
        return;
      }
      if (this.state.scrollOffset > 0) {
        this.state.scrollOffset = 0;
        this.scheduleRender(true);
      }
      return;
    }

    // Viewport scrolling keys
    if (key.name === "pageup") {
      this.scrollBy(12);
      return;
    }
    if (key.name === "pagedown") {
      this.scrollBy(-12);
      return;
    }
    if (key.alt && key.name === "up") {
      this.scrollBy(4);
      return;
    }
    if (key.alt && key.name === "down") {
      this.scrollBy(-4);
      return;
    }

    // Active autocomplete popup navigation
    if (this.popup && this.popup.items.length > 0) {
      if (key.name === "up") {
        this.popup.selected = (this.popup.selected - 1 + this.popup.items.length) % this.popup.items.length;
        this.scheduleRender(true);
        return;
      }
      if (key.name === "down") {
        this.popup.selected = (this.popup.selected + 1) % this.popup.items.length;
        this.scheduleRender(true);
        return;
      }
      if (key.name === "tab") {
        this.applyPopupSelection(false);
        return;
      }
      if (key.name === "enter" && !key.shift && !key.alt && !key.ctrl) {
        this.applyPopupSelection(true);
        return;
      }
    }

    // Newline insertion (Shift+Enter, Alt+Enter, Ctrl+Enter, Ctrl+J)
    if (
      (key.name === "enter" && (key.shift || key.alt || key.ctrl)) ||
      (key.ctrl && key.name === "j")
    ) {
      this.state.composer.insert("\n");
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }

    // Submit on Enter (trailing backslash + Enter also inserts newline)
    if (key.name === "enter") {
      if (this.state.composer.text.endsWith("\\")) {
        this.state.composer.backspace();
        this.state.composer.insert("\n");
        this.scheduleRender(true);
        return;
      }
      this.submitComposer();
      return;
    }

    // Fallback space insertion when terminal encodes Space as key name
    if (!key.ctrl && !key.alt && key.name === "space") {
      this.state.composer.insert(" ");
      this.dismissedPopupKey = null;
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }

    // Composer editing & cursor navigation
    if (key.name === "backspace") {
      if (key.alt) {
        this.state.composer.deleteWordBackward();
      } else {
        this.state.composer.backspace();
      }
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.name === "delete") {
      this.state.composer.deleteForward();
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.ctrl && key.name === "w") {
      this.state.composer.deleteWordBackward();
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.ctrl && key.name === "u") {
      this.state.composer.killToLineStart();
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.ctrl && key.name === "k") {
      this.state.composer.killToLineEnd();
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.ctrl && key.name === "a") {
      this.state.composer.moveLineStart();
      this.scheduleRender(true);
      return;
    }
    if (key.ctrl && key.name === "e") {
      this.state.composer.moveLineEnd();
      this.scheduleRender(true);
      return;
    }
    if (key.name === "home") {
      if (this.state.composer.isEmpty()) {
        this.state.scrollOffset = this.state.maxScrollOffset;
      } else {
        this.state.composer.moveLineStart();
      }
      this.scheduleRender(true);
      return;
    }
    if (key.name === "end") {
      if (this.state.composer.isEmpty()) {
        this.state.scrollOffset = 0;
      } else {
        this.state.composer.moveLineEnd();
      }
      this.scheduleRender(true);
      return;
    }
    if (key.name === "left") {
      if (key.ctrl || key.alt) {
        this.state.composer.moveWordLeft();
      } else {
        this.state.composer.moveLeft();
      }
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.name === "right") {
      if (key.ctrl || key.alt) {
        this.state.composer.moveWordRight();
      } else {
        this.state.composer.moveRight();
      }
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.ctrl && key.name === "p") {
      this.state.composer.historyPrev();
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.ctrl && key.name === "n") {
      this.state.composer.historyNext();
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.name === "up") {
      this.state.composer.moveUpOrHistory(inputWidth);
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
    if (key.name === "down") {
      this.state.composer.moveDownOrHistory(inputWidth);
      this.updatePopupState();
      this.scheduleRender(true);
      return;
    }
  }

  updatePopupState() {
    const slash = this.state.composer.getSlashTrigger();
    if (slash) {
      const triggerKey = `slash:${slash.query}`;
      if (this.dismissedPopupKey === triggerKey) {
        this.popup = null;
        return;
      }
      const q = slash.query.toLowerCase();
      const combined = [
        ...LOCAL_COMMANDS.map((c) => ({
          label: `/${c.name}`,
          value: `/${c.name}`,
          description: c.description,
          local: true,
        })),
        ...this.state.agentCommands
          .filter((ac) => !LOCAL_COMMANDS.some((lc) => lc.name === ac.name))
          .map((ac) => ({
            label: `/${ac.name}`,
            value: `/${ac.name}`,
            description: ac.description || "Agent command",
            local: false,
          })),
      ].filter((item) => item.label.slice(1).toLowerCase().includes(q));

      if (combined.length > 0) {
        const prevSel = this.popup?.kind === "slash" ? this.popup.selected : 0;
        this.popup = {
          kind: "slash",
          triggerKey,
          trigger: slash,
          items: combined,
          selected: Math.min(prevSel, combined.length - 1),
        };
        return;
      }
    }

    const fileTrig = this.state.composer.getFileTrigger();
    if (fileTrig) {
      const triggerKey = `file:${fileTrig.query}`;
      if (this.dismissedPopupKey === triggerKey) {
        this.popup = null;
        return;
      }
      const matches = this.fileIndex.search(fileTrig.query, 8);
      if (matches.length > 0) {
        const prevSel = this.popup?.kind === "file" ? this.popup.selected : 0;
        this.popup = {
          kind: "file",
          triggerKey,
          trigger: fileTrig,
          items: matches.map((m) => ({ label: `@${m}`, value: `@${m} `, description: "" })),
          selected: Math.min(prevSel, matches.length - 1),
        };
        return;
      }
    }

    this.popup = null;
  }

  applyPopupSelection(executeIfLocal) {
    if (!this.popup || this.popup.items.length === 0) return;
    const item = this.popup.items[this.popup.selected];
    const { trigger, kind } = this.popup;

    if (kind === "file") {
      this.state.composer.replaceRange(trigger.startIdx, trigger.endIdx, item.value);
      this.popup = null;
      this.scheduleRender(true);
      return;
    }

    // Slash command
    if (executeIfLocal && item.local) {
      this.state.composer.clear();
      this.popup = null;
      this.runLocalCommand(item.value.slice(1), "");
      return;
    }

    this.state.composer.replaceRange(trigger.startIdx, trigger.endIdx, `${item.value} `);
    this.popup = null;
    this.scheduleRender(true);
  }

  submitComposer() {
    const displayRaw = this.state.composer.text.trim();
    const fullRaw = this.state.composer.expandText(displayRaw).trim();
    if (!fullRaw && this.state.stagedImages.length === 0) return;

    if (displayRaw) {
      this.state.composer.pushHistory(displayRaw);
    }
    this.state.composer.clear();
    this.popup = null;
    this.state.scrollOffset = 0;

    if (fullRaw.startsWith("!")) {
      const shellCmd = fullRaw.slice(1).trim();
      if (!shellCmd) {
        this.pushNotice("info", "Usage: !<shell command>  (runs directly in your workspace without calling the agent)");
        this.scheduleRender(true);
        return;
      }
      this.runLocalShellCommand(shellCmd);
      return;
    }

    if (fullRaw.startsWith("/") && !fullRaw.includes("\n")) {
      const spaceIdx = fullRaw.indexOf(" ");
      const cmdName = (spaceIdx === -1 ? fullRaw.slice(1) : fullRaw.slice(1, spaceIdx)).toLowerCase();
      const argText = spaceIdx === -1 ? "" : fullRaw.slice(spaceIdx + 1).trim();
      if (this.isLocalCommand(cmdName)) {
        this.runLocalCommand(cmdName, argText);
        return;
      }
    }

    this.sendUserPrompt(fullRaw, displayRaw !== fullRaw ? displayRaw : "");
  }

  isLocalCommand(cmdName) {
    return (
      LOCAL_COMMANDS.some((c) => c.name === cmdName) ||
      ["exit", "q", "detach", "thinking", "agents", "attach", "paste-image"].includes(cmdName)
    );
  }

  handleBoardInput(event) {
    if (event.type !== "key") return;
    const entries = this.state.multiAgent.getRosterEntries();
    if (event.name === "escape" || (event.ctrl && event.name === "b") || (event.ctrl && event.name === "c")) {
      this.boardOpen = false;
      this.scheduleRender(true);
      return;
    }
    if (event.name === "tab") {
      this.boardState.tab = this.boardState.tab === "board" ? "detail" : "board";
      this.boardState.scrollOffset = 0;
      this.scheduleRender(true);
      return;
    }
    if (event.name === "up" && entries.length > 0) {
      this.boardState.selectedIdx = (this.boardState.selectedIdx - 1 + entries.length) % entries.length;
      const sel = entries[this.boardState.selectedIdx];
      this.boardState.tab = sel?.kind === "board" ? "board" : "detail";
      this.boardState.scrollOffset = 0;
      this.scheduleRender(true);
      return;
    }
    if (event.name === "down" && entries.length > 0) {
      this.boardState.selectedIdx = (this.boardState.selectedIdx + 1) % entries.length;
      const sel = entries[this.boardState.selectedIdx];
      this.boardState.tab = sel?.kind === "board" ? "board" : "detail";
      this.boardState.scrollOffset = 0;
      this.scheduleRender(true);
      return;
    }
    if (event.name === "pageup") {
      this.boardState.scrollOffset = Math.max(0, this.boardState.scrollOffset - 8);
      this.scheduleRender(true);
      return;
    }
    if (event.name === "pagedown") {
      this.boardState.scrollOffset = Math.min(this.boardState.maxDetailScroll || 0, this.boardState.scrollOffset + 8);
      this.scheduleRender(true);
    }
  }

  runLocalShellCommand(command) {
    if (this.activeLocalShell) {
      this.showToast("A local shell command is already running (press Esc or Ctrl+C to stop it)", "error");
      this.scheduleRender(true);
      return;
    }
    const item = {
      type: "shell",
      command,
      cwd: this.cwd,
      status: "running",
      output: "",
      exitCode: null,
      startedAt: Date.now(),
      durationMs: 0,
      _rev: 0,
    };
    this.state.items.push(item);
    this.state.scrollOffset = 0;

    const shellBin = process.env.SHELL || "/bin/bash";
    const child = spawn(shellBin, ["-lc", command], {
      cwd: this.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const MAX_SHELL_OUTPUT = 256 * 1024;
    let truncated = false;
    const appendOutput = (chunk) => {
      if (truncated) return;
      const text = chunk.toString("utf8");
      if (!text) return;
      if (item.output.length + text.length > MAX_SHELL_OUTPUT) {
        item.output += text.slice(0, Math.max(0, MAX_SHELL_OUTPUT - item.output.length));
        item.output += "\n… (output truncated at 256 KB)";
        truncated = true;
      } else {
        item.output += text;
      }
      item._rev += 1;
      this.scheduleRender();
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    const record = { child, item, cancelled: false };
    this.activeLocalShell = record;

    child.on("error", (err) => {
      if (this.activeLocalShell === record) {
        this.activeLocalShell = null;
      }
      item.status = "failed";
      item.exitCode = 1;
      item.durationMs = Date.now() - item.startedAt;
      item.output = item.output ? `${item.output}\n${err.message}` : err.message;
      item._rev += 1;
      this.scheduleRender(true);
    });

    child.on("close", (code) => {
      if (this.activeLocalShell === record) {
        this.activeLocalShell = null;
      }
      item.durationMs = Date.now() - item.startedAt;
      if (record.cancelled) {
        item.status = "cancelled";
      } else {
        item.exitCode = typeof code === "number" ? code : 1;
        item.status = item.exitCode === 0 ? "completed" : "failed";
      }
      item._rev += 1;
      this.scheduleRender(true);
    });

    this.scheduleRender(true);
  }

  cancelLocalShell() {
    const active = this.activeLocalShell;
    if (!active) return;
    active.cancelled = true;
    try {
      if (process.platform !== "win32" && active.child.pid) {
        process.kill(-active.child.pid, "SIGTERM");
      } else {
        active.child.kill("SIGTERM");
      }
    } catch {
      try {
        active.child.kill("SIGKILL");
      } catch {
        // Ignore
      }
    }
    this.showToast("Cancelled local shell command");
    this.scheduleRender(true);
  }

  toggleSwarmBoard() {
    this.boardOpen = !this.boardOpen;
    if (this.boardOpen) {
      const entries = this.state.multiAgent.getRosterEntries();
      this.boardState.selectedIdx = Math.min(this.boardState.selectedIdx, Math.max(0, entries.length - 1));
      this.boardState.scrollOffset = 0;
    }
    this.scheduleRender();
  }

  toggleSwarmDock() {
    this.state.swarmDockCollapsed = !this.state.swarmDockCollapsed;
    this.showToast(this.state.swarmDockCollapsed ? "Agent dock folded" : "Agent dock expanded");
    this.scheduleRender(true);
  }

  cycleFocusedAgent(delta = 1) {
    const members = this.state.multiAgent.getInspectableMembers();
    if (members.length === 0) {
      if (this.state.focusedAgentId) {
        this.state.focusedAgentId = null;
        this.state.focusedAgentName = "";
        this.state.scrollOffset = 0;
        this.scheduleRender(true);
      } else {
        this.showToast("No active Swarm workers or Subagents to inspect");
      }
      return;
    }
    // Cycle order: null (main conversation) -> member[0] -> ... -> member[n-1] -> null
    const slots = [null, ...members];
    const currentIdx = this.state.focusedAgentId
      ? slots.findIndex((m) => m && m.id === this.state.focusedAgentId)
      : 0;
    const baseIdx = currentIdx >= 0 ? currentIdx : 0;
    const nextIdx = (baseIdx + delta + slots.length) % slots.length;
    const nextMember = slots[nextIdx];
    this.state.focusedAgentId = nextMember ? nextMember.id : null;
    this.state.focusedAgentName = nextMember ? nextMember.name : "";
    this.state.scrollOffset = 0;
    this.selection = null;
    this.showToast(nextMember ? `Inspecting ${nextMember.name}` : "Main conversation");
    this.scheduleRender(true);
  }

  attachFromClipboard() {
    const img = tryReadClipboardImage();
    if (img) {
      this.state.stagedImages.push(img);
      this.showToast(`Attached clipboard image (${formatBytes(img.sizeBytes)})`);
      this.scheduleRender();
    } else {
      this.showToast("No local clipboard image — paste an image path, use /image <path>, or @img.png", "error", 3600);
    }
  }

  async runLocalCommand(cmdName, argText) {
    if (cmdName === "quit" || cmdName === "exit" || cmdName === "q") {
      await this.shutdown(0);
      return;
    }

    if (cmdName === "bg" || cmdName === "detach") {
      await this.detachToBackground({ promptText: argText });
      return;
    }

    if (cmdName === "help") {
      this.modal = { type: "help", title: "Lucid Keyboard Shortcuts & Commands" };
      this.scheduleRender();
      return;
    }

    if (cmdName === "board" || cmdName === "agents") {
      this.toggleSwarmBoard();
      return;
    }

    if (cmdName === "dock") {
      this.toggleSwarmDock();
      return;
    }

    if (cmdName === "artifacts") {
      const list = this.state.multiAgent.getArtifactsList();
      if (list.length === 0) {
        this.showToast("No Markdown artifacts recorded in this session yet");
        return;
      }
      this.openPickerModal({
        title: "Session Artifacts",
        items: list.map((a) => ({
          label: a.title,
          value: a.path,
          description: a.summary ? a.summary.split("\n")[0] : a.path,
          active: false,
        })),
        onSelect: (chosen) => {
          try {
            const content = fs.readFileSync(chosen.value, "utf8");
            this.modal = {
              type: "artifact",
              title: chosen.label,
              content,
              scrollOffset: 0,
              maxScroll: 0,
            };
          } catch (err) {
            this.pushNotice("error", `Cannot read artifact ${chosen.value}: ${err.message}`);
          }
          this.scheduleRender();
        },
      });
      return;
    }

    if (cmdName === "image" || cmdName === "attach") {
      if (!argText) {
        this.pushNotice("info", "Usage: /image <path-to-png-jpg-webp-gif>  (or drag/paste an image path, or use @image.png)");
        this.scheduleRender();
        return;
      }
      try {
        const img = loadImageAttachment(argText, this.cwd);
        this.state.stagedImages.push(img);
        this.showToast(`Attached image: ${img.label} (${formatBytes(img.sizeBytes)})`);
      } catch (err) {
        this.pushNotice("error", err.message);
      }
      this.scheduleRender();
      return;
    }

    if (cmdName === "paste-image") {
      this.attachFromClipboard();
      return;
    }

    if (cmdName === "unattach") {
      const count = this.state.stagedImages.length;
      this.state.stagedImages = [];
      this.showToast(count > 0 ? `Cleared ${count} staged image(s)` : "No staged images");
      this.scheduleRender();
      return;
    }

    if (cmdName === "clear") {
      this.state.items = [];
      this.toolMap.clear();
      this.activePlanItem = null;
      this.state.scrollOffset = 0;
      this.scheduleRender();
      return;
    }

    if (cmdName === "copy") {
      this.copyLastAssistantReply();
      return;
    }

    if (cmdName === "mouse") {
      this.toggleMouseCapture();
      return;
    }

    if (cmdName === "expand") {
      this.state.expandTools = !this.state.expandTools;
      this.userConfig.expandTools = this.state.expandTools;
      saveUserConfig(this.userConfig);
      this.showToast(this.state.expandTools ? "Tool details: expanded" : "Tool details: compact");
      return;
    }

    if (cmdName === "thoughts") {
      const arg = (argText || "").trim().toLowerCase();
      if (!arg) {
        const next = this.state.thoughtMode === "expanded" ? "fold" : "expanded";
        this.setThoughtMode(next);
        return;
      }
      if (["show", "expand", "on"].includes(arg)) {
        this.setThoughtMode("expanded");
        return;
      }
      if (["fold", "collapse"].includes(arg)) {
        this.setThoughtMode("fold");
        return;
      }
      if (["hide", "off"].includes(arg)) {
        this.setThoughtMode("hidden");
        return;
      }
      this.pushNotice("warn", "Usage: /thoughts [fold|show|hide]");
      this.scheduleRender(true);
      return;
    }

    if (cmdName === "theme") {
      const themes = listThemes();
      if (argText) {
        const match = themes.find((t) => t.name === argText.toLowerCase());
        if (match) {
          this.setTheme(match.name);
        } else {
          this.pushNotice("warn", `Unknown theme "${argText}". Available: ${themes.map((t) => t.name).join(", ")}`);
          this.scheduleRender();
        }
        return;
      }
      this.openPickerModal({
        title: "Select Transparent Theme",
        items: themes.map((t) => ({
          label: t.name,
          value: t.name,
          description: t.description,
          active: t.name === this.style.name,
        })),
        onSelect: (chosen) => this.setTheme(chosen.value),
      });
      return;
    }

    if (cmdName === "quota" || cmdName === "usage") {
      if (this.state.usage && this.state.usage.size > 0) {
        const pct = Math.min(100, Math.round((this.state.usage.used / this.state.usage.size) * 100));
        this.pushNotice("info", `Context window: ${this.state.usage.used.toLocaleString()} / ${this.state.usage.size.toLocaleString()} tokens (${pct}%)`);
      }
      if (!this.launchSpec.supportsQuotaCli) {
        if (!this.state.usage) {
          this.showToast("Quota check is only available for Antigravity (agy)", "error");
        }
        this.scheduleRender();
        return;
      }
      this.showToast("Checking Antigravity quota…");
      const quota = await fetchAgyQuota(15000);
      if (quota) {
        this.state.quotaText = quota.badge;
        for (const line of quota.lines) {
          this.pushNotice("info", line);
        }
        this.showToast(`Quota updated (${quota.badge})`);
      } else {
        this.pushNotice("warn", "Could not fetch quota (API key mode or CLI unavailable).");
      }
      this.scheduleRender();
      return;
    }

    if (!this.state.connected || !this.acp) {
      this.pushNotice("error", "Not connected to an ACP agent.");
      this.scheduleRender();
      return;
    }

    if (cmdName === "new") {
      try {
        if (this.state.sessionId) {
          await this.acp.closeSession(this.state.sessionId);
        }
        this.state.items = [];
        this.toolMap.clear();
        this.state.multiAgent.reset();
        this.state.focusedAgentId = null;
        this.state.focusedAgentName = "";
        this.state.stagedImages = [];
        this.boardOpen = false;
        this.activePlanItem = null;
        this.state.usage = null;
        this.state.scrollOffset = 0;
        const created = await this.acp.createSession(this.cwd, this.cliOptions.addDirs || []);
        this.state.sessionId = created.sessionId;
        this.applySessionMetadata(created);
        this.showToast("Started new conversation");
      } catch (err) {
        this.pushNotice("error", `Failed to start new session: ${err.message}`);
      }
      this.scheduleRender();
      return;
    }

    if (cmdName === "sessions" || cmdName === "resume") {
      await this.openResumePicker({ query: argText, startup: false });
      return;
    }

    if (cmdName === "model") {
      const modelOpt = this.getConfigOption("model");
      let items = [];
      let preferConfig = false;
      if (modelOpt && Array.isArray(modelOpt.options) && modelOpt.options.length > 0) {
        preferConfig = true;
        items = modelOpt.options.map((o) => ({
          label: o.name || o.value,
          value: o.value,
          description: o.value,
          active: o.value === modelOpt.currentValue,
        }));
      } else if (this.state.models.length > 0) {
        items = this.state.models.map((m) => ({
          label: m.name || m.modelId,
          value: m.modelId,
          description: m.modelId,
          active: (m.name || m.modelId) === this.state.modelLabel,
        }));
      }

      if (items.length === 0) {
        this.pushNotice("warn", "No selectable models exposed by this ACP agent.");
        this.scheduleRender();
        return;
      }

      this.openPickerModal({
        title: "Select Model",
        items,
        onSelect: async (chosen) => {
          const res = await this.acp.setModel(this.state.sessionId, chosen.value, preferConfig);
          this.applySessionMetadata(res);
          this.state.modelLabel = chosen.label;
          this.showToast(`Model → ${chosen.label}`);
          this.scheduleRender();
        },
      });
      return;
    }

    if (cmdName === "effort" || cmdName === "thinking") {
      const effortOpt = this.getConfigOption("thought_level") || this.getConfigOption("effort");
      if (!effortOpt || !Array.isArray(effortOpt.options) || effortOpt.options.length === 0) {
        this.pushNotice("warn", "This model/agent does not expose a separate thinking level option.");
        this.scheduleRender();
        return;
      }
      this.openPickerModal({
        title: effortOpt.name || "Thinking Level",
        items: effortOpt.options.map((o) => ({
          label: o.name || o.value,
          value: o.value,
          description: o.description || "",
          active: o.value === effortOpt.currentValue,
        })),
        onSelect: async (chosen) => {
          const res = await this.acp.setConfigOption(this.state.sessionId, effortOpt.id, chosen.value);
          this.applySessionMetadata(res);
          this.state.effortLabel = chosen.label;
          this.showToast(`Thinking → ${chosen.label}`);
          this.scheduleRender();
        },
      });
      return;
    }

    if (cmdName === "mode") {
      const cycle = this.getModeCycle();
      if (cycle.length === 0) {
        this.pushNotice("warn", "No execution modes exposed by this ACP agent.");
        this.scheduleRender();
        return;
      }
      if (argText) {
        const requested = argText.trim().toLowerCase();
        const targetId = requested === BYPASS_MODE_ID || requested === "yolo"
          ? BYPASS_MODE_ID
          : this.resolveModeId(requested);
        const target = cycle.find((entry) => entry.id === targetId);
        if (target) {
          await this.switchMode(target.id);
        } else {
          this.pushNotice("warn", `Unknown mode "${argText}". Available: ${cycle.map((entry) => entry.id).join(", ")}`);
          this.scheduleRender();
        }
        return;
      }
      const currentId = this.currentModeCycleId();
      this.openPickerModal({
        title: "Execution Mode",
        items: cycle.map((entry) => ({
          label: entry.name,
          value: entry.id,
          description: entry.description,
          active: entry.id === currentId,
        })),
        onSelect: async (chosen) => {
          await this.switchMode(chosen.value);
        },
      });
    }
  }

  /**
   * Modes offered by Shift+Tab and /mode: the agent's own modes, plus lucid's
   * session-level Bypass unless agy was already launched with bypass.
   */
  getModeCycle() {
    const cycle = this.state.modes.map((mode) => ({
      id: mode.id,
      name: mode.name || mode.id,
      description: mode.description || "",
    }));
    if (!this.state.launchBypass) {
      cycle.push({
        id: BYPASS_MODE_ID,
        name: "Bypass",
        description: "auto mode + approve every tool permission (this session only)",
      });
    }
    return cycle;
  }

  currentModeCycleId() {
    return this.state.sessionBypass ? BYPASS_MODE_ID : this.state.modeId;
  }

  setSessionBypass(enabled) {
    this.state.sessionBypass = Boolean(enabled);
    this.state.bypassPermissions = this.state.launchBypass || this.state.sessionBypass;
    if (this.acp && typeof this.acp.setBypassPermissions === "function") {
      this.acp.setBypassPermissions(this.state.bypassPermissions);
    }
  }

  async switchMode(targetId) {
    try {
      if (targetId === BYPASS_MODE_ID) {
        // Run the agent in its autonomous mode and let lucid approve every request.
        const autoModeId = this.resolveModeId("auto");
        if (autoModeId && autoModeId !== this.state.modeId && this.state.sessionId) {
          const res = await this.acp.setMode(this.state.sessionId, autoModeId);
          this.applySessionMetadata(res);
          this.state.modeId = autoModeId;
        }
        this.setSessionBypass(true);
        this.approvePendingPermissions();
        // Deliberately not saved to config: bypass ends with this lucid session.
        this.showToast("Mode → Bypass (every tool permission auto-approved this session)", "error");
      } else {
        const res = await this.acp.setMode(this.state.sessionId, targetId);
        this.applySessionMetadata(res);
        this.state.modeId = targetId;
        this.setSessionBypass(false);
        this.userConfig.mode = targetId;
        saveUserConfig(this.userConfig);
        const target = this.state.modes.find((mode) => mode.id === targetId);
        this.showToast(`Mode → ${target?.name || targetId}`);
      }
    } catch (err) {
      this.showToast(`Mode switch failed: ${err.message}`, "error");
    }
    this.scheduleRender();
  }

  async cycleMode() {
    if (!this.state.connected || !this.state.sessionId) {
      return;
    }
    const cycle = this.getModeCycle();
    if (cycle.length < 2) {
      return;
    }
    const currentIndex = cycle.findIndex((entry) => entry.id === this.currentModeCycleId());
    const next = cycle[(currentIndex + 1) % cycle.length];
    await this.switchMode(next.id);
  }

  setTheme(themeName) {
    this.style = createThemeStyler(themeName, this.colorDepth);
    this.userConfig.theme = this.style.name;
    saveUserConfig(this.userConfig);
    this.renderer.invalidate();
    this.showToast(`Theme → ${this.style.name}`);
    this.scheduleRender();
  }

  toggleMouseCapture() {
    this.state.mouseCapture = !this.state.mouseCapture;
    this.renderer.setMouseCapture(this.state.mouseCapture);
    this.userConfig.mouseCapture = this.state.mouseCapture;
    saveUserConfig(this.userConfig);
    this.showToast(
      this.state.mouseCapture
        ? "Mouse capture ON (wheel scrolls history)"
        : "Mouse capture OFF (native drag-select enabled)",
    );
    this.scheduleRender();
  }

  copyLastAssistantReply() {
    for (let i = this.state.items.length - 1; i >= 0; i -= 1) {
      const item = this.state.items[i];
      if (item.type === "assistant" && item.text && item.text.trim()) {
        copyToClipboardOsc52(item.text, process.stdout);
        this.showToast(`Copied latest reply (${item.text.length} chars) via OSC 52`);
        return;
      }
    }
    this.showToast("No assistant reply to copy yet", "error");
  }

  async sendUserPrompt(text, displayText = "") {
    if (!this.state.connected || !this.state.sessionId) {
      this.pushNotice("error", "Not connected to an ACP session yet.");
      this.scheduleRender();
      return;
    }

    const supportsEmbedded = Boolean(this.acp.agentCapabilities?.promptCapabilities?.embeddedContext);
    const supportsImage = Boolean(this.acp.agentCapabilities?.promptCapabilities?.image);
    const stagedImages = this.state.stagedImages.splice(0, this.state.stagedImages.length);

    if (stagedImages.length > 0 && !supportsImage) {
      this.pushNotice("warn", "Connected ACP agent does not advertise image input capability; sending text only.");
    }

    const { blocks, attachedPaths, attachedImages } = buildPromptBlocks(text, this.cwd, {
      supportsEmbeddedContext: supportsEmbedded,
      supportsImage,
      stagedImages,
    });

    this.state.items.push({
      type: "user",
      text: text || "(image attachment)",
      displayText: displayText || undefined,
      attachedPaths,
      attachedImages,
    });

    this.state.activePromptCount += 1;
    if (!this.state.busy) {
      this.state.busy = true;
      this.state.turnStartedAt = Date.now();
    }
    this.scheduleRender();

    if (this.acp.isHosted) {
      try {
        await this.acp.sendPrompt(this.state.sessionId, blocks, {
          text: text || "(image attachment)",
          displayText: displayText || "",
          attachedPaths,
          attachedImages,
        });
      } catch (err) {
        this.pushNotice("error", err.message || String(err));
        this.state.activePromptCount = Math.max(0, this.state.activePromptCount - 1);
        if (this.state.activePromptCount === 0) {
          this.state.busy = false;
          this.finalizeAllStreaming();
        }
        this.scheduleRender();
      }
      return;
    }

    try {
      const result = await this.acp.sendPrompt(this.state.sessionId, blocks);
      if (result?.stopReason === "cancelled") {
        this.pushNotice("info", "Turn cancelled.");
      }
    } catch (err) {
      this.pushNotice("error", err.message || String(err));
    } finally {
      this.state.activePromptCount = Math.max(0, this.state.activePromptCount - 1);
      if (this.state.activePromptCount === 0) {
        this.state.busy = false;
        this.finalizeAllStreaming();
      }
      this.scheduleRender();
    }
  }

  setThoughtMode(nextMode) {
    const mode = ["fold", "expanded", "hidden"].includes(nextMode) ? nextMode : "fold";
    this.state.thoughtMode = mode;
    this.state.showThoughts = mode === "expanded";
    this.userConfig.thoughtMode = mode;
    this.userConfig.showThoughts = this.state.showThoughts;
    saveUserConfig(this.userConfig);
    const label =
      mode === "expanded"
        ? "Thoughts: expanded"
        : mode === "hidden"
          ? "Thoughts: hidden"
          : "Thoughts: folded";
    this.showToast(label);
    this.scheduleRender(true);
  }

  scheduleRender(priority = false) {
    if (this.exiting || this.replayingSnapshot) return;
    if (this.renderTimer) {
      if (!priority || this.renderPriority) return;
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderPriority = Boolean(priority);
    const delayMs = priority ? 8 : 33;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderPriority = false;
      this.renderNow();
    }, delayMs);
  }

  buildScreenFrame(cols, rows) {
    const headerLines = renderHeader(this.state, cols, this.style);

    this.timelineLayout = null;

    if (this.boardOpen && !this.modal) {
      const boardHeight = Math.max(6, rows - headerLines.length);
      const renderedBoard = renderSwarmBoardView(
        this.state.multiAgent,
        this.boardState,
        cols,
        boardHeight,
        this.style,
        this.state.spinnerFrame,
      );
      this.boardState.maxDetailScroll = renderedBoard.maxDetailScroll;
      return {
        rows: [...headerLines, ...renderedBoard.rows],
        cursor: { visible: false, row: 0, col: 0 },
      };
    }

    const focusedMember = this.state.focusedAgentId
      ? this.state.multiAgent.getMemberById(this.state.focusedAgentId)
      : null;
    if (this.state.focusedAgentId && !focusedMember) {
      this.state.focusedAgentId = null;
      this.state.focusedAgentName = "";
    } else if (focusedMember) {
      this.state.focusedAgentName = focusedMember.name;
    }

    const composerState = this.modal
      ? { ...this.state, activeModalType: this.modal.type }
      : this.state;
    const composerBlock = renderComposerBlock(composerState, cols, this.style);
    const popupLines = this.modal ? [] : renderAutocompletePopup(this.popup, cols, this.style);

    const reservedBottom = composerBlock.lines.length + popupLines.length;
    const viewportHeight = Math.max(3, rows - headerLines.length - reservedBottom);

    const timelineLines = focusedMember
      ? renderMemberTimeline(focusedMember, cols, this.style, this.state.spinnerFrame)
      : renderTimeline(this.state, cols, this.style);
    const maxScroll = Math.max(0, timelineLines.length - viewportHeight);
    this.state.maxScrollOffset = maxScroll;
    if (this.state.scrollOffset > maxScroll) {
      this.state.scrollOffset = maxScroll;
    }

    const endIdx = timelineLines.length - this.state.scrollOffset;
    const startIdx = Math.max(0, endIdx - viewportHeight);
    let viewportRows = timelineLines.slice(startIdx, endIdx);

    while (viewportRows.length < viewportHeight) {
      viewportRows.push("");
    }

    const rawViewportRows = viewportRows;
    if (!this.modal) {
      viewportRows = highlightSelectionInViewport(rawViewportRows, startIdx, this.selection);
    }

    if (this.modal) {
      viewportRows = applyOverlayModal(viewportRows, cols, this.modal, this.style);
    }

    const allRows = [...headerLines, ...viewportRows, ...popupLines, ...composerBlock.lines];
    const composerStartRow = headerLines.length + viewportRows.length + popupLines.length;

    const cursor = this.modal
      ? { visible: false, row: 0, col: 0 }
      : {
          visible: true,
          row: composerStartRow + composerBlock.cursorOffsetRow,
          col: composerBlock.cursorCol,
        };

    if (!this.modal) {
      this.timelineLayout = {
        cols,
        rows,
        topRow: headerLines.length,
        height: viewportHeight,
        firstLineIndex: startIdx,
        lines: timelineLines,
        viewportRawRows: rawViewportRows,
        frameRows: allRows,
        cursor,
        defaultFooterLine: composerBlock.defaultFooterLine || "",
        renderedScrollOffset: this.state.scrollOffset,
        renderedSelection: cloneSelection(this.selection),
      };
    }

    return { rows: allRows, cursor };
  }

  renderNow() {
    if (this.exiting) return;
    const { cols, rows } = this.renderer.getSize();
    const frame = this.buildScreenFrame(cols, rows);
    this.renderer.render(frame.rows, frame.cursor);
  }

  async detachToBackground({ silent = false, promptText = "" } = {}) {
    if (!this.acp?.isHosted) {
      if (!silent) {
        this.showToast("Background detach is unavailable in --direct mode", "error");
        this.scheduleRender(true);
      }
      return;
    }
    if (promptText && promptText.trim()) {
      await this.sendUserPrompt(promptText.trim());
    }
    const hostId = this.acp.hostId || "";
    const statusLabel = this.state.busy ? "running" : "idle";
    if (!silent) {
      this.exitNotice =
        `Session moved to background (${hostId} · ${statusLabel}).\n` +
        `Resume anytime: lucid -r ${hostId}  (or lucid -r)\n` +
        `List / stop:    lucid bg  |  lucid bg stop ${hostId}`;
    }
    await this.shutdown(0, { detach: true });
  }

  async shutdown(exitCode = 0, { detach = false } = {}) {
    if (this.exiting) return;
    this.exiting = true;

    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.selectionPatchTimer) {
      clearTimeout(this.selectionPatchTimer);
      this.selectionPatchTimer = null;
    }
    if (this.scrollFlushTimer) {
      clearTimeout(this.scrollFlushTimer);
      this.scrollFlushTimer = null;
    }
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.activeLocalShell) {
      this.cancelLocalShell();
    }
    if (this.agyStateTimer) {
      clearInterval(this.agyStateTimer);
      this.agyStateTimer = null;
    }

    // Cancel pending permission requests only on real shutdown; when detaching,
    // keep them queued in the background host so re-attaching can approve them.
    if (!detach) {
      while (this.permissionQueue.length > 0) {
        const req = this.permissionQueue.shift();
        try {
          req.cancel();
        } catch {
          // Ignore
        }
      }
    } else {
      this.permissionQueue = [];
    }

    if (this.inputParser) {
      this.inputParser.destroy();
    }
    if (this.onStdinData) {
      process.stdin.off("data", this.onStdinData);
    }
    if (this.onResize) {
      process.stdout.off("resize", this.onResize);
    }
    if (this.onSignal) {
      process.off("SIGINT", this.onSignal);
      process.off("SIGTERM", this.onSignal);
    }
    if (this.onSighup) {
      process.off("SIGHUP", this.onSighup);
    }
    if (this.onProcessExit) {
      process.off("exit", this.onProcessExit);
    }
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      // Ignore
    }

    this.renderer.leave();

    if (this.acp) {
      if (detach && typeof this.acp.detach === "function") {
        await this.acp.detach();
      } else {
        await this.acp.stop(this.state.sessionId);
      }
    }

    if (this.resolveRun) {
      this.resolveRun();
    }
    process.exitCode = exitCode;
  }
}
