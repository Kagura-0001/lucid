import { highlightVisibleColumns, sliceVisibleColumns } from "../term/unicode.mjs";

/**
 * Mouse text selection over the conversation timeline.
 *
 * Positions are stored in timeline coordinates — `line` is an index into the
 * full list of rendered timeline lines and `col` is a 0-based screen column —
 * so a selection stays attached to its text while the view scrolls or new
 * output streams in below it.
 */

export function createSelection(line, col) {
  return {
    anchor: { line, col },
    head: { line, col },
    dragging: true,
  };
}

export function cloneSelection(selection) {
  if (!selection) return null;
  return {
    anchor: { line: selection.anchor.line, col: selection.anchor.col },
    head: { line: selection.head.line, col: selection.head.col },
    dragging: Boolean(selection.dragging),
  };
}

function comparePositions(a, b) {
  if (a.line !== b.line) return a.line - b.line;
  return a.col - b.col;
}

/**
 * Returns the selection as an ordered { start, end } pair, where `end.col` is
 * exclusive (the character under the mouse when released is included).
 */
export function orderedSelectionRange(selection) {
  const anchorFirst = comparePositions(selection.anchor, selection.head) <= 0;
  const first = anchorFirst ? selection.anchor : selection.head;
  const last = anchorFirst ? selection.head : selection.anchor;
  return {
    start: { line: first.line, col: first.col },
    end: { line: last.line, col: last.col + 1 },
  };
}

export function isSelectionEmpty(selection) {
  if (!selection) return true;
  return comparePositions(selection.anchor, selection.head) === 0;
}

/**
 * Column range [fromCol, toCol) selected on a given timeline line, or null when
 * the line is outside the selection.
 */
function selectedColumnsOnLine(range, lineIndex) {
  if (lineIndex < range.start.line || lineIndex > range.end.line) {
    return null;
  }
  const fromCol = lineIndex === range.start.line ? range.start.col : 0;
  const toCol = lineIndex === range.end.line ? range.end.col : Number.POSITIVE_INFINITY;
  return { fromCol, toCol };
}

/**
 * Applies reverse-video highlighting to the visible viewport rows.
 * `firstLineIndex` is the timeline index of viewportRows[0].
 */
export function highlightSelectionInViewport(viewportRows, firstLineIndex, selection) {
  if (!selection || isSelectionEmpty(selection)) {
    return viewportRows;
  }
  const range = orderedSelectionRange(selection);
  return viewportRows.map((row, offset) => {
    const columns = selectedColumnsOnLine(range, firstLineIndex + offset);
    if (!columns) return row;
    return highlightVisibleColumns(row, columns.fromCol, columns.toCol);
  });
}

function sameColumnRange(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.fromCol === b.fromCol && a.toCol === b.toCol;
}

/**
 * Updates only the viewport rows whose highlight changed between `prevSelection`
 * and `nextSelection`, writing into `frameRows` in place starting at `topRow`.
 * Returns the number of rows touched.
 */
export function patchSelectionInFrame({
  frameRows,
  viewportRawRows,
  topRow,
  firstLineIndex,
  prevSelection,
  nextSelection,
}) {
  const prevRange = prevSelection && !isSelectionEmpty(prevSelection) ? orderedSelectionRange(prevSelection) : null;
  const nextRange = nextSelection && !isSelectionEmpty(nextSelection) ? orderedSelectionRange(nextSelection) : null;
  if (!prevRange && !nextRange) {
    return 0;
  }

  let touched = 0;
  for (let offset = 0; offset < viewportRawRows.length; offset += 1) {
    const lineIndex = firstLineIndex + offset;
    const prevCols = prevRange ? selectedColumnsOnLine(prevRange, lineIndex) : null;
    const nextCols = nextRange ? selectedColumnsOnLine(nextRange, lineIndex) : null;
    if (sameColumnRange(prevCols, nextCols)) {
      continue;
    }
    const rawRow = viewportRawRows[offset];
    frameRows[topRow + offset] = nextCols
      ? highlightVisibleColumns(rawRow, nextCols.fromCol, nextCols.toCol)
      : rawRow;
    touched += 1;
  }
  return touched;
}

function leadingSpaceCount(text) {
  const match = /^ */.exec(text);
  return match ? match[0].length : 0;
}

/**
 * Extracts the selected text as plain text: trailing spaces are trimmed on
 * every line and the indentation shared by all non-empty lines is removed.
 */
export function extractSelectionText(timelineLines, selection) {
  if (!selection || isSelectionEmpty(selection)) return "";
  const range = orderedSelectionRange(selection);
  const lastLine = Math.min(range.end.line, timelineLines.length - 1);

  const pieces = [];
  const firstLineIndex = Math.max(0, range.start.line);
  for (let lineIndex = firstLineIndex; lineIndex <= lastLine; lineIndex += 1) {
    const columns = selectedColumnsOnLine(range, lineIndex);
    const piece = sliceVisibleColumns(timelineLines[lineIndex] || "", columns.fromCol, columns.toCol);
    pieces.push(piece.trimEnd());
  }

  // The first piece usually starts mid-row, so its screen indentation is its
  // start column plus any spaces that were selected.
  const firstPieceOffset = firstLineIndex === range.start.line ? range.start.col : 0;
  const screenIndent = (piece, pieceIndex) => {
    const offset = pieceIndex === 0 ? firstPieceOffset : 0;
    return offset + leadingSpaceCount(piece);
  };

  const indents = [];
  pieces.forEach((piece, pieceIndex) => {
    if (piece.trim() !== "") indents.push(screenIndent(piece, pieceIndex));
  });
  if (indents.length === 0) return "";
  const sharedIndent = Math.min(...indents);

  const dedented = pieces.map((piece, pieceIndex) => {
    const offset = pieceIndex === 0 ? firstPieceOffset : 0;
    const removable = Math.max(0, Math.min(sharedIndent - offset, leadingSpaceCount(piece)));
    return piece.slice(removable);
  });

  // Drop blank lines at the start and end of the selection.
  while (dedented.length > 0 && dedented[0].trim() === "") dedented.shift();
  while (dedented.length > 0 && dedented[dedented.length - 1].trim() === "") dedented.pop();
  return dedented.join("\n");
}
