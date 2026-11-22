import path from "node:path";
import { displayWidth, padEndVisible, truncateAnsi, wrapAnsiLine, wrapAnsiText } from "../term/unicode.mjs";
import { PASTED_TOKEN_REGEX } from "./composer.mjs";
import { renderDiffLines } from "./diff.mjs";
import { formatBytes } from "./files.mjs";
import { alignLeftRight, formatDuration, isToolTerminalStatus, sliceCenteredWindow, spinnerChar } from "./format.mjs";
import { safeRenderMarkdown } from "./markdown.mjs";
import { renderSwarmDock } from "./swarm.mjs";
import {
  classifyToolItemCached,
  summarizeArchivedWork,
  summarizeExploreEntries,
} from "./tool_format.mjs";

export { formatDuration };

const itemRenderCache = new WeakMap();
const archivedBlockCache = new WeakMap();

export function resolveThoughtMode(state) {
  if (state?.thoughtMode === "fold" || state?.thoughtMode === "expanded" || state?.thoughtMode === "hidden") {
    return state.thoughtMode;
  }
  return state?.showThoughts ? "expanded" : "fold";
}

function renderFoldedThoughtSummary(count, totalDurationMs, style) {
  const durPart = totalDurationMs > 0 ? ` for ${formatDuration(totalDurationMs)}` : "";
  const stepsPart = count > 1 ? ` · ${count} steps` : "";
  return `  ${style.thought(`▸ Thought${durPart}`)}${style.muted(`${stepsPart}  (Ctrl+T to expand)`)}`;
}

export function formatTokenCount(count) {
  if (typeof count !== "number" || Number.isNaN(count)) return "";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(count);
}

function formatModeLabel(modeId, style) {
  if (!modeId) return "";
  switch (modeId) {
    case "auto":
      return style.successBold("auto");
    case "accept-edits":
      return style.warnBold("accept-edits");
    case "plan":
      return style.accentBold("plan");
    default:
      return style.muted(modeId);
  }
}

export function renderHeader(state, cols, style) {
  const dirName = path.basename(state.cwd) || state.cwd;
  const brand = style.accentBold("◆ lucid");
  const sep = style.border(" · ");

  const leftParts = [brand, style.bold(dirName)];

  if (state.modelLabel) {
    const modelPiece = state.effortLabel
      ? `${state.modelLabel} ${style.muted(`(${state.effortLabel})`)}`
      : state.modelLabel;
    leftParts.push(style.accentAlt(modelPiece));
  } else if (state.agentLabel) {
    leftParts.push(style.muted(state.agentLabel));
  }

  if (state.modeId) {
    leftParts.push(formatModeLabel(state.modeId, style));
  }

  if (state.bypassPermissions) {
    leftParts.push(style.errorBold("bypass"));
  }

  const rightParts = [];
  if (state.usage && state.usage.size > 0) {
    const pct = Math.min(100, Math.round((state.usage.used / state.usage.size) * 100));
    const usageText = `${formatTokenCount(state.usage.used)}/${formatTokenCount(state.usage.size)} (${pct}%)`;
    const colored = pct >= 85 ? style.error(usageText) : pct >= 65 ? style.warn(usageText) : style.muted(usageText);
    rightParts.push(colored);
  }
  if (state.quotaText) {
    rightParts.push(style.muted(state.quotaText));
  }

  const leftStr = leftParts.join(sep);
  const rightStr = rightParts.join(sep);
  const topLine = ` ${alignLeftRight(leftStr, rightStr, cols - 2, 2)} `;
  const ruleLine = style.border("─".repeat(cols));
  return [topLine, ruleLine];
}

export function renderWelcome(state, cols, style) {
  const innerWidth = Math.min(76, Math.max(36, cols - 4));
  const lines = [""];
  lines.push(`  ${style.accentBold("◆ lucid")}  ${style.muted("transparent ACP terminal UI")}`);
  lines.push("");

  const statusLine = state.connected
    ? `${style.success("●")} Connected to ${style.bold(state.agentLabel || "ACP agent")}`
    : state.connecting
      ? `${style.warn(spinnerChar(state.spinnerFrame))} Connecting to ${style.bold(state.agentLabel || "ACP agent")}…`
      : `${style.error("●")} Disconnected`;

  lines.push(`  ${statusLine}`);
  lines.push(`  ${style.muted("Workspace:")}  ${state.cwd}`);
  if (state.modelLabel) {
    const effortPart = state.effortLabel ? ` · effort ${state.effortLabel}` : "";
    lines.push(`  ${style.muted("Model:")}      ${state.modelLabel}${style.muted(effortPart)}`);
  }
  if (state.modeId) {
    lines.push(`  ${style.muted("Mode:")}       ${formatModeLabel(state.modeId, style)}  ${style.muted("(Shift+Tab to cycle)")}`);
  }
  lines.push(`  ${style.muted("Theme:")}      ${style.name}  ${style.muted("(/theme to switch)")}`);
  lines.push("");
  lines.push(`  ${style.border("─".repeat(Math.min(innerWidth, 56)))}`);
  lines.push("");
  lines.push(`  ${style.accent("/resume")}     ${style.muted("Browse & resume existing conversations (/sessions)")}`);
  lines.push(`  ${style.accent("/model")}      ${style.muted("Switch model")}    ${style.accent("/effort")}  ${style.muted("Adjust thinking level")}`);
  lines.push(`  ${style.accent("/theme")}      ${style.muted("Switch palette")}  ${style.accent("@file")}    ${style.muted("Attach workspace file")}`);
  lines.push(`  ${style.accent("Ctrl+Y")}      ${style.muted("Copy last reply (SSH/tmux OSC 52)")}`);
  lines.push(`  ${style.accent("Drag")}        ${style.muted("Select text & copy (OSC 52); Ctrl+C copies again, Esc clears")}`);
  lines.push(`  ${style.accent("Ctrl+G")}      ${style.muted("Toggle mouse capture for native drag-select")}`);
  lines.push("");
  return lines;
}

