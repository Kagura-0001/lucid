import path from "node:path";

const METADATA_LINE_PATTERNS = [
  /^Created At:\s/i,
  /^Completed At:\s/i,
  /^Command exited with code \d+\.?$/i,
  /^Command output:\s*$/i,
  /^Showing lines \d+-\d+ of \d+/i,
  /^The tool's output was truncated due to being too long\./i,
  /^Here is a preview with the middle of the output truncated:/i,
  /^<truncated \d+ of \d+ bytes/i,
];

const EXIT_CODE_REGEX = /Command exited with code (\d+)\.?/i;

const READ_ONLY_COMMAND_PREFIXES = [
  { regex: /^(?:ls|ll|la|tree)\b/i, group: "list", verb: "List" },
  { regex: /^(?:find|fd)\b/i, group: "list", verb: "Find" },
  { regex: /^(?:rg|grep|egrep|fgrep|ag)\b/i, group: "search", verb: "Search" },
  { regex: /^(?:cat|head|tail|nl|sed\s+-n)\b/i, group: "read", verb: "Read" },
  { regex: /^(?:wc|stat|file|pwd|which|type|du|df|ps|pgrep|nvidia-smi)\b/i, group: "check", verb: "Check" },
  { regex: /^git\s+(?:status|log|diff|show|branch|rev-parse|ls-files)\b/i, group: "check", verb: "Check" },
];

