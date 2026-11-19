import { wrapAnsiLine } from "../term/unicode.mjs";

function splitLines(text) {
  if (!text) return [];
  const normalized = String(text).replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return trimmed.length === 0 ? [] : trimmed.split("\n");
}

/**
 * Computes line-level diff operations between oldLines and newLines.
 * Uses classic DP LCS for reasonably sized files and falls back to prefix/suffix
 * trimming when files are very large to keep TUI rendering instant.
 */
export function computeLineDiff(oldText, newText) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length === 0 && newLines.length === 0) {
    return { ops: [], additions: 0, deletions: 0 };
  }

  // Trim identical leading and trailing lines first
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const midOld = oldLines.slice(prefix, oldLines.length - suffix);
  const midNew = newLines.slice(prefix, newLines.length - suffix);

  const ops = [];
  for (let i = 0; i < prefix; i += 1) {
    ops.push({ type: "equal", oldLine: i + 1, newLine: i + 1, text: oldLines[i] });
  }

  let additions = 0;
  let deletions = 0;

  if (midOld.length * midNew.length <= 40000) {
    const n = midOld.length;
    const m = midNew.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));

    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        if (midOld[i] === midNew[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
        }
      }
    }

    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midOld[i] === midNew[j]) {
        ops.push({ type: "equal", oldLine: prefix + i + 1, newLine: prefix + j + 1, text: midOld[i] });
        i += 1;
        j += 1;
      } else if (i < n && (j === m || dp[i + 1][j] >= dp[i][j + 1])) {
        ops.push({ type: "del", oldLine: prefix + i + 1, newLine: null, text: midOld[i] });
        deletions += 1;
        i += 1;
      } else {
        ops.push({ type: "add", oldLine: null, newLine: prefix + j + 1, text: midNew[j] });
        additions += 1;
        j += 1;
      }
    }
  } else {
    // Fast fallback for huge diffs
    for (let i = 0; i < midOld.length; i += 1) {
      ops.push({ type: "del", oldLine: prefix + i + 1, newLine: null, text: midOld[i] });
      deletions += 1;
    }
    for (let j = 0; j < midNew.length; j += 1) {
      ops.push({ type: "add", oldLine: null, newLine: prefix + j + 1, text: midNew[j] });
      additions += 1;
    }
  }

  for (let k = 0; k < suffix; k += 1) {
    const oldIdx = oldLines.length - suffix + k;
    const newIdx = newLines.length - suffix + k;
    ops.push({ type: "equal", oldLine: oldIdx + 1, newLine: newIdx + 1, text: oldLines[oldIdx] });
  }

  return { ops, additions, deletions };
}

/**
 * Renders a transparent-background unified diff with subtle rails and line numbers.
 */
export function renderDiffLines({ pathLabel, oldText, newText, maxWidth, style, maxOutputLines = 36 }) {
  const { ops, additions, deletions } = computeLineDiff(oldText, newText);
  const lines = [];
  const rail = style.border("│");

  const stats = `${style.diffAdd(`+${additions}`)} ${style.diffDel(`-${deletions}`)}`;
  if (pathLabel) {
    lines.push(`${style.border("╭─")} ${style.muted(pathLabel)} ${stats}`);
  }

  // Keep up to 2 context lines around each change
  const contextRadius = 2;
  const keep = new Uint8Array(ops.length);
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i].type !== "equal") {
      const start = Math.max(0, i - contextRadius);
      const end = Math.min(ops.length - 1, i + contextRadius);
      for (let k = start; k <= end; k += 1) {
        keep[k] = 1;
      }
    }
  }

  const contentWidth = Math.max(16, maxWidth - 10);
  let emitted = 0;
  let truncated = false;
  let lastKeptIdx = -1;

  for (let i = 0; i < ops.length; i += 1) {
    if (!keep[i]) continue;

    if (emitted >= maxOutputLines) {
      truncated = true;
      break;
    }

    if (lastKeptIdx !== -1 && i > lastKeptIdx + 1) {
      lines.push(`${rail} ${style.diffHunk("···")}`);
      emitted += 1;
    }
    lastKeptIdx = i;

    const op = ops[i];
    const lineNo = op.type === "del" ? op.oldLine : op.newLine;
    const gutter = style.muted(String(lineNo ?? "").padStart(4, " "));
    const wrapped = wrapAnsiLine(op.text.replace(/\t/g, "    "), contentWidth);

    for (let wIdx = 0; wIdx < wrapped.length; wIdx += 1) {
      if (emitted >= maxOutputLines) {
        truncated = true;
        break;
      }
      const chunk = wrapped[wIdx];
      const prefixNo = wIdx === 0 ? gutter : "    ";
      if (op.type === "add") {
        lines.push(`${rail} ${prefixNo} ${style.diffAdd(`+ ${chunk}`)}`);
      } else if (op.type === "del") {
        lines.push(`${rail} ${prefixNo} ${style.diffDel(`- ${chunk}`)}`);
      } else {
        lines.push(`${rail} ${prefixNo} ${style.muted(`  ${chunk}`)}`);
      }
      emitted += 1;
    }
  }

  if (truncated) {
    lines.push(`${rail} ${style.muted("… (diff truncated; press Ctrl+O for expanded view)")}`);
  }
  if (pathLabel) {
    lines.push(style.border("╰─"));
  }

  return { lines, additions, deletions };
}
