import path from "node:path";
import { displayWidth, padEndVisible, truncateAnsi, wrapAnsiLine, wrapAnsiText } from "../term/unicode.mjs";
import { renderDiffLines } from "./diff.mjs";
import { formatBytes } from "./files.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { renderSwarmStrip } from "./swarm.mjs";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const itemRenderCache = new WeakMap();

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

export function formatDuration(ms) {
  if (!ms || ms < 0) return "";
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.floor(secs % 60);
  return `${mins}m${rem}s`;
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
  const leftW = displayWidth(leftStr);
  const rightW = displayWidth(rightStr);

  let topLine;
  if (rightW > 0 && leftW + rightW + 4 <= cols) {
    const gap = cols - leftW - rightW - 2;
    topLine = ` ${leftStr}${" ".repeat(gap)}${rightStr} `;
  } else {
    topLine = ` ${truncateAnsi(leftStr, cols - 2, "…")} `;
  }

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
      ? `${style.warn(SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length])} Connecting to ${style.bold(state.agentLabel || "ACP agent")}…`
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

function renderToolItem(item, maxWidth, style, state) {
  const lines = [];
  const spinner = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length];

  let icon;
  if (item.status === "completed") {
    icon = style.success("✓");
  } else if (item.status === "failed" || item.status === "error") {
    icon = style.error("✗");
  } else if (item.status === "cancelled") {
    icon = style.muted("○");
  } else {
    icon = style.warn(spinner);
  }

  const fullTitle = String(item.title || item.name || item.kind || "Tool");
  // Multi-line commands (heredocs, scripts) are summarized as their first line in
  // the one-row header; the full command is in the expanded details (Ctrl+O).
  const titleLines = fullTitle
    .replace(/\t/g, "    ")
    .split(/\r\n|\r|\n/)
    .filter((line) => line.trim() !== "");
  const title = titleLines.length > 0 ? titleLines[0] : "Tool";
  const hiddenLineCount = Math.max(0, titleLines.length - 1);
  const moreLinesTag = hiddenLineCount > 0 ? style.muted(` (+${hiddenLineCount} lines)`) : "";
  const kindTag = item.kind ? style.muted(` [${item.kind}]`) : "";
  const durTag = item.durationMs ? style.muted(` · ${formatDuration(item.durationMs)}`) : "";

  const titleWidth = Math.max(20, maxWidth - 20 - (hiddenLineCount > 0 ? 14 : 0));
  const headerText = `${icon} ${style.bold(truncateAnsi(title, titleWidth, "…"))}${moreLinesTag}${kindTag}${durTag}`;
  lines.push(`  ${headerText}`);

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

  // Show text output & input details when expanded (Ctrl+O) or on failure
  const showDetails = state.expandTools || item.status === "failed" || item.status === "error";
  if (showDetails) {
    if (item.rawInputSummary) {
      const wrappedIn = wrapAnsiText(style.muted(item.rawInputSummary), Math.max(16, maxWidth - 8));
      for (const l of wrappedIn.slice(0, state.expandTools ? 12 : 3)) {
        lines.push(`    ${style.border("│")} ${l}`);
      }
    }
    if (item.outputText) {
      const rawOutLines = item.outputText.replace(/\r\n/g, "\n").split("\n");
      const maxOut = state.expandTools ? 24 : 6;
      const slice = rawOutLines.slice(0, maxOut);
      for (const ol of slice) {
        const wrapped = wrapAnsiLine(style.muted(ol.replace(/\t/g, "    ")), Math.max(16, maxWidth - 8));
        for (const wl of wrapped) {
          lines.push(`    ${style.border("│")} ${wl}`);
        }
      }
      if (rawOutLines.length > maxOut) {
        lines.push(`    ${style.border("│")} ${style.muted(`… ${rawOutLines.length - maxOut} more lines`)}`);
      }
    }
  } else if (item.outputPreview && (!item.diffs || item.diffs.length === 0)) {
    lines.push(`    ${style.border("└")} ${style.muted(truncateAnsi(item.outputPreview, Math.max(16, maxWidth - 8), "…"))}`);
  }

  return lines;
}

