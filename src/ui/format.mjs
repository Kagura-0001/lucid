import { displayWidth, truncateAnsi } from "../term/unicode.mjs";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const TERMINAL_TOOL_STATUSES = new Set(["completed", "failed", "error", "cancelled"]);

export function spinnerChar(frame) {
  return SPINNER_FRAMES[(frame || 0) % SPINNER_FRAMES.length];
}

export function isToolTerminalStatus(status) {
  return TERMINAL_TOOL_STATUSES.has(status);
}

export function formatDuration(ms) {
  if (!ms || ms < 0) return "";
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.floor(secs % 60);
  return `${mins}m${rem}s`;
}

export function formatElapsed(startedAt, endedAt = Date.now()) {
  if (!startedAt) return "";
  const secs = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${secs % 60}s`;
  return `${Math.floor(mins / 60)}h${mins % 60}m`;
}

export function formatRelativeTime(isoOrMs) {
  if (!isoOrMs) return "";
  const ts = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (Number.isNaN(ts)) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

export function sliceCenteredWindow(items, selectedIndex, maxVisible, bias = Math.floor(maxVisible / 2)) {
  const start = Math.max(0, Math.min(selectedIndex - bias, items.length - maxVisible));
  return { start, slice: items.slice(start, start + maxVisible) };
}

export function alignLeftRight(left, right, width, minGap = 2) {
  if (right) {
    const leftWidth = displayWidth(left);
    const rightWidth = displayWidth(right);
    if (leftWidth + rightWidth + minGap <= width) {
      return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
    }
  }
  return truncateAnsi(left, width, "…");
}