function formatOptionalDuration(durationMs, isFailure) {
  if (!durationMs || durationMs <= 0) return "";
  // Quiet for fast successful calls (< 3s), always shown for failures or slower commands.
  if (!isFailure && durationMs < 3000) return "";
  return formatDuration(durationMs);
}

function formatStatusMetaTag(parts, isFailure, style) {
  if (!parts || parts.length === 0) return "";
  const text = `  (${parts.join(" · ")})`;
  return isFailure ? style.error(text) : style.muted(text);
}

function renderToolItem(item, maxWidth, style, state, precomputedInfo = null) {
  const lines = [];
  const spinner = spinnerChar(state.spinnerFrame);
  const info = precomputedInfo || classifyToolItemCached(item, state.cwd || "");

  let icon;
  if (info.isFailure) {
    icon = style.error("✗");
  } else if (item.status === "cancelled") {
    icon = style.muted("○");
  } else if (info.isRunning) {
    icon = style.warn(spinner);
  } else {
    icon = style.muted("•");
  }

  const moreLinesTag = info.hiddenCommandLines > 0 ? style.muted(` (+${info.hiddenCommandLines} lines)`) : "";
  const metaParts = [];
  if (info.isFailure) {
    metaParts.push(info.exitCode !== null && info.exitCode !== 0 ? `exit ${info.exitCode}` : "failed");
  }
  const durStr = formatOptionalDuration(item.durationMs, info.isFailure);
  if (durStr) metaParts.push(durStr);
  const metaTag = formatStatusMetaTag(metaParts, info.isFailure, style);

  const verbLabel = info.isFailure
    ? style.errorBold(info.verb)
    : info.category === "edit"
      ? style.accentBold(info.verb)
      : info.category === "post" || info.category === "swarm" || info.category === "agent"
        ? style.accentAlt(info.verb)
        : style.bold(info.verb);

  const reservedRight = displayWidth(moreLinesTag) + displayWidth(metaTag) + displayWidth(info.verb) + 6;
  const summaryWidth = Math.max(16, maxWidth - reservedRight);
  const summaryText = truncateAnsi(info.summary || "", summaryWidth, "…");
  lines.push(`  ${icon} ${verbLabel} ${style.text(summaryText)}${moreLinesTag}${metaTag}`);

  // Render diff blocks cleanly even in compact mode (with sensible cap)
  if (Array.isArray(item.diffs) && item.diffs.length > 0) {
    const cap = state.expandTools ? 120 : 28;
    for (const diffEntry of item.diffs) {
      const relPath = diffEntry.path
        ? path.relative(state.cwd, diffEntry.path) || diffEntry.path
        : "";
      const rendered = renderDiffLines({
        pathLabel: relPath,
        oldText: diffEntry.oldText || "",
        newText: diffEntry.newText || "",
        maxWidth: maxWidth - 4,
        style,
        maxOutputLines: cap,
      });
      for (const dl of rendered.lines) {
        lines.push(`    ${dl}`);
      }
    }
  }

  // Show cleaned output & input details when expanded (Ctrl+O) or on failure
  const showDetails = state.expandTools || info.isFailure;
  if (showDetails) {
    if (state.expandTools && item.rawInputSummary) {
      const wrappedIn = wrapAnsiText(style.muted(item.rawInputSummary), Math.max(16, maxWidth - 8));
      for (const l of wrappedIn.slice(0, 12)) {
        lines.push(`    ${style.border("│")} ${l}`);
      }
    }
    const outLines = info.cleanLines.length > 0
      ? info.cleanLines
      : item.outputText
        ? item.outputText.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim() !== "")
        : [];
    if (outLines.length > 0) {
      const maxOut = state.expandTools ? 24 : 3;
      const slice = outLines.slice(0, maxOut);
      for (let i = 0; i < slice.length; i += 1) {
        const prefix = state.expandTools ? style.border("│") : style.border("└");
        const colorLine = info.isFailure && !state.expandTools ? style.error : style.muted;
        const wrapped = wrapAnsiLine(colorLine(slice[i].replace(/\t/g, "    ")), Math.max(16, maxWidth - 8));
        for (let wIdx = 0; wIdx < wrapped.length; wIdx += 1) {
          const lead = wIdx === 0 ? prefix : " ";
          lines.push(`    ${lead} ${wrapped[wIdx]}`);
        }
      }
      if (outLines.length > maxOut) {
        lines.push(`    ${style.border("│")} ${style.muted(`… +${outLines.length - maxOut} lines`)}`);
      }
    } else if (info.isFailure && info.exitCode !== null && info.exitCode !== 0) {
      lines.push(`    ${style.border("└")} ${style.error(`Command exited with code ${info.exitCode}`)}`);
    }
  } else if (info.previewLine && (!item.diffs || item.diffs.length === 0)) {
    const extraCount = Math.max(0, info.totalCleanLines - 1);
    const suffix = extraCount > 0 ? style.muted(`  (+${extraCount} lines)`) : "";
    const budget = Math.max(16, maxWidth - 8 - displayWidth(suffix));
    lines.push(`    ${style.border("└")} ${style.muted(truncateAnsi(info.previewLine, budget, "…"))}${suffix}`);
  }

  return lines;
}

