import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { AcpClient } from "./client.mjs";
import { removeBgFiles, writeBgMeta } from "./bg_registry.mjs";

const MAX_EVENT_LOG = 6000;
const EMPTY_DETACHED_GRACE_MS = 4000;
const COMPLETED_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

function extractChunkText(update) {
  if (!update) return "";
  if (typeof update.text === "string") return update.text;
  const content = update.content;
  if (typeof content === "string") return content;
  if (content && typeof content.text === "string") return content.text;
  return "";
}

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
    this.launchSpec = spec.launchSpec;
    this.addDirs = Array.isArray(spec.addDirs) ? spec.addDirs : [];
    this.initialPrompt = spec.initialPrompt || "";
    this.initialMode = spec.initialMode || "";
    this.initialModel = spec.initialModel || "";
    this.startBackgrounded = Boolean(spec.startBackgrounded);
    this.bypassPermissions = Boolean(
      spec.bypassPermissions || (this.launchSpec?.args || []).includes("--dangerously-skip-permissions"),
    );

    this.acp = new AcpClient(this.launchSpec);
    this.server = null;
    this.activeSocket = null;
    this.socketBuffer = "";
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
    if (!payload || typeof payload !== "object") return;
    if (payload.modes) {
      this.sessionMeta.modes = payload.modes;
      if (payload.modes.currentModeId) this.modeId = payload.modes.currentModeId;
    }
    if (payload.models) {
      this.sessionMeta.models = payload.models;
      if (payload.models.currentModelId) {
        const found = (payload.models.availableModels || []).find((m) => m.modelId === payload.models.currentModelId);
        this.modelLabel = found?.name || payload.models.currentModelId;
      }
    }
    if (Array.isArray(payload.configOptions)) {
      this.sessionMeta.configOptions = payload.configOptions;
      const modelOpt = payload.configOptions.find((c) => c.category === "model" || c.id === "model");
      if (modelOpt?.currentValue) {
        const opt = (modelOpt.options || []).find((o) => o.value === modelOpt.currentValue);
        this.modelLabel = opt?.name || modelOpt.currentValue;
      }
      const modeOpt = payload.configOptions.find((c) => c.category === "mode" || c.id === "mode");
      if (modeOpt?.currentValue) {
        this.modeId = modeOpt.currentValue;
      }
    }
    if (Array.isArray(payload.availableCommands)) {
      this.sessionMeta.availableCommands = payload.availableCommands;
    }
  }

  autoApprovePermission(req) {
    const options = Array.isArray(req.params?.options) ? req.params.options : [];
    const allowOption =
      options.find((o) => o.kind === "allow_always") ||
      options.find((o) => o.kind === "allow_once") ||
      options.find((o) => /allow|approve|yes/i.test(`${o.optionId} ${o.name || ""}`));
    if (!allowOption) return false;
    req.selectOption(allowOption.optionId);
    return true;
  }

  approveAllPendingPermissions() {
    for (const [permId, entry] of [...this.pendingPermissions]) {
      if (this.autoApprovePermission(entry)) {
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

    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true });
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore
    }

    this.acp.on("sessionUpdate", (params) => {
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
        } else if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
          this.captureSessionMeta({ configOptions: update.configOptions });
        }
        const summary = summarizeUpdateText(update);
        if (summary) this.lastSummary = summary;
      }
      this.pushEvent({ type: "sessionUpdate", params });
      this.sendToClient({ type: "sessionUpdate", params });
      this.scheduleMetaFlush();
    });

    this.acp.on("permissionRequest", (req) => {
      if (this.bypassPermissions && this.autoApprovePermission(req)) {
        return;
      }
      const permId = `perm_${this.nextPermId++}`;
      this.pendingPermissions.set(permId, { permId, ...req });
      this.updatedAt = Date.now();
      this.flushMetaNow();
      this.sendToClient({ type: "permissionRequest", permId, params: req.params });
    });

    this.acp.on("disconnect", () => {
      if (this.shuttingDown) return;
      this.busy = false;
      this.sendToClient({ type: "disconnect" });
      this.shutdown();
    });

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
          const hasConfigModel = Array.isArray(this.sessionMeta.configOptions) &&
            this.sessionMeta.configOptions.some((c) => c.id === "model" || c.category === "model");
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
    }
  }

  handleConnection(socket) {
    if (this.activeSocket && !this.activeSocket.destroyed) {
      this.sendToClient({ type: "detached", reason: "taken over by another lucid client" });
      try {
        this.activeSocket.end();
      } catch {
        // Ignore
      }
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.activeSocket = socket;
    this.socketBuffer = "";
    this.flushMetaNow();

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.socketBuffer += chunk;
      let nlIdx = this.socketBuffer.indexOf("\n");
      while (nlIdx !== -1) {
        const line = this.socketBuffer.slice(0, nlIdx).trim();
        this.socketBuffer = this.socketBuffer.slice(nlIdx + 1);
        if (line) {
          this.handleClientMessage(socket, line);
        }
        nlIdx = this.socketBuffer.indexOf("\n");
      }
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
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, op } = msg;

    try {
      if (op === "attach") {
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
          eventLog: this.eventLog,
          pendingPermissions: [...this.pendingPermissions.values()].map((p) => ({
            permId: p.permId,
            params: p.params,
          })),
        });
        return;
      }

      if (op === "detach") {
        this.backgrounded = true;
        this.flushMetaNow();
        this.reply(socket, id, { hostId: this.hostId, sessionId: this.sessionId, status: this.computeStatus() });
        socket.end();
        return;
      }

      if (op === "shutdown") {
        this.reply(socket, id, { ok: true });
        await this.shutdown();
        return;
      }

      if (op === "setBypass") {
        this.bypassPermissions = Boolean(msg.enabled);
        if (this.bypassPermissions) {
          this.approveAllPendingPermissions();
        } else {
          this.flushMetaNow();
        }
        this.reply(socket, id, { ok: true });
        return;
      }

      if (op === "permissionResponse") {
        const entry = this.pendingPermissions.get(msg.permId);
        if (entry) {
          this.pendingPermissions.delete(msg.permId);
          if (msg.cancelled) {
            entry.cancel();
          } else {
            entry.selectOption(msg.optionId);
          }
          this.flushMetaNow();
        }
        this.reply(socket, id, { ok: true });
        return;
      }

      if (op === "listSessions") {
        const sessions = await this.acp.listSessions(msg.cwd || this.cwd);
        this.reply(socket, id, sessions);
        return;
      }

      if (op === "createSession") {
        this.eventLog = [];
        this.pendingPermissions.clear();
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

      if (op === "loadSession") {
        this.eventLog = [];
        this.pendingPermissions.clear();
        this.sessionId = msg.sessionId;
        const res = await this.acp.loadSession(msg.sessionId, msg.cwd || this.cwd);
        this.captureSessionMeta(res);
        this.flushMetaNow();
        this.reply(socket, id, res);
        return;
      }

      if (op === "resumeSession") {
        this.eventLog = [];
        this.pendingPermissions.clear();
        this.sessionId = msg.sessionId;
        const res = await this.acp.resumeSession(msg.sessionId, msg.cwd || this.cwd);
        this.captureSessionMeta(res);
        this.flushMetaNow();
        this.reply(socket, id, res);
        return;
      }

      if (op === "closeSession") {
        await this.acp.closeSession(msg.sessionId);
        if (this.sessionId === msg.sessionId) {
          this.sessionId = "";
        }
        this.reply(socket, id, { ok: true });
        return;
      }

      if (op === "setMode") {
        const res = await this.acp.setMode(msg.sessionId, msg.modeId);
        this.captureSessionMeta(res);
        this.modeId = msg.modeId;
        this.flushMetaNow();
        this.reply(socket, id, res);
        return;
      }

      if (op === "setConfigOption") {
        const res = await this.acp.setConfigOption(msg.sessionId, msg.configId, msg.value);
        this.captureSessionMeta(res);
        this.flushMetaNow();
        this.reply(socket, id, res);
        return;
      }

      if (op === "setModel") {
        const res = await this.acp.setModel(msg.sessionId, msg.modelValue, msg.preferConfigOption);
        this.captureSessionMeta(res);
        this.flushMetaNow();
        this.reply(socket, id, res);
        return;
      }

      if (op === "cancelTurn") {
        this.acp.cancelTurn(msg.sessionId);
        this.reply(socket, id, { ok: true });
        return;
      }

      if (op === "sendPrompt") {
        // Acknowledge immediately so a client that detaches right after sending
        // does not abort the prompt; completion is delivered via `promptDone`.
        this.reply(socket, id, { accepted: true });
        this.runHostedPrompt(msg.sessionId, msg.blocks, msg.meta || {});
        return;
      }

      this.reply(socket, id, null, `Unknown host op: ${op}`);
    } catch (err) {
      this.reply(socket, id, null, err?.message || String(err));
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

  async shutdown() {
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

    for (const [, entry] of this.pendingPermissions) {
      try {
        entry.cancel();
      } catch {
        // Ignore
      }
    }
    this.pendingPermissions.clear();

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
    process.exit(0);
  }
}

export async function runSessionHostFromFile(specFilePath) {
  const raw = fs.readFileSync(specFilePath, "utf8");
  try {
    fs.unlinkSync(specFilePath);
  } catch {
    // Ignore
  }
  const spec = JSON.parse(raw);
  const host = new SessionHost(spec);
  await host.start();
}
