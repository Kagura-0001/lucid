import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { getBgDir } from "./bg_registry.mjs";
import { ensureLucidPermissionHook, PermissionBridgeServer } from "./orchestrator_bridge.mjs";
import { createLineSplitter, parseJsonObjectLine } from "./protocol.mjs";

const DEFAULT_CONTEXT_WINDOW = 1_000_000;

function inferToolKind(toolName) {
  switch (toolName) {
    case "run_command":
      return "execute";
    case "view_file":
    case "list_dir":
    case "find_by_name":
    case "grep_search":
      return "read";
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
    case "notebook_edit":
      return "edit";
    case "search_web":
    case "read_url_content":
      return "fetch";
    default:
      return "other";
  }
}

function buildToolTitle(toolName, params = {}) {
  if (toolName === "run_command") {
    const cmd = String(params.CommandLine || params.command || "").split(/\r?\n/)[0].trim();
    return cmd ? `$ ${cmd}` : "run_command";
  }
  const filePath = String(params.TargetFile || params.AbsolutePath || params.Path || params.DirectoryPath || "").trim();
  if (filePath) {
    return `${toolName} ${filePath}`;
  }
  if (toolName === "exit_plan_mode") return "Hand off plan to Executor";
  if (toolName === "enter_plan_mode") return "Return to Planner";
  return toolName || "Tool";
}

function synthesizeToolDiffs(toolName, params = {}) {
  if (!params || typeof params !== "object") return [];
  const filePath = String(params.TargetFile || params.Path || params.AbsolutePath || "").trim();
  if (!filePath) return [];

  if (toolName === "replace_file_content") {
    if (typeof params.TargetContent === "string" || typeof params.ReplacementContent === "string") {
      return [
        {
          type: "diff",
          path: filePath,
          oldText: String(params.TargetContent || ""),
          newText: String(params.ReplacementContent || ""),
        },
      ];
    }
  } else if (toolName === "multi_replace_file_content" && Array.isArray(params.ReplacementChunks)) {
    const oldParts = [];
    const newParts = [];
    for (const chunk of params.ReplacementChunks) {
      if (!chunk || typeof chunk !== "object") continue;
      oldParts.push(String(chunk.TargetContent || ""));
      newParts.push(String(chunk.ReplacementContent || ""));
    }
    if (oldParts.length > 0 || newParts.length > 0) {
      return [
        {
          type: "diff",
          path: filePath,
          oldText: oldParts.join("\n...\n"),
          newText: newParts.join("\n...\n"),
        },
      ];
    }
  } else if (toolName === "write_to_file" && typeof params.CodeContent === "string") {
    return [
      {
        type: "diff",
        path: filePath,
        oldText: "",
        newText: params.CodeContent,
      },
    ];
  }
  return [];
}

/**
 * Serializes ACP prompt blocks into plain text accepted by agy's
 * `--input-format stream-json` (which only accepts text content blocks).
 */
export function serializeBlocksForStreamJson(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource" && block.resource?.text) {
      const uri = block.resource.uri || "file";
      parts.push(`[Attached resource: ${uri}]\n${block.resource.text}`);
    } else if (block.type === "image") {
      const hint = block.path || block.uri || "";
      parts.push(
        hint
          ? `[Attached image: ${hint} — inspect with view_file if needed]`
          : "[Image attachment omitted: stream-json mode accepts text or file paths]",
      );
    }
  }
  return parts.join("\n\n").trim();
}

const TRANSCRIPT_THINKING_TAIL_BYTES = 256 * 1024;

function readTailUtf8(filePath, maxBytes) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return "";
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore
      }
    }
  }
}

function readTranscriptStepThinking(dataDir, sessionId, stepIndex) {
  if (!dataDir || !sessionId || typeof stepIndex !== "number") return null;
  const transcriptPath = path.join(dataDir, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
  try {
    const text = readTailUtf8(transcriptPath, TRANSCRIPT_THINKING_TAIL_BYTES);
    if (!text) return null;
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line || !line.includes(`"step_index":${stepIndex}`)) continue;
      const parsed = JSON.parse(line);
      if (parsed && parsed.step_index === stepIndex) {
        return {
          thinking: typeof parsed.thinking === "string" ? parsed.thinking.trim() : "",
          model: typeof parsed.model === "string" ? parsed.model : "",
        };
      }
    }
  } catch {
    // Best-effort thought recovery from on-disk transcript
  }
  return null;
}

