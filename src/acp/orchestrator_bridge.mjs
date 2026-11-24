import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../config.mjs";
import { ensureSecureBgDir, getBgDir } from "./bg_registry.mjs";
import { createLineSplitter, parseJsonObjectLine } from "./protocol.mjs";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PERM_HOOK_SCRIPT_PATH = path.resolve(THIS_DIR, "perm_hook.mjs");
export const LUCID_HOOK_NAME = "lucid-permission-bridge";

// Only match tools that can mutate files/state, execute commands, or hit external
// MCP/web/browser surfaces. Read-only tools (view_file, grep_search, list_dir,
// find_by_name, exit_plan_mode, subagents, etc.) never spawn a hook subprocess.
export const PERM_HOOK_MATCHER = [
  "run_command",
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
  "notebook_execution",
  "call_mcp_tool",
  "read_url_content",
  "execute_browser_javascript",
  "open_browser_url",
  "click_browser_pixel",
  "browser_click_element",
  "browser_input",
  "browser_press_key",
  "browser_drag_pixel_to_pixel",
  "browser_select_option",
  "delete_knowledge",
  "manage_task",
  "schedule",
].join("|");

const MAX_UNIX_SOCKET_PATH_BYTES = 96;

export function getAgyHooksPath(geminiDir = "") {
  const base = geminiDir
    ? path.isAbsolute(geminiDir)
      ? geminiDir
      : path.join(os.homedir(), geminiDir)
    : path.join(os.homedir(), ".gemini");
  return path.join(base, "config", "hooks.json");
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function buildPermissionHookCommand(nodePath = process.execPath, hookScriptPath = PERM_HOOK_SCRIPT_PATH) {
  const execLine = `exec ${shellSingleQuote(nodePath)} ${shellSingleQuote(hookScriptPath)}`;
  const script = `if [ -z "$LUCID_PERM_SOCK" ]; then printf '{"decision":"allow"}\\n'; exit 0; fi; ${execLine}`;
  return `sh -c ${shellSingleQuote(script)}`;
}

/**
 * Ensures the env-gated PreToolUse hook entry exists in Antigravity's
 * `~/.gemini/config/hooks.json` without disturbing any existing hooks.
 * When `LUCID_PERM_SOCK` is unset (normal `agy` runs), the hook exits in ~1ms
 * with `{"decision":"allow"}` and delegates cleanly to agy's default policy.
 */
export function ensureLucidPermissionHook({
  hooksPath = getAgyHooksPath(),
  nodePath = process.execPath,
  hookScriptPath = PERM_HOOK_SCRIPT_PATH,
} = {}) {
  const desiredCommand = buildPermissionHookCommand(nodePath, hookScriptPath);
  const desiredEntry = {
    PreToolUse: [
      {
        matcher: PERM_HOOK_MATCHER,
        hooks: [
          {
            type: "command",
            command: desiredCommand,
            timeout: 600,
          },
        ],
      },
    ],
  };

  let existing = {};
  if (fs.existsSync(hooksPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, error: `${hooksPath} is not a JSON object` };
      }
      existing = parsed;
    } catch (err) {
      return { ok: false, error: `Could not parse ${hooksPath}: ${err.message}` };
    }
  }

  const currentRule = existing[LUCID_HOOK_NAME]?.PreToolUse?.[0];
  const currentCmd = currentRule?.hooks?.[0]?.command;
  if (currentRule?.matcher === PERM_HOOK_MATCHER && currentCmd === desiredCommand) {
    return { ok: true, updated: false, hooksPath };
  }

  const next = {
    ...existing,
    [LUCID_HOOK_NAME]: desiredEntry,
  };
  try {
    writeJsonAtomic(hooksPath, next);
    return { ok: true, updated: true, hooksPath };
  } catch (err) {
    return { ok: false, error: `Could not update ${hooksPath}: ${err.message}` };
  }
}

function inferToolKind(toolName) {
  if (toolName === "run_command") return "execute";
  if (
    toolName === "write_to_file" ||
    toolName === "replace_file_content" ||
    toolName === "multi_replace_file_content" ||
    toolName === "sed_file" ||
    toolName === "notebook_edit"
  ) {
    return "edit";
  }
  if (toolName === "read_url_content" || toolName === "search_web") return "fetch";
  return "other";
}

