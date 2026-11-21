import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getConfigDir } from "../config.mjs";

const MAX_UNIX_SOCKET_PATH_BYTES = 96;

export function getBgDir() {
  return path.join(getConfigDir(), "bg");
}

export function generateHostId() {
  return crypto.randomBytes(4).toString("hex");
}

export function resolveSocketPath(hostId, bgDir = getBgDir()) {
  const preferred = path.join(bgDir, `${hostId}.sock`);
  if (Buffer.byteLength(preferred, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "u";
  return path.join(os.tmpdir(), `lucid-bg-${uid}-${hostId}.sock`);
}

export function getMetaPath(hostId, bgDir = getBgDir()) {
  return path.join(bgDir, `${hostId}.json`);
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

export function writeBgMeta(meta, bgDir = getBgDir()) {
  fs.mkdirSync(bgDir, { recursive: true });
  const target = getMetaPath(meta.hostId, bgDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, target);
}

export function removeBgFiles(hostId, socketPath = "", bgDir = getBgDir()) {
  const metaPath = getMetaPath(hostId, bgDir);
  const sock = socketPath || resolveSocketPath(hostId, bgDir);
  for (const filePath of [metaPath, sock]) {
    if (!filePath) continue;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already removed
    }
  }
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

const STATUS_PRIORITY = {
  waiting_permission: 0,
  running: 1,
  starting: 2,
  done: 3,
  idle: 4,
  error: 5,
};

/**
 * Lists live hosted lucid sessions, automatically pruning stale files whose
 * host process has exited.
 */
export function listLiveBgSessions({ cwd = "", allCwd = false, includeAttached = false, excludeHostId = "", bgDir = getBgDir() } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(bgDir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const normalizedCwd = cwd ? path.resolve(cwd) : "";
  const live = [];

  for (const name of names) {
    const metaPath = path.join(bgDir, name);
    const meta = readJsonSafe(metaPath);
    if (!meta || !meta.hostId) {
      try {
        fs.unlinkSync(metaPath);
      } catch {
        // Ignore
      }
      continue;
    }

    const alive = isPidAlive(meta.pid) && meta.socketPath && fs.existsSync(meta.socketPath);
    if (!alive) {
      // Give brand-new hosts a brief grace period before treating missing socket as stale.
      const ageMs = Date.now() - (meta.startedAt || 0);
      if (!isPidAlive(meta.pid) || ageMs > 5000) {
        removeBgFiles(meta.hostId, meta.socketPath, bgDir);
      }
      continue;
    }

    if (excludeHostId && meta.hostId === excludeHostId) continue;
    if (!includeAttached && meta.attached && !meta.backgrounded) continue;
    if (!allCwd && normalizedCwd && path.resolve(meta.cwd || "") !== normalizedCwd) continue;

    live.push(meta);
  }

  live.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 9;
    const pb = STATUS_PRIORITY[b.status] ?? 9;
    if (pa !== pb) return pa - pb;
    return (b.updatedAt || b.startedAt || 0) - (a.updatedAt || a.startedAt || 0);
  });

  return live;
}

/**
 * Matches a live hosted session by hostId prefix or ACP sessionId prefix.
 */
export function findLiveBgSession(ref, options = {}) {
  const query = String(ref || "").trim().toLowerCase();
  if (!query) return null;
  const sessions = listLiveBgSessions({ ...options, allCwd: true, includeAttached: true });
  const exact = sessions.find(
    (s) =>
      String(s.hostId || "").toLowerCase() === query ||
      String(s.sessionId || "").toLowerCase() === query,
  );
  if (exact) return exact;
  if (query.length < 3) return null;
  const matches = sessions.filter(
    (s) =>
      String(s.hostId || "").toLowerCase().startsWith(query) ||
      String(s.sessionId || "").toLowerCase().startsWith(query),
  );
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Asks a live background host to shut down cleanly via its Unix socket,
 * falling back to SIGTERM if the socket does not respond.
 */
export function stopBgSession(meta, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!meta || !meta.socketPath) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const socket = net.createConnection(meta.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      if (isPidAlive(meta.pid)) {
        try {
          process.kill(meta.pid, "SIGTERM");
        } catch {
          // Ignore
        }
      }
      removeBgFiles(meta.hostId, meta.socketPath);
      finish(true);
    }, timeoutMs);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: "stop", op: "shutdown" })}\n`);
    });

    socket.on("close", () => {
      clearTimeout(timer);
      finish(true);
    });

    socket.on("error", () => {
      clearTimeout(timer);
      if (isPidAlive(meta.pid)) {
        try {
          process.kill(meta.pid, "SIGTERM");
        } catch {
          // Ignore
        }
      }
      removeBgFiles(meta.hostId, meta.socketPath);
      finish(true);
    });
  });
}
