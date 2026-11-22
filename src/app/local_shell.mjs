import { spawn } from "node:child_process";
import { sanitizeUntrustedText } from "../term/unicode.mjs";

const MAX_SHELL_OUTPUT = 256 * 1024;

function sendProcessSignal(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Ignore already-exited child
    }
  }
}

export function runLocalShellCommand(app, command) {
  if (app.activeLocalShell) {
    app.showToast("A local shell command is already running (press Esc or Ctrl+C to stop it)", "error");
    app.scheduleRender(true);
    return;
  }

  const item = {
    type: "shell",
    command,
    cwd: app.cwd,
    status: "running",
    output: "",
    exitCode: null,
    startedAt: Date.now(),
    durationMs: 0,
    _rev: 0,
  };
  app.state.items.push(item);
  app.state.scrollOffset = 0;

  const shellBin = process.env.SHELL || "/bin/bash";
  const child = spawn(shellBin, ["-lc", command], {
    cwd: app.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let truncated = false;
  const appendOutput = (chunk) => {
    if (truncated) return;
    const text = sanitizeUntrustedText(chunk);
    if (!text) return;
    if (item.output.length + text.length > MAX_SHELL_OUTPUT) {
      item.output += text.slice(0, Math.max(0, MAX_SHELL_OUTPUT - item.output.length));
      item.output += "\n… (output truncated at 256 KB)";
      truncated = true;
    } else {
      item.output += text;
    }
    item._rev += 1;
    app.scheduleRender();
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", appendOutput);
  child.stderr?.on("data", appendOutput);

  const record = { child, item, cancelled: false, settled: false, exitTimer: null, killTimer: null };
  app.activeLocalShell = record;

  const finish = (status, code) => {
    if (record.settled) return;
    record.settled = true;
    if (record.exitTimer) {
      clearTimeout(record.exitTimer);
      record.exitTimer = null;
    }
    if (record.killTimer) {
      clearTimeout(record.killTimer);
      record.killTimer = null;
    }
    if (app.activeLocalShell === record) {
      app.activeLocalShell = null;
    }
    item.durationMs = Date.now() - item.startedAt;
    item.status = status;
    item.exitCode = code;
    item._rev += 1;
    app.scheduleRender(true);
  };

  child.on("error", (err) => {
    const msg = sanitizeUntrustedText(err?.message || String(err));
    item.output = item.output ? `${item.output}\n${msg}` : msg;
    finish("failed", 1);
  });

  child.on("exit", (code) => {
    if (record.settled || record.exitTimer) return;
    // Fallback when a backgrounded descendant holds stdout/stderr open after shell exits.
    record.exitTimer = setTimeout(() => {
      const status = record.cancelled ? "cancelled" : code === 0 ? "completed" : "failed";
      finish(status, record.cancelled ? null : typeof code === "number" ? code : 1);
    }, 500);
    record.exitTimer.unref();
  });

  child.on("close", (code) => {
    if (record.cancelled) {
      finish("cancelled", null);
    } else {
      const exitCode = typeof code === "number" ? code : 1;
      finish(exitCode === 0 ? "completed" : "failed", exitCode);
    }
  });

  app.scheduleRender(true);
}

export function cancelLocalShell(app, { force = false } = {}) {
  const active = app.activeLocalShell;
  if (!active) return;
  active.cancelled = true;
  if (force) {
    if (active.killTimer) {
      clearTimeout(active.killTimer);
      active.killTimer = null;
    }
    sendProcessSignal(active.child, "SIGKILL");
    return;
  }

  sendProcessSignal(active.child, "SIGTERM");
  if (!active.killTimer) {
    active.killTimer = setTimeout(() => {
      active.killTimer = null;
      if (!active.settled) {
        sendProcessSignal(active.child, "SIGKILL");
      }
    }, 1500);
    active.killTimer.unref();
  }
  app.showToast("Cancelled local shell command");
  app.scheduleRender(true);
}
