import { AgyStateWatcher, resolveAgyDataDir } from "./acp/agy_state.mjs";
import { autoApprovePermission } from "./acp/permissions.mjs";
import { findConfigOption, mergeSessionMetadata } from "./acp/protocol.mjs";
import { buildSlashAutocompleteItems, executeLocalCommand, findLocalCommand } from "./app/commands.mjs";
import {
  createPacedScheduler,
  dispatchInputBatch,
  flushScroll,
  flushSelectionPatch,
  handleInputEvent,
  handleMainKey,
  handleModalInput,
  refreshPickerFilter,
  sliceViewportRows,
} from "./app/input.mjs";
import { cancelLocalShell, runLocalShellCommand } from "./app/local_shell.mjs";
import {
  applyHostSnapshot,
  applyToolUpdate,
  bindAcpClient,
  connectAndStartSession,
  drainCancelledPermissions,
  finalizeAllStreaming,
  handleSessionUpdate,
  openInitialSession,
  resolveModeId,
  summarizeRawInput,
} from "./app/session.mjs";
import {
  getConfigLoadError,
  isAgyCommand,
  loadUserConfig,
  resolveAgentLaunch,
  saveUserConfig,
} from "./config.mjs";
import { copyToClipboardOsc52, detectColorDepth } from "./term/ansi.mjs";
import { InputParser } from "./term/input.mjs";
import { TerminalRenderer } from "./term/renderer.mjs";
import { sanitizeUntrustedText } from "./term/unicode.mjs";
import { Composer } from "./ui/composer.mjs";
import { WorkspaceFileIndex, buildPromptBlocks, formatBytes, tryReadClipboardImage } from "./ui/files.mjs";
import { isToolTerminalStatus } from "./ui/format.mjs";
import { cloneSelection } from "./ui/selection.mjs";
import { MultiAgentTracker, renderMemberTimeline, renderSwarmBoardView } from "./ui/swarm.mjs";
import { createThemeStyler } from "./ui/themes.mjs";
import {
  applyOverlayModal,
  renderAutocompletePopup,
  renderComposerBlock,
  renderHeader,
  renderTimeline,
  resolveThoughtMode,
} from "./ui/views.mjs";