function renderExploreGroup(classifiedList, maxWidth, style, state) {
  const isRunning = classifiedList.some((entry) => entry.isRunning);
  const icon = isRunning
    ? style.warn(spinnerChar(state.spinnerFrame))
    : style.muted("•");
  const heading = isRunning ? style.bold("Exploring") : style.muted("Explored");
  const lines = [`  ${icon} ${heading}`];

  const rows = summarizeExploreEntries(classifiedList);
  for (const row of rows) {
    const lead = row.running
      ? style.warn(spinnerChar(state.spinnerFrame))
      : style.border("└");
    const verbStr = style.muted(row.verb);
    const textBudget = Math.max(14, maxWidth - 8 - displayWidth(row.verb) - 1);
    const body = truncateAnsi(row.text || "", textBudget, "…");
    lines.push(`    ${lead} ${verbStr} ${style.text(body)}`);
  }
  return lines;
}

function renderArchivedWorkBlock(segmentItems, maxWidth, style, state, thoughtMode) {
  const includeThoughts = thoughtMode === "fold";
  const summary = summarizeArchivedWork(segmentItems, state.cwd || "", { includeThoughts });
  if (summary.stepCount === 0 && summary.toolCount === 0) return [];

  const parts = [];
  const dur = summary.totalMs > 0 ? ` for ${formatDuration(summary.totalMs)}` : "";
  const label = summary.toolCount > 0 ? `Worked${dur}` : `Thought${dur}`;
  parts.push(style.muted(`▸ ${label}`));

  const detailBits = [];
  if (summary.stepCount > 0) {
    detailBits.push(`${summary.stepCount} ${summary.stepCount === 1 ? "step" : "steps"}`);
  }
  if (summary.breakdown.length > 0) {
    detailBits.push(`(${summary.breakdown.join(", ")})`);
  }
  if (detailBits.length > 0) {
    parts.push(style.muted(detailBits.join(" ")));
  }
  parts.push(style.muted("^O expand"));

  const lines = [`  ${truncateAnsi(parts.join(style.border(" · ")), maxWidth, "…")}`];

  // Keep any failed commands visible right beneath the collapsed summary so errors are never hidden.
  for (const { info } of summary.failedItems) {
    const exitTag = info.exitCode !== null && info.exitCode !== 0 ? `exit ${info.exitCode}` : "failed";
    const cmdBudget = Math.max(14, maxWidth - 16 - exitTag.length);
    const cmdText = truncateAnsi(`${info.verb} ${info.summary}`, cmdBudget, "…");
    lines.push(`    ${style.error("✗")} ${style.text(cmdText)}  ${style.error(exitTag)}`);
    const errLine = info.cleanLines.find((l) => l.trim() !== "")?.trim();
    if (errLine) {
      lines.push(`      ${style.border("└")} ${style.error(truncateAnsi(errLine, Math.max(14, maxWidth - 10), "…"))}`);
    }
  }

  // Keep edited files summarized subtly when present.
  if (summary.editedPaths.length > 0) {
    const shown = summary.editedPaths.slice(0, 3).join(", ");
    const rest = summary.editedPaths.length - 3;
    const editedLabel = rest > 0 ? `${shown} (+${rest} more)` : shown;
    lines.push(`    ${style.border("└")} ${style.accent("Edited")} ${style.muted(truncateAnsi(editedLabel, Math.max(14, maxWidth - 16), "…"))}`);
  }

  return lines;
}

function renderExpandedThoughtItem(item, maxWidth, style, state) {
  const text = (item.text || "").trim();
  if (!text) return [];
  const isLive = Boolean(item.streaming);
  const dur = item.durationMs ? ` · ${formatDuration(item.durationMs)}` : "";
  const labelIcon = isLive ? style.thought(spinnerChar(state.spinnerFrame)) : style.thought("▾");
  const titleLabel = isLive ? `Thinking${dur}` : `Thought${dur}`;
  const lines = [`  ${labelIcon} ${style.thought(titleLabel)}`];
  for (const w of wrapAnsiText(style.thought(text), Math.max(16, maxWidth - 6))) {
    lines.push(`    ${style.border("│")} ${w}`);
  }
  return lines;
}

function renderPlanItem(item, maxWidth, style) {
  const entries = Array.isArray(item.entries) ? item.entries : [];
  if (entries.length === 0) return [];
  const lines = [];
  lines.push(`  ${style.border("╭─")} ${style.accentBold("Plan")}`);
  const innerWidth = Math.max(16, maxWidth - 8);
  for (const entry of entries) {
    const status = entry.status || "pending";
    const icon =
      status === "completed"
        ? style.success("✓")
        : status === "in_progress"
          ? style.warn("◐")
          : style.muted("○");
    const content = status === "completed" ? style.muted(entry.content || "") : style.text(entry.content || "");
    const wrapped = wrapAnsiLine(content, innerWidth);
    wrapped.forEach((wl, idx) => {
      lines.push(idx === 0 ? `  ${style.border("│")} ${icon} ${wl}` : `  ${style.border("│")}   ${wl}`);
    });
  }
  lines.push(`  ${style.border("╰─")}`);
  return lines;
}

function stylePastedTokens(line, baseStyleFn, style) {
  if (!line || !line.includes("[Pasted text #")) {
    return baseStyleFn(line);
  }
  let out = "";
  let lastIndex = 0;
  PASTED_TOKEN_REGEX.lastIndex = 0;
  let match = PASTED_TOKEN_REGEX.exec(line);
  while (match) {
    if (match.index > lastIndex) {
      out += baseStyleFn(line.slice(lastIndex, match.index));
    }
    out += style.accentAlt(match[0]);
    lastIndex = match.index + match[0].length;
    match = PASTED_TOKEN_REGEX.exec(line);
  }
  if (lastIndex < line.length) {
    out += baseStyleFn(line.slice(lastIndex));
  }
  return out;
}