/**
 * Drives Antigravity CLI's `--input-format stream-json --output-format stream-json`
 * channel with `--settings '{"orchestrator":{"planner":...,"executor":...}}'` so
 * lucid can execute custom Orchestrator Planner/Executor models and thinking
 * efforts while preserving interactive tool permission modals via `PreToolUse`.
 */
export class OrchestratorStreamClient extends EventEmitter {
  constructor({
    command = "agy",
    cwd = process.cwd(),
    addDirs = [],
    dataDir = "",
    bgDir = getBgDir(),
    hooksPath = undefined,
    skipHookInstall = false,
    spawnFn = spawn,
  } = {}) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.addDirs = Array.isArray(addDirs) ? [...addDirs] : [];
    this.dataDir = dataDir;
    this.bgDir = bgDir;
    this.hooksPath = hooksPath;
    this.skipHookInstall = Boolean(skipHookInstall);
    this.spawnFn = spawnFn;

    this.sessionId = "";
    this.orchestratorConfig = null; // { modelValue, modelLabel, plannerLabel, executorLabel }
    this.modeId = "auto";
    this.bypassPermissions = false;

    this.child = null;
    this.stopping = false;
    this.needsRestart = false;
    this.activeTurn = null;
    this.stderrTail = [];
    this.emittedThoughtSteps = new Set();
    this.activeToolSteps = new Set();

