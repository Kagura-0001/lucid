import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { getConfigDir, writeJsonAtomic } from "../config.mjs";
import { matchByIdOrPrefix } from "./protocol.mjs";

const MAX_UNIX_SOCKET_PATH_BYTES = 96;

export function getBgDir() {
  return path.join(getConfigDir(), "bg");
}

export function generateHostId() {
  return crypto.randomBytes(6).toString("hex");
}

/**
 * Ensures a directory exists with private 0700 permissions and is owned by the
 * current user (not a symlink or shared writable directory).
 */
export function ensureSecureBgDir(dirPath = getBgDir()) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe lucid runtime directory: ${dirPath}`);
  }
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw new Error(`Refusing directory not owned by current user: ${dirPath}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      fs.chmodSync(dirPath, 0o700);
      const verified = fs.lstatSync(dirPath);
      if ((verified.mode & 0o077) !== 0) {
        throw new Error(`Unable to enforce private permissions on ${dirPath}`);
      }
    }
  }
  return dirPath;
}

/**
 * Verifies a Unix domain socket path is owned by the current user and is not a symlink.
 */
export function verifySocketOwnership(socketPath) {
  if (!socketPath) return false;
  try {
    const stat = fs.lstatSync(socketPath);
    if (stat.isSymbolicLink()) return false;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function resolveSocketPath(hostId, bgDir = getBgDir()) {
  const preferred = path.join(bgDir, `${hostId}.sock`);
  if (Buffer.byteLength(preferred, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : "u";
  const runtimeRoot = process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.trim();
  const fallbackDir = runtimeRoot
    ? path.join(runtimeRoot, "lucid")
    : path.join(os.tmpdir(), `lucid-bg-${uid}`);
  ensureSecureBgDir(fallbackDir);
  return path.join(fallbackDir, `${hostId}.sock`);
}

export function getMetaPath(hostId, bgDir = getBgDir()) {
  return path.join(bgDir, `${hostId}.json`);
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function terminatePid(pid) {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore
  }
}

export function writeBgMeta(meta, bgDir = getBgDir()) {
  writeJsonAtomic(getMetaPath(meta.hostId, bgDir), meta, { ensureDir: ensureSecureBgDir });
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
const META_FILENAME_RE = /^[0-9a-f]+\.json$/i;

export function listLiveBgSessions({ cwd = "", allCwd = false, includeAttached = false, excludeHostId = "", bgDir = getBgDir() } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(bgDir).filter((name) => META_FILENAME_RE.test(name));
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

    const pidAlive = isPidAlive(meta.pid);
    const alive = pidAlive && meta.socketPath && verifySocketOwnership(meta.socketPath);
    if (!alive) {
      // Give starting hosts up to 25s (and non-starting up to 5s) before pruning missing socket.
      const ageMs = Date.now() - (meta.startedAt || 0);
      const staleStarting = meta.status === "starting" ? ageMs > 25000 : ageMs > 5000;
      if (!pidAlive || staleStarting) {
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
  const sessions = listLiveBgSessions({ ...options, allCwd: true, includeAttached: true });
  return matchByIdOrPrefix(sessions, ref, (s) => [s.hostId, s.sessionId], 3);
}

/**
 * Asks a live background host to shut down cleanly via its Unix socket,
 * falling back to SIGTERM if the socket does not respond.
 */
export function stopBgSession(meta, timeoutMs = 4000, bgDir = getBgDir()) {
  return new Promise((resolve) => {
    if (!meta || !meta.socketPath || !verifySocketOwnership(meta.socketPath)) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const killAndClean = () => {
      terminatePid(meta.pid);
      removeBgFiles(meta.hostId, meta.socketPath, bgDir);
      finish(true);
    };

    const socket = net.createConnection(meta.socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      killAndClean();
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
      killAndClean();
    });
  });
}