function renderUserItem(item, contentWidth, style, state) {
  const out = [];
  const visibleText = state?.expandTools ? (item.text || "") : (item.displayText || item.text || "");
  const rawLines = String(visibleText).split("\n");
  let firstLine = true;
  for (const rl of rawLines) {
    const styledLine = stylePastedTokens(rl, (part) => style.bold(part), style);
    const wrapped = wrapAnsiLine(styledLine, Math.max(16, contentWidth - 2));
    for (const wl of wrapped) {
      const prefix = firstLine ? `${style.accentBold("❯")} ` : `${style.border("│")} `;
      out.push(`  ${prefix}${wl}`);
      firstLine = false;
    }
  }
  const hasFiles = Array.isArray(item.attachedPaths) && item.attachedPaths.length > 0;
  const hasImages = Array.isArray(item.attachedImages) && item.attachedImages.length > 0;
  if (hasFiles || hasImages) {
    const tags = [];
    if (hasImages) {
      for (const img of item.attachedImages) {
        const sizeStr = img.sizeBytes ? ` (${formatBytes(img.sizeBytes)})` : "";
        tags.push(style.warn(`🖼 ${img.label}${sizeStr}`));
      }
    }
    if (hasFiles) {
      for (const p of item.attachedPaths) {
        tags.push(style.accentAlt(`@${p}`));
      }
    }
    out.push(`    ${style.muted("attached:")} ${tags.join("  ")}`);
  }
  out.push("");
  return out;
}

function renderAssistantItem(item, contentWidth, style) {
  const mdLines = safeRenderMarkdown(item.text || "", contentWidth, style);
  return mdLines.map((ml) => (ml ? `  ${ml}` : ""));
}

function renderShellItem(item, contentWidth, style, state) {
  const out = [];
  const spinner = spinnerChar(state.spinnerFrame);
  const isRunning = item.status === "running";
  const isCancelled = item.status === "cancelled";
  const isFailure = item.status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0);

  let lead;
  if (isRunning) {
    lead = `${style.warn(spinner)} ${style.warnBold("!")}`;
  } else if (isFailure) {
    lead = `${style.error("✗")} ${style.errorBold("!")}`;
  } else if (isCancelled) {
    lead = `${style.muted("○")} ${style.muted("!")}`;
  } else {
    lead = style.warnBold("!");
  }

  const metaParts = [];
  if (isFailure) {
    metaParts.push(typeof item.exitCode === "number" && item.exitCode !== 0 ? `exit ${item.exitCode}` : "failed");
  } else if (isCancelled) {
    metaParts.push("cancelled");
  }
  if (item.durationMs >= 1000) {
    metaParts.push(formatDuration(item.durationMs));
  }
  const metaTag = formatStatusMetaTag(metaParts, isFailure, style);

  const cmdRaw = String(item.command || "").replace(/\r?\n/g, " ").trim();
  const cmdBudget = Math.max(16, contentWidth - displayWidth(lead) - displayWidth(metaTag) - 4);
  out.push(`  ${lead} ${style.bold(truncateAnsi(cmdRaw, cmdBudget, "…"))}${metaTag}`);

  const rawOutput = String(item.output || "").replace(/\r\n/g, "\n");
  if (rawOutput.trim()) {
    const rawLines = rawOutput
      .split("\n")
      .map((l) => (l.includes("\r") ? l.slice(l.lastIndexOf("\r") + 1) : l));
    while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
      rawLines.pop();
    }
    const maxOut = state.expandTools ? 120 : 16;
    const slice = rawLines.slice(0, maxOut);
    const bodyWidth = Math.max(16, contentWidth - 6);
    for (const line of slice) {
      const colored = isFailure ? style.error(line.replace(/\t/g, "    ")) : style.muted(line.replace(/\t/g, "    "));
      const wrapped = wrapAnsiLine(colored, bodyWidth);
      for (const wl of wrapped) {
        out.push(`    ${style.border("│")} ${wl}`);
      }
    }
    if (rawLines.length > maxOut) {
      out.push(`    ${style.border("│")} ${style.muted(`… +${rawLines.length - maxOut} more lines (^O expand)`)}`);
    }
  } else if (!isRunning && !isCancelled && !isFailure) {
    out.push(`    ${style.border("└")} ${style.muted("(no output)")}`);
  }
  out.push("");
  return out;
}

function renderNoticeItem(item, contentWidth, style) {
  const [marker, paint] =
    item.level === "error"
      ? [style.errorBold("!"), style.error]
      : item.level === "warn"
        ? [style.warnBold("!"), style.warn]
        : [style.muted("·"), style.muted];
  const wrapped = wrapAnsiText(paint(item.text), Math.max(16, contentWidth - 2));
  return wrapped.map((wl, wIdx) => (wIdx === 0 ? `  ${marker} ${wl}` : `    ${wl}`));
}

function isCacheableTimelineItem(item, thoughtMode) {
  if (!item || typeof item !== "object") return false;
  switch (item.type) {
    case "user":
    case "notice":
    case "plan":
      return true;
    case "shell":
      return item.status !== "running";
    case "tool":
      return isToolTerminalStatus(item.status);
    case "assistant":
      return !item.streaming;
    case "thought":
      return thoughtMode === "expanded" && !item.streaming;
    default:
      return false;
  }
}

