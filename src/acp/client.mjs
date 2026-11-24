import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { LUCID_VERSION } from "../config.mjs";
import { StdioJsonRpc } from "./jsonrpc.mjs";
import {
  findConfigOption,
  supportsSessionList as capsSupportList,
  supportsSessionLoad as capsSupportLoad,
  supportsSessionResume as capsSupportResume,
} from "./protocol.mjs";

export class AcpClient extends EventEmitter {
  constructor(launchSpec) {
    super();
    this.launchSpec = launchSpec;
    this.child = null;
    this.rpc = null;
    this.stderrTail = [];
    this.agentInfo = null;
    this.agentCapabilities = {};
    this.authMethods = [];
    this.stopping = false;
  }

  async start() {
    const { command, args } = this.launchSpec;
    this.stopping = false;
    this.stderrTail = [];

    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const spawnErrorPromise = new Promise((_, reject) => {
      this.child.once("error", (err) => {
        reject(new Error(`Failed to launch "${command}": ${err.message}`));
      });
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 80) {
          this.stderrTail.shift();
        }
      }
      this.emit("stderr", chunk);
    });

    this.child.on("exit", (code, signal) => {
      const tailCopy = [...this.stderrTail];
      this.emit("exit", { code, signal, stderrTail: tailCopy });
      if (!this.stopping && this.rpc && !this.rpc.closed) {
        const tailMsg = tailCopy.slice(-3).join(" | ");
        const suffix = tailMsg ? `: ${tailMsg}` : "";
        const err = new Error(`ACP agent exited (code=${code ?? "null"}, signal=${signal ?? "none"})${suffix}`);
        this.rpc.handleClose(err);
      }
    });

    this.rpc = new StdioJsonRpc(this.child.stdin, this.child.stdout);

    this.rpc.on("notification", (method, params) => {
      if (method === "session/update") {
        this.emit("sessionUpdate", params);
      } else {
        this.emit("notification", { method, params });
      }
    });

    this.rpc.on("close", (err) => {
      if (!this.stopping) {
        this.emit("disconnect", err);
      }
    });

    this.rpc.onRequest(async (method, params) => {
      if (method === "session/request_permission") {
        return this.handlePermissionRequest(params);
      }
      if (this.listenerCount("serverRequest") > 0) {
        return new Promise((resolve, reject) => {
          this.emit("serverRequest", { method, params, resolve, reject });
        });
      }
      const err = new Error(`Client does not support method "${method}"`);
      err.code = -32601;
      throw err;
    });

    let initResult;
    try {
      initResult = await Promise.race([
        this.rpc.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: {
              name: "lucid",
              version: LUCID_VERSION,
            },
          },
          15000,
        ),
        spawnErrorPromise,
      ]);
    } catch (err) {
      await this.stop().catch(() => {});
      throw err;
    }

    this.agentInfo = initResult?.agentInfo || { name: this.launchSpec.name, version: "" };
    this.agentCapabilities = initResult?.agentCapabilities || {};
    this.authMethods = Array.isArray(initResult?.authMethods) ? initResult.authMethods : [];

    return initResult;
  }

  handlePermissionRequest(params) {
    return new Promise((resolve) => {
      if (this.listenerCount("permissionRequest") === 0) {
        resolve({ outcome: { outcome: "cancelled" } });
        return;
      }
      let settled = false;
      const selectOption = (optionId) => {
        if (settled) return;
        settled = true;
        resolve({
          outcome: {
            outcome: "selected",
            optionId,
          },
        });
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        resolve({
          outcome: {
            outcome: "cancelled",
          },
        });
      };
      this.emit("permissionRequest", { params, selectOption, cancel });
    });
  }

  supportsSessionList() {
    return capsSupportList(this.agentCapabilities);
  }

  supportsSessionLoad() {
    return capsSupportLoad(this.agentCapabilities);
  }

  supportsSessionResume() {
    return capsSupportResume(this.agentCapabilities);
  }

  async listSessions(cwd) {
    const result = await this.rpc.request("session/list", { cwd }, 15000);
    const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
    return sessions;
  }

  async createSession(cwd, additionalDirectories = []) {
    const params = { cwd, mcpServers: [] };
    if (Array.isArray(additionalDirectories) && additionalDirectories.length > 0) {
      params.additionalDirectories = additionalDirectories;
    }
    return this.rpc.request("session/new", params, 30000);
  }

  async loadSession(sessionId, cwd) {
    return this.rpc.request("session/load", { sessionId, cwd, mcpServers: [] }, 30000);
  }

  async resumeSession(sessionId, cwd) {
    return this.rpc.request("session/resume", { sessionId, cwd, mcpServers: [] }, 30000);
  }

  async closeSession(sessionId) {
    if (!sessionId || !this.rpc || this.rpc.closed) return;
    try {
      await this.rpc.request("session/close", { sessionId }, 5000);
    } catch {
      // Best-effort cleanup
    }
  }

  async sendPrompt(sessionId, promptBlocks) {
    return this.rpc.request("session/prompt", {
      sessionId,
      prompt: promptBlocks,
    });
  }

  cancelTurn(sessionId) {
    if (!sessionId || !this.rpc || this.rpc.closed) return;
    this.rpc.notify("session/cancel", { sessionId });
  }

  async setConfigOption(sessionId, configId, value) {
    return this.rpc.request(
      "session/set_config_option",
      {
        sessionId,
        configId,
        value,
      },
      10000,
    );
  }

  async setMode(sessionId, modeId) {
    try {
      return await this.setConfigOption(sessionId, "mode", modeId);
    } catch {
      return this.rpc.request("session/set_mode", { sessionId, modeId }, 10000);
    }
  }

  async setModel(sessionId, modelValue, preferConfigOption = true) {
    if (preferConfigOption) {
      try {
        return await this.setConfigOption(sessionId, "model", modelValue);
      } catch {
        // Fallback to legacy session/set_model
      }
    }
    return this.rpc.request("session/set_model", { sessionId, modelId: modelValue }, 10000);
  }

  async stop(activeSessionId = null, { killGraceMs = 1500 } = {}) {
    this.stopping = true;
    if (activeSessionId) {
      await this.closeSession(activeSessionId);
    }
    if (this.rpc) {
      this.rpc.close();
      this.rpc = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null;
      try {
        child.stdin.end();
      } catch {
        // Ignore
      }
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            try {
              if (child.exitCode === null) child.kill("SIGKILL");
            } catch {
              // Ignore
            }
            resolve();
          }, killGraceMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }
}

