import { copyToClipboardOsc52 } from "../term/ansi.mjs";
import { formatBytes, tryLoadDroppedImage } from "../ui/files.mjs";
import {
  cloneSelection,
  createSelection,
  extractSelectionText,
  highlightSelectionInViewport,
  isSelectionEmpty,
  patchSelectionInFrame,
} from "../ui/selection.mjs";
import { cancelLocalShell } from "./local_shell.mjs";

export function createPacedScheduler(minIntervalMs, flushFn) {
  let queued = false;
  let timer = null;
  let lastRunAt = 0;

  const run = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    flushFn();
    lastRunAt = Date.now();
  };

  return {
    schedule() {
      if (queued || timer) return;
      const elapsed = Date.now() - lastRunAt;
      if (elapsed >= minIntervalMs) {
        queued = true;
        queueMicrotask(() => {
          queued = false;
          run();
        });
      } else {
        timer = setTimeout(run, minIntervalMs - elapsed);
      }
    },
    flush: run,
    cancel() {
      queued = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function sliceViewportRows(timelineLines, viewportHeight, scrollOffset, selection) {
  const maxScroll = Math.max(0, timelineLines.length - viewportHeight);
  const clampedOffset = Math.max(0, Math.min(scrollOffset, maxScroll));
  const endIdx = timelineLines.length - clampedOffset;
  const startIdx = Math.max(0, endIdx - viewportHeight);
  const rawViewportRows = timelineLines.slice(startIdx, endIdx);
  while (rawViewportRows.length < viewportHeight) {
    rawViewportRows.push("");
  }
  const visibleRows = selection ? highlightSelectionInViewport(rawViewportRows, startIdx, selection) : rawViewportRows;
  return { maxScroll, scrollOffset: clampedOffset, startIdx, rawViewportRows, visibleRows };
}

function isPlainVerticalArrow(ev) {
  return (
    ev &&
    ev.type === "key" &&
    !ev.ctrl &&
    !ev.alt &&
    !ev.shift &&
    (ev.name === "up" || ev.name === "down")
  );
}

/**
 * Catches Alternate Scroll arrow bursts (2+ same-direction Up/Down arrows in one
 * chunk, or trailing ticks within 180 ms) from terminals or multiplexers such as
 * tmux with `mouse off` that still translate wheel notches into arrow keys even
 * when ?1007l or ?1000h is active. Single Up/Down presses still recall prompt history.
 */
export function dispatchInputBatch(app, events) {
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (!app.modal && !app.boardOpen && !app.popup && isPlainVerticalArrow(ev)) {
      let j = i + 1;
      while (j < events.length && isPlainVerticalArrow(events[j]) && events[j].name === ev.name) {
        j += 1;
      }
      const runLen = j - i;
      const now = Date.now();
      const continuingAltScroll = now - app.lastAltScrollAt < 180;

      if (runLen >= 2 || continuingAltScroll) {
        const direction = ev.name === "up" ? 1 : -1;
        app.lastAltScrollAt = now;
        app.scrollBy(direction * runLen);
        i = j;
        continue;
      }
    }

    handleInputEvent(app, ev);
    i += 1;
  }
}

function buildPickerSearchHaystack(item) {
  if (typeof item.searchText === "string" && item.searchText) {
    return item.searchText.toLowerCase();
  }
  return [
    item.label || "",
    item.description || "",
    item.preview || "",
    item.cwd || "",
    String(item.value || ""),
  ]
    .join(" ")
    .toLowerCase();
}

export function refreshPickerFilter(modal, { resetSelection = false } = {}) {
  if (!modal || modal.type !== "picker") return;
  const all = modal.allItems || [];
  const scope = modal.scopeFilter;
  const scoped = scope && typeof scope.matches === "function"
    ? all.filter((item) => scope.matches(item, scope.active))
    : all;
  modal.scopedCount = scoped.length;

  const tokens = (modal.filter || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const filtered = tokens.length > 0
    ? scoped.filter((item) => {
        const haystack = buildPickerSearchHaystack(item);
        return tokens.every((token) => haystack.includes(token));
      })
    : scoped;
  modal.filteredItems = filtered;
  if (resetSelection) {
    modal.selected = 0;
  } else {
    modal.selected = Math.min(modal.selected, Math.max(0, filtered.length - 1));
  }
}

function scheduleSelectionPatch(app) {
  if (!app.exiting) app.selectionScheduler.schedule();
}

function wrapIndex(index, delta, length) {
  return (index + delta + length) % length;
}

function getValidTimelineLayout(app) {
  if (app.exiting) return null;
  const layout = app.timelineLayout;
  if (!layout || app.modal || app.boardOpen) {
    app.scheduleRender(true);
    return null;
  }
  const { cols, rows } = app.renderer.getSize();
  if (cols !== layout.cols || rows !== layout.rows) {
    app.renderNow();
    return null;
  }
  return layout;
}

export function handleInputEvent(app, event) {
  if (app.exiting) return;

  if (event.type === "mouse") {
    handleMouseEvent(app, event);
    return;
  }

  if (event.type === "paste") {
    if (app.modal && app.modal.type === "picker") {
      app.modal.filter = (app.modal.filter || "") + event.text.replace(/\n/g, " ");
      refreshPickerFilter(app.modal, { resetSelection: true });
      app.scheduleRender(true);
      return;
    }
    if (!app.modal) {
      if (app.boardOpen) app.boardOpen = false;
      const droppedImg = tryLoadDroppedImage(event.text, app.cwd);
      if (droppedImg) {
        app.state.stagedImages.push(droppedImg);
        app.showToast(`Attached image: ${droppedImg.label} (${formatBytes(droppedImg.sizeBytes)})`);
        app.scheduleRender(true);
        return;
      }
      const pasted = app.state.composer.insertPaste(event.text);
      if (pasted.collapsed) {
        app.showToast(`Pasted ${pasted.lineCount} lines (${pasted.charCount} chars) — full text sent on Enter`);
      }
      app.updatePopupState();
      app.scheduleRender(true);
    }
    return;
  }

  if (app.modal) {
    handleModalInput(app, event);
    return;
  }

  if (app.boardOpen) {
    handleBoardInput(app, event);
    return;
  }

  if (event.type === "text") {
    app.state.composer.insert(event.text);
    app.dismissedPopupKey = null;
    app.updatePopupState();
    app.scheduleRender(true);
    return;
  }

  if (event.type === "key") {
    handleMainKey(app, event);
  }
}

function clampScroll(current, delta, max) {
  return Math.max(0, Math.min(max || 0, (current || 0) + delta));
}

export function handleMouseEvent(app, event) {
  const wheelDir = event.action === "wheelUp" ? -1 : event.action === "wheelDown" ? 1 : 0;

  if (app.modal) {
    if (!wheelDir) return;
    if (app.modal.type === "artifact") {
      app.modal.scrollOffset = clampScroll(app.modal.scrollOffset, wheelDir * 3, app.modal.maxScroll);
      app.scheduleRender(true);
    } else if (app.modal.type === "picker") {
      const count = (app.modal.filteredItems || []).length;
      if (count > 0) {
        app.modal.selected = clampScroll(app.modal.selected, wheelDir, count - 1);
        app.scheduleRender(true);
      }
    }
    return;
  }

  if (app.boardOpen) {
    if (wheelDir) {
      app.boardState.scrollOffset = clampScroll(app.boardState.scrollOffset, wheelDir * 3, app.boardState.maxDetailScroll);
      app.boardState.stickToBottom = app.boardState.scrollOffset >= app.boardState.maxDetailScroll;
      app.scheduleRender(true);
    }
    return;
  }

  if (wheelDir) {
    app.scrollBy(-wheelDir * 3);
  } else if (event.action === "leftDown" || event.action === "leftDrag" || event.action === "leftUp") {
    handleSelectionMouse(app, event);
  }
}

function screenRowToTimelineLine(app, screenRow, clamp) {
  const layout = app.timelineLayout;
  if (!layout) return null;
  let viewportRow = screenRow - 1 - layout.topRow;
  if ((viewportRow < 0 || viewportRow >= layout.height) && !clamp) return null;
  viewportRow = Math.max(0, Math.min(layout.height - 1, viewportRow));
  return layout.firstLineIndex + viewportRow;
}

export function flushSelectionPatch(app) {
  const layout = getValidTimelineLayout(app);
  if (!layout) return;
  const touched = patchSelectionInFrame({
    frameRows: layout.frameRows,
    viewportRawRows: layout.viewportRawRows,
    topRow: layout.topRow,
    firstLineIndex: layout.firstLineIndex,
    prevSelection: layout.renderedSelection,
    nextSelection: app.selection,
  });
  layout.renderedSelection = cloneSelection(app.selection);
  if (touched > 0) {
    app.renderer.render(layout.frameRows, layout.cursor);
  }
}

export function copySelection(app, { clearAfterCopy }) {
  const layout = app.timelineLayout;
  if (!app.selection || !layout) return false;
  const text = extractSelectionText(layout.lines, app.selection);
  if (clearAfterCopy) {
    app.selection = null;
    app.selectionScheduler.flush();
  }
  if (!text) return false;
  copyToClipboardOsc52(text, process.stdout);
  const lineCount = text.split("\n").length;
  app.showToast(`Copied ${text.length} chars (${lineCount} lines) via OSC 52`);
  app.scheduleRender(true);
  return true;
}

export function handleSelectionMouse(app, event) {
  const col = Math.max(0, event.col - 1);

  if (event.action === "leftDown") {
    const hadVisible = !isSelectionEmpty(app.selection);
    const line = screenRowToTimelineLine(app, event.row, false);
    app.selection = line === null ? null : createSelection(line, col);
    if (hadVisible) scheduleSelectionPatch(app);
    return;
  }

  if (!app.selection || !app.selection.dragging) return;

  if (event.action === "leftDrag") {
    const layout = app.timelineLayout;
    const prevScroll = app.state.scrollOffset;
    if (layout) {
      const viewportRow = event.row - 1 - layout.topRow;
      if (viewportRow < 0) app.scrollBy(1);
      else if (viewportRow >= layout.height) app.scrollBy(-1);
    }
    const scrolled = app.state.scrollOffset !== prevScroll;
    const line = screenRowToTimelineLine(app, event.row, true);
    let headChanged = false;
    if (line !== null) {
      const prevHead = app.selection.head;
      if (prevHead.line !== line || prevHead.col !== col) {
        app.selection.head = { line, col };
        headChanged = true;
      }
    }
    if (scrolled) app.scheduleRender(true);
    else if (headChanged) scheduleSelectionPatch(app);
    return;
  }

  const hadVisible = !isSelectionEmpty(app.selection);
  const line = screenRowToTimelineLine(app, event.row, true);
  if (line !== null) {
    app.selection.head = { line, col };
  }
  app.selection.dragging = false;
  if (isSelectionEmpty(app.selection)) {
    app.selection = null;
    if (hadVisible) scheduleSelectionPatch(app);
  } else {
    app.selectionScheduler.flush();
    copySelection(app, { clearAfterCopy: false });
  }
}

export function flushScroll(app) {
  const layout = getValidTimelineLayout(app);
  if (!layout) return;

  const slice = sliceViewportRows(layout.lines, layout.height, app.state.scrollOffset, app.selection);
  app.state.maxScrollOffset = slice.maxScroll;
  app.state.scrollOffset = slice.scrollOffset;

  const delta = app.state.scrollOffset - layout.renderedScrollOffset;
  if (delta === 0) return;

  for (let offset = 0; offset < layout.height; offset += 1) {
    layout.frameRows[layout.topRow + offset] = slice.visibleRows[offset];
  }

  const hasActiveToast = Boolean(app.state.toast && Date.now() < app.state.toast.expiresAt);
  if (!hasActiveToast && layout.frameRows.length > 0 && layout.defaultFooterLine) {
    layout.frameRows[layout.frameRows.length - 1] =
      app.state.scrollOffset > 0
        ? ` ${app.style.accentAlt(`↓ ${app.state.scrollOffset} lines below · End / Esc to jump to bottom`)}`
        : layout.defaultFooterLine;
  }

  layout.firstLineIndex = slice.startIdx;
  layout.viewportRawRows = slice.rawViewportRows;
  layout.renderedScrollOffset = app.state.scrollOffset;
  layout.renderedSelection = cloneSelection(app.selection);

  app.renderer.render(layout.frameRows, layout.cursor, {
    topRow: layout.topRow,
    height: layout.height,
    delta,
  });
}

function invokeModalCallback(app, fn, arg) {
  if (!fn) return;
  Promise.resolve(fn(arg)).catch((err) => {
    app.pushNotice("error", err.message);
    app.scheduleRender();
  });
}

export function handleModalInput(app, event) {
  const modal = app.modal;
  if (modal.type === "help") {
    if (event.type === "key" && (event.name === "escape" || event.name === "enter" || (event.ctrl && event.name === "c"))) {
      app.modal = null;
      app.scheduleRender(true);
    }
    return;
  }

  if (modal.type === "artifact") {
    if (event.type !== "key") return;
    if (event.name === "escape" || (event.ctrl && event.name === "c")) {
      app.modal = null;
      app.scheduleRender(true);
      return;
    }
    const scrollDeltas = { up: -1, down: 1, pageup: -10, pagedown: 10 };
    if (Object.hasOwn(scrollDeltas, event.name)) {
      modal.scrollOffset = clampScroll(modal.scrollOffset, scrollDeltas[event.name], modal.maxScroll);
      app.scheduleRender(true);
    } else if (event.ctrl && event.name === "y") {
      copyToClipboardOsc52(modal.content || "", process.stdout);
      app.showToast(`Copied artifact (${(modal.content || "").length} chars)`);
    }
    return;
  }

  if (modal.type === "permission") {
    const options = Array.isArray(modal.params?.options) ? modal.params.options : [];
    if (event.type === "text") {
      if (/^[1-9]$/.test(event.text)) {
        const idx = Number.parseInt(event.text, 10) - 1;
        if (idx < options.length) app.resolveActivePermission(idx);
      } else {
        app.showToast("Permission dialog active — press 1-9 / Enter to choose, or Esc to deny", "error", 3200);
        app.scheduleRender(true);
      }
      return;
    }
    if (event.type !== "key") return;
    if (event.name === "escape" || (event.ctrl && event.name === "c")) {
      app.resolveActivePermission(null);
    } else if ((event.name === "up" || event.name === "down") && options.length > 0) {
      modal.selected = wrapIndex(modal.selected, event.name === "up" ? -1 : 1, options.length);
      app.scheduleRender(true);
    } else if (event.name === "enter" && options.length > 0) {
      app.resolveActivePermission(modal.selected);
    }
    return;
  }

  if (modal.type === "picker") {
    if (event.type === "text") {
      modal.filter = (modal.filter || "") + event.text;
      refreshPickerFilter(modal, { resetSelection: true });
      app.scheduleRender(true);
      return;
    }
    if (event.type !== "key") return;
    const items = modal.filteredItems || [];
    if (event.name === "escape" || (event.ctrl && event.name === "c")) {
      const { onCancel } = modal;
      app.modal = null;
      app.scheduleRender(true);
      invokeModalCallback(app, onCancel);
    } else if ((event.name === "tab" || (event.ctrl && event.name === "a")) && modal.scopeFilter) {
      modal.scopeFilter.active = modal.scopeFilter.active === "all" ? "cwd" : "all";
      refreshPickerFilter(modal, { resetSelection: true });
      app.scheduleRender(true);
    } else if (event.ctrl && event.name === "u") {
      if (modal.filter) {
        modal.filter = "";
        refreshPickerFilter(modal, { resetSelection: true });
        app.scheduleRender(true);
      }
    } else if (event.name === "backspace") {
      modal.filter = (modal.filter || "").slice(0, -1);
      refreshPickerFilter(modal, { resetSelection: true });
      app.scheduleRender(true);
    } else if ((event.name === "up" || event.name === "down") && items.length > 0) {
      modal.selected = wrapIndex(modal.selected, event.name === "up" ? -1 : 1, items.length);
      app.scheduleRender(true);
    } else if ((event.name === "pageup" || event.name === "pagedown") && items.length > 0) {
      const step = modal.layout === "cards" ? 5 : 8;
      const delta = event.name === "pageup" ? -step : step;
      modal.selected = clampScroll(modal.selected, delta, items.length - 1);
      app.scheduleRender(true);
    } else if (event.name === "home" && items.length > 0) {
      modal.selected = 0;
      app.scheduleRender(true);
    } else if (event.name === "end" && items.length > 0) {
      modal.selected = items.length - 1;
      app.scheduleRender(true);
    } else if (event.name === "enter" && items.length > 0) {
      const chosen = items[modal.selected];
      const { onSelect } = modal;
      app.modal = null;
      app.scheduleRender(true);
      if (chosen) invokeModalCallback(app, onSelect, chosen);
    }
  }
}

export function syncBoardTab(app, tabOverride = null) {
  const entries = app.state.multiAgent.getRosterEntries();
  app.boardState.selectedIdx = Math.min(app.boardState.selectedIdx, Math.max(0, entries.length - 1));
  const sel = entries[app.boardState.selectedIdx];
  app.boardState.tab = tabOverride || (sel?.kind === "board" ? "board" : "detail");
  app.boardState.scrollOffset = 0;
  app.boardState.stickToBottom = app.boardState.tab === "board";
}

export function handleBoardInput(app, event) {
  if (event.type !== "key") return;
  const entries = app.state.multiAgent.getRosterEntries();
  if (event.name === "escape" || (event.ctrl && event.name === "b") || (event.ctrl && event.name === "c")) {
    app.boardOpen = false;
    app.scheduleRender(true);
    return;
  }
  if (event.name === "tab") {
    syncBoardTab(app, app.boardState.tab === "board" ? "detail" : "board");
    app.scheduleRender(true);
    return;
  }
  if ((event.name === "up" || event.name === "down") && entries.length > 0) {
    app.boardState.selectedIdx = wrapIndex(app.boardState.selectedIdx, event.name === "up" ? -1 : 1, entries.length);
    syncBoardTab(app);
    app.scheduleRender(true);
    return;
  }
  if (event.name === "pageup" || event.name === "pagedown") {
    const delta = event.name === "pageup" ? -8 : 8;
    app.boardState.scrollOffset = clampScroll(app.boardState.scrollOffset, delta, app.boardState.maxDetailScroll);
    app.boardState.stickToBottom = app.boardState.scrollOffset >= app.boardState.maxDetailScroll;
    app.scheduleRender(true);
    return;
  }
  if (event.name === "home" || event.name === "end") {
    app.boardState.stickToBottom = event.name === "end";
    app.boardState.scrollOffset = event.name === "end" ? app.boardState.maxDetailScroll : 0;
    app.scheduleRender(true);
  }
}

const CTRL_KEY_ACTIONS = {
  o: (app) => app.toggleExpandTools(),
  t: (app) => app.toggleThoughtMode(),
  y: (app) => app.copyLastAssistantReply(),
  g: (app) => app.toggleMouseCapture(),
  b: (app) => app.toggleSwarmBoard(),
  v: (app) => app.attachFromClipboard(),
  l: (app) => {
    app.renderer.invalidate();
    app.scheduleRender();
  },
  w: (app) => ({ edit: () => app.state.composer.deleteWordBackward(), popup: true }),
  u: (app) => ({ edit: () => app.state.composer.killToLineStart(), popup: true }),
  k: (app) => ({ edit: () => app.state.composer.killToLineEnd(), popup: true }),
  a: (app) => ({ edit: () => app.state.composer.moveLineStart(), popup: false }),
  e: (app) => ({ edit: () => app.state.composer.moveLineEnd(), popup: false }),
  p: (app) => ({ edit: () => app.state.composer.historyPrev(), popup: true }),
  n: (app) => ({ edit: () => app.state.composer.historyNext(), popup: true }),
};

const ALT_KEY_ACTIONS = {
  b: (app) => app.toggleSwarmDock(),
  "[": (app) => app.cycleFocusedAgent(-1),
  "]": (app) => app.cycleFocusedAgent(1),
  up: (app) => app.scrollBy(4),
  down: (app) => app.scrollBy(-4),
};

export function handleMainKey(app, key) {
  const { cols } = app.renderer.getSize();
  const inputWidth = Math.max(12, cols - 4);
  const composer = app.state.composer;

  // Mouse selection takes priority for Ctrl+C and Esc.
  if (app.selection && key.ctrl && key.name === "c") {
    copySelection(app, { clearAfterCopy: true });
    return;
  }
  if (app.selection && key.name === "escape") {
    app.selection = null;
    scheduleSelectionPatch(app);
    return;
  }

  if (key.ctrl && key.name === "c") {
    if (!composer.isEmpty()) {
      composer.clear();
      app.popup = null;
      app.scheduleRender(true);
      return;
    }
    if (app.activeLocalShell) {
      cancelLocalShell(app);
      return;
    }
    if (app.state.busy && app.state.sessionId) {
      app.acp.cancelTurn(app.state.sessionId);
      app.showToast("Cancellation requested…");
      return;
    }
    const now = Date.now();
    if (now - app.lastCtrlCAt < 1500) {
      app.shutdown(0);
    } else {
      app.lastCtrlCAt = now;
      app.showToast("Press Ctrl+C again to exit", "info", 1500);
    }
    return;
  }

  if (key.ctrl && key.name === "d") {
    if (composer.isEmpty()) {
      app.shutdown(0);
    } else {
      composer.deleteForward();
      app.updatePopupState();
      app.scheduleRender(true);
    }
    return;
  }

  if (key.shift && key.name === "tab") {
    app.cycleMode();
    return;
  }

  if (key.shift && !key.ctrl && !key.alt && composer.isEmpty() && (key.name === "left" || key.name === "right")) {
    if (app.state.multiAgent.getInspectableMembers().length > 0) {
      app.cycleFocusedAgent(key.name === "right" ? 1 : -1);
      return;
    }
  }

  if (key.alt && Object.hasOwn(ALT_KEY_ACTIONS, key.name)) {
    ALT_KEY_ACTIONS[key.name](app);
    return;
  }

  if (key.ctrl && Object.hasOwn(CTRL_KEY_ACTIONS, key.name)) {
    const res = CTRL_KEY_ACTIONS[key.name](app);
    if (res && typeof res === "object" && res.edit) {
      res.edit();
      if (res.popup) app.updatePopupState();
      app.scheduleRender(true);
    }
    return;
  }

  if (key.name === "escape") {
    if (app.popup) {
      app.dismissedPopupKey = app.popup.triggerKey;
      app.popup = null;
      app.scheduleRender(true);
    } else if (app.state.focusedAgentId) {
      app.state.focusedAgentId = null;
      app.state.focusedAgentName = "";
      app.state.scrollOffset = 0;
      app.showToast("Returned to main conversation");
      app.scheduleRender(true);
    } else if (composer.text.startsWith("!")) {
      composer.clear();
      app.scheduleRender(true);
    } else if (app.activeLocalShell) {
      cancelLocalShell(app);
    } else if (app.state.busy && app.state.sessionId) {
      app.acp.cancelTurn(app.state.sessionId);
      app.showToast("Cancelling turn…");
    } else if (app.state.scrollOffset > 0) {
      app.state.scrollOffset = 0;
      app.scheduleRender(true);
    }
    return;
  }

  if (key.name === "pageup" || key.name === "pagedown") {
    app.scrollBy(key.name === "pageup" ? 12 : -12);
    return;
  }

  if (app.popup && app.popup.items.length > 0) {
    if (key.name === "up" || key.name === "down") {
      app.popup.selected = wrapIndex(app.popup.selected, key.name === "up" ? -1 : 1, app.popup.items.length);
      app.scheduleRender(true);
      return;
    }
    if (key.name === "tab") {
      app.applyPopupSelection(false);
      return;
    }
    if (key.name === "enter" && !key.shift && !key.alt && !key.ctrl) {
      app.applyPopupSelection(true);
      return;
    }
  }

  if ((key.name === "enter" && (key.shift || key.alt || key.ctrl)) || (key.ctrl && key.name === "j")) {
    composer.insert("\n");
    app.updatePopupState();
    app.scheduleRender(true);
    return;
  }

  if (key.name === "enter") {
    if (composer.text.endsWith("\\")) {
      composer.backspace();
      composer.insert("\n");
      app.scheduleRender(true);
    } else {
      app.submitComposer();
    }
    return;
  }

  if (!key.ctrl && !key.alt && key.name === "space") {
    composer.insert(" ");
    app.dismissedPopupKey = null;
    app.updatePopupState();
    app.scheduleRender(true);
    return;
  }

  let handled = true;
  let refreshPopup = true;
  switch (key.name) {
    case "backspace":
      if (key.alt) composer.deleteWordBackward();
      else composer.backspace();
      break;
    case "delete":
      composer.deleteForward();
      break;
    case "home":
      refreshPopup = false;
      if (composer.isEmpty()) app.state.scrollOffset = app.state.maxScrollOffset;
      else composer.moveLineStart();
      break;
    case "end":
      refreshPopup = false;
      if (composer.isEmpty()) app.state.scrollOffset = 0;
      else composer.moveLineEnd();
      break;
    case "left":
      if (key.ctrl || key.alt) composer.moveWordLeft();
      else composer.moveLeft();
      break;
    case "right":
      if (key.ctrl || key.alt) composer.moveWordRight();
      else composer.moveRight();
      break;
    case "up":
      refreshPopup = false;
      composer.moveUpOrHistory(inputWidth);
      break;
    case "down":
      refreshPopup = false;
      composer.moveDownOrHistory(inputWidth);
      break;
    default:
      handled = false;
      break;
  }
  if (handled) {
    if (refreshPopup) app.updatePopupState();
    app.scheduleRender(true);
  }
}