function renderCachedArchivedWorkBlock(segmentItems, cols, contentWidth, style, state, thoughtMode) {
  if (!Array.isArray(segmentItems) || segmentItems.length === 0) return [];
  const firstItem = segmentItems[0];
  const baseKey = `${cols}|${style.name}|${style.depth}|${state.cwd || ""}|${thoughtMode}|${segmentItems.length}`;
  const cached = archivedBlockCache.get(firstItem);
  if (cached && cached.baseKey === baseKey && cached.items.length === segmentItems.length) {
    let match = true;
    for (let i = 0; i < segmentItems.length; i += 1) {
      if (cached.items[i] !== segmentItems[i] || cached.revs[i] !== (segmentItems[i]._rev || 0)) {
        match = false;
        break;
      }
    }
    if (match) return cached.lines;
  }
  const lines = renderArchivedWorkBlock(segmentItems, contentWidth, style, state, thoughtMode);
  archivedBlockCache.set(firstItem, {
    baseKey,
    items: segmentItems,
    revs: segmentItems.map((it) => it._rev || 0),
    lines,
  });
  return lines;
}

function renderCachedTimelineItem(item, cols, contentWidth, style, state, thoughtMode, renderFn) {
  if (!isCacheableTimelineItem(item, thoughtMode)) {
    return renderFn();
  }
  const key = `${cols}|${style.name}|${style.depth}|${state.cwd || ""}|${state.expandTools ? 1 : 0}|${thoughtMode}|${item._rev || 0}`;
  const cached = itemRenderCache.get(item);
  if (cached && cached.key === key) {
    return cached.lines;
  }
  const lines = renderFn();
  itemRenderCache.set(item, { key, lines });
  return lines;
}

