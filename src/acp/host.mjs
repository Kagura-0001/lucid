import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { AcpClient, hotSwapAcpClient } from "./client.mjs";
import { ensureSecureBgDir, removeBgFiles, writeBgMeta } from "./bg_registry.mjs";
import { autoApprovePermission } from "./permissions.mjs";
import {
  createLineSplitter,
  extractChunkText,
  findConfigOption,
  mergeSessionMetadata,
  parseJsonObjectLine,
} from "./protocol.mjs";
import { supportsNativeBypassFlag, withDangerouslySkipPermissions } from "../config.mjs";

const MAX_EVENT_LOG = 6000;
const EMPTY_DETACHED_GRACE_MS = 4000;
const COMPLETED_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

function summarizeUpdateText(update) {
  if (!update || typeof update !== "object") return "";
  const kind = update.sessionUpdate;
  if (kind === "tool_call" || kind === "tool_call_update") {
    const title = String(update.title || update.name || "Tool").split(/\r?\n/)[0];
    return title.slice(0, 80);
  }
  if (kind === "agent_message_chunk") {
    const chunk = extractChunkText(update).trim();
    if (chunk) return chunk.split(/\r?\n/)[0].slice(0, 80);
  }
  return "";
}

/**
 * Detached background host that owns one ACP child process (`agy acp --stdio`
 * or custom ACP agent) and serves a single active TUI client at a time over a
 * Unix domain socket. Detaching or losing SSH keeps the agent running.
 */
export class SessionHost {
  constructor(spec) {
    this.hostId = spec.hostId;
    this.bgDir = spec.bgDir;
    this.socketPath = spec.socketPath;
    this.cwd = spec.cwd;
    this.baseLaunchSpec = spec.launchSpec;
    this.launchSpec = spec.launchSpec;
    this.addDirs = Array.isArray(spec.addDirs) ? spec.addDirs : [];
    this.initialPrompt = spec.initialPrompt || "";
    this.initialMode = spec.initialMode || "";
    this.initialModel = spec.initialModel || "";
    this.startBackgrounded = Boolean(spec.startBackgrounded);
    this.launchBypass = (this.launchSpec?.args || []).includes("--dangerously-skip-permissions");
    this.bypassPermissions = Boolean(spec.bypassPermissions || this.launchBypass);
    this.nativeBypassActive = this.launchBypass;
    this.suppressReplayEvents = false;
    this.bypassSwapPromise = null;

    this.acp = new AcpClient(this.launchSpec);
    this.server = null;
    this.activeSocket = null;
    this.shuttingDown = false;

    this.initResult = null;
    this.sessionId = "";
    this.sessionMeta = {};
    this.sessionTitle = "";
    this.modelLabel = "";
    this.modeId = "";
    this.usage = null;
    this.busy = false;
    this.activePromptCount = 0;
    this.turnStartedAt = 0;
    this.everSentPrompt = false;
    this.backgrounded = this.startBackgrounded;
    this.startedAt = Date.now();
    this.updatedAt = this.startedAt;
    this.lastSummary = this.initialPrompt ? this.initialPrompt.split(/\r?\n/)[0].slice(0, 80) : "";

    this.eventLog = [];
    this.pendingPermissions = new Map(); // permId -> { permId, params, selectOption, cancel }
    this.nextPermId = 1;
    this.idleTimer = null;
    this.metaDirtyTimer = null;
  }

  computeStatus() {
    if (this.pendingPermissions.size > 0) return "waiting_permission";
    if (this.busy) return "running";
    if (!this.initResult) return "starting";
    if (this.everSentPrompt && this.backgrounded) return "done";
    return "idle";
  }

