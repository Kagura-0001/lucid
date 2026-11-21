import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StdioJsonRpc } from "./jsonrpc.mjs";

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
      this.emit("exit", { code, signal, stderrTail: [...this.stderrTail] });
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

    const initResult = await Promise.race([
      this.rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: {
            name: "lucid",
            version: "0.1.0",
          },
        },
        15000,
      ),
      spawnErrorPromise,
    ]);

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

  async stop(activeSessionId = null) {
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
          }, 1500);
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

export function parseQuotaPayload(payload) {
  if (!payload || typeof payload !== "object") return null;

  // Structured agy -p "/usage" / "/quota" --output-format json shape:
  // { status: "SUCCESS", command: { name: "usage", data: { groups: [{ name, buckets: [...] }] } } }
  const groups = payload.command?.data?.groups;
  if (Array.isArray(groups) && groups.length > 0) {
    let gemini5h = "";
    let geminiWk = "";
    let claude5h = "";
    let claudeWk = "";
    const detailLines = [];

    for (const group of groups) {
      const groupName = String(group?.name || "Models");
      const gLower = groupName.toLowerCase();
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

        const wLower = win.toLowerCase();
        if (gLower.includes("gemini")) {
          if (wLower.includes("5h") || wLower.includes("five")) gemini5h = pct;
          if (wLower.includes("week")) geminiWk = pct;
        } else if (gLower.includes("claude") || gLower.includes("gpt")) {
          if (wLower.includes("5h") || wLower.includes("five")) claude5h = pct;
          if (wLower.includes("week")) claudeWk = pct;
        }
      }
    }

    if (detailLines.length > 0) {
      const badgeParts = [];
      if (gemini5h) badgeParts.push(`5h ${gemini5h}`);
      if (geminiWk) badgeParts.push(`wk ${geminiWk}`);
      if (badgeParts.length === 0 && claude5h) badgeParts.push(`5h ${claude5h}`);
      if (badgeParts.length === 0 && claudeWk) badgeParts.push(`wk ${claudeWk}`);
      return {
        badge: badgeParts.join(" · ") || detailLines[0].slice(0, 40),
        lines: detailLines,
      };
    }
  }

  // Fallback tab-separated response shape:
  // { status: "SUCCESS", response: "Gemini Models\tWeekly Limit Remaining\t97%\t2026-...\n..." }
  if (typeof payload.response === "string" && payload.response.trim()) {
    const rawLines = payload.response.trim().split(/\r?\n/).filter(Boolean);
    const parsedRows = rawLines.map((line) => line.split("\t").map((s) => s.trim()));

    let gemini5h = "";
    let geminiWk = "";
    let claude5h = "";
    let claudeWk = "";
    const detailLines = [];

    for (const cols of parsedRows) {
      if (cols.length >= 3) {
        const [group, metric, pct] = cols;
        detailLines.push(`${group} · ${metric}: ${pct}`);
        const gLower = group.toLowerCase();
        const mLower = metric.toLowerCase();
        if (gLower.includes("gemini")) {
          if (mLower.includes("five hour") || mLower.includes("5")) gemini5h = pct;
          if (mLower.includes("weekly")) geminiWk = pct;
        } else if (gLower.includes("claude") || gLower.includes("gpt")) {
          if (mLower.includes("five hour") || mLower.includes("5")) claude5h = pct;
          if (mLower.includes("weekly")) claudeWk = pct;
        }
      } else {
        detailLines.push(cols.join(" "));
      }
    }

    const badgeParts = [];
    if (gemini5h) badgeParts.push(`5h ${gemini5h}`);
    if (geminiWk) badgeParts.push(`wk ${geminiWk}`);
    if (badgeParts.length === 0 && claude5h) badgeParts.push(`5h ${claude5h}`);
    if (badgeParts.length === 0 && claudeWk) badgeParts.push(`wk ${claudeWk}`);

    return {
      badge: badgeParts.join(" · ") || detailLines[0]?.slice(0, 40) || "",
      lines: detailLines,
    };
  }

  if (typeof payload.text === "string" && payload.text.trim()) {
    const first = payload.text.trim().split("\n")[0];
    return { badge: first.slice(0, 40), lines: [first] };
  }
  return null;
}