const WRITE_OR_CHAIN_PATTERN = /(?:&&|\|\||;|`|\$\(|(?<!2)>{1,2}|\|\s*(?:tee|sh|bash|zsh|python|node|rm|mv|cp|chmod|chown|kill)\b)/;

export function normalizeToolRawInput(rawInput) {
  if (!rawInput) return null;
  if (typeof rawInput === "object") return rawInput;
  if (typeof rawInput === "string") {
    try {
      const parsed = JSON.parse(rawInput);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function parseExitCode(outputText) {
  if (!outputText || typeof outputText !== "string") return null;
  const match = EXIT_CODE_REGEX.exec(outputText);
  if (!match) return null;
  const code = Number.parseInt(match[1], 10);
  return Number.isNaN(code) ? null : code;
}

export function cleanToolOutputLines(outputText) {
  if (!outputText || typeof outputText !== "string") {
    return { lines: [], totalLines: 0 };
  }
  const rawLines = outputText.replace(/\r\n/g, "\n").split("\n");
  const filtered = [];
  for (const rawLine of rawLines) {
    const trimmed = rawLine.trim();
    if (!trimmed && filtered.length === 0) continue;
    if (trimmed && METADATA_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
      continue;
    }
    filtered.push(rawLine.replace(/\t/g, "    "));
  }
  while (filtered.length > 0 && !filtered[filtered.length - 1].trim()) {
    filtered.pop();
  }
  const nonEmptyCount = filtered.filter((line) => line.trim() !== "").length;
  return { lines: filtered, totalLines: nonEmptyCount };
}

export function extractCleanOutputPreview(outputText) {
  const { lines, totalLines } = cleanToolOutputLines(outputText);
  const firstMeaningful = lines.find((line) => line.trim() !== "");
  if (!firstMeaningful) {
    const exitCode = parseExitCode(outputText);
    if (exitCode !== null && exitCode !== 0) {
      return `exit code ${exitCode}`;
    }
    return "";
  }
  const compact = firstMeaningful.trim();
  const extraLines = Math.max(0, totalLines - 1);
  return extraLines > 0 ? `${compact}  (+${extraLines} lines)` : compact;
}

export function shortenPathForDisplay(rawText, cwd = "") {
  if (!rawText || typeof rawText !== "string") return "";
  let text = rawText.trim();
  if (cwd && cwd !== "/") {
    const cleanCwd = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (text.includes(cleanCwd)) {
      text = text.split(cleanCwd).join("");
    }
  }
  return text;
}

function summarizeShellListTarget(cmd, cwd) {
  const cleaned = shortenPathForDisplay(cmd, cwd)
    .replace(/\s*2>&1\s*/g, " ")
    .replace(/^(?:ls|ll|la)\s+(?:-[a-zA-Z]+\s+)*/i, "")
    .trim();
  if (!cleaned) return ".";
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length === 1) return tokens[0];
  // Collapse shared directory prefix if listing multiple siblings
  const dir = path.dirname(tokens[0]);
  if (dir && dir !== "." && tokens.every((t) => path.dirname(t) === dir)) {
    return `${dir}/{${tokens.map((t) => path.basename(t)).join(",")}}`;
  }
  return cleaned;
}

function detectReadOnlyShell(commandLine, cwd) {
  const singleLine = commandLine.trim();
  if (!singleLine || singleLine.includes("\n")) return null;
  if (WRITE_OR_CHAIN_PATTERN.test(singleLine)) return null;
  // Strip harmless trailing 2>&1 and pipes to read-only paging/counting
  const mainSegment = singleLine.split("|")[0].trim();
  for (const spec of READ_ONLY_COMMAND_PREFIXES) {
    if (spec.regex.test(mainSegment)) {
      let target = shortenPathForDisplay(singleLine, cwd).replace(/\s*2>&1\s*$/, "").trim();
      if (spec.group === "list" && /^(?:ls|ll|la)\b/i.test(mainSegment)) {
        target = summarizeShellListTarget(mainSegment, cwd);
      }
      return {
        exploreGroup: spec.group,
        verb: spec.verb,
        summary: target,
      };
    }
  }
  return null;
}

function formatSwarmAction(input, rawTitle) {
  const action = String(input?.action || "").toLowerCase();
  if (!action || action === "status") {
    return { isExplore: true, exploreGroup: "check", verb: "Check", summary: "swarm status" };
  }
  if (action === "models") {
    return { isExplore: true, exploreGroup: "check", verb: "Check", summary: "swarm models" };
  }
  if (action === "add") {
    const name = input.name || "worker";
    const count = Array.isArray(input.tasks) && input.tasks.length > 0
      ? ` ×${input.tasks.length}`
      : typeof input.n === "number" && input.n > 1
        ? ` ×${input.n}`
        : "";
    return { isExplore: false, category: "swarm", verb: "Swarm", summary: `add ${name}${count}` };
  }
  if (action === "title" && input.title) {
    return { isExplore: false, category: "swarm", verb: "Swarm", summary: `title "${input.title}"` };
  }
  if (action === "kill" && input.name) {
    return { isExplore: false, category: "swarm", verb: "Swarm", summary: `kill ${input.name}` };
  }
  if (action === "model") {
    const target = input.name ? `${input.name} → ` : "";
    return { isExplore: false, category: "swarm", verb: "Swarm", summary: `model ${target}${input.model || ""}`.trim() };
  }
  return {
    isExplore: false,
    category: "swarm",
    verb: "Swarm",
    summary: action || rawTitle.replace(/^run\s+swarm\s*/i, "").trim() || "action",
  };
}

function extractFilePathFromTitle(title) {
  const stripped = title
    .replace(/^(?:File|Read|View|Open|Inspect)\s+/i, "")
    .trim();
  return stripped || title;
}

export function classifyToolItem(item, cwd = "") {
  const rawName = String(item.name || "").trim();
  const nameLower = rawName.toLowerCase();
  const kindLower = String(item.kind || "").trim().toLowerCase();
  const fullTitle = String(item.title || rawName || item.kind || "Tool");
  const titleLines = fullTitle
    .replace(/\t/g, "    ")
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== "");
  const firstTitleLine = titleLines[0] || "Tool";
  const hiddenCommandLines = Math.max(0, titleLines.length - 1);
  const titleLower = firstTitleLine.toLowerCase();

  const input = normalizeToolRawInput(item.rawInput);
  const exitCode = typeof item.exitCode === "number" ? item.exitCode : parseExitCode(item.outputText || "");
  const isRunning = !["completed", "failed", "error", "cancelled"].includes(item.status);
  const isFailure =
    item.status === "failed" ||
    item.status === "error" ||
    (exitCode !== null && exitCode !== 0);

  const { lines: cleanLines, totalLines: totalCleanLines } = cleanToolOutputLines(item.outputText || "");
  const firstMeaningfulLine = cleanLines.find((line) => line.trim() !== "")?.trim() || "";
  const previewLine = firstMeaningfulLine || (item.outputPreview && !METADATA_LINE_PATTERNS.some((p) => p.test(item.outputPreview.trim())) ? item.outputPreview.trim() : "");

  const base = {
    category: "other",
    isExplore: false,
    exploreGroup: "",
    isFailure,
    isRunning,
    exitCode,
    verb: "Ran",
    summary: shortenPathForDisplay(firstTitleLine, cwd),
    shortName: "",
    cleanLines,
    totalCleanLines,
    previewLine,
    hiddenCommandLines,
  };

  // 1. Swarm / board / message tools
  if (nameLower === "read_board" || titleLower === "run read_board" || titleLower.startsWith("read_board")) {
    return {
      ...base,
      category: "explore",
      isExplore: !isFailure,
      exploreGroup: "check",
      verb: "Check",
      summary: "board",
      shortName: "board",
    };
  }

  if (nameLower === "swarm_wait" || titleLower === "run swarm_wait") {
    return {
      ...base,
      category: "explore",
      isExplore: !isFailure,
      exploreGroup: "check",
      verb: "Check",
      summary: "wait on board",
      shortName: "wait on board",
    };
  }

  if (nameLower === "swarm" || titleLower === "run swarm" || titleLower.startsWith("swarm ")) {
    const sw = formatSwarmAction(input, firstTitleLine);
    return {
      ...base,
      category: sw.isExplore && !isFailure ? "explore" : "swarm",
      isExplore: Boolean(sw.isExplore) && !isFailure,
      exploreGroup: sw.exploreGroup || "",
      verb: sw.verb,
      summary: sw.summary,
      shortName: sw.summary,
    };
  }

  if (
    nameLower === "post_message" ||
    nameLower === "send_message" ||
    titleLower === "run post_message" ||
    titleLower === "run send_message"
  ) {
    const body = String(input?.text || input?.Message || "").trim();
    const mention = /^@([a-z0-9][a-z0-9_#-]*)/i.exec(body);
    const target = mention
      ? `@${mention[1]}`
      : input?.Recipient
        ? String(input.Recipient)
        : input?.channel
          ? `#${input.channel}`
          : "board";
    const bodyFirstLine = body.replace(/^@\S+\s*/, "").split(/\r?\n/)[0]?.trim() || "";
    return {
      ...base,
      category: "post",
      isExplore: false,
      verb: "Posted",
      summary: `to ${target}`,
      previewLine: bodyFirstLine || previewLine,
    };
  }

  // 2. Subagent orchestration tools
  if (nameLower === "invoke_subagent" || (input && input.TypeName && input.Role)) {
    const role = input?.Role || firstTitleLine.replace(/^run\s+/i, "");
    const typePart = input?.TypeName ? ` (${input.TypeName})` : "";
    return {
      ...base,
      category: "agent",
      isExplore: false,
      verb: "Delegated",
      summary: `${role}${typePart}`,
    };
  }

  if (nameLower === "manage_subagents") {
    const action = String(input?.Action || "list").toLowerCase();
    if (action === "list" && !isFailure) {
      return {
        ...base,
        category: "explore",
        isExplore: true,
        exploreGroup: "check",
        verb: "Check",
        summary: "subagents",
        shortName: "subagents",
      };
    }
    return {
      ...base,
      category: "agent",
      isExplore: false,
      verb: "Subagents",
      summary: action,
    };
  }

  // 3. File edits / diffs
  const hasDiffs = Array.isArray(item.diffs) && item.diffs.length > 0;
  if (
    hasDiffs ||
    kindLower === "edit" ||
    nameLower === "edit_file" ||
    nameLower === "write_file" ||
    nameLower === "replace_file_content" ||
    nameLower === "multi_replace_file_content"
  ) {
    const isWrite = nameLower === "write_file" || /^write\b/i.test(firstTitleLine);
    const targetPath =
      input?.Path ||
      input?.TargetFile ||
      (hasDiffs ? item.diffs[0]?.path : "") ||
      "";
    const cleanedTitle = shortenPathForDisplay(firstTitleLine, cwd);
    // Preserve custom explicit titles (like "Updated module_0.mjs") while trimming redundant "Edit " prefix
    let summary;
    if (/^(?:Edit|Write|File)\s+/i.test(cleanedTitle)) {
      summary = cleanedTitle.replace(/^(?:Edit|Write|File)\s+/i, "");
    } else if (cleanedTitle && cleanedTitle !== rawName && !/^run\s+/i.test(cleanedTitle)) {
      summary = cleanedTitle;
    } else if (targetPath) {
      summary = shortenPathForDisplay(targetPath, cwd);
    } else {
      summary = cleanedTitle;
    }
    return {
      ...base,
      category: "edit",
      isExplore: false,
      verb: isWrite ? "Wrote" : "Edited",
      summary,
      shortName: path.basename(summary),
    };
  }

  // 4. File reads & codebase searches
  if (
    kindLower === "read" ||
    nameLower === "read_file" ||
    nameLower === "view_file" ||
    /^File\s+\S+/i.test(firstTitleLine) ||
    /^Read\s+\S+/i.test(firstTitleLine)
  ) {
    const rawPath = input?.Path || input?.AbsolutePath || extractFilePathFromTitle(firstTitleLine);
    const rel = shortenPathForDisplay(rawPath, cwd);
    return {
      ...base,
      category: "explore",
      isExplore: !isFailure,
      exploreGroup: "read",
      verb: "Read",
      summary: rel,
      shortName: path.basename(rel) || rel,
    };
  }

  if (
    kindLower === "search" ||
    nameLower === "grep_search" ||
    nameLower === "find_by_name" ||
    nameLower === "list_dir" ||
    nameLower === "search_web"
  ) {
    const isList = nameLower === "list_dir" || nameLower === "find_by_name";
    const query = input?.Query || input?.query || input?.Pattern || input?.DirectoryPath || firstTitleLine.replace(/^run\s+/i, "");
    const summary = shortenPathForDisplay(String(query), cwd);
    return {
      ...base,
      category: "explore",
      isExplore: !isFailure,
      exploreGroup: isList ? "list" : "search",
      verb: isList ? "List" : "Search",
      summary,
      shortName: summary,
    };
  }

  // 5. Shell / command execution
  if (
    kindLower === "execute" ||
    nameLower === "run_command" ||
    nameLower === "bash" ||
    nameLower === "shell" ||
    (input && typeof input.CommandLine === "string")
  ) {
    const cmdRaw = typeof input?.CommandLine === "string" && input.CommandLine.trim()
      ? input.CommandLine.trim()
      : firstTitleLine;
    const cmdLines = cmdRaw.replace(/\t/g, "    ").split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
    const cmdFirst = cmdLines[0] || firstTitleLine;
    const cmdExtra = Math.max(hiddenCommandLines, Math.max(0, cmdLines.length - 1));

    if (!isFailure && cmdExtra === 0) {
      const readOnly = detectReadOnlyShell(cmdFirst, cwd);
      if (readOnly) {
        return {
          ...base,
          category: "explore",
          isExplore: true,
          exploreGroup: readOnly.exploreGroup,
          verb: readOnly.verb,
          summary: readOnly.summary,
          shortName: readOnly.summary,
          hiddenCommandLines: 0,
        };
      }
    }

    return {
      ...base,
      category: "run",
      isExplore: false,
      verb: "Ran",
      summary: shortenPathForDisplay(cmdFirst, cwd),
      hiddenCommandLines: cmdExtra,
    };
  }

  // 6. Fallback: strip noisy "Run " prefix
  const fallbackSummary = shortenPathForDisplay(firstTitleLine.replace(/^Run\s+/i, ""), cwd);
  return {
    ...base,
    category: "other",
    verb: "Ran",
    summary: fallbackSummary || firstTitleLine,
  };
}