  flushMetaNow() {
    if (this.shuttingDown) return;
    if (this.metaDirtyTimer) {
      clearTimeout(this.metaDirtyTimer);
      this.metaDirtyTimer = null;
    }
    try {
      writeBgMeta(
        {
          hostId: this.hostId,
          pid: process.pid,
          socketPath: this.socketPath,
          cwd: this.cwd,
          sessionId: this.sessionId,
          title: this.sessionTitle || this.lastSummary || "Untitled session",
          agent: this.launchSpec?.name || this.launchSpec?.command || "agent",
          modelLabel: this.modelLabel,
          modeId: this.modeId,
          bypassPermissions: this.bypassPermissions,
          nativeBypassActive: this.nativeBypassActive,
          status: this.computeStatus(),
          attached: Boolean(this.activeSocket),
          backgrounded: this.backgrounded,
          startedAt: this.startedAt,
          updatedAt: this.updatedAt,
          lastSummary: this.lastSummary,
        },
        this.bgDir,
      );
    } catch {
      // Best-effort metadata persistence
    }
  }

  scheduleMetaFlush() {
    if (this.shuttingDown || this.metaDirtyTimer) return;
    this.metaDirtyTimer = setTimeout(() => {
      this.metaDirtyTimer = null;
      this.flushMetaNow();
    }, 250);
  }

  pushEvent(event) {
    // Coalesce adjacent text/thought streaming chunks to keep replay compact.
    if (event.type === "sessionUpdate") {
      const update = event.params?.update;
      const kind = update?.sessionUpdate;
      const isStreamChunk = kind === "agent_message_chunk" || kind === "agent_thought_chunk";
      if (isStreamChunk && this.eventLog.length > 0) {
        const last = this.eventLog[this.eventLog.length - 1];
        if (last.type === "sessionUpdate" && last.params?.update?.sessionUpdate === kind) {
          const prevText = extractChunkText(last.params.update);
          const nextText = extractChunkText(update);
          if (nextText) {
            last.params = {
              ...last.params,
              update: {
                sessionUpdate: kind,
                content: { type: "text", text: prevText + nextText },
              },
            };
            return;
          }
        }
      }
    }

    this.eventLog.push(event);
    if (this.eventLog.length > MAX_EVENT_LOG) {
      this.eventLog.splice(0, this.eventLog.length - MAX_EVENT_LOG);
    }
  }

  sendToClient(msg) {
    if (!this.activeSocket || this.activeSocket.destroyed) return;
    try {
      this.activeSocket.write(`${JSON.stringify(msg)}\n`);
    } catch {
      // Ignore broken socket
    }
  }

  captureSessionMeta(payload) {
    const derived = mergeSessionMetadata(this.sessionMeta, payload);
    if (derived.modeId) this.modeId = derived.modeId;
    if (derived.modelLabel) this.modelLabel = derived.modelLabel;
  }

  cancelAllPendingPermissions() {
    for (const [, entry] of this.pendingPermissions) {
      try {
        entry.cancel();
      } catch {
        // Ignore
      }
    }
    this.pendingPermissions.clear();
  }

  approveAllPendingPermissions() {
    for (const [permId, entry] of [...this.pendingPermissions]) {
      if (autoApprovePermission(entry)) {
        this.pendingPermissions.delete(permId);
      }
    }
    this.flushMetaNow();
  }