function renderThoughtItem(item, maxWidth, style, state) {
  const thoughtMode = resolveThoughtMode(state);
  if (thoughtMode === "hidden") return [];

  const text = (item.text || "").trim();
  if (!text) return [];

  const isLive = Boolean(item.streaming);
  const dur = item.durationMs ? ` · ${formatDuration(item.durationMs)}` : "";

  if (thoughtMode === "expanded") {
    const lines = [];
    const labelIcon = isLive ? style.thought(SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]) : style.thought("▾");
    const titleLabel = isLive ? `Thinking${dur}` : `Thought${dur}`;
    lines.push(`  ${labelIcon} ${style.thought(titleLabel)}`);
    const wrapped = wrapAnsiText(style.thought(text), Math.max(16, maxWidth - 6));
    for (const w of wrapped) {
      lines.push(`    ${style.border("│")} ${w}`);
    }
    return lines;
  }

  // Folded mode (default, Claude Code style)
  if (isLive) {
    const spin = style.thought(SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]);
    return [`  ${spin} ${style.thought(`Thinking${dur}`)}  ${style.muted("(Ctrl+T to expand)")}`];
  }
  return [renderFoldedThoughtSummary(1, item.durationMs || 0, style)];
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

function renderUserItem(item, contentWidth, style) {
  const out = [];
  const rawLines = String(item.text || "").split("\n");
  let firstLine = true;
  for (const rl of rawLines) {
    const wrapped = wrapAnsiLine(style.bold(rl), Math.max(16, contentWidth - 2));
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
  const out = [];
  const mdLines = renderMarkdown(item.text || "", contentWidth, style);
  for (const ml of mdLines) {
    out.push(ml ? `  ${ml}` : "");
  }
  return out;
}

function renderNoticeItem(item, contentWidth, style) {
  const marker =
    item.level === "error"
      ? style.errorBold("!")
      : item.level === "warn"
        ? style.warnBold("!")
        : style.muted("·");
  const textStyled =
    item.level === "error"
      ? style.error(item.text)
      : item.level === "warn"
        ? style.warn(item.text)
        : style.muted(item.text);
  const wrapped = wrapAnsiText(textStyled, Math.max(16, contentWidth - 2));
  return wrapped.map((wl, wIdx) => (wIdx === 0 ? `  ${marker} ${wl}` : `    ${wl}`));
}

function isCacheableTimelineItem(item, thoughtMode) {
  if (!item || typeof item !== "object") return false;
  switch (item.type) {
    case "user":
    case "notice":
    case "plan":
      return true;
    case "tool":
      return ["completed", "failed", "error", "cancelled"].includes(item.status);
    case "assistant":
      return !item.streaming;
    case "thought":
      return thoughtMode === "expanded" && !item.streaming;
    default:
      return false;
  }
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

export function renderTimeline(state, cols, style) {
  if (state.items.length === 0) {
    return renderWelcome(state, cols, style);
  }

  const contentWidth = Math.max(24, cols - 4);
  const thoughtMode = resolveThoughtMode(state);
  const lines = [""];

  let foldedThoughtCount = 0;
  let foldedThoughtMs = 0;
  let hasPendingFolded = false;
  let lastEmittedType = null;

  const flushFoldedThoughts = () => {
    if (!hasPendingFolded) return;
    lines.push(renderFoldedThoughtSummary(foldedThoughtCount, foldedThoughtMs, style));
    foldedThoughtCount = 0;
    foldedThoughtMs = 0;
    hasPendingFolded = false;
    lastEmittedType = "thought";
  };

  const pushLines = (chunk) => {
    for (let i = 0; i < chunk.length; i += 1) {
      lines.push(chunk[i]);
    }
  };

  for (let idx = 0; idx < state.items.length; idx += 1) {
    const item = state.items[idx];

    if (item.type === "user") {
      flushFoldedThoughts();
      if (lines.length > 1) lines.push("");
      const userLines = renderCachedTimelineItem(item, cols, contentWidth, style, state, thoughtMode, () =>
        renderUserItem(item, contentWidth, style),
      );
      pushLines(userLines);
      lastEmittedType = "user";
      continue;
    }

    if (item.type === "thought") {
      if (thoughtMode === "hidden") {
        continue;
      }
      if (thoughtMode === "fold") {
        if (item.streaming) {
          const combinedMs = foldedThoughtMs + (item.durationMs || 0);
          const spin = style.thought(SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length]);
          const dur = combinedMs > 0 ? ` · ${formatDuration(combinedMs)}` : "";
          const stepTag = foldedThoughtCount > 0 ? ` · ${foldedThoughtCount + 1} steps` : "";
          lines.push(`  ${spin} ${style.thought(`Thinking${dur}`)}${style.muted(`${stepTag}  (Ctrl+T to expand)`)}`);
          foldedThoughtCount = 0;
          foldedThoughtMs = 0;
          hasPendingFolded = false;
          lastEmittedType = "thought";
        } else if ((item.text || "").trim()) {
          foldedThoughtCount += 1;
          foldedThoughtMs += item.durationMs || 0;
          hasPendingFolded = true;
        }
        continue;
      }

      const thoughtLines = renderCachedTimelineItem(item, cols, contentWidth, style, state, thoughtMode, () =>
        renderThoughtItem(item, contentWidth, style, state),
      );
      if (thoughtLines.length > 0) {
        pushLines(thoughtLines);
        lastEmittedType = "thought";
      }
      continue;
    }

    if (item.type === "tool") {
      const toolLines = renderCachedTimelineItem(item, cols, contentWidth, style, state, thoughtMode, () =>
        renderToolItem(item, contentWidth, style, state),
      );
      pushLines(toolLines);
      lastEmittedType = "tool";
      continue;
    }

    if (item.type === "plan") {
      const planLines = renderCachedTimelineItem(item, cols, contentWidth, style, state, thoughtMode, () =>
        renderPlanItem(item, contentWidth, style),
      );
      if (planLines.length > 0) {
        pushLines(planLines);
        lastEmittedType = "plan";
      }
      continue;
    }

    if (item.type === "assistant") {
      flushFoldedThoughts();
      if (lastEmittedType === "tool" || lastEmittedType === "thought" || lastEmittedType === "plan") {
        lines.push("");
      }
      const assistantLines = renderCachedTimelineItem(item, cols, contentWidth, style, state, thoughtMode, () =>
        renderAssistantItem(item, contentWidth, style),
      );
      pushLines(assistantLines);
      if (item.streaming) {
        lines.push(`  ${style.accent(SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length])}`);
      }
      lines.push("");
      lastEmittedType = "assistant";
      continue;
    }

    if (item.type === "notice") {
      flushFoldedThoughts();
      const noticeLines = renderCachedTimelineItem(item, cols, contentWidth, style, state, thoughtMode, () =>
        renderNoticeItem(item, contentWidth, style),
      );
      pushLines(noticeLines);
      lastEmittedType = "notice";
    }
  }

  flushFoldedThoughts();
  return lines;
}

export function renderAutocompletePopup(popup, cols, style) {
  if (!popup || !Array.isArray(popup.items) || popup.items.length === 0) {
    return [];
  }

  const maxVisible = Math.min(8, popup.items.length);
  const start = Math.max(0, Math.min(popup.selected - Math.floor(maxVisible / 2), popup.items.length - maxVisible));
  const slice = popup.items.slice(start, start + maxVisible);
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

  // Live Swarm / Subagent / Artifact indicator (only shown when active)
  const swarmStrip = renderSwarmStrip(state.multiAgent, cols, style, state.spinnerFrame);
  if (swarmStrip) {
    lines.push(swarmStrip);
  }

  // Staged image attachments strip (only shown when images are queued)
  if (Array.isArray(state.stagedImages) && state.stagedImages.length > 0) {
    const pills = state.stagedImages
      .map((img) => style.warn(`🖼 ${img.label} (${formatBytes(img.sizeBytes)})`))
      .join("  ");
    const clearHint = style.muted(" · /unattach to clear");
    lines.push(` ${truncateAnsi(`${pills}${clearHint}`, cols - 2, "…")}`);
  }

  const thoughtMode = resolveThoughtMode(state);

  // Optional status strip right above the composer hairline
  const statusPieces = [];
  if (state.activeModalType === "permission") {
    statusPieces.push(
      truncateAnsi(
        `${style.warnBold("⚠ Permission approval required above")} ${style.muted("· press 1-9, ↑/↓ + Enter, or Esc to deny")}`,
        Math.max(16, cols - 2),
        "…",
      ),
    );
  } else if (state.activeModalType === "picker") {
    statusPieces.push(
      truncateAnsi(
        `${style.accent("▸ Picker open")} ${style.muted("· type to filter, ↑/↓ + Enter to select, Esc to close")}`,
        Math.max(16, cols - 2),
        "…",
      ),
    );
  } else if (state.busy) {
    const spin = SPINNER_FRAMES[state.spinnerFrame % SPINNER_FRAMES.length];
    const items = Array.isArray(state.items) ? state.items : [];
    const lastItem = items.length > 0 ? items[items.length - 1] : null;
    const isThinkingHidden = thoughtMode === "hidden" && lastItem?.type === "thought" && lastItem?.streaming;
    if (isThinkingHidden) {
      const tDur = lastItem.durationMs ? ` · ${formatDuration(lastItem.durationMs)}` : "";
      statusPieces.push(`${style.thought(spin)} ${style.muted(`Working · thinking${tDur} · ^T show · Esc cancel`)}`);
    } else {
      const elapsed = state.turnStartedAt ? ` · ${formatDuration(Date.now() - state.turnStartedAt)}` : "";
      statusPieces.push(`${style.accent(spin)} ${style.muted(`Working${elapsed} · Esc cancel · type to steer`)}`);
    }
  } else if (state.toast && Date.now() < state.toast.expiresAt) {
    const tone = state.toast.level === "error" ? style.error : style.success;
    statusPieces.push(tone(state.toast.text));
  }

  if (state.scrollOffset > 0 && !state.activeModalType) {
    statusPieces.push(style.accentAlt(`↓ ${state.scrollOffset} lines below · End to jump`));
  }

  if (statusPieces.length > 0) {
    lines.push(` ${statusPieces.join(style.border("  ·  "))}`);
  }

  lines.push(style.border("─".repeat(cols)));

  const composerTopOffset = lines.length;
  const isEmpty = state.composer.isEmpty();

  for (let i = 0; i < layout.lines.length; i += 1) {
    const promptPrefix = i === 0 ? ` ${style.accentBold("❯")} ` : ` ${style.border("│")} `;
    if (isEmpty && i === 0) {
      const placeholder =
        state.activeModalType === "permission"
          ? "Respond to permission prompt above (1-9 / Enter / Esc)…"
          : state.activeModalType === "picker"
            ? "Type in the picker above to filter…"
            : state.busy
              ? "Type to steer the running turn…"
              : "Message agent…  (/ commands · @ files · Shift+Tab mode)";
      lines.push(`${promptPrefix}${style.muted(truncateAnsi(placeholder, inputWidth, "…"))}`);
    } else {
      lines.push(`${promptPrefix}${layout.lines[i]}`);
    }
  }

  lines.push(style.border("─".repeat(cols)));

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
  const footerLine = ` ${keptFooter.join(sep)}`;
  lines.push(footerLine);

  return {
    lines,
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
      for (const l of wrapAnsiText(style.muted(modal.detailPreview), innerWidth).slice(0, 6)) {
        contentLines.push(l);
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
      const start = Math.max(0, Math.min(modal.selected - Math.floor(maxItems / 2), items.length - maxItems));
      const slice = items.slice(start, start + maxItems);
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
      ["Ctrl+J / Shift+Enter", "Insert newline in composer"],
      ["Esc", "Cancel running turn / close popup or modal"],
      ["Shift+Tab", "Cycle execution mode (default / accept-edits / auto / plan)"],
      ["Ctrl+B / /board", "Toggle Swarm & Subagent multi-pane board"],
      ["Ctrl+O  /  Ctrl+T", "Toggle tool details  /  fold or expand thoughts (/thoughts)"],
      ["Mouse drag", "Select timeline text, copied on release (Ctrl+C copies again, Esc clears)"],
      ["Ctrl+Y  /  Ctrl+G", "Copy latest reply (OSC 52)  /  toggle mouse capture"],
      ["Ctrl+V  /  /image", "Attach clipboard image or image file (also @img.png / drag path)"],
      ["PgUp / PgDn / Wheel", "Scroll conversation history"],
      ["/model  /effort  /mode", "Switch model, thinking level, or mode"],
      ["/resume  /new", "Resume session (/sessions) or start fresh"],
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
    const rendered = renderMarkdown(modal.content || "", innerWidth, style);
    const maxBodyRows = Math.max(4, height - 6);
    const maxScroll = Math.max(0, rendered.length - maxBodyRows);
    const offset = Math.max(0, Math.min(modal.scrollOffset || 0, maxScroll));
    modal.maxScroll = maxScroll;
    const slice = rendered.slice(offset, offset + maxBodyRows);
    for (const l of slice) {
      contentLines.push(l);
    }
    contentLines.push("");
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