// lucid's session-level bypass: agent "auto" mode plus auto-approval of every
// tool permission request. Lives only in this lucid process, never persisted.
const BYPASS_MODE_ID = "bypass";

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

    const thoughtMode = resolveThoughtMode(this.userConfig);

    this.state = {
      cwd: this.cwd,
      agentLabel: this.launchSpec.name,
      // launchBypass: agy itself was started with --dangerously-skip-permissions.
      // sessionBypass: user switched to the Bypass mode inside this session.
      launchBypass: (this.launchSpec.args || []).includes("--dangerously-skip-permissions"),
      sessionBypass: false,
      get bypassPermissions() {
        return this.launchBypass || this.sessionBypass;
      },
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
      get showThoughts() {
        return this.thoughtMode === "expanded";
      },
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

    this.selection = null;
    this.timelineLayout = null;
    this.selectionScheduler = createPacedScheduler(22, () => flushSelectionPatch(this));
    this.scrollScheduler = createPacedScheduler(24, () => flushScroll(this));
    this.lastAltScrollAt = 0;
    this.pendingChunkEvents = null;

    this.agyStateWatcher = isAgyCommand(this.launchSpec.command)
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

    const configError = getConfigLoadError(this.userConfig);
    if (configError) {
      this.pushNotice("warn", `config.json could not be parsed (${configError}); auto-save is paused to protect it.`);
    }

    this.setupTerminal();
    this.fileIndex.refresh();
    this.renderNow();

    if (this.agyStateWatcher) {
      this.agyStateTimer = setInterval(() => this.pollAgyState(), 1000);
    }

    this.spinnerTimer = setInterval(() => {
      if (this.state.toast && Date.now() >= this.state.toast.expiresAt) {
        this.state.toast = null;
        this.scheduleRender();
      }
      if (this.state.connecting || this.state.busy || this.hasRunningTools() || this.state.multiAgent.hasRunningMembers()) {
        this.state.spinnerFrame = (this.state.spinnerFrame + 1) % 10;
        this.scheduleRender();
      }
    }, 120);

    await connectAndStartSession(this);

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
      return;
    }
    if (snapshot) {
      this.state.multiAgent.applyAgyState(snapshot);
      this.scheduleRender();
    }
  }

  hasRunningTools() {
    for (const [, tool] of this.toolMap) {
      if (!isToolTerminalStatus(tool.status)) return true;
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
        handleInputEvent(this, event);
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

    this.onSignal = () => this.shutdown(0);
    this.onSighup = () => {
      if (this.acp?.isHosted && (this.state.busy || this.state.items.length > 0)) {
        this.detachToBackground({ silent: true });
      } else {
        this.shutdown(0);
      }
    };
    this.onProcessExit = () => this.restoreTerminalSync();
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

  // Session lifecycle & ACP delegation (preserves public/test API)
  bindAcpClient(client) {
    return bindAcpClient(this, client);
  }

  applyHostSnapshot(snapshot) {
    return applyHostSnapshot(this, snapshot);
  }

  openInitialSession() {
    return openInitialSession(this);
  }

  handleSessionUpdate(params) {
    return handleSessionUpdate(this, params);
  }

  applyToolUpdate(update) {
    return applyToolUpdate(this, update);
  }

  applySessionMetadata(payload) {
    const rawMeta = {
      availableCommands: this.state.agentCommands,
      configOptions: this.state.configOptions,
      modes: { availableModes: this.state.modes, currentModeId: this.state.modeId },
      models: { availableModels: this.state.models },
    };
    Object.assign(this.state, mergeSessionMetadata(rawMeta, payload));
  }

  getConfigOption(idOrCategory) {
    return findConfigOption(this.state.configOptions, idOrCategory);
  }

  // Permission handling
  enqueuePermissionRequest(req) {
    if (this.state.bypassPermissions && autoApprovePermission(req)) {
      return;
    }
    this.permissionQueue.push(req);
    if (!this.modal || this.modal.type !== "permission") {
      this.openNextPermissionModal();
    }
  }

  approvePendingPermissions() {
    this.permissionQueue = this.permissionQueue.filter((req) => !autoApprovePermission(req));
    if (this.modal && this.modal.type === "permission") {
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
    const clean = (val) => (val ? sanitizeUntrustedText(val) : val);
    const detailPreview = clean(
      matchedTool?.rawInputSummary || summarizeRawInput(params.toolCall?.rawInput) || "",
    );

    const cleanToolCall = params.toolCall && typeof params.toolCall === "object"
      ? { ...params.toolCall, title: clean(params.toolCall.title) }
      : params.toolCall;
    const cleanOptions = Array.isArray(params.options)
      ? params.options.map((opt) => (opt && typeof opt === "object" ? { ...opt, name: clean(opt.name) } : opt))
      : params.options;
    const cleanParams = {
      ...params,
      title: clean(params.title),
      description: clean(params.description),
      ...(cleanToolCall ? { toolCall: cleanToolCall } : {}),
      ...(cleanOptions ? { options: cleanOptions } : {}),
    };

    this.modal = {
      type: "permission",
      title: "Permission Approval",
      params: cleanParams,
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

  // Input, scrolling & selection delegation
  dispatchInputBatch(events) {
    return dispatchInputBatch(this, events);
  }

  handleModalInput(event) {
    return handleModalInput(this, event);
  }

  handleMainKey(key) {
    return handleMainKey(this, key);
  }

  scheduleScrollFlush() {
    if (!this.exiting) this.scrollScheduler.schedule();
  }

  scrollBy(deltaLines) {
    const next = Math.max(0, Math.min(this.state.maxScrollOffset, this.state.scrollOffset + deltaLines));
    if (next !== this.state.scrollOffset) {
      this.state.scrollOffset = next;
      this.scheduleScrollFlush();
    }
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
      refreshPickerFilter(this.modal);
    }
    this.scheduleRender();
  }

  openPopup(kind, trigger, items) {
    const triggerKey = `${kind}:${trigger.query}`;
    if (this.dismissedPopupKey === triggerKey) {
      this.popup = null;
      return true;
    }
    if (items.length === 0) return false;
    const prevSel = this.popup?.kind === kind ? this.popup.selected : 0;
    this.popup = {
      kind,
      triggerKey,
      trigger,
      items,
      selected: Math.min(prevSel, items.length - 1),
    };
    return true;
  }

  // Composer, autocomplete & commands
  updatePopupState() {
    const slash = this.state.composer.getSlashTrigger();
    if (slash && this.openPopup("slash", slash, buildSlashAutocompleteItems(this.state.agentCommands, slash.query))) {
      return;
    }
    const fileTrig = this.state.composer.getFileTrigger();
    if (fileTrig) {
      const items = this.fileIndex.search(fileTrig.query, 8).map((m) => ({
        label: `@${m}`,
        value: `@${m} `,
        description: "",
      }));
      if (this.openPopup("file", fileTrig, items)) return;
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

    if (executeIfLocal && item.local) {
      this.state.composer.clear();
      this.popup = null;
      this.invokeLocalCommand(item.value.slice(1), "");
      return;
    }

    this.state.composer.replaceRange(trigger.startIdx, trigger.endIdx, `${item.value} `);
    this.popup = null;
    this.scheduleRender(true);
  }

  invokeLocalCommand(cmdName, argText) {
    return this.runLocalCommand(cmdName, argText).catch((err) => {
      this.pushNotice("error", `/${cmdName} failed: ${err?.message || err}`);
      this.scheduleRender(true);
    });
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

    if (displayRaw.startsWith("!")) {
      const shellCmd = displayRaw.slice(1).trim();
      if (!shellCmd) {
        this.pushNotice("info", "Usage: !<shell command>  (runs directly in your workspace without calling the agent)");
        this.scheduleRender(true);
        return;
      }
      this.runLocalShellCommand(shellCmd);
      return;
    }

    if (displayRaw.startsWith("/") && !displayRaw.includes("\n")) {
      const spaceIdx = displayRaw.indexOf(" ");
      const cmdName = (spaceIdx === -1 ? displayRaw.slice(1) : displayRaw.slice(1, spaceIdx)).toLowerCase();
      const argText = spaceIdx === -1 ? "" : displayRaw.slice(spaceIdx + 1).trim();
      if (findLocalCommand(cmdName)) {
        this.invokeLocalCommand(cmdName, argText);
        return;
      }
    }

    this.sendUserPrompt(fullRaw, displayRaw !== fullRaw ? displayRaw : "");
  }

  runLocalCommand(cmdName, argText) {
    return executeLocalCommand(this, cmdName, argText);
  }

  runLocalShellCommand(command) {
    return runLocalShellCommand(this, command);
  }

  // UI toggles & mode switching
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
    if (this.acp && typeof this.acp.setBypassPermissions === "function") {
      this.acp.setBypassPermissions(this.state.bypassPermissions);
    }
  }

  async switchMode(targetId) {
    try {
      if (targetId === BYPASS_MODE_ID) {
        const autoModeId = resolveModeId(this, "auto");
        if (autoModeId && autoModeId !== this.state.modeId && this.state.sessionId) {
          const res = await this.acp.setMode(this.state.sessionId, autoModeId);
          this.applySessionMetadata(res);
          this.state.modeId = autoModeId;
        }
        this.setSessionBypass(true);
        this.approvePendingPermissions();
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
    if (!this.state.connected || !this.state.sessionId) return;
    const cycle = this.getModeCycle();
    if (cycle.length < 2) return;
    const currentIndex = cycle.findIndex((entry) => entry.id === this.currentModeCycleId());
    const next = cycle[(currentIndex + 1) % cycle.length];
    await this.switchMode(next.id);
  }

  persistConfig(patch, toastText, priority = false) {
    Object.assign(this.userConfig, patch);
    saveUserConfig(this.userConfig);
    this.showToast(toastText);
    this.scheduleRender(priority);
  }

  setTheme(themeName) {
    this.style = createThemeStyler(themeName, this.colorDepth);
    this.renderer.invalidate();
    this.persistConfig({ theme: this.style.name }, `Theme → ${this.style.name}`);
  }

  toggleMouseCapture() {
    this.state.mouseCapture = !this.state.mouseCapture;
    this.renderer.setMouseCapture(this.state.mouseCapture);
    this.persistConfig(
      { mouseCapture: this.state.mouseCapture },
      this.state.mouseCapture
        ? "Mouse capture ON (wheel scrolls history)"
        : "Mouse capture OFF (native drag-select enabled)",
    );
  }

  toggleExpandTools() {
    this.state.expandTools = !this.state.expandTools;
    this.persistConfig(
      { expandTools: this.state.expandTools },
      this.state.expandTools ? "Tool details: expanded" : "Tool details: compact",
      true,
    );
  }

  toggleThoughtMode() {
    this.setThoughtMode(this.state.thoughtMode === "expanded" ? "fold" : "expanded");
  }

  setThoughtMode(nextMode) {
    const mode = ["fold", "expanded", "hidden"].includes(nextMode) ? nextMode : "fold";
    this.state.thoughtMode = mode;
    const label =
      mode === "expanded"
        ? "Thoughts: expanded"
        : mode === "hidden"
          ? "Thoughts: hidden"
          : "Thoughts: folded";
    this.persistConfig({ thoughtMode: mode, showThoughts: mode === "expanded" }, label, true);
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

  // Prompting
  finishPromptTurn(explicitActiveCount) {
    this.state.activePromptCount = typeof explicitActiveCount === "number"
      ? explicitActiveCount
      : Math.max(0, this.state.activePromptCount - 1);
    if (this.state.activePromptCount === 0) {
      this.state.busy = false;
      finalizeAllStreaming(this);
    }
    this.scheduleRender();
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
      mentionSourceText: displayText || text,
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
        this.finishPromptTurn();
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
      this.finishPromptTurn();
    }
  }

  // Frame rendering & lifecycle
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

    const slice = sliceViewportRows(
      timelineLines,
      viewportHeight,
      this.state.scrollOffset,
      this.modal ? null : this.selection,
    );
    this.state.maxScrollOffset = slice.maxScroll;
    this.state.scrollOffset = slice.scrollOffset;

    const viewportRows = this.modal
      ? applyOverlayModal(slice.visibleRows, cols, this.modal, this.style)
      : slice.visibleRows;

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
        firstLineIndex: slice.startIdx,
        lines: timelineLines,
        viewportRawRows: slice.rawViewportRows,
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
    this.selectionScheduler.cancel();
    this.scrollScheduler.cancel();
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
    if (this.activeLocalShell) {
      cancelLocalShell(this, { force: true });
    }
    if (this.agyStateTimer) {
      clearInterval(this.agyStateTimer);
      this.agyStateTimer = null;
    }

    if (!detach) {
      drainCancelledPermissions(this.permissionQueue);
    }
    this.permissionQueue = [];

    if (this.inputParser) this.inputParser.destroy();
    if (this.onStdinData) process.stdin.off("data", this.onStdinData);
    if (this.onResize) process.stdout.off("resize", this.onResize);
    if (this.onSignal) {
      process.off("SIGINT", this.onSignal);
      process.off("SIGTERM", this.onSignal);
    }
    if (this.onSighup) process.off("SIGHUP", this.onSighup);
    if (this.onProcessExit) process.off("exit", this.onProcessExit);
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

    if (this.resolveRun) this.resolveRun();
    process.exitCode = exitCode;
  }
}