  scheduleIdleCheck() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.activeSocket || this.busy || this.pendingPermissions.size > 0 || this.shuttingDown) {
      return;
    }
    const delayMs = this.everSentPrompt || this.backgrounded ? COMPLETED_IDLE_TTL_MS : EMPTY_DETACHED_GRACE_MS;
    this.idleTimer = setTimeout(() => {
      if (!this.activeSocket && !this.busy && this.pendingPermissions.size === 0) {
        this.shutdown();
      }
    }, delayMs);
    this.idleTimer.unref();
  }

  async start() {
    // Ignore SIGHUP so closing the terminal or dropping SSH keeps the host alive.
    process.on("SIGHUP", () => {});
    process.once("SIGTERM", () => this.shutdown());
    process.once("SIGINT", () => this.shutdown());

    ensureSecureBgDir(path.dirname(this.socketPath));
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore
    }

    this.bindAcpEvents(this.acp);

    this.flushMetaNow();
    this.initResult = await this.acp.start();

    // Start Unix domain socket server before optional initialPrompt so callers
    // can connect immediately.
    await new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => this.handleConnection(socket));
      this.server.once("error", reject);
      this.server.listen(this.socketPath, () => {
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch {
          // Ignore
        }
        resolve();
      });
    });

    if (this.initialPrompt) {
      const created = await this.acp.createSession(this.cwd, this.addDirs);
      this.sessionId = created.sessionId;
      this.captureSessionMeta(created);
      if (this.initialMode) {
        try {
          const modeRes = await this.acp.setMode(this.sessionId, this.initialMode);
          this.captureSessionMeta(modeRes);
          this.modeId = this.initialMode;
        } catch {
          // Best-effort mode apply
        }
      }
      if (this.initialModel) {
        try {
          const hasConfigModel = Boolean(findConfigOption(this.sessionMeta.configOptions, "model"));
          const modelRes = await this.acp.setModel(this.sessionId, this.initialModel, hasConfigModel);
          this.captureSessionMeta(modelRes);
        } catch {
          // Best-effort model apply
        }
      }
      this.flushMetaNow();
      this.runHostedPrompt(this.sessionId, [{ type: "text", text: this.initialPrompt }], {
        text: this.initialPrompt,
        displayText: "",
        attachedPaths: [],
        attachedImages: [],
      });
    } else {
      this.flushMetaNow();
      this.scheduleIdleCheck();
    }
  }

  bindAcpEvents(acpClient) {
    acpClient.on("sessionUpdate", (params) => {
      if (acpClient !== this.acp || this.suppressReplayEvents) return;
      this.updatedAt = Date.now();
      const update = params?.update;
      if (update) {
        if (update.sessionUpdate === "session_info_update" && typeof update.title === "string" && update.title.trim()) {
          this.sessionTitle = update.title.trim();
        } else if (update.sessionUpdate === "usage_update" && typeof update.used === "number") {
          this.usage = { used: update.used, size: update.size };
        } else if (update.sessionUpdate === "current_mode_update") {
          this.modeId = update.currentModeId || update.modeId || this.modeId;
        } else if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
          this.sessionMeta.availableCommands = update.availableCommands;
        } else if (update.sessionUpdate === "config_option_update" && (Array.isArray(update.configOptions) || update.configOption)) {
          this.captureSessionMeta(update);
        }
        const summary = summarizeUpdateText(update);
        if (summary) this.lastSummary = summary;
      }
      this.pushEvent({ type: "sessionUpdate", params });
      this.sendToClient({ type: "sessionUpdate", params });
      this.scheduleMetaFlush();
    });

    acpClient.on("permissionRequest", (req) => {
      if (acpClient !== this.acp) return;
      if (this.bypassPermissions && autoApprovePermission(req)) {
        return;
      }
      const permId = `perm_${this.nextPermId++}`;
      this.pendingPermissions.set(permId, { permId, ...req });
      this.updatedAt = Date.now();
      this.flushMetaNow();
      this.sendToClient({ type: "permissionRequest", permId, params: req.params });
    });

    acpClient.on("disconnect", () => {
      if (acpClient !== this.acp || this.shuttingDown) return;
      this.busy = false;
      this.sendToClient({ type: "disconnect" });
      this.shutdown();
    });
  }

  async syncNativeBypass(enabled, { modeId = "", hasRunningMembers = false, immediateOnly = false } = {}) {
    const target = Boolean(enabled);
    this.bypassPermissions = target;
    if (target) {
      this.approveAllPendingPermissions();
    }

    if (immediateOnly) {
      this.flushMetaNow();
      return { ok: true, nativeBypass: this.nativeBypassActive, restarted: false, deferred: false };
    }

    const canSwapBackend =
      supportsNativeBypassFlag(this.baseLaunchSpec) &&
      !this.launchBypass &&
      Boolean(this.sessionId) &&
      Boolean(this.acp?.supportsSessionResume?.() || this.acp?.supportsSessionLoad?.());

    if (!canSwapBackend) {
      this.flushMetaNow();
      return { ok: true, nativeBypass: this.nativeBypassActive, restarted: false, deferred: false };
    }

    const execute = async () => {
      if (target === this.nativeBypassActive) {
        this.flushMetaNow();
        return { ok: true, nativeBypass: this.nativeBypassActive, restarted: false, deferred: false };
      }
      if (this.busy || this.activePromptCount > 0 || hasRunningMembers) {
        this.flushMetaNow();
        return { ok: true, nativeBypass: this.nativeBypassActive, restarted: false, deferred: true };
      }

      const nextSpec = withDangerouslySkipPermissions(this.baseLaunchSpec, target);
      const restoreMode = modeId || (target ? "auto" : this.modeId);
      try {
        const { updates } = await hotSwapAcpClient({
          currentClient: this.acp,
          nextLaunchSpec: nextSpec,
          sessionId: this.sessionId,
          cwd: this.cwd,
          modeId: restoreMode,
          sessionMeta: this.sessionMeta,
          onBindNext: (nextAcp) => {
            this.acp = nextAcp;
            this.bindAcpEvents(nextAcp);
          },
          onReplaySuppressed: (flag) => {
            this.suppressReplayEvents = flag;
          },
        });
        for (const meta of updates) {
          if (meta) this.captureSessionMeta(meta);
        }
        this.launchSpec = nextSpec;
        this.nativeBypassActive = target;
        this.flushMetaNow();
        return {
          ok: true,
          nativeBypass: this.nativeBypassActive,
          restarted: true,
          deferred: false,
          sessionMeta: this.sessionMeta,
          modeId: this.modeId,
          modelLabel: this.modelLabel,
        };
      } catch (err) {
        this.flushMetaNow();
        return {
          ok: true,
          nativeBypass: this.nativeBypassActive,
          restarted: false,
          deferred: false,
          error: err?.message || String(err),
        };
      }
    };

    if (this.bypassSwapPromise) {
      await this.bypassSwapPromise.catch(() => {});
    }
    const tracked = execute().finally(() => {
      if (this.bypassSwapPromise === tracked) {
        this.bypassSwapPromise = null;
      }
    });
    this.bypassSwapPromise = tracked;
    return tracked;
  }

  handleConnection(socket) {
    const prevSocket = this.activeSocket;
    if (prevSocket && !prevSocket.destroyed) {
      this.sendToClient({ type: "detached", reason: "taken over by another lucid client" });
      try {
        prevSocket.destroy();
      } catch {
        // Ignore
      }
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.activeSocket = socket;
    this.backgrounded = false;
    this.flushMetaNow();

    const feed = createLineSplitter((line) => this.handleClientMessage(socket, line));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (this.activeSocket === socket) feed(chunk);
    });

    socket.on("close", () => {
      if (this.activeSocket === socket) {
        this.activeSocket = null;
        if (this.everSentPrompt || this.busy) {
          this.backgrounded = true;
        }
        this.flushMetaNow();
        this.scheduleIdleCheck();
      }
    });

    socket.on("error", () => {
      // Handled by close
    });
  }

  reply(socket, id, result = null, error = null) {
    if (!socket || socket.destroyed) return;
    const payload = error ? { type: "response", id, error: String(error) } : { type: "response", id, result };
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // Ignore
    }
  }

  async handleClientMessage(socket, line) {
    const msg = parseJsonObjectLine(line);
    if (!msg) return;
    const { id, op } = msg;
    if (typeof op !== "string") {
      if (id !== undefined) {
        this.reply(socket, id, null, "Invalid host op");
      }
      return;
    }

    try {
      switch (op) {
        case "attach":
          this.reply(socket, id, {
            hostId: this.hostId,
            initResult: this.initResult,
            agentInfo: this.acp.agentInfo,
            agentCapabilities: this.acp.agentCapabilities,
            authMethods: this.acp.authMethods,
            sessionId: this.sessionId,
            sessionMeta: this.sessionMeta,
            sessionTitle: this.sessionTitle,
            modelLabel: this.modelLabel,
            modeId: this.modeId,
            usage: this.usage,
            busy: this.busy,
            activePromptCount: this.activePromptCount,
            turnStartedAt: this.turnStartedAt,
            bypassPermissions: this.bypassPermissions,
            nativeBypassActive: this.nativeBypassActive,
            eventLog: this.eventLog,
            pendingPermissions: [...this.pendingPermissions.values()].map((p) => ({
              permId: p.permId,
              params: p.params,
            })),
          });
          return;
        case "detach":
          this.backgrounded = true;
          this.flushMetaNow();
          this.reply(socket, id, { hostId: this.hostId, sessionId: this.sessionId, status: this.computeStatus() });
          socket.end();
          return;
        case "shutdown":
          this.reply(socket, id, { ok: true });
          await this.shutdown();
          return;
        case "setBypass": {
          const res = await this.syncNativeBypass(Boolean(msg.enabled), {
            modeId: msg.modeId || "",
            hasRunningMembers: Boolean(msg.hasRunningMembers),
            immediateOnly: Boolean(msg.immediateOnly),
          });
          this.reply(socket, id, res);
          return;
        }
        case "permissionResponse": {
          const entry = this.pendingPermissions.get(msg.permId);
          if (entry) {
            this.pendingPermissions.delete(msg.permId);
            if (msg.cancelled) entry.cancel();
            else entry.selectOption(msg.optionId);
            this.flushMetaNow();
          }
          this.reply(socket, id, { ok: true });
          return;
        }
        case "listSessions":
          this.reply(socket, id, await this.acp.listSessions(msg.cwd || this.cwd));
          return;
        case "createSession": {
          this.eventLog = [];
          this.sessionMeta = {};
          this.cancelAllPendingPermissions();
          this.usage = null;
          this.sessionTitle = "";
          this.everSentPrompt = false;
          const created = await this.acp.createSession(msg.cwd || this.cwd, msg.additionalDirectories || []);
          this.sessionId = created.sessionId;
          this.captureSessionMeta(created);
          this.flushMetaNow();
          this.reply(socket, id, created);
          return;
        }
        case "loadSession":
        case "resumeSession":
          this.reply(socket, id, await this.openExistingSession(op, msg.sessionId, msg.cwd || this.cwd));
          return;
        case "closeSession":
          if (this.sessionId === msg.sessionId) this.cancelAllPendingPermissions();
          await this.acp.closeSession(msg.sessionId);
          if (this.sessionId === msg.sessionId) this.sessionId = "";
          this.reply(socket, id, { ok: true });
          return;
        case "setMode":
          if (this.bypassSwapPromise) await this.bypassSwapPromise.catch(() => {});
          this.applyMetaAndReply(socket, id, await this.acp.setMode(msg.sessionId, msg.modeId), msg.modeId);
          return;
        case "setConfigOption":
          if (this.bypassSwapPromise) await this.bypassSwapPromise.catch(() => {});
          this.applyMetaAndReply(
            socket,
            id,
            await this.acp.setConfigOption(msg.sessionId, msg.configId, msg.value),
          );
          return;
        case "setModel":
          if (this.bypassSwapPromise) await this.bypassSwapPromise.catch(() => {});
          this.applyMetaAndReply(
            socket,
            id,
            await this.acp.setModel(msg.sessionId, msg.modelValue, msg.preferConfigOption),
          );
          return;
        case "cancelTurn":
          this.acp.cancelTurn(msg.sessionId);
          this.reply(socket, id, { ok: true });
          return;
        case "sendPrompt":
          // Acknowledge immediately so a client that detaches right after sending
          // does not abort the prompt; completion is delivered via `promptDone`.
          this.reply(socket, id, { accepted: true });
          this.runHostedPrompt(msg.sessionId, msg.blocks, msg.meta || {});
          return;
        default:
          this.reply(socket, id, null, `Unknown host op: ${op}`);
      }
    } catch (err) {
      this.reply(socket, id, null, err?.message || String(err));
    }
  }

  applyMetaAndReply(socket, id, res, modeOverride = "") {
    this.captureSessionMeta(res);
    if (modeOverride) this.modeId = modeOverride;
    this.flushMetaNow();
    this.reply(socket, id, res);
  }

  async openExistingSession(method, sessionId, cwd) {
    const prevSessionId = this.sessionId;
    const prevEventLog = this.eventLog;
    const prevMeta = this.sessionMeta;
    this.eventLog = [];
    this.sessionMeta = {};
    this.sessionId = sessionId;
    try {
      const res = await this.acp[method](sessionId, cwd);
      this.cancelAllPendingPermissions();
      this.captureSessionMeta(res);
      this.flushMetaNow();
      return res;
    } catch (err) {
      this.sessionId = prevSessionId;
      this.eventLog = prevEventLog;
      this.sessionMeta = prevMeta;
      throw err;
    }
  }

  async runHostedPrompt(sessionId, blocks, meta) {
    this.everSentPrompt = true;
    this.updatedAt = Date.now();
    if (meta?.text) {
      this.lastSummary = String(meta.text).split(/\r?\n/)[0].slice(0, 80);
      if (!this.sessionTitle) {
        this.sessionTitle = this.lastSummary;
      }
      this.pushEvent({
        type: "userPrompt",
        text: meta.text,
        displayText: meta.displayText || "",
        attachedPaths: meta.attachedPaths || [],
        attachedImages: meta.attachedImages || [],
      });
    }

    this.activePromptCount += 1;
    if (!this.busy) {
      this.busy = true;
      this.turnStartedAt = Date.now();
    }
    this.flushMetaNow();

    let stopReason = "";
    let errorMessage = "";
    try {
      if (this.bypassSwapPromise) {
        await this.bypassSwapPromise.catch(() => {});
      }
      const result = await this.acp.sendPrompt(sessionId, blocks);
      stopReason = result?.stopReason || "end_turn";
    } catch (err) {
      errorMessage = err?.message || String(err);
    } finally {
      this.activePromptCount = Math.max(0, this.activePromptCount - 1);
      if (this.activePromptCount === 0) {
        this.busy = false;
      }
      this.updatedAt = Date.now();
      if (stopReason === "cancelled") {
        this.pushEvent({ type: "notice", level: "info", text: "Turn cancelled." });
      } else if (errorMessage) {
        this.pushEvent({ type: "notice", level: "error", text: errorMessage });
      }
      this.flushMetaNow();
      this.sendToClient({
        type: "promptDone",
        stopReason,
        error: errorMessage || null,
        activePromptCount: this.activePromptCount,
      });
      this.scheduleIdleCheck();
    }
  }

  async shutdown(exitCode = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.metaDirtyTimer) {
      clearTimeout(this.metaDirtyTimer);
      this.metaDirtyTimer = null;
    }

    this.cancelAllPendingPermissions();

    if (this.activeSocket && !this.activeSocket.destroyed) {
      try {
        this.activeSocket.end();
      } catch {
        // Ignore
      }
      this.activeSocket = null;
    }

    if (this.server) {
      try {
        this.server.close();
      } catch {
        // Ignore
      }
      this.server = null;
    }

    try {
      await this.acp.stop(this.sessionId);
    } catch {
      // Ignore
    }

    removeBgFiles(this.hostId, this.socketPath, this.bgDir);
    process.exit(exitCode);
  }
}

export async function runSessionHostFromFile(specFilePath) {
  try {
    process.umask(0o077);
  } catch {
    // Ignore on unsupported platforms
  }
  const raw = fs.readFileSync(specFilePath, "utf8");
  try {
    fs.unlinkSync(specFilePath);
  } catch {
    // Ignore
  }
  const spec = JSON.parse(raw);
  const host = new SessionHost(spec);
  process.on("uncaughtException", () => {
    host.shutdown(1);
  });
  process.on("unhandledRejection", () => {
    host.shutdown(1);
  });
  try {
    await host.start();
  } catch {
    await host.shutdown(1);
  }
}
