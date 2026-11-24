#!/usr/bin/env node
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const READ_ONLY_TOOLS = new Set([
  "view_file",
  "list_dir",
  "find_by_name",
  "grep_search",
  "list_permissions",
  "list_resources",
  "list_plugin_accounts",
  "list_browser_pages",
  "read_browser_page",
  "list_network_requests",
  "browser_get_dom",
  "browser_get_network_request",
  "command_status",
  "wait",
  "wait_5_seconds",
  "enter_plan_mode",
  "exit_plan_mode",
  "finish",
  "search_marketplace",
  "manage_inbox",
  "ask_question",
  "search_web",
]);

const EDIT_TOOLS = new Set([
  "write_to_file",
  "replace_file_content",
  "multi_replace_file_content",
  "sed_file",
  "notebook_edit",
]);

const AUTO_DELEGATE_TOOLS = new Set([
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "send_message",
  "run_workflow",
  "manage_task",
  "schedule",
  "read_url_content",
]);

const RISKY_COMMAND_RE =
  /\b(rm\s+-[^\s]*r[^\s]*f|\bsudo\b|git\s+push|git\s+reset\s+--hard|git\s+clean\s+-[^\s]*f|chmod\b|chown\b|mkfs\b|dd\s+if=|shutdown\b|reboot\b|kill\s+-9|pkill\b|killall\b)|(\bcurl\b|\bwget\b)[^|\n]*\|\s*(ba|z|da)?sh\b/i;

export function extractTargetPath(args = {}) {
  if (!args || typeof args !== "object") return "";
  return String(
    args.TargetFile ||
      args.AbsolutePath ||
      args.Path ||
      args.path ||
      args.NotebookPath ||
      args.FilePath ||
      "",
  ).trim();
}

export function isPathInsideWorkspaces(targetPath, cwd, workspacePaths = []) {
  if (!targetPath) return true;
  const roots = [cwd, ...(Array.isArray(workspacePaths) ? workspacePaths : [])].filter(Boolean);
  if (roots.length === 0) return false;
  const resolvedTarget = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd || roots[0], targetPath);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    const rel = path.relative(resolvedRoot, resolvedTarget);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

/**
 * Decides whether a PreToolUse event can be resolved immediately or must prompt
 * the user through lucid's interactive PermissionBridgeServer.
 *
 * Returns `{ immediate: true, response }` or `{ immediate: false }`.
 */
export function evaluateHookPolicy(payload, env = process.env) {
  const sockPath = String(env.LUCID_PERM_SOCK || "").trim();
  if (!sockPath) {
    return { immediate: true, response: { decision: "allow" } };
  }

  const mode = String(env.LUCID_PERM_MODE || "default").trim().toLowerCase();
  const toolName = String(payload?.toolCall?.name || "").trim();
  const args = payload?.toolCall?.args && typeof payload.toolCall.args === "object" ? payload.toolCall.args : {};
  const cwd = String(payload?.cwd || "");
  const workspacePaths = Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [];

  if (!toolName || READ_ONLY_TOOLS.has(toolName)) {
    return { immediate: true, response: { decision: "allow" } };
  }

  if (mode === "bypass") {
    return { immediate: true, response: { decision: "allow" } };
  }

  if (mode === "plan") {
    return { immediate: true, response: { decision: "allow" } };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const targetPath = extractTargetPath(args);
    const inWorkspace = isPathInsideWorkspaces(targetPath, cwd, workspacePaths);
    if ((mode === "accept-edits" || mode === "auto") && inWorkspace) {
      return { immediate: true, response: { decision: "auto_approve" } };
    }
    return { immediate: false };
  }

  if (toolName === "run_command") {
    if (mode === "auto") {
      const cmd = String(args.CommandLine || args.command || "");
      const cmdCwd = String(args.Cwd || args.cwd || "");
      const cwdSafe = !cmdCwd || isPathInsideWorkspaces(cmdCwd, cwd, workspacePaths);
      if (cwdSafe && !RISKY_COMMAND_RE.test(cmd)) {
        return { immediate: true, response: { decision: "allow" } };
      }
    }
    return { immediate: false };
  }

  if (AUTO_DELEGATE_TOOLS.has(toolName)) {
    if (mode === "auto") {
      return { immediate: true, response: { decision: "allow" } };
    }
    if (toolName === "invoke_subagent" || toolName === "define_subagent" || toolName === "manage_subagents" || toolName === "send_message") {
      return { immediate: true, response: { decision: "allow" } };
    }
  }

  return { immediate: false };
}

export function queryPermissionBridge(socketPath, payload, timeoutMs = 590000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (resp) => {
      if (settled) return;
      settled = true;
      resolve(resp);
    };

    const socket = net.createConnection(socketPath);
    socket.setEncoding("utf8");

    const timer = setTimeout(() => {
      socket.destroy();
      finish({ decision: "deny", reason: "Timed out waiting for lucid permission response" });
    }, timeoutMs);
    timer.unref?.();

    let buf = "";
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(payload)}\n`);
      } catch {
        clearTimeout(timer);
        finish({ decision: "deny", reason: "Failed to write to lucid permission bridge" });
      }
    });

    socket.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      clearTimeout(timer);
      socket.end();
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.decision === "string") {
          finish(parsed);
          return;
        }
      } catch {
        // Fall through to fail-safe deny
      }
      finish({ decision: "deny", reason: "Invalid response from lucid permission bridge" });
    });

    socket.on("error", () => {
      clearTimeout(timer);
      finish({ decision: "deny", reason: "Could not reach lucid permission bridge" });
    });

    socket.on("close", () => {
      clearTimeout(timer);
      finish({ decision: "deny", reason: "lucid permission bridge closed before responding" });
    });
  });
}

async function readStdinText() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });
}

async function main() {
  const raw = await readStdinText();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    payload = {};
  }

  const verdict = evaluateHookPolicy(payload, process.env);
  if (verdict.immediate) {
    process.stdout.write(`${JSON.stringify(verdict.response)}\n`);
    return;
  }

  const sockPath = String(process.env.LUCID_PERM_SOCK || "").trim();
  const response = await queryPermissionBridge(sockPath, {
    toolName: String(payload?.toolCall?.name || ""),
    args: payload?.toolCall?.args || {},
    cwd: String(payload?.cwd || ""),
    workspacePaths: Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [],
    modelName: String(payload?.modelName || ""),
    mode: String(process.env.LUCID_PERM_MODE || "default"),
  });
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(() => {
    process.stdout.write('{"decision":"deny","reason":"Permission hook internal error"}\n');
  });
}