/**
 * Starts a replacement AcpClient with `nextLaunchSpec`, swaps it in cleanly,
 * stops the previous process, resumes or reloads the same session, and restores
 * mode, model, and thinking effort without emitting spurious disconnects.
 */
export async function hotSwapAcpClient({
  currentClient,
  nextLaunchSpec,
  sessionId,
  cwd,
  modeId = "",
  sessionMeta = {},
  onBindNext,
  onReplaySuppressed = () => {},
}) {
  const nextAcp = new AcpClient(nextLaunchSpec);
  try {
    await nextAcp.start();
  } catch (err) {
    await nextAcp.stop().catch(() => {});
    throw err;
  }

  onBindNext(nextAcp);
  // Stop without session/close so the on-disk session stays intact for resume.
  // Use a shorter SIGKILL grace window because agy acp can ignore SIGTERM.
  await currentClient.stop(null, { killGraceMs: 300 }).catch(() => {});

  const modelOpt = findConfigOption(sessionMeta.configOptions, "model");
  const restoreModel = modelOpt?.currentValue || sessionMeta.models?.currentModelId || "";
  const preferConfigModel = Boolean(modelOpt);
  const effortOpt =
    findConfigOption(sessionMeta.configOptions, "thought_level") ||
    findConfigOption(sessionMeta.configOptions, "effort");
  const restoreEffort = effortOpt?.currentValue || "";

  let res = null;
  let restored = false;
  if (nextAcp.supportsSessionResume()) {
    try {
      res = await nextAcp.resumeSession(sessionId, cwd);
      restored = true;
    } catch {
      res = null;
    }
  }
  if (!restored && nextAcp.supportsSessionLoad()) {
    onReplaySuppressed(true);
    try {
      res = await nextAcp.loadSession(sessionId, cwd);
      restored = true;
    } finally {
      onReplaySuppressed(false);
    }
  }
  if (!restored) {
    throw new Error("Replacement ACP backend does not support resuming or loading the active session");
  }

  const restoreTasks = [];
  if (modeId) {
    restoreTasks.push(nextAcp.setMode(sessionId, modeId).catch(() => null));
  }
  if (restoreModel) {
    restoreTasks.push(nextAcp.setModel(sessionId, restoreModel, preferConfigModel).catch(() => null));
  }
  if (effortOpt?.id && restoreEffort) {
    restoreTasks.push(nextAcp.setConfigOption(sessionId, effortOpt.id, restoreEffort).catch(() => null));
  }
  const restoredUpdates = restoreTasks.length > 0 ? await Promise.all(restoreTasks) : [];
  return { nextAcp, updates: [res, ...restoredUpdates] };
}

/**
 * Optional read-only Antigravity CLI quota probe (`agy -p "/usage" --output-format json`).
 * Never starts an agent turn or spends quota. Returns `{ badge, lines }` or null.
 */
export function fetchAgyQuota(timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    let proc;
    try {
      proc = spawn("agy", ["-p", "/usage", "--output-format", "json"], {
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      });
    } catch {
      finish(null);
      return;
    }

    let stdout = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    const timer = setTimeout(() => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Ignore
      }
      finish(null);
    }, timeoutMs);

    proc.on("error", () => {
      clearTimeout(timer);
      finish(null);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        finish(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        finish(parseQuotaPayload(parsed));
      } catch {
        const firstLine = stdout.trim().split("\n")[0];
        finish(firstLine ? { badge: firstLine.slice(0, 40), lines: [firstLine] } : null);
      }
    });
  });
}