function describePermissionRequest(toolName, args = {}) {
  if (toolName === "run_command") {
    const cmd = String(args.CommandLine || args.command || "").trim();
    const firstWord = cmd.split(/\s+/)[0] || "command";
    return {
      title: `Run command: ${cmd.split(/\r?\n/)[0].slice(0, 72) || "(empty)"}`,
      description: args.Cwd ? `cwd: ${args.Cwd}` : "",
      grantKey: `run_command:${firstWord}`,
      grantLabel: `\`${firstWord}\` commands`,
    };
  }
  const targetFile = String(args.TargetFile || args.AbsolutePath || args.Path || args.path || "").trim();
  if (targetFile) {
    return {
      title: `${toolName}: ${targetFile}`,
      description: String(args.Description || args.Instruction || "").slice(0, 120),
      grantKey: `tool:${toolName}`,
      grantLabel: toolName,
    };
  }
  return {
    title: `Approve tool: ${toolName}`,
    description: "",
    grantKey: `tool:${toolName}`,
    grantLabel: toolName,
  };
}

function resolveBridgeSocketPath(bgDir) {
  const id = crypto.randomBytes(6).toString("hex");
  const preferred = path.join(bgDir, `perm-${id}.sock`);
  if (Buffer.byteLength(preferred, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return preferred;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const fallbackDir = path.join(os.tmpdir(), `lucid-bg-${uid}`);
  ensureSecureBgDir(fallbackDir);
  return path.join(fallbackDir, `p-${id}.sock`);
}

/**
 * Local Unix domain socket server that bridges Antigravity `PreToolUse` hook
 * invocations into standard ACP-shaped `permissionRequest` events for lucid's
 * interactive permission modal.
 */
export class PermissionBridgeServer extends EventEmitter {
  constructor({ bgDir = getBgDir(), bypassPermissions = false } = {}) {
    super();
    this.bgDir = bgDir;
    this.bypassPermissions = Boolean(bypassPermissions);
    this.socketPath = "";
    this.server = null;
    this.sessionGrants = new Set();
    this.pending = new Set();
  }

  async start() {
    if (this.server) return this.socketPath;
    ensureSecureBgDir(this.bgDir);
    this.socketPath = resolveBridgeSocketPath(this.bgDir);
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore
    }

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

    return this.socketPath;
  }

  setBypassPermissions(enabled) {
    this.bypassPermissions = Boolean(enabled);
    if (this.bypassPermissions) {
      for (const entry of [...this.pending]) {
        entry.selectOption("allow_once");
      }
    }
  }

  cancelAll(reason = "Turn cancelled") {
    for (const entry of [...this.pending]) {
      entry.respond({ decision: "deny", reason });
    }
  }

  handleConnection(socket) {
    socket.setEncoding("utf8");
    let handled = false;

    const sendResponse = (obj) => {
      if (socket.destroyed) return;
      try {
        socket.end(`${JSON.stringify(obj)}\n`);
      } catch {
        // Ignore broken socket
      }
    };

    const feed = createLineSplitter((line) => {
      if (handled) return;
      const msg = parseJsonObjectLine(line);
      if (!msg) return;
      handled = true;

      const toolName = String(msg.toolName || "tool");
      const args = msg.args && typeof msg.args === "object" ? msg.args : {};
      const info = describePermissionRequest(toolName, args);

      if (this.bypassPermissions || this.sessionGrants.has(info.grantKey)) {
        sendResponse({ decision: "auto_approve" });
        return;
      }

      if (this.listenerCount("permissionRequest") === 0) {
        sendResponse({ decision: "deny", reason: "No interactive permission handler attached" });
        return;
      }

      let settled = false;
      const entry = {
        respond: (payload) => {
          if (settled) return;
          settled = true;
          this.pending.delete(entry);
          sendResponse(payload);
        },
        selectOption: (optionId) => {
          if (optionId === "allow_always") {
            this.sessionGrants.add(info.grantKey);
            entry.respond({ decision: "auto_approve" });
          } else if (optionId === "allow_once") {
            entry.respond({ decision: "auto_approve" });
          } else {
            entry.respond({ decision: "deny", reason: "Denied by user in lucid" });
          }
        },
        cancel: () => {
          entry.respond({ decision: "deny", reason: "Cancelled by user in lucid" });
        },
      };

      this.pending.add(entry);
      socket.once("close", () => {
        if (!settled) {
          settled = true;
          this.pending.delete(entry);
        }
      });

      this.emit("permissionRequest", {
        params: {
          title: info.title,
          description: info.description,
          toolCall: {
            title: info.title,
            kind: inferToolKind(toolName),
            rawInput: args,
          },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "allow_always", name: `Allow ${info.grantLabel} for this session`, kind: "allow_always" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
          ],
        },
        selectOption: entry.selectOption,
        cancel: entry.cancel,
      });
    });

    socket.on("data", feed);
    socket.on("error", () => {
      // Handled on close
    });
  }

  async stop() {
    this.cancelAll("Permission bridge stopped");
    const srv = this.server;
    this.server = null;
    if (srv) {
      await new Promise((resolve) => srv.close(() => resolve()));
    }
    if (this.socketPath) {
      try {
        fs.unlinkSync(this.socketPath);
      } catch {
        // Ignore
      }
      this.socketPath = "";
    }
  }
}