/**
 * Collapses a contiguous run of explore-class tools into concise Codex-style
 * indented tree lines ("Read a.py, b.sh", "Check board, swarm status", etc.).
 */
export function summarizeExploreEntries(classifiedItems) {
  const entries = [];
  for (const entry of classifiedItems) {
    const last = entries[entries.length - 1];
    if (
      last &&
      last.group === entry.exploreGroup &&
      (entry.exploreGroup === "read" || entry.exploreGroup === "check")
    ) {
      last.items.push(entry);
    } else {
      entries.push({
        group: entry.exploreGroup || "check",
        verb: entry.verb || "Check",
        items: [entry],
      });
    }
  }

  return entries.map((bucket) => {
    if (bucket.items.length === 1) {
      const single = bucket.items[0];
      return {
        verb: bucket.verb,
        text: single.summary,
        running: single.isRunning,
      };
    }
    const labels = [];
    for (const item of bucket.items) {
      const label = item.shortName || item.summary;
      if (!labels.includes(label)) labels.push(label);
    }
    const maxListed = 3;
    const shown = labels.slice(0, maxListed).join(", ");
    const rest = labels.length - maxListed;
    return {
      verb: bucket.verb,
      text: rest > 0 ? `${shown} (+${rest} more)` : shown,
      running: bucket.items.some((item) => item.isRunning),
    };
  });
}