    this.permissionBridge = new PermissionBridgeServer({ bgDir: this.bgDir });
    this.permissionBridge.on("permissionRequest", (req) => {
      this.emit("permissionRequest", req);
    });
  }

  configure({ sessionId, orchestratorConfig, modeId, bypassPermissions } = {}) {
    let spawnConfigChanged = false;
    if (sessionId !== undefined && sessionId !== this.sessionId) {
      this.sessionId = sessionId;
      spawnConfigChanged = true;
    }
    if (orchestratorConfig !== undefined) {
      const prevKey = JSON.stringify(this.orchestratorConfig);
      const nextKey = JSON.stringify(orchestratorConfig);
      if (prevKey !== nextKey) {
        this.orchestratorConfig = orchestratorConfig ? { ...orchestratorConfig } : null;
        spawnConfigChanged = true;
      }
    }
    if (modeId !== undefined && modeId !== this.modeId) {
      this.modeId = modeId;
      spawnConfigChanged = true;
    }
    if (bypassPermissions !== undefined && Boolean(bypassPermissions) !== this.bypassPermissions) {
      this.bypassPermissions = Boolean(bypassPermissions);
      this.permissionBridge.setBypassPermissions(this.bypassPermissions);
      spawnConfigChanged = true;
    }

    if (spawnConfigChanged && this.child) {
      if (this.activeTurn) {
        this.needsRestart = true;
      } else {
        this.stopChild().catch(() => {});
      }
    }
  }

  buildSpawnArgs() {
    const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
    if (this.sessionId) {
      args.push("--conversation", this.sessionId);
    }
    for (const dir of this.addDirs) {
      if (dir) args.push("--add-dir", dir);
    }

    const effectiveMode = this.bypassPermissions ? "bypass" : String(this.modeId || "auto").toLowerCase();
    if (effectiveMode === "bypass") {
      args.push("--dangerously-skip-permissions");
    } else if (effectiveMode === "auto" || effectiveMode === "accept-edits" || effectiveMode === "plan") {
      args.push("--mode", effectiveMode);
    }

    const settingsObj = {};
    if (this.orchestratorConfig?.modelLabel) {
      settingsObj.model = this.orchestratorConfig.modelLabel;
    }
    if (effectiveMode === "default") {
      settingsObj.agentMode = "";
    }
    if (this.orchestratorConfig?.plannerLabel || this.orchestratorConfig?.executorLabel) {
      settingsObj.orchestrator = {};
      if (this.orchestratorConfig.plannerLabel) {
        settingsObj.orchestrator.planner = this.orchestratorConfig.plannerLabel;
      }
      if (this.orchestratorConfig.executorLabel) {
        settingsObj.orchestrator.executor = this.orchestratorConfig.executorLabel;
      }
    }
    if (Object.keys(settingsObj).length > 0) {
      args.push("--settings", JSON.stringify(settingsObj));
    }

    return args;
  }

  async ensureProcess() {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return;
    }

    this.stopping = false;
    this.needsRestart = false;
    this.stderrTail = [];
    this.emittedThoughtSteps.clear();
    this.activeToolSteps.clear();

    const effectiveMode = this.bypassPermissions ? "bypass" : String(this.modeId || "auto").toLowerCase();
    let permSock = "";
    if (!this.bypassPermissions) {
      if (!this.skipHookInstall) {
        ensureLucidPermissionHook({ hooksPath: this.hooksPath });
      }
      permSock = await this.permissionBridge.start();
    }

    const spawnArgs = this.buildSpawnArgs();
    const env = {
      ...process.env,
      LUCID_PERM_MODE: effectiveMode,
      ...(permSock ? { LUCID_PERM_SOCK: permSock } : {}),
    };
    if (!permSock) {
      delete env.LUCID_PERM_SOCK;
    }

    const child = this.spawnFn(this.command, spawnArgs, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.child = child;

    const feedStdout = createLineSplitter((line) => this.handleStdoutLine(line));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", feedStdout);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 60) this.stderrTail.shift();
      }
      this.emit("stderr", chunk);
    });

    child.on("error", (err) => {
      if (this.child === child) this.child = null;
      this.rejectActiveTurn(new Error(`Failed to launch "${this.command}": ${err.message}`));
    });

    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.activeTurn) {
        if (this.activeTurn.cancelled) {
          this.resolveActiveTurn({ stopReason: "cancelled" });
        } else if (code === 0) {
          this.resolveActiveTurn({ stopReason: "end_turn" });
        } else {
          const tail = this.stderrTail.slice(-3).join(" | ");
          this.rejectActiveTurn(
            new Error(
              `Orchestrator stream exited (code=${code ?? "null"}, signal=${signal ?? "none"})${tail ? `: ${tail}` : ""}`,
            ),
          );
        }
      }
    });
  }

  emitUpdate(update) {
    this.emit("sessionUpdate", {
      sessionId: this.sessionId,
      update,
    });
  }

  handleStdoutLine(line) {
    const msg = parseJsonObjectLine(line);
    if (!msg) return;

    if (msg.event === "init") {
      if (!this.sessionId && msg.conversation_id) {
        this.sessionId = msg.conversation_id;
      }
      return;
    }

    if (msg.event === "step_update" && msg.step_update) {
      this.handleStepUpdate(msg.step_update);
      return;
    }

    if (msg.event === "result" && msg.result) {
      const res = msg.result;
      if (!this.sessionId && res.conversation_id) {
        this.sessionId = res.conversation_id;
      }
      this.emitUsage(res.usage);
      const status = String(res.status || "SUCCESS").toUpperCase();
      if (status === "ERROR") {
        this.rejectActiveTurn(new Error(res.error || "Orchestrator turn failed"));
      } else if (status === "CANCELED" || status === "INTERRUPTED") {
        this.resolveActiveTurn({ stopReason: "cancelled" });
      } else {
        this.resolveActiveTurn({ stopReason: "end_turn" });
      }
    }
  }

  emitUsage(usage) {
    if (!usage || typeof usage !== "object") return;
    const used = (Number(usage.input_tokens) || 0) + (Number(usage.cache_read_tokens) || 0);
    if (used > 0) {
      this.emitUpdate({
        sessionUpdate: "usage_update",
        used,
        size: DEFAULT_CONTEXT_WINDOW,
      });
    }
  }

  handleStepUpdate(step) {
    const stepType = String(step.step_type || "");
    const state = String(step.state || "");
    const stepIdx = typeof step.step_index === "number" ? step.step_index : -1;

    if (step.usage) {
      this.emitUsage(step.usage);
    }

    if (stepType === "agent_response") {
      if (state === "DONE" && stepIdx >= 0 && !this.emittedThoughtSteps.has(stepIdx)) {
        const thinkingTokens = Number(step.usage?.thinking_tokens) || 0;
        if (thinkingTokens > 0) {
          const recovered = readTranscriptStepThinking(this.dataDir, this.sessionId, stepIdx);
          if (recovered?.thinking) {
            this.emittedThoughtSteps.add(stepIdx);
            this.emitUpdate({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: recovered.thinking },
            });
          }
        }
      }
      if (typeof step.text_delta === "string" && step.text_delta.length > 0) {
        this.emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: step.text_delta },
        });
      }
      return;
    }

    if (stepType === "tool") {
      const toolInfo = step.tool_info && typeof step.tool_info === "object" ? step.tool_info : {};
      const toolName = String(step.tool_name || toolInfo.name || "tool");
      const params = toolInfo.parameters && typeof toolInfo.parameters === "object" ? toolInfo.parameters : {};
      const toolCallId = `orch_step_${stepIdx >= 0 ? stepIdx : Date.now()}`;
      const title = buildToolTitle(toolName, params);
      const kind = inferToolKind(toolName);
      const diffs = synthesizeToolDiffs(toolName, params);

      if (state === "ACTIVE" && !this.activeToolSteps.has(toolCallId)) {
        this.activeToolSteps.add(toolCallId);
        this.emitUpdate({
          sessionUpdate: "tool_call",
          toolCallId,
          name: toolName,
          title,
          kind,
          status: "in_progress",
          rawInput: params,
          ...(diffs.length > 0 ? { content: diffs } : {}),
        });
        return;
      }

      if (state === "DONE") {
        const hasError = Boolean(toolInfo.error);
        const outputText = hasError
          ? String(toolInfo.error?.message || toolInfo.error || toolInfo.output || "")
          : String(toolInfo.output || "");
        const content = [...diffs];
        if (outputText) {
          content.push({ type: "text", text: outputText });
        }
        const updateKind = this.activeToolSteps.has(toolCallId) ? "tool_call_update" : "tool_call";
        this.activeToolSteps.delete(toolCallId);
        this.emitUpdate({
          sessionUpdate: updateKind,
          toolCallId,
          name: toolName,
          title,
          kind,
          status: hasError ? "failed" : "completed",
          rawInput: params,
          ...(content.length > 0 ? { content } : {}),
          ...(outputText ? { rawOutput: outputText } : {}),
        });
      }
    }
  }

  resolveActiveTurn(result) {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = null;
    turn.resolve(result);
    if (this.needsRestart) {
      this.needsRestart = false;
      this.stopChild().catch(() => {});
    }
  }

  rejectActiveTurn(err) {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = null;
    turn.reject(err);
    if (this.needsRestart) {
      this.needsRestart = false;
      this.stopChild().catch(() => {});
    }
  }

  async sendPrompt(sessionId, blocks) {
    if (sessionId && sessionId !== this.sessionId) {
      this.configure({ sessionId });
    }
    const content = serializeBlocksForStreamJson(blocks);
    if (!content) {
      return { stopReason: "end_turn" };
    }

    await this.ensureProcess();
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new Error("Orchestrator stream process is not ready");
    }

    return new Promise((resolve, reject) => {
      this.activeTurn = { resolve, reject, cancelled: false };
      try {
        const payload = JSON.stringify({ event: "user", message: { content } });
        this.child.stdin.write(`${payload}\n`);
      } catch (err) {
        this.rejectActiveTurn(err);
      }
    });
  }

  cancelTurn() {
    this.permissionBridge.cancelAll("Turn cancelled");
    if (this.activeTurn) {
      this.activeTurn.cancelled = true;
    }
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      try {
        this.child.kill("SIGINT");
      } catch {
        // Ignore
      }
    }
  }

  async stopChild({ killGraceMs = 400 } = {}) {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin?.end();
    } catch {
      // Ignore
    }
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore
      }
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

  async stop() {
    this.stopping = true;
    this.permissionBridge.cancelAll("Orchestrator client stopping");
    await this.stopChild();
    await this.permissionBridge.stop();
  }
}