function formatUsageBar(fraction, width = 16) {
  const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
  const filled = Math.round(clamped * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function formatResetEta(resetTimeIso, description = "") {
  if (resetTimeIso) {
    const ms = Date.parse(resetTimeIso) - Date.now();
    if (!Number.isNaN(ms) && ms > 0) {
      const totalMins = Math.round(ms / 60000);
      const days = Math.floor(totalMins / (60 * 24));
      const hours = Math.floor((totalMins % (60 * 24)) / 60);
      const mins = totalMins % 60;
      if (days > 0) return `resets in ${days}d ${hours}h`;
      if (hours > 0) return `resets in ${hours}h ${mins}m`;
      return `resets in ${mins}m`;
    }
  }
  const match = /refresh in ([^.]+)/i.exec(String(description || ""));
  return match ? `resets in ${match[1].trim()}` : "";
}

function selectQuotaBadge(records, fallbackLine = "") {
  let gemini5h = "";
  let geminiWk = "";
  let claude5h = "";
  let claudeWk = "";

  for (const { group, windowText, pct } of records) {
    const gLower = String(group || "").toLowerCase();
    const wLower = String(windowText || "").toLowerCase();
    const is5h = wLower.includes("5h") || wLower.includes("five hour") || /\b5\b/.test(wLower) || wLower.includes("five");
    const isWk = wLower.includes("week");
    if (gLower.includes("gemini")) {
      if (is5h) gemini5h = pct;
      if (isWk) geminiWk = pct;
    } else if (gLower.includes("claude") || gLower.includes("gpt")) {
      if (is5h) claude5h = pct;
      if (isWk) claudeWk = pct;
    }
  }

  const parts = [];
  if (gemini5h) parts.push(`5h ${gemini5h}`);
  if (geminiWk) parts.push(`wk ${geminiWk}`);
  if (parts.length === 0 && claude5h) parts.push(`5h ${claude5h}`);
  if (parts.length === 0 && claudeWk) parts.push(`wk ${claudeWk}`);
  return parts.join(" · ") || String(fallbackLine || "").slice(0, 40);
}

export function parseQuotaPayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  // Structured agy -p "/usage" / "/quota" --output-format json shape:
  // { status: "SUCCESS", command: { name: "usage", data: { groups: [{ name, buckets: [...] }] } } }
  const groups = payload.command?.data?.groups;
  if (Array.isArray(groups) && groups.length > 0) {
    const records = [];
    const detailLines = [];

    for (const group of groups) {
      const groupName = String(group?.name || "Models");
      const buckets = Array.isArray(group?.buckets) ? group.buckets : [];
      // Show 5h before weekly within each group for readability.
      const ordered = [...buckets].sort((a, b) => (a.window === "5h" ? -1 : b.window === "5h" ? 1 : 0));
      for (const bucket of ordered) {
        const frac = typeof bucket?.remaining_fraction === "number" ? bucket.remaining_fraction : null;
        if (frac === null) continue;
        const pct = `${Math.round(frac * 100)}%`;
        const win = String(bucket.window || bucket.name || "");
        const bar = formatUsageBar(frac);
        const eta = formatResetEta(bucket.reset_time, bucket.description);
        const etaSuffix = eta ? `  (${eta})` : "";
        detailLines.push(`${groupName} · ${win.padEnd(6)} ${bar} ${pct.padStart(4)}${etaSuffix}`);
        records.push({ group: groupName, windowText: win, pct });
      }
    }

    if (detailLines.length > 0) {
      return {
        badge: selectQuotaBadge(records, detailLines[0]),
        lines: detailLines,
      };
    }
  }

  // Fallback tab-separated response shape:
  // { status: "SUCCESS", response: "Gemini Models\tWeekly Limit Remaining\t97%\t2026-...\n..." }
  if (typeof payload.response === "string" && payload.response.trim()) {
    const rawLines = payload.response.trim().split(/\r?\n/).filter(Boolean);
    const parsedRows = rawLines.map((line) => line.split("\t").map((s) => s.trim()));
    const records = [];
    const detailLines = [];

    for (const cols of parsedRows) {
      if (cols.length >= 3) {
        const [group, metric, pct] = cols;
        detailLines.push(`${group} · ${metric}: ${pct}`);
        records.push({ group, windowText: metric, pct });
      } else {
        detailLines.push(cols.join(" "));
      }
    }

    return {
      badge: selectQuotaBadge(records, detailLines[0]),
      lines: detailLines,
    };
  }

  if (typeof payload.text === "string" && payload.text.trim()) {
    const first = payload.text.trim().split("\n")[0];
    return { badge: first.slice(0, 40), lines: [first] };
  }
  return null;
}