/**
 * Summarizes an archived turn's tools & thoughts into an agy-style single-line
 * trajectory header, plus any failed commands or edited files to keep visible.
 */
export function summarizeArchivedWork(items, cwd = "", { includeThoughts = true } = {}) {
  let totalMs = 0;
  let thoughtCount = 0;
  let toolCount = 0;
  let commandCount = 0;
  let readCount = 0;
  let editCount = 0;
  let searchCount = 0;
  let swarmCount = 0;
  const failedItems = [];
  const editedPaths = [];

  for (const item of items) {
    if (item.type === "thought") {
      if ((item.text || "").trim()) {
        thoughtCount += 1;
        totalMs += item.durationMs || 0;
      }
      continue;
    }
    if (item.type !== "tool") continue;
    toolCount += 1;
    totalMs += item.durationMs || 0;
    const info = classifyToolItem(item, cwd);
    if (info.category === "run") commandCount += 1;
    else if (info.exploreGroup === "read") readCount += 1;
    else if (info.exploreGroup === "list" || info.exploreGroup === "search") searchCount += 1;
    else if (info.category === "edit") {
      editCount += 1;
      if (info.summary && !editedPaths.includes(info.summary)) {
        editedPaths.push(info.summary);
      }
    } else if (info.category === "swarm" || info.category === "post" || info.category === "agent" || info.exploreGroup === "check") {
      swarmCount += 1;
    }

    if (info.isFailure) {
      failedItems.push({ item, info });
    }
  }

  const breakdown = [];
  if (commandCount > 0) breakdown.push(`${commandCount} ${commandCount === 1 ? "command" : "commands"}`);
  if (readCount > 0) breakdown.push(`${readCount} ${readCount === 1 ? "read" : "reads"}`);
  if (editCount > 0) breakdown.push(`${editCount} ${editCount === 1 ? "edit" : "edits"}`);
  if (searchCount > 0) breakdown.push(`${searchCount} ${searchCount === 1 ? "search" : "searches"}`);
  if (swarmCount > 0) breakdown.push("swarm");
  if (includeThoughts && thoughtCount > 0 && toolCount === 0) {
    breakdown.push(`${thoughtCount} ${thoughtCount === 1 ? "thought" : "thoughts"}`);
  }

  return {
    totalMs,
    toolCount,
    thoughtCount,
    stepCount: toolCount + (includeThoughts ? thoughtCount : 0),
    breakdown,
    failedItems,
    editedPaths,
  };
}
