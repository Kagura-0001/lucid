import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateHostId, getBgDir, resolveSocketPath } from "./bg_registry.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(THIS_DIR, "../../bin/lucid.mjs");

function waitForSocket(socketPath, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for lucid session host at ${socketPath}`));
        return;
      }
      if (!fs.existsSync(socketPath)) {
        setTimeout(attempt, 40);
        return;
      }
      const probe = net.createConnection(socketPath);
      probe.once("connect", () => {
        resolve(probe);
      });
      probe.once("error", () => {
        probe.destroy();
        setTimeout(attempt, 50);
      });
    };

    attempt();
  });
}

/**
 * Spawns a detached lucid session host process and returns its hostId & socketPath.
 */
export function spawnSessionHost({
  cwd,
  launchSpec,
  addDirs = [],
  initialPrompt = "",
  initialMode = "",
  initialModel = "",
  startBackgrounded = false,
  bypassPermissions = false,
  bgDir = getBgDir(),
}) {
  fs.mkdirSync(bgDir, { recursive: true });
  const hostId = generateHostId();
  const socketPath = resolveSocketPath(hostId, bgDir);
  const specPath = path.join(bgDir, `${hostId}.spec.json`);

  const spec = {
    hostId,
    bgDir,
    socketPath,
    cwd,
    launchSpec,
    addDirs,
    initialPrompt,
    initialMode,
    initialModel,
    startBackgrounded,
    bypassPermissions,
  };
  fs.writeFileSync(specPath, JSON.stringify(spec), { encoding: "utf8", mode: 0o600 });

  const child = spawn(process.execPath, [BIN_PATH, "--internal-host", specPath], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  return { hostId, socketPath, pid: child.pid };
}

/**
 * ACP client proxy connected to a detached SessionHost over a Unix domain socket.
 * Exposes the same interface as AcpClient, plus attach() and detach().
 */
export class HostAcpClient extends EventEmitter {
  constructor({ hostId, socketPath, launchSpec = null }) {
    super();
    this.hostId = hostId;
    this.socketPath = socketPath;
    this.launchSpec = launchSpec;
    this.isHosted = true;

    this.socket = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextReqId = 1;
    this.agentInfo = null;
    this.agentCapabilities = {};
    this.authMethods = [];
    this.detaching = false;
    this.stopping = false;
  }

  async start(timeoutMs = 20000) {
    this.socket = await waitForSocket(this.socketPath, timeoutMs);
    this.socket.setEncoding("utf8");

    this.socket.on("data", (chunk) => {
      this.buffer += chunk;
      let nlIdx = this.buffer.indexOf("\n");
      while (nlIdx !== -1) {
        const line = this.buffer.slice(0, nlIdx).trim();
        this.buffer = this.buffer.slice(nlIdx + 1);
        if (line) {
          this.handleMessage(line);
        }
        nlIdx = this.buffer.indexOf("\n");
      }
    });

    this.socket.on("close", () => {
      for (const [, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Session host connection closed"));
      }
      this.pending.clear();
      if (!this.detaching && !this.stopping) {
        this.emit("disconnect");
      }
    });

    this.socket.on("error", () => {
      // Handled by close
    });

    const snapshot = await this.request("attach", {}, timeoutMs);
    this.hostId = snapshot.hostId || this.hostId;
    this.agentInfo = snapshot.agentInfo || snapshot.initResult?.agentInfo || null;
    this.agentCapabilities = snapshot.agentCapabilities || snapshot.initResult?.agentCapabilities || {};
    this.authMethods = snapshot.authMethods || snapshot.initResult?.authMethods || [];
    return snapshot;
  }

  handleMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === "response" && msg.id) {
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        clearTimeout(waiter.timer);
        if (msg.error) {
          waiter.reject(new Error(msg.error));
        } else {
          waiter.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.type === "sessionUpdate") {
      this.emit("sessionUpdate", msg.params);
      return;
    }

    if (msg.type === "permissionRequest") {
      this.emit("permissionRequest", this.makePermissionHandle(msg.permId, msg.params));
      return;
    }

    if (msg.type === "promptDone") {
      this.emit("promptDone", msg);
      return;
    }

    if (msg.type === "detached") {
      this.detaching = true;
      this.emit("detached", msg.reason || "");
      return;
    }

    if (msg.type === "disconnect") {
      this.emit("disconnect");
    }
  }

  makePermissionHandle(permId, params) {
    let settled = false;
    return {
      params,
      selectOption: (optionId) => {
        if (settled) return;
        settled = true;
        this.request("permissionResponse", { permId, optionId, cancelled: false }, 5000).catch(() => {});
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        this.request("permissionResponse", { permId, cancelled: true }, 5000).catch(() => {});
      },
    };
  }

  request(op, payload = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error("Not connected to lucid session host"));
        return;
      }
      const id = `r_${this.nextReqId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Host request "${op}" timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.write(`${JSON.stringify({ id, op, ...payload })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  supportsSessionList() {
    const caps = this.agentCapabilities.sessionCapabilities || this.agentCapabilities.session_capabilities || {};
    return Boolean(caps.list);
  }

  supportsSessionLoad() {
    const caps = this.agentCapabilities.sessionCapabilities || this.agentCapabilities.session_capabilities || {};
    return Boolean(this.agentCapabilities.loadSession || this.agentCapabilities.load_session || caps.load);
  }

  supportsSessionResume() {
    const caps = this.agentCapabilities.sessionCapabilities || this.agentCapabilities.session_capabilities || {};
    return Boolean(caps.resume);
  }

  listSessions(cwd) {
    return this.request("listSessions", { cwd }, 15000);
  }

  createSession(cwd, additionalDirectories = []) {
    return this.request("createSession", { cwd, additionalDirectories }, 30000);
  }

  loadSession(sessionId, cwd) {
    return this.request("loadSession", { sessionId, cwd }, 30000);
  }

  resumeSession(sessionId, cwd) {
    return this.request("resumeSession", { sessionId, cwd }, 30000);
  }

  closeSession(sessionId) {
    if (!sessionId) return Promise.resolve();
    return this.request("closeSession", { sessionId }, 5000).catch(() => {});
  }

  sendPrompt(sessionId, blocks, meta = {}) {
    return this.request("sendPrompt", { sessionId, blocks, meta }, 15000);
  }

  cancelTurn(sessionId) {
    this.request("cancelTurn", { sessionId }, 5000).catch(() => {});
  }

  setMode(sessionId, modeId) {
    return this.request("setMode", { sessionId, modeId }, 10000);
  }

  setConfigOption(sessionId, configId, value) {
    return this.request("setConfigOption", { sessionId, configId, value }, 10000);
  }

  setModel(sessionId, modelValue, preferConfigOption = false) {
    return this.request("setModel", { sessionId, modelValue, preferConfigOption }, 10000);
  }

  setBypassPermissions(enabled) {
    this.request("setBypass", { enabled: Boolean(enabled) }, 5000).catch(() => {});
  }

  async detach() {
    this.detaching = true;
    try {
      const info = await this.request("detach", {}, 3000);
      return info;
    } catch {
      return { hostId: this.hostId };
    } finally {
      if (this.socket && !this.socket.destroyed) {
        this.socket.end();
      }
    }
  }

  async stop() {
    this.stopping = true;
    try {
      await this.request("shutdown", {}, 4000);
    } catch {
      // Ignore if host already exited
    } finally {
      if (this.socket && !this.socket.destroyed) {
        this.socket.destroy();
      }
    }
  }
}
