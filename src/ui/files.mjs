import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "dist",
  "build",
  "target",
  ".next",
  ".cache",
  ".pytest_cache",
  ".ruff_cache",
]);

const MAX_INDEXED_FILES = 6000;
const MAX_TEXT_RESOURCE_BYTES = 128 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB (matches agy 1.5.11 limit)

const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export function isImageFilePath(filePath) {
  return Boolean(getImageMimeType(filePath));
}

export function getImageMimeType(filePath) {
  const ext = path.extname(filePath || "").toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || null;
}

export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * Normalizes a pasted or drag-and-dropped file path from a terminal
 * (handles surrounding quotes, file:// URIs, ~ expansion, and backslash-escaped spaces).
 */
export function normalizeDroppedPath(rawText) {
  let s = String(rawText ?? "").trim();
  if (!s || s.includes("\n")) return null;

  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    s = s.slice(1, -1);
  }
  if (s.startsWith("file://")) {
    try {
      s = decodeURIComponent(new URL(s).pathname);
    } catch {
      s = s.slice("file://".length);
    }
  }
  s = s.replace(/\\([ ()[\]'"])/g, "$1");
  if (s.startsWith("~/")) {
    s = path.join(os.homedir(), s.slice(2));
  }
  return s;
}

/**
 * Loads an image from disk and returns a structured attachment object ready for ACP `image` blocks.
 */
export function loadImageAttachment(inputPath, cwd) {
  const normalized = normalizeDroppedPath(inputPath);
  if (!normalized) {
    throw new Error("Invalid image path.");
  }
  const absPath = path.resolve(cwd, normalized);
  const mimeType = getImageMimeType(absPath);
  if (!mimeType) {
    throw new Error(`Unsupported image extension: ${path.basename(absPath)} (supported: png, jpg, jpeg, webp, gif)`);
  }

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    throw new Error(`Image file not found: ${absPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${absPath}`);
  }
  if (stat.size === 0) {
    throw new Error(`Image file is empty: ${absPath}`);
  }
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds 20 MB limit (${formatBytes(stat.size)}): ${path.basename(absPath)}`);
  }

  const buf = fs.readFileSync(absPath);
  return {
    path: absPath,
    label: path.basename(absPath),
    mimeType,
    sizeBytes: stat.size,
    data: buf.toString("base64"),
  };
}

/**
 * Checks whether a pasted string is a single path pointing to an existing image file.
 */
export function tryLoadDroppedImage(pastedText, cwd) {
  const normalized = normalizeDroppedPath(pastedText);
  if (!normalized || !isImageFilePath(normalized)) return null;
  try {
    return loadImageAttachment(normalized, cwd);
  } catch {
    return null;
  }
}

function parseClipboardImageBuffer(buf, requirePngSig = false) {
  if (!buf || buf.length < 16 || buf.length > MAX_IMAGE_BYTES) return null;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (requirePngSig && !isPng) return null;
  if (!isPng && !isJpeg) return null;

  const mimeType = isPng ? "image/png" : "image/jpeg";
  const ext = isPng ? "png" : "jpg";
  return {
    path: null,
    label: `clipboard-${Date.now().toString().slice(-4)}.${ext}`,
    mimeType,
    sizeBytes: buf.length,
    data: buf.toString("base64"),
  };
}

function getClipboardImageProbes() {
  if (process.platform === "darwin") {
    return [{ cmd: "pngpaste", args: ["-"] }];
  }
  // Over headless SSH without X11/Wayland, probing clipboard tools can block or fail.
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    return [];
  }
  return [
    { cmd: "wl-paste", args: ["--type", "image/png"] },
    { cmd: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] },
    { cmd: "xsel", args: ["--clipboard", "--output"], requirePngSig: true },
  ];
}

/**
 * Best-effort local clipboard image capture (Wayland wl-paste, X11 xclip, macOS pngpaste).
 * Returns an image attachment object or null when no local clipboard image is available.
 */
export function tryReadClipboardImage() {
  for (const probe of getClipboardImageProbes()) {
    try {
      const res = spawnSync(probe.cmd, probe.args, {
        encoding: null,
        maxBuffer: MAX_IMAGE_BYTES,
        timeout: 2000,
      });
      if (res.status !== 0) continue;
      const parsed = parseClipboardImageBuffer(res.stdout, probe.requirePngSig);
      if (parsed) return parsed;
    } catch {
      // Try next clipboard utility
    }
  }
  return null;
}

/**
 * Non-blocking version of tryReadClipboardImage so pressing Ctrl+V never freezes
 * the TUI event loop.
 */
export async function tryReadClipboardImageAsync() {
  for (const probe of getClipboardImageProbes()) {
    const parsed = await new Promise((resolve) => {
      try {
        execFile(
          probe.cmd,
          probe.args,
          { encoding: "buffer", maxBuffer: MAX_IMAGE_BYTES, timeout: 2000 },
          (err, stdout) => {
            if (err) {
              resolve(null);
              return;
            }
            resolve(parseClipboardImageBuffer(stdout, probe.requirePngSig));
          },
        );
      } catch {
        resolve(null);
      }
    });
    if (parsed) return parsed;
  }
  return null;
}

export class WorkspaceFileIndex {
  constructor(cwd) {
    this.cwd = cwd;
    this.files = [];
    this.loaded = false;
    this.loading = false;
  }

  refresh() {
    if (this.loading) return;
    this.loading = true;

    execFile(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: this.cwd, maxBuffer: 8 * 1024 * 1024, timeout: 4000 },
      (err, stdout) => {
        if (!err && stdout) {
          this.files = stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(0, MAX_INDEXED_FILES);
          this.loaded = true;
          this.loading = false;
          return;
        }
        walkDirectoryAsync(this.cwd, MAX_INDEXED_FILES)
          .then((walked) => {
            this.files = walked;
          })
          .catch(() => {
            this.files = [];
          })
          .finally(() => {
            this.loaded = true;
            this.loading = false;
          });
      },
    );
  }

  search(query, limit = 8) {
    if (!this.loaded && !this.loading) {
      this.refresh();
    }
    const q = (query || "").trim().toLowerCase();
    if (!q) {
      return this.files.slice(0, limit);
    }

    const scored = [];
    for (const filePath of this.files) {
      const score = scoreFileMatch(filePath, q);
      if (score > 0) {
        scored.push({ filePath, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.filePath.length - b.filePath.length);
    return scored.slice(0, limit).map((item) => item.filePath);
  }
}

async function walkDirectoryAsync(rootDir, maxCount) {
  const results = [];
  const queue = [""];

  while (queue.length > 0 && results.length < maxCount) {
    const relDir = queue.shift();
    const absDir = relDir ? path.join(rootDir, relDir) : rootDir;
    let entries;
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (results.length >= maxCount) break;
      if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          queue.push(relDir ? `${relDir}/${entry.name}` : entry.name);
        }
      } else if (entry.isFile()) {
        results.push(relDir ? `${relDir}/${entry.name}` : entry.name);
      }
    }
  }
  return results;
}

function scoreFileMatch(filePath, lowerQuery) {
  const lowerPath = filePath.toLowerCase();
  const baseName = path.basename(lowerPath);

  if (baseName === lowerQuery) return 1000;
  if (baseName.startsWith(lowerQuery)) return 800;
  if (lowerPath.includes(`/${lowerQuery}`)) return 650;
  if (lowerPath.includes(lowerQuery)) return 500;

  let qi = 0;
  let consecutive = 0;
  let bonus = 0;
  for (let i = 0; i < lowerPath.length && qi < lowerQuery.length; i += 1) {
    if (lowerPath[i] === lowerQuery[qi]) {
      qi += 1;
      consecutive += 1;
      bonus += consecutive * 3;
    } else {
      consecutive = 0;
    }
  }
  if (qi === lowerQuery.length) {
    return 100 + bonus;
  }
  return 0;
}

function guessMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".ts": "text/typescript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".rs": "text/x-rust",
    ".go": "text/x-go",
    ".json": "application/json",
    ".md": "text/markdown",
    ".sh": "text/x-shellscript",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".toml": "text/plain",
    ".html": "text/html",
    ".css": "text/css",
  };
  return map[ext] || "text/plain";
}

function isPathWithinDir(targetPath, baseDir) {
  try {
    const resolvedBase = fs.realpathSync(path.resolve(baseDir || process.cwd()));
    const resolvedTarget = fs.existsSync(targetPath)
      ? fs.realpathSync(targetPath)
      : path.resolve(targetPath);
    const basePrefix = resolvedBase.endsWith(path.sep) ? resolvedBase : `${resolvedBase}${path.sep}`;
    return resolvedTarget === resolvedBase || resolvedTarget.startsWith(basePrefix);
  } catch {
    return false;
  }
}

/**
 * Builds ACP `session/prompt` content blocks from user text plus staged images.
 */
export function buildPromptBlocks(text, cwd, options = {}) {
  const {
    supportsEmbeddedContext = true,
    supportsImage = true,
    stagedImages = [],
    mentionSourceText = text,
  } = options;

  const blocks = [];
  const attachedPaths = [];
  const attachedImages = [];

  if (text && text.length > 0) {
    blocks.push({ type: "text", text });
  }

  const appendImageBlock = (img, labelOverride) => {
    if (!img || !img.data || !img.mimeType) return;
    blocks.push({ type: "image", mimeType: img.mimeType, data: img.data });
    attachedImages.push({
      label: labelOverride || img.label,
      sizeBytes: img.sizeBytes,
      mimeType: img.mimeType,
    });
  };

  if (supportsImage && Array.isArray(stagedImages)) {
    for (const img of stagedImages) {
      appendImageBlock(img);
    }
  }

  const mentionRegex = /(?:^|\s)@([^\s]+)/g;
  const seen = new Set();
  let match;

  while ((match = mentionRegex.exec(mentionSourceText || "")) !== null) {
    const rawMention = match[1].replace(/[),.;:!?]+$/, "");
    if (!rawMention || seen.has(rawMention)) continue;
    seen.add(rawMention);

    const normalized = normalizeDroppedPath(rawMention);
    if (!normalized) continue;
    const absPath = path.resolve(cwd, normalized);
    if (!isPathWithinDir(absPath, cwd)) continue;

    if (isImageFilePath(absPath)) {
      if (!supportsImage) continue;
      try {
        appendImageBlock(loadImageAttachment(absPath, cwd), rawMention);
      } catch {
        // Ignore unreadable or oversized image mention
      }
      continue;
    }

    if (!supportsEmbeddedContext) continue;

    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_TEXT_RESOURCE_BYTES) continue;

    try {
      const buf = fs.readFileSync(absPath);
      if (buf.includes(0)) continue;
      blocks.push({
        type: "resource",
        resource: {
          uri: `file://${absPath}`,
          mimeType: guessMimeType(absPath),
          text: buf.toString("utf8"),
        },
      });
      attachedPaths.push(rawMention);
    } catch {
      // Ignore unreadable files
    }
  }

  if (!text && blocks.length > 0) {
    blocks.unshift({ type: "text", text: "Please inspect the attached image(s)." });
  }

  return { blocks, attachedPaths, attachedImages };
}