function splitItemsIntoTurns(items) {
  const turns = [];
  let current = [];
  for (const item of items) {
    if (item.type === "user" && current.length > 0) {
      turns.push(current);
      current = [item];
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) {
    turns.push(current);
  }
  return turns;
}

export function renderTimeline(state, cols, style) {
  if (state.items.length === 0) {
    return renderWelcome(state, cols, style);
  }

  const contentWidth = Math.max(24, cols - 4);
  const thoughtMode = resolveThoughtMode(state);
  const lines = [""];
  let lastEmittedType = null;

  const pushLines = (chunk) => {
    for (let i = 0; i < chunk.length; i += 1) {
      lines.push(chunk[i]);
    }
  };
  const renderCached = (item, fn) => renderCachedTimelineItem(item, cols, contentWidth, style, state, thoughtMode, fn);

  const turns = splitItemsIntoTurns(state.items);

  for (let tIdx = 0; tIdx < turns.length; tIdx += 1) {
    const turn = turns[tIdx];
    const isLatestTurn = tIdx === turns.length - 1;
    const turnHasLive = turn.some(
      (item) => item.streaming || (item.type === "tool" && !isToolTerminalStatus(item.status)),
    );
    const archiveWork = !isLatestTurn && !turnHasLive && !state.expandTools;

    let turnFoldedCount = 0;
    let turnFoldedMs = 0;
    let hasLiveThought = false;
    if (!archiveWork && thoughtMode === "fold") {
      for (const item of turn) {
        if (item.type !== "thought") continue;
        if (item.streaming) {
          hasLiveThought = true;
        } else if ((item.text || "").trim()) {
          turnFoldedCount += 1;
          turnFoldedMs += item.durationMs || 0;
        }
      }
    }
    let emittedTurnFoldedThought = false;
    let pendingBatch = [];

    const flushPending = () => {
      if (pendingBatch.length === 0) return;
      const block = archiveWork
        ? renderCachedArchivedWorkBlock(pendingBatch, cols, contentWidth, style, state, thoughtMode)
        : renderExploreGroup(pendingBatch, contentWidth, style, state);
      if (block.length > 0) {
        pushLines(block);
        lastEmittedType = "tool";
      }
      pendingBatch = [];
    };

    for (const item of turn) {
      if (item.type === "tool") {
        if (archiveWork) {
          pendingBatch.push(item);
          continue;
        }
        const info = !state.expandTools ? classifyToolItemCached(item, state.cwd || "") : null;
        if (info && info.isExplore && !info.isFailure) {
          pendingBatch.push(info);
          continue;
        }
        flushPending();
        pushLines(renderCached(item, () => renderToolItem(item, contentWidth, style, state, info)));
        lastEmittedType = "tool";
        continue;
      }

      if (item.type === "thought") {
        if (thoughtMode === "hidden") continue;
        if (thoughtMode === "fold") {
          if (archiveWork) {
            if ((item.text || "").trim()) pendingBatch.push(item);
            continue;
          }
          if (item.streaming) {
            flushPending();
            const combinedMs = turnFoldedMs + (item.durationMs || 0);
            const spin = style.thought(spinnerChar(state.spinnerFrame));
            const dur = combinedMs > 0 ? ` · ${formatDuration(combinedMs)}` : "";
            const stepTag = turnFoldedCount > 0 ? ` · ${turnFoldedCount + 1} steps` : "";
            lines.push(`  ${spin} ${style.thought(`Thinking${dur}`)}${style.muted(`${stepTag}  (Ctrl+T to expand)`)}`);
            emittedTurnFoldedThought = true;
            lastEmittedType = "thought";
          } else if (!hasLiveThought && !emittedTurnFoldedThought && turnFoldedCount > 0) {
            flushPending();
            lines.push(renderFoldedThoughtSummary(turnFoldedCount, turnFoldedMs, style));
            emittedTurnFoldedThought = true;
            lastEmittedType = "thought";
          }
          continue;
        }
        flushPending();
        const thoughtLines = renderCached(item, () => renderExpandedThoughtItem(item, contentWidth, style, state));
        if (thoughtLines.length > 0) {
          pushLines(thoughtLines);
          lastEmittedType = "thought";
        }
        continue;
      }

      flushPending();

      switch (item.type) {
        case "user":
          if (lines.length > 1) lines.push("");
          pushLines(renderCached(item, () => renderUserItem(item, contentWidth, style, state)));
          lastEmittedType = "user";
          break;
        case "plan": {
          const planLines = renderCached(item, () => renderPlanItem(item, contentWidth, style));
          if (planLines.length > 0) {
            pushLines(planLines);
            lastEmittedType = "plan";
          }
          break;
        }
        case "assistant":
          if (lastEmittedType === "tool" || lastEmittedType === "thought" || lastEmittedType === "plan") {
            lines.push("");
          }
          pushLines(renderCached(item, () => renderAssistantItem(item, contentWidth, style)));
          if (item.streaming) {
            lines.push(`  ${style.accent(spinnerChar(state.spinnerFrame))}`);
          }
          lines.push("");
          lastEmittedType = "assistant";
          break;
        case "notice":
          pushLines(renderCached(item, () => renderNoticeItem(item, contentWidth, style)));
          lastEmittedType = "notice";
          break;
        case "shell":
          pushLines(renderCached(item, () => renderShellItem(item, contentWidth, style, state)));
          lastEmittedType = "shell";
          break;
        default:
          break;
      }
    }

    flushPending();
  }

  return lines;
}

export function renderAutocompletePopup(popup, cols, style) {
  if (!popup || !Array.isArray(popup.items) || popup.items.length === 0) {
    return [];
  }

  const maxVisible = Math.min(8, popup.items.length);
  const { start, slice } = sliceCenteredWindow(popup.items, popup.selected, maxVisible);
  const innerWidth = Math.max(24, cols - 4);
  const lines = [];

  const title = popup.kind === "file" ? "Files (@)" : "Commands (/)";
  const topFill = Math.max(0, innerWidth - displayWidth(title) - 3);
  lines.push(` ${style.border("╭─")} ${style.muted(title)} ${style.border("─".repeat(topFill) + "╮")}`);

  for (let i = 0; i < slice.length; i += 1) {
    const entry = slice[i];
    const isSelected = start + i === popup.selected;
    const labelRaw = entry.label || "";
    const descRaw = entry.description || "";
    const labelCol = Math.min(26, Math.max(14, Math.floor(innerWidth * 0.34)));

    let content;
    if (descRaw) {
      const left = padEndVisible(truncateAnsi(labelRaw, labelCol, "…"), labelCol);
      const right = truncateAnsi(descRaw, Math.max(8, innerWidth - labelCol - 4), "…");
      content = isSelected
        ? style.selected(` ${left}  ${right} `)
        : ` ${style.accent(left)}  ${style.muted(right)}`;
    } else {
      const single = truncateAnsi(labelRaw, innerWidth - 2, "…");
      content = isSelected ? style.selected(` ${single} `) : ` ${style.text(single)}`;
    }

    lines.push(` ${style.border("│")}${padEndVisible(content, innerWidth)}${style.border("│")}`);
  }

  lines.push(` ${style.border("╰" + "─".repeat(innerWidth) + "╯")}`);
  return lines;
}

export function renderComposerBlock(state, cols, style) {
  const gutterWidth = 4; // " ❯ " + 1 right margin
  const inputWidth = Math.max(12, cols - gutterWidth);
  const layout = state.composer.layout(inputWidth, 6);

  const lines = [];

  // Staged image attachments strip (only shown when images are queued)
  if (Array.isArray(state.stagedImages) && state.stagedImages.length > 0) {
    const pills = state.stagedImages
      .map((img) => style.warn(`🖼 ${img.label} (${formatBytes(img.sizeBytes)})`))
      .join("  ");
    const clearHint = style.muted(" · /unattach to clear");
    lines.push(` ${truncateAnsi(`${pills}${clearHint}`, cols - 2, "…")}`);
  }

  const thoughtMode = resolveThoughtMode(state);

  const isShellInput = !state.activeModalType && state.composer.text.startsWith("!");

  // Optional status strip right above the composer hairline
  let statusBanner = "";
  if (state.activeModalType === "permission") {
    statusBanner = `${style.warnBold("⚠ Permission approval required above")} ${style.muted("· press 1-9, ↑/↓ + Enter, or Esc to deny")}`;
  } else if (state.activeModalType === "picker") {
    statusBanner = `${style.accent("▸ Picker open")} ${style.muted("· type to filter, ↑/↓ + Enter to select, Esc to close")}`;
  } else if (isShellInput) {
    statusBanner = `${style.warnBold("! Local shell")} ${style.muted("· runs directly in workspace (bypasses agent) · Enter run · Esc clear")}`;
  } else if (state.focusedAgentName) {
    statusBanner = `${style.accentBold(`Viewing ${state.focusedAgentName}`)} ${style.muted("· Alt+[/] switch · Esc back to main")}`;
  } else if (state.busy) {
    const spin = spinnerChar(state.spinnerFrame);
    const items = Array.isArray(state.items) ? state.items : [];
    const lastItem = items.length > 0 ? items[items.length - 1] : null;
    const isThinkingHidden = thoughtMode === "hidden" && lastItem?.type === "thought" && lastItem?.streaming;
    if (isThinkingHidden) {
      const tDur = lastItem.durationMs ? ` · ${formatDuration(lastItem.durationMs)}` : "";
      statusBanner = `${style.thought(spin)} ${style.muted(`Working · thinking${tDur} · ^T show · Esc cancel`)}`;
    } else {
      const elapsed = state.turnStartedAt ? ` · ${formatDuration(Date.now() - state.turnStartedAt)}` : "";
      statusBanner = `${style.accent(spin)} ${style.muted(`Working${elapsed} · Esc cancel · type to steer`)}`;
    }
  }

  if (statusBanner) {
    lines.push(` ${truncateAnsi(statusBanner, Math.max(16, cols - 2), "…")}`);
  }

  const ruleColor = isShellInput ? style.warn : style.border;
  lines.push(ruleColor("─".repeat(cols)));

  const composerTopOffset = lines.length;
  const isEmpty = state.composer.isEmpty();

  for (let i = 0; i < layout.lines.length; i += 1) {
    const promptPrefix = i === 0
      ? ` ${isShellInput ? style.warnBold("!") : style.accentBold("❯")} `
      : ` ${ruleColor("│")} `;
    if (isEmpty && i === 0) {
      const placeholder =
        state.activeModalType === "permission"
          ? "Respond to permission prompt above (1-9 / Enter / Esc)…"
          : state.activeModalType === "picker"
            ? "Type in the picker above to filter…"
            : state.focusedAgentName
              ? `Viewing ${state.focusedAgentName} · Esc back to main, or message coordinator…`
              : state.busy
                ? "Type to steer the running turn…"
                : "Message agent…  (/ commands · ! shell · @ files · Shift+Tab mode)";
      lines.push(`${promptPrefix}${style.muted(truncateAnsi(placeholder, inputWidth, "…"))}`);
    } else {
      lines.push(`${promptPrefix}${stylePastedTokens(layout.lines[i], (part) => part, style)}`);
    }
  }

  lines.push(ruleColor("─".repeat(cols)));

  // Render active toasts or scroll-position badge in-place inside the fixed footer
  // line so scrolling or toasts never shift viewport height or trigger full redraws.
  const hasActiveToast = Boolean(state.toast && Date.now() < state.toast.expiresAt);
  let defaultFooterLine = "";
  let footerLine;
  if (hasActiveToast) {
    const tone = state.toast.level === "error" ? style.error : style.success;
    footerLine = ` ${tone(truncateAnsi(state.toast.text, Math.max(12, cols - 2), "…"))}`;
  } else {
    // Compact footer hints — drop trailing items cleanly rather than clipping mid-word
    const mouseState = state.mouseCapture ? style.success("on") : style.warn("off");
    const detailsState = state.expandTools ? style.accent("full") : style.muted("compact");
    const thoughtsHint =
      thoughtMode === "expanded"
        ? style.accent("thoughts:on")
        : thoughtMode === "hidden"
          ? style.muted("thoughts:off")
          : style.muted("thoughts");
    const footerCandidates = [
      `${style.muted("Enter")} send`,
      `${style.muted("^J")} newline`,
      `${style.muted("⇧Tab")} mode`,
      `${style.muted("^O")} ${detailsState}`,
      `${style.muted("^T")} ${thoughtsHint}`,
      `${style.muted("^Y")} copy`,
      `${style.muted("^G")} mouse:${mouseState}`,
      `${style.muted("/help")}`,
    ];
    const sep = style.border(" · ");
    const sepWidth = 3;
    const maxFooterWidth = Math.max(12, cols - 2);
    const keptFooter = [];
    let footerWidth = 0;
    for (const part of footerCandidates) {
      const w = displayWidth(part);
      const added = keptFooter.length === 0 ? w : sepWidth + w;
      if (footerWidth + added > maxFooterWidth) break;
      keptFooter.push(part);
      footerWidth += added;
    }
    defaultFooterLine = ` ${keptFooter.join(sep)}`;
    if (state.scrollOffset > 0 && !state.activeModalType) {
      footerLine = ` ${style.accentAlt(`↓ ${state.scrollOffset} lines below · End / Esc to jump to bottom`)}`;
    } else {
      footerLine = defaultFooterLine;
    }
  }
  lines.push(footerLine);

  // Persistent multi-agent progress dock below the composer (only when Swarm / Subagents are active)
  lines.push(
    ...renderSwarmDock(state.multiAgent, cols, style, state.spinnerFrame, {
      collapsed: Boolean(state.swarmDockCollapsed),
      focusedMemberId: state.focusedAgentId || "",
    }),
  );

  return {
    lines,
    defaultFooterLine,
    cursorOffsetRow: composerTopOffset + layout.cursorRow,
    cursorCol: 3 + layout.cursorCol,
  };
}

/**
 * Draws a centered, crisp transparent-background modal box over the viewport rows.
 */
export function applyOverlayModal(viewportRows, cols, modal, style) {
  const height = viewportRows.length;
  if (!modal || height < 4 || cols < 36) return viewportRows;

  const boxWidth = Math.min(Math.max(44, Math.floor(cols * 0.78)), cols - 4, 86);
  const innerWidth = boxWidth - 4;
  const contentLines = [];

  if (modal.type === "permission") {
    const p = modal.params || {};
    const title = p.title || p.toolCall?.title || "Permission required";
    contentLines.push(style.warnBold(truncateAnsi(title, innerWidth, "…")));
    if (p.description) {
      contentLines.push("");
      for (const l of wrapAnsiText(style.text(p.description), innerWidth).slice(0, 6)) {
        contentLines.push(l);
      }
    }
    if (modal.detailPreview) {
      contentLines.push("");
      const wrapped = wrapAnsiText(style.muted(modal.detailPreview), innerWidth);
      if (wrapped.length > 6) {
        contentLines.push(...wrapped.slice(0, 5), style.warn(`… (+${wrapped.length - 5} more lines)`));
      } else {
        contentLines.push(...wrapped);
      }
    }
    contentLines.push("");
    const options = Array.isArray(p.options) ? p.options : [];
    options.forEach((opt, idx) => {
      const label = `${idx + 1}. ${opt.name || opt.optionId}`;
      const desc = opt.kind ? style.muted(` (${opt.kind})`) : "";
      if (idx === modal.selected) {
        contentLines.push(style.selected(` ▸ ${truncateAnsi(label, innerWidth - 4, "…")} `));
      } else {
        contentLines.push(`   ${style.text(truncateAnsi(label, innerWidth - 16, "…"))}${desc}`);
      }
    });
    contentLines.push("");
    contentLines.push(style.muted("Press 1-9 or ↑/↓ + Enter to confirm · Esc to cancel"));
  } else if (modal.type === "picker") {
    const queryDisplay = modal.filter
      ? `${style.muted("Filter:")} ${style.text(modal.filter)}${style.accent("▏")}`
      : style.muted("Type to filter · ↑/↓ move · Enter select · Esc close");
    contentLines.push(truncateAnsi(queryDisplay, innerWidth, "…"));
    contentLines.push(style.border("─".repeat(innerWidth)));

    const items = modal.filteredItems || [];
    const maxItems = Math.max(4, Math.min(12, height - 8));
    if (items.length === 0) {
      contentLines.push(style.muted("No matching items."));
    } else {
      const { start, slice } = sliceCenteredWindow(items, modal.selected, maxItems);
      for (let i = 0; i < slice.length; i += 1) {
        const entry = slice[i];
        const isSel = start + i === modal.selected;
        const marker = entry.active ? style.success("●") : " ";
        const label = entry.label || "";
        const sub = entry.description ? `  ${entry.description}` : "";
        if (isSel) {
          contentLines.push(style.selected(` ▸ ${truncateAnsi(label + sub, innerWidth - 4, "…")} `));
        } else {
          const leftCap = Math.min(34, Math.floor(innerWidth * 0.52));
          const leftText = truncateAnsi(label, leftCap, "…");
          const rem = Math.max(0, innerWidth - displayWidth(leftText) - 5);
          const rightText = entry.description && rem > 6 ? `  ${style.muted(truncateAnsi(entry.description, rem, "…"))}` : "";
          contentLines.push(` ${marker} ${style.text(leftText)}${rightText}`);
        }
      }
    }
  } else if (modal.type === "help") {
    const rows = [
      ["Enter", "Send prompt (or steer while running)"],
      ["!<command>", "Run a local shell command directly (bypasses agent)"],
      ["Ctrl+J / Shift+Enter", "Insert newline in composer"],
      ["Esc", "Cancel running turn / close popup or modal"],
      ["Shift+Tab", "Cycle execution mode (default / accept-edits / auto / plan / bypass)"],
      ["Ctrl+B / /board", "Toggle Swarm & Subagent multi-pane board"],
      ["Alt+[ / Alt+]  /  Alt+B", "Inspect agent live stream  /  fold bottom agent dock"],
      ["Ctrl+O  /  Ctrl+T", "Toggle tool details  /  fold or expand thoughts (/thoughts)"],
      ["Mouse drag", "Select timeline text, copied on release (Ctrl+C copies again, Esc clears)"],
      ["Ctrl+Y  /  Ctrl+G", "Copy latest reply (OSC 52)  /  toggle mouse capture"],
      ["Ctrl+V  /  /image", "Attach clipboard image or image file (also @img.png / drag path)"],
      ["PgUp / PgDn / Wheel", "Scroll conversation history"],
      ["/model  /effort  /mode", "Switch model, thinking level, or mode"],
      ["/resume  /new", "Resume live background / saved session or start fresh"],
      ["/bg [prompt]", "Move session to background (survives SSH disconnect)"],
      ["/artifacts  /quota", "Preview session Markdown artifacts / check quota"],
      ["/theme  @path", "Switch transparent palette / attach workspace file"],
    ];
    for (const [k, v] of rows) {
      const left = padEndVisible(style.accent(k), 24);
      const right = truncateAnsi(style.muted(v), Math.max(10, innerWidth - 25), "…");
      contentLines.push(`${left} ${right}`);
    }
    contentLines.push("");
    contentLines.push(style.muted("Press Esc or Enter to close"));
  } else if (modal.type === "artifact") {
    const rendered = safeRenderMarkdown(modal.content || "", innerWidth, style);
    const maxBodyRows = Math.max(4, height - 6);
    const maxScroll = Math.max(0, rendered.length - maxBodyRows);
    const offset = Math.max(0, Math.min(modal.scrollOffset || 0, maxScroll));
    modal.maxScroll = maxScroll;
    const slice = rendered.slice(offset, offset + maxBodyRows);
    contentLines.push(...slice, "");
    const pos = maxScroll > 0 ? ` (${offset + 1}-${Math.min(rendered.length, offset + maxBodyRows)}/${rendered.length})` : "";
    contentLines.push(style.muted(`↑/↓ PgUp/PgDn scroll · Ctrl+Y copy · Esc close${pos}`));
  }

  const maxBody = Math.max(3, height - 4);
  const clippedBody = contentLines.slice(0, maxBody);
  const boxHeight = clippedBody.length + 2;
  const startRow = Math.max(0, Math.floor((height - boxHeight) / 2));
  const leftPad = " ".repeat(Math.max(0, Math.floor((cols - boxWidth) / 2)));

  const headerTitle = modal.title || "Dialog";
  const topRuleLen = Math.max(0, boxWidth - displayWidth(headerTitle) - 5);
  const boxLines = [
    `${leftPad}${style.border("╭─")} ${style.accentBold(headerTitle)} ${style.border("─".repeat(topRuleLen) + "╮")}`,
    ...clippedBody.map(
      (line) => `${leftPad}${style.border("│")} ${padEndVisible(line, innerWidth)} ${style.border("│")}`,
    ),
    `${leftPad}${style.border("╰" + "─".repeat(boxWidth - 2) + "╯")}`,
  ];

  const out = [...viewportRows];
  for (let i = 0; i < boxLines.length && startRow + i < height; i += 1) {
    out[startRow + i] = boxLines[i];
  }
  return out;
}
