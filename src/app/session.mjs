import { findLiveBgSession, listLiveBgSessions, terminatePid } from "../acp/bg_registry.mjs";
import { AcpClient, fetchAgyQuota, hotSwapAcpClient } from "../acp/client.mjs";
import { HostAcpClient, spawnSessionHost } from "../acp/host_client.mjs";
import { extractChunkText, findConfigOption, matchByIdOrPrefix } from "../acp/protocol.mjs";
import { saveUserConfig, supportsNativeBypassFlag, withDangerouslySkipPermissions } from "../config.mjs";
import { sanitizeUntrustedText } from "../term/unicode.mjs";
import { formatRelativeTime, isToolTerminalStatus } from "../ui/format.mjs";
import { extractCleanOutputPreview, parseExitCode } from "../ui/tool_format.mjs";

const MAX_TOOL_OUTPUT = 64 * 1024;

export function summarizeRawInput(rawInput) {
  if (!rawInput) return "";
  if (typeof rawInput === "string") return sanitizeUntrustedText(rawInput).slice(0, 300);
  if (typeof rawInput === "object") {
    if (typeof rawInput.CommandLine === "string") return sanitizeUntrustedText(`$ ${rawInput.CommandLine}`);
    if (typeof rawInput.command === "string") return sanitizeUntrustedText(`$ ${rawInput.command}`);
    if (typeof rawInput.Path === "string") return sanitizeUntrustedText(rawInput.Path);
    if (typeof rawInput.path === "string") return sanitizeUntrustedText(rawInput.path);
    try {
      return sanitizeUntrustedText(JSON.stringify(rawInput)).slice(0, 300);
    } catch {
      return "";
    }
  }
  return "";
}

export function drainCancelledPermissions(queue) {
  for (const req of queue) {
    try {
      req.cancel();
    } catch {
      // Ignore already-settled permissions
    }
  }
}

export function finalizeStreamingItems(app, targetType = null) {
  for (let i = app.state.items.length - 1; i >= 0; i -= 1) {
    const item = app.state.items[i];
    if (!item.streaming) continue;
    if (targetType && item.type !== targetType) continue;
    item.streaming = false;
    if (item.type === "thought") {
      item.durationMs = Date.now() - item.startedAt;
    }
    item._rev = (item._rev || 0) + 1;
  }
}

export function clearIdleStreamTimer(app) {
  if (app.idleStreamTimer) {
    clearTimeout(app.idleStreamTimer);
    app.idleStreamTimer = null;
  }
}

export function finalizeAllStreaming(app) {
  clearIdleStreamTimer(app);
  finalizeStreamingItems(app);
  for (const item of app.state.items) {
    if (item.fromReplay) item.fromReplay = false;
  }
}

export function resetConversationState(
  app,
  { cancelPermissions = false, keepMultiAgent = false, keepSessionMeta = false } = {},
) {
  app.state.items = [];
  app.toolMap.clear();
  app.activePlanItem = null;
  app.selection = null;
  app.state.scrollOffset = 0;
  app.state.maxScrollOffset = 0;

  if (!keepMultiAgent) {
    app.state.multiAgent.reset();
    app.state.focusedAgentId = null;
    app.state.focusedAgentName = "";
    app.state.stagedImages = [];
    app.boardOpen = false;
    app.modal = null;
  }

  if (!keepSessionMeta) {
    app.state.usage = null;
    app.state.sessionTitle = "";
    app.state.busy = false;
    app.state.activePromptCount = 0;
    app.state.turnStartedAt = 0;
  }

  if (cancelPermissions && app.permissionQueue.length > 0) {
    drainCancelledPermissions(app.permissionQueue);
    app.permissionQueue = [];
  }
}

export function bindAcpClient(app, client) {
  client.on("sessionUpdate", (params) => {
    if (client !== app.acp || app.suppressReplayEvents) return;
    handleSessionUpdate(app, params);
  });

  client.on("permissionRequest", (req) => {
    if (client !== app.acp) return;
    app.enqueuePermissionRequest(req);
  });

  client.on("promptDone", (info) => {
    if (client !== app.acp) return;
    if (info?.stopReason === "cancelled") {
      app.pushNotice("info", "Turn cancelled.");
    } else if (info?.error) {
      app.pushNotice("error", info.error);
    }
    app.finishPromptTurn(info?.activePromptCount);
  });

  client.on("detached", (reason) => {
    if (client !== app.acp || app.exiting) return;
    app.exitNotice = reason ? `Detached: ${reason}` : "Detached from session host.";
    app.shutdown(0, { detach: true });
  });

  client.on("disconnect", () => {
    if (client !== app.acp || app.exiting) return;
    app.state.connected = false;
    app.state.busy = false;
    app.pushNotice("error", "ACP backend disconnected. Use /quit or restart lucid.");
    app.scheduleRender();
  });
}

function seedComposerHistoryFromItems(app) {
  for (const item of app.state.items) {
    if (item.type !== "user") continue;
    const entry = (item.displayText || item.text || "").trim();
    if (entry && entry !== "(image attachment)") {
      app.state.composer.pushHistory(entry);
    }
  }
}

export async function syncSessionBypass(app, enabled, { modeId = "" } = {}) {
  const target = Boolean(enabled);
  app.state.sessionBypass = target;
  app.pendingNativeBypass = null;
  const hasRunningMembers = Boolean(app.state.multiAgent?.hasRunningMembers?.());

  if (!app.acp) {
    return { ok: true, nativeBypass: false, restarted: false, deferred: false };
  }

  if (app.acp.isHosted) {
    const res = await app.acp.setBypassPermissions(target, { modeId, hasRunningMembers });
    if (res?.sessionMeta) {
      app.applySessionMetadata(res.sessionMeta);
    }
    if (res?.modeId) {
      app.state.modeId = res.modeId;
    }
    if (typeof res?.nativeBypass === "boolean") {
      app.state.nativeBypassActive = res.nativeBypass;
    }
    if (res?.deferred) {
      app.pendingNativeBypass = { enabled: target, modeId };
    }
    return res || { ok: false, nativeBypass: app.state.nativeBypassActive, restarted: false, deferred: false };
  }

  const canHotSwapDirect =
    supportsNativeBypassFlag(app.launchSpec) &&
    !app.state.launchBypass &&
    Boolean(app.state.sessionId) &&
    typeof app.acp.stop === "function" &&
    (typeof app.acp.resumeSession === "function" || typeof app.acp.loadSession === "function");

  if (!canHotSwapDirect) {
    if (typeof app.acp.setBypassPermissions === "function") {
      app.acp.setBypassPermissions(target);
    }
    return { ok: true, nativeBypass: false, restarted: false, deferred: false };
  }

  if (target === Boolean(app.state.nativeBypassActive)) {
    return { ok: true, nativeBypass: app.state.nativeBypassActive, restarted: false, deferred: false };
  }

  if (app.state.busy || hasRunningMembers) {
    app.pendingNativeBypass = { enabled: target, modeId };
    return { ok: true, nativeBypass: app.state.nativeBypassActive, restarted: false, deferred: true };
  }

  const nextLaunchSpec = withDangerouslySkipPermissions(app.launchSpec, target);
  const restoreMode = modeId || (target ? resolveModeId(app, "auto") || "auto" : app.state.modeId);
  const sessionMeta = {
    availableCommands: app.state.agentCommands,
    configOptions: app.state.configOptions,
    modes: { availableModes: app.state.modes, currentModeId: app.state.modeId },
    models: { availableModels: app.state.models },
  };
  try {
    const { updates } = await hotSwapAcpClient({
      currentClient: app.acp,
      nextLaunchSpec,
      sessionId: app.state.sessionId,
      cwd: app.cwd,
      modeId: restoreMode,
      sessionMeta,
      onBindNext: (nextAcp) => {
        app.acp = nextAcp;
        bindAcpClient(app, nextAcp);
      },
      onReplaySuppressed: (flag) => {
        app.suppressReplayEvents = flag;
      },
    });
    for (const meta of updates) {
      if (meta) app.applySessionMetadata(meta);
    }
    app.launchSpec = nextLaunchSpec;
    app.state.nativeBypassActive = target;
    return { ok: true, nativeBypass: target, restarted: true, deferred: false };
  } catch (err) {
    return { ok: false, nativeBypass: app.state.nativeBypassActive, restarted: false, deferred: false, error: err?.message };
  }
}

export function maybeFlushPendingNativeBypass(app) {
  if (
    !app.pendingNativeBypass ||
    app.exiting ||
    app.nativeBypassFlushing ||
    app.state.busy ||
    app.state.multiAgent?.hasRunningMembers?.()
  ) {
    return;
  }
  const pending = app.pendingNativeBypass;
  app.pendingNativeBypass = null;
  app.nativeBypassFlushing = true;
  syncSessionBypass(app, pending.enabled, { modeId: pending.modeId })
    .then((res) => {
      if (app.exiting || !res?.restarted) return;
      app.showToast(
        pending.enabled
          ? "Bypass backend upgraded — Swarm sub-workers now auto-approved"
          : "Bypass backend restored — standard permissions active",
      );
      app.scheduleRender();
    })
    .catch(() => {})
    .finally(() => {
      app.nativeBypassFlushing = false;
    });
}

export async function switchSessionMode(app, targetId, bypassModeId) {
  try {
    if (targetId === bypassModeId) {
      app.state.sessionBypass = true;
      app.approvePendingPermissions();
      const autoModeId = resolveModeId(app, "auto");
      const res = await syncSessionBypass(app, true, { modeId: autoModeId || "auto" });
      if (!res?.restarted && autoModeId && autoModeId !== app.state.modeId && app.state.sessionId) {
        const modeRes = await app.acp.setMode(app.state.sessionId, autoModeId);
        app.applySessionMetadata(modeRes);
        app.state.modeId = autoModeId;
      }
      if (res?.restarted) {
        app.showToast("Mode → Bypass (backend upgraded with --dangerously-skip-permissions; sub-workers included)", "error");
      } else if (res?.deferred) {
        app.showToast("Mode → Bypass (ACP auto-approved; will upgrade backend for sub-workers when idle)", "error");
      } else {
        app.showToast("Mode → Bypass (every tool permission auto-approved this session)", "error");
      }
    } else {
      const wasBypass = Boolean(app.state.sessionBypass || app.state.nativeBypassActive || app.pendingNativeBypass);
      const res = wasBypass ? await syncSessionBypass(app, false, { modeId: targetId }) : null;
      if (!wasBypass || !res?.restarted) {
        const modeRes = await app.acp.setMode(app.state.sessionId, targetId);
        app.applySessionMetadata(modeRes);
        app.state.modeId = targetId;
      }
      app.userConfig.mode = targetId;
      saveUserConfig(app.userConfig);
      const target = app.state.modes.find((mode) => mode.id === targetId);
      const suffix = res?.deferred ? " (backend downgrade queued until idle)" : "";
      app.showToast(`Mode → ${target?.name || targetId}${suffix}`);
    }
  } catch (err) {
    app.showToast(`Mode switch failed: ${err.message}`, "error");
  }
  app.scheduleRender();
}

export function applyHostSnapshot(app, snapshot) {
  if (!snapshot) return;
  const info = snapshot.agentInfo || snapshot.initResult?.agentInfo;
  if (info?.name) {
    app.state.agentLabel = info.version ? `${info.name} ${info.version}` : info.name;
  }

  resetConversationState(app, { cancelPermissions: false });
  app.permissionQueue = [];

  app.state.sessionId = snapshot.sessionId || "";
  app.state.sessionTitle = sanitizeUntrustedText(snapshot.sessionTitle || "");
  app.state.usage = snapshot.usage || null;
  app.applySessionMetadata(snapshot.sessionMeta || {});
  if (snapshot.modelLabel) app.state.modelLabel = sanitizeUntrustedText(snapshot.modelLabel);
  if (snapshot.modeId) app.state.modeId = snapshot.modeId;
  if (!app.state.launchBypass) {
    app.state.sessionBypass = Boolean(snapshot.bypassPermissions);
    app.state.nativeBypassActive = Boolean(snapshot.nativeBypassActive);
  }

  app.replayingSnapshot = true;
  try {
    for (const ev of snapshot.eventLog || []) {
      if (ev.type === "userPrompt") {
        finalizeAllStreaming(app);
        app.state.items.push({
          type: "user",
          text: sanitizeUntrustedText(ev.text || "(image attachment)"),
          displayText: ev.displayText ? sanitizeUntrustedText(ev.displayText) : undefined,
          attachedPaths: ev.attachedPaths || [],
          attachedImages: ev.attachedImages || [],
        });
      } else if (ev.type === "sessionUpdate") {
        handleSessionUpdate(app, ev.params);
      } else if (ev.type === "notice") {
        app.pushNotice(ev.level || "info", sanitizeUntrustedText(ev.text || ""));
      }
    }
    if (!snapshot.busy) {
      finalizeAllStreaming(app);
    }
  } finally {
    app.replayingSnapshot = false;
  }
  seedComposerHistoryFromItems(app);

  app.state.busy = Boolean(snapshot.busy);
  app.state.activePromptCount = snapshot.activePromptCount || (snapshot.busy ? 1 : 0);
  app.state.turnStartedAt = snapshot.turnStartedAt || 0;

  if (Array.isArray(snapshot.pendingPermissions) && app.acp?.makePermissionHandle) {
    for (const perm of snapshot.pendingPermissions) {
      app.enqueuePermissionRequest(app.acp.makePermissionHandle(perm.permId, perm.params));
    }
  }

  if (app.state.sessionTitle) {
    app.renderer.setTitle(app.state.sessionTitle);
  }
  app.pollAgyState();
  app.scheduleRender(true);
}

export async function attachToBgHost(app, bgMeta, { keepPreviousHost = false } = {}) {
  const nextClient = new HostAcpClient({
    hostId: bgMeta.hostId,
    socketPath: bgMeta.socketPath,
    launchSpec: app.launchSpec,
  });
  const prevClient = app.acp;
  const prevSessionId = app.state.sessionId;
  const prevHadWork = Boolean(app.state.busy || app.state.items.length > 0);

  const snapshot = await nextClient.start(15000);
  app.acp = nextClient;
  bindAcpClient(app, nextClient);
  app.state.connected = true;
  applyHostSnapshot(app, snapshot);

  if (prevClient && prevClient !== nextClient) {
    if (keepPreviousHost && prevClient.isHosted && prevHadWork) {
      await prevClient.detach();
    } else {
      await prevClient.stop(prevSessionId);
    }
  }

  const statusTag = snapshot.busy ? "running" : "resumed";
  app.showToast(`Attached to live session ${bgMeta.hostId} (${statusTag})`);
  app.scheduleRender(true);
}

export async function startHostedOrDirectClient(app) {
  if (!app.cliOptions.direct) {
    let spawned = null;
    let client = null;
    try {
      spawned = spawnSessionHost({
        cwd: app.cwd,
        launchSpec: app.launchSpec,
        addDirs: app.cliOptions.addDirs || [],
        bypassPermissions: app.state.bypassPermissions,
      });
      client = new HostAcpClient({
        hostId: spawned.hostId,
        socketPath: spawned.socketPath,
        launchSpec: app.launchSpec,
        hostPid: spawned.pid,
      });
      app.acp = client;
      bindAcpClient(app, client);
      return await client.start(20000);
    } catch (err) {
      if (app.exiting) {
        throw err;
      }
      if (client) {
        await client.stop().catch(() => {});
      }
      terminatePid(spawned?.pid);
      // Fall back to direct child process if spawning/binding the host fails.
    }
  }
  const direct = new AcpClient(app.launchSpec);
  app.acp = direct;
  bindAcpClient(app, direct);
  return direct.start();
}

export async function connectAndStartSession(app) {
  app.state.connecting = true;
  app.scheduleRender();

  try {
    let liveTarget = null;
    if (!app.cliOptions.direct) {
      if (app.cliOptions.session) {
        liveTarget = findLiveBgSession(app.cliOptions.session);
      } else if (app.cliOptions.continueLatest) {
        const liveForCwd = listLiveBgSessions({ cwd: app.cwd });
        if (liveForCwd.length > 0) {
          liveTarget = liveForCwd[0];
        }
      }
    }

    if (liveTarget) {
      await attachToBgHost(app, liveTarget);
      app.startupOverridesApplied = true;
    } else {
      const initResult = await startHostedOrDirectClient(app);
      const info = initResult?.agentInfo || initResult?.initResult?.agentInfo;
      if (info?.name) {
        app.state.agentLabel = info.version ? `${info.name} ${info.version}` : info.name;
      }
      app.state.connected = true;

      await openInitialSession(app);
      await applyStartupOverrides(app);
    }

    app.state.connecting = false;
    app.scheduleRender();

    if (app.launchSpec.supportsQuotaCli) {
      fetchAgyQuota(15000).then((quota) => {
        if (quota?.badge && !app.exiting) {
          app.state.quotaText = quota.badge;
          app.scheduleRender();
        }
      });
    }
  } catch (err) {
    app.state.connecting = false;
    app.state.connected = false;
    app.pushNotice("error", `Failed to connect to ${app.launchSpec.command}: ${err.message}`);
    if (app.launchSpec.loginArgs) {
      app.pushNotice("info", `If authentication is needed, run: ${app.launchSpec.command} ${app.launchSpec.loginArgs.join(" ")}`);
    }
    app.scheduleRender();
  }
}

export async function createFreshSession(app) {
  const created = await app.acp.createSession(app.cwd, app.cliOptions.addDirs || []);
  app.state.sessionId = created.sessionId;
  app.applySessionMetadata(created);
  if (app.startupOverridesApplied) {
    await applyPreferredMode(app, { silentIfUnavailable: true });
  }
}

export function resolveModeId(app, requestedMode) {
  const raw = String(requestedMode || "").trim().toLowerCase();
  if (!raw) return "";
  if (app.state.modes.length === 0) return raw;
  const exact = app.state.modes.find((m) => String(m.id || "").toLowerCase() === raw);
  if (exact) return exact.id;
  if (raw === "bypass" || raw === "yolo") {
    const bypassMatch = app.state.modes.find((m) => /bypass|auto/i.test(String(m.id || "")));
    if (bypassMatch) return bypassMatch.id;
  }
  return "";
}

export async function applyPreferredMode(app, { explicitMode = "", silentIfUnavailable = false } = {}) {
  if (!app.state.sessionId) return;
  const requested = explicitMode || app.userConfig.mode || "";
  if (!requested) return;
  const resolvedId = resolveModeId(app, requested);
  if (!resolvedId) {
    if (!silentIfUnavailable) {
      app.pushNotice("warn", `Unknown mode "${requested}". Available: ${app.state.modes.map((m) => m.id).join(", ")}`);
    }
    return;
  }
  if (resolvedId === app.state.modeId) return;
  try {
    const res = await app.acp.setMode(app.state.sessionId, resolvedId);
    app.applySessionMetadata(res);
    app.state.modeId = resolvedId;
  } catch (err) {
    if (!silentIfUnavailable) {
      app.pushNotice("warn", `Could not set mode "${requested}": ${err.message}`);
    }
  }
}

export async function applyStartupOverrides(app) {
  if (app.startupOverridesApplied || !app.state.sessionId) return;
  app.startupOverridesApplied = true;

  const explicitMode = app.cliOptions.mode || "";
  await applyPreferredMode(app, {
    explicitMode,
    silentIfUnavailable: !explicitMode,
  });

  if (app.cliOptions.model) {
    try {
      const res = await app.acp.setModel(app.state.sessionId, app.cliOptions.model, Boolean(app.getConfigOption("model")));
      app.applySessionMetadata(res);
    } catch (err) {
      app.pushNotice("warn", `Could not set model "${app.cliOptions.model}": ${err.message}`);
    }
  }
}

async function resolveSessionReference(app, ref) {
  const trimmed = String(ref || "").trim();
  if (!trimmed) return { sessionId: "", title: "" };
  if (app.acp.supportsSessionList()) {
    try {
      const sessions = await app.acp.listSessions(app.cwd);
      const match = matchByIdOrPrefix(sessions, trimmed, (s) => [s.sessionId], 4);
      if (match) {
        return { sessionId: match.sessionId, title: match.title || "" };
      }
    } catch {
      // Fallback to raw session ID
    }
  }
  return { sessionId: trimmed, title: "" };
}

export async function openInitialSession(app) {
  if (app.cliOptions.session) {
    const resolved = await resolveSessionReference(app, app.cliOptions.session);
    await switchToSession(app, resolved.sessionId, resolved.title || "Resumed session");
    return;
  }

  if (app.cliOptions.resumePicker) {
    await openResumePicker(app, { startup: true });
    return;
  }

  if (app.cliOptions.continueLatest && app.acp.supportsSessionList()) {
    try {
      const sessions = await app.acp.listSessions(app.cwd);
      if (sessions.length > 0) {
        await switchToSession(app, sessions[0].sessionId, sessions[0].title || "Latest session");
        return;
      }
    } catch {
      // Fallback to creating a fresh session
    }
  }

  await createFreshSession(app);
}

const BG_STATUS_TAGS = {
  waiting_permission: "⚠ [bg permission]",
  running: "● [bg running]",
  starting: "● [bg running]",
  done: "✓ [bg done]",
};

export async function openResumePicker(app, { query = "", startup = false } = {}) {
  try {
    const q = (query || "").trim();
    const liveBg = app.cliOptions.direct
      ? []
      : listLiveBgSessions({ cwd: app.cwd, excludeHostId: app.acp?.hostId || "" });

    if (q && liveBg.length > 0) {
      const liveMatch = matchByIdOrPrefix(liveBg, q, (s) => [s.hostId, s.sessionId], 3);
      if (liveMatch) {
        await attachToBgHost(app, liveMatch, { keepPreviousHost: !startup });
        return;
      }
    }

    const canListSaved = Boolean(app.acp && app.acp.supportsSessionList());
    if (!canListSaved && liveBg.length === 0) {
      if (!startup && q && (app.acp.supportsSessionLoad() || app.acp.supportsSessionResume())) {
        await switchToSession(app, q, q);
        return;
      }
      app.pushNotice("warn", "Connected ACP agent does not advertise session/list.");
      if (startup) await createFreshSession(app);
      app.scheduleRender();
      return;
    }

    if (!startup) app.showToast("Loading sessions…");
    const sessions = canListSaved ? await app.acp.listSessions(app.cwd) : [];
    if (sessions.length === 0 && liveBg.length === 0) {
      app.pushNotice("info", `No saved sessions found for ${app.cwd}.`);
      if (startup) await createFreshSession(app);
      app.scheduleRender();
      return;
    }

    if (q && sessions.length > 0) {
      const match = matchByIdOrPrefix(sessions, q, (s) => [s.sessionId], 4);
      if (match) {
        await switchToSession(app, match.sessionId, match.title || match.sessionId.slice(0, 12));
        if (startup) await applyStartupOverrides(app);
        return;
      }
    }

    const liveSessionIds = new Set(liveBg.map((s) => s.sessionId).filter(Boolean));
    const liveItems = liveBg.map((s) => ({
      label: `${BG_STATUS_TAGS[s.status] || "◌ [bg idle]"} ${s.title || s.hostId}`,
      value: `bg:${s.hostId}`,
      description: `${formatRelativeTime(s.updatedAt || s.startedAt)} · ${s.hostId}`,
      active: false,
      bgMeta: s,
    }));

    const savedItems = sessions
      .filter((s) => !liveSessionIds.has(s.sessionId))
      .map((s) => ({
        label: s.title || s.sessionId.slice(0, 12),
        value: s.sessionId,
        description: `${formatRelativeTime(s.updatedAt)} · ${s.sessionId.slice(0, 8)}`,
        active: s.sessionId === app.state.sessionId,
      }));

    app.openPickerModal({
      title: liveItems.length > 0 ? "Resume Conversation (Live Background First)" : "Resume Conversation",
      initialFilter: q,
      items: [...liveItems, ...savedItems],
      onSelect: async (chosen) => {
        if (chosen.bgMeta) {
          await attachToBgHost(app, chosen.bgMeta, { keepPreviousHost: !startup });
          return;
        }
        await switchToSession(app, chosen.value, chosen.label);
        if (startup) await applyStartupOverrides(app);
      },
      onCancel: startup
        ? async () => {
            if (!app.state.sessionId) {
              await createFreshSession(app);
              await applyStartupOverrides(app);
              app.showToast("Started new conversation");
              app.scheduleRender();
            }
          }
        : null,
    });
  } catch (err) {
    app.pushNotice("error", `Failed to resume session: ${err.message}`);
    if (startup && !app.state.sessionId) {
      await createFreshSession(app).catch(() => {});
    }
    app.scheduleRender();
  }
}

export async function switchToSession(app, sessionId, titleLabel = "") {
  if (app.state.sessionId && app.state.sessionId === sessionId) {
    app.showToast("Already in this session");
    return;
  }

  const prevSessionId = app.state.sessionId;
  const savedState = {
    items: app.state.items,
    usage: app.state.usage,
    sessionTitle: app.state.sessionTitle || "",
    scrollOffset: app.state.scrollOffset,
    sessionId: prevSessionId,
  };
  const savedToolMap = new Map(app.toolMap);
  const savedActivePlanItem = app.activePlanItem;
  const savedPermissions = app.permissionQueue;

  app.permissionQueue = [];
  resetConversationState(app, { cancelPermissions: false });
  app.state.sessionTitle = sanitizeUntrustedText(titleLabel || "");
  app.state.sessionId = sessionId;

  let res = null;
  try {
    if (app.acp.supportsSessionLoad()) {
      try {
        res = await app.acp.loadSession(sessionId, app.cwd);
      } catch (loadErr) {
        if (app.acp.supportsSessionResume()) {
          res = await app.acp.resumeSession(sessionId, app.cwd);
        } else {
          throw loadErr || new Error(`Could not load session ${sessionId}`);
        }
      }
    } else if (app.acp.supportsSessionResume()) {
      res = await app.acp.resumeSession(sessionId, app.cwd);
    }
  } catch (err) {
    Object.assign(app.state, savedState);
    app.toolMap = savedToolMap;
    app.activePlanItem = savedActivePlanItem;
    app.permissionQueue = savedPermissions;
    throw err;
  }

  drainCancelledPermissions(savedPermissions);
  if (prevSessionId && prevSessionId !== sessionId) {
    await app.acp.closeSession(prevSessionId);
  }

  finalizeAllStreaming(app);
  seedComposerHistoryFromItems(app);
  app.applySessionMetadata(res);
  app.pollAgyState?.();
  if (app.state.sessionTitle) {
    app.renderer.setTitle(app.state.sessionTitle);
  }
  if (app.state.items.length === 0) {
    app.pushNotice("info", `Connected to session ${app.state.sessionTitle || sessionId.slice(0, 8)} (history not replayed).`);
  } else {
    app.showToast(`Loaded session: ${app.state.sessionTitle || sessionId.slice(0, 8)}`);
  }
  app.scheduleRender();
}

function appendStreamingChunk(app, kind, rawUpdate) {
  const chunk = sanitizeUntrustedText(extractChunkText(rawUpdate));
  if (!chunk) return;
  const items = app.state.items;
  const last = items[items.length - 1];

  if (kind === "user_message_chunk") {
    if (last && last.type === "user" && last.fromReplay) {
      last.text += chunk;
      last._rev = (last._rev || 0) + 1;
    } else {
      finalizeAllStreaming(app);
      items.push({ type: "user", text: chunk, fromReplay: true, _rev: 0 });
    }
  } else if (kind === "agent_thought_chunk") {
    if (last && last.type === "thought" && last.streaming) {
      last.text += chunk;
      last.durationMs = Date.now() - last.startedAt;
      last._rev = (last._rev || 0) + 1;
    } else {
      finalizeStreamingItems(app, "assistant");
      items.push({ type: "thought", text: chunk, streaming: true, startedAt: Date.now(), durationMs: 0, _rev: 0 });
    }
  } else {
    finalizeStreamingItems(app, "thought");
    if (last && last.type === "assistant" && last.streaming) {
      last.text += chunk;
      last._rev = (last._rev || 0) + 1;
    } else {
      items.push({ type: "assistant", text: chunk, streaming: true, _rev: 0 });
    }
  }
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    // Out-of-turn / reactive wakeup chunks (e.g. /goal completion or async
    // subagent wakeup after promptDone) arrive while state.busy is false, so no
    // promptDone follows them. Finalize automatically once chunks go quiet.
    clearIdleStreamTimer(app);
    if (!app.state.busy && !app.replayingSnapshot) {
      app.idleStreamTimer = setTimeout(() => {
        app.idleStreamTimer = null;
        if (!app.state.busy && !app.exiting) {
          finalizeAllStreaming(app);
          app.scheduleRender();
        }
      }, 2500);
      app.idleStreamTimer.unref?.();
    }
  }
  app.scheduleRender();
}

export function handleSessionUpdate(app, params) {
  if (!params) return;
  if (app.state.sessionId && params.sessionId && params.sessionId !== app.state.sessionId) {
    return;
  }
  const update = params.update;
  if (!update || typeof update !== "object") return;

  switch (update.sessionUpdate) {
    case "available_commands_update":
      app.state.agentCommands = Array.isArray(update.availableCommands) ? update.availableCommands : [];
      app.updatePopupState();
      app.scheduleRender();
      return;
    case "usage_update":
      if (typeof update.used === "number" && typeof update.size === "number") {
        app.state.usage = { used: update.used, size: update.size };
        app.scheduleRender();
      }
      return;
    case "session_info_update": {
      const cleanTitle = sanitizeUntrustedText(update.title || "").trim();
      if (cleanTitle) {
        app.state.sessionTitle = cleanTitle;
        app.renderer.setTitle(cleanTitle);
        app.scheduleRender();
      }
      return;
    }
    case "current_mode_update": {
      const nextMode = update.currentModeId || update.modeId;
      if (nextMode) {
        app.state.modeId = nextMode;
        app.scheduleRender();
      }
      return;
    }
    case "config_option_update":
      if (Array.isArray(update.configOptions) || update.configOption) {
        app.applySessionMetadata(update);
        app.scheduleRender();
      }
      return;
    case "user_message_chunk":
    case "agent_thought_chunk":
    case "agent_message_chunk":
      appendStreamingChunk(app, update.sessionUpdate, update);
      return;
    case "tool_call":
    case "tool_call_update":
      finalizeStreamingItems(app);
      applyToolUpdate(app, update);
      app.state.multiAgent.ingestToolUpdate(update);
      app.scheduleRender();
      return;
    case "plan":
    case "plan_update": {
      const entries = Array.isArray(update.entries)
        ? update.entries.map((e) => ({ ...e, content: sanitizeUntrustedText(e?.content || "") }))
        : [];
      if (app.activePlanItem && app.state.items.includes(app.activePlanItem)) {
        app.activePlanItem.entries = entries;
        app.activePlanItem._rev = (app.activePlanItem._rev || 0) + 1;
      } else {
        app.activePlanItem = { type: "plan", entries, _rev: 0 };
        app.state.items.push(app.activePlanItem);
      }
      app.scheduleRender();
      return;
    }
    default:
      return;
  }
}

function applyToolOutputMetadata(item, fallbackFirstLine = "") {
  const parsedCode = parseExitCode(item.outputText);
  if (parsedCode !== null) {
    item.exitCode = parsedCode;
  }
  item.outputPreview = extractCleanOutputPreview(item.outputText) || fallbackFirstLine;
}

export function applyToolUpdate(app, update) {
  const id = update.toolCallId || `tool_${app.toolMap.size + 1}`;
  let item = app.toolMap.get(id);
  if (!item) {
    item = {
      type: "tool",
      toolCallId: id,
      title: sanitizeUntrustedText(update.title || update.name || "Tool call"),
      name: sanitizeUntrustedText(update.name || ""),
      kind: update.kind || "",
      status: update.status || "in_progress",
      startedAt: Date.now(),
      durationMs: 0,
      diffs: [],
      outputText: "",
      outputPreview: "",
      rawInput: update.rawInput ?? null,
      rawInputSummary: "",
      exitCode: null,
      _rev: 0,
    };
    app.toolMap.set(id, item);
    app.state.items.push(item);
  }

  item._rev = (item._rev || 0) + 1;

  if (update.title) item.title = sanitizeUntrustedText(update.title);
  if (update.name) item.name = sanitizeUntrustedText(update.name);
  if (update.kind) item.kind = update.kind;
  if (update.status) {
    item.status = update.status;
    if (isToolTerminalStatus(update.status)) {
      item.durationMs = Date.now() - item.startedAt;
    }
  }
  if (update.rawInput) {
    item.rawInput = update.rawInput;
    item.rawInputSummary = summarizeRawInput(update.rawInput);
  }

  const contentBlocks = Array.isArray(update.content)
    ? update.content
    : update.content
      ? [update.content]
      : [];

  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "diff") {
      const cleanPath = sanitizeUntrustedText(block.path || "");
      const existingIdx = item.diffs.findIndex((d) => d.path === cleanPath);
      const diffObj = {
        path: cleanPath,
        oldText: block.oldText ?? "",
        newText: block.newText ?? "",
      };
      if (existingIdx >= 0) {
        item.diffs[existingIdx] = diffObj;
      } else {
        item.diffs.push(diffObj);
      }
    } else {
      const rawText =
        typeof block.text === "string"
          ? block.text
          : block.content && typeof block.content.text === "string"
            ? block.content.text
            : "";
      const text = sanitizeUntrustedText(rawText);
      if (text) {
        if (item.outputText && text.startsWith(item.outputText)) {
          item.outputText = text.slice(0, MAX_TOOL_OUTPUT);
        } else {
          const next = item.outputText ? `${item.outputText}\n${text}` : text;
          item.outputText = next.length > MAX_TOOL_OUTPUT ? next.slice(0, MAX_TOOL_OUTPUT) : next;
        }
        applyToolOutputMetadata(item);
      }
    }
  }

  if (!item.outputText && update.rawOutput) {
    const rawStr = sanitizeUntrustedText(
      typeof update.rawOutput === "string" ? update.rawOutput : JSON.stringify(update.rawOutput),
    );
    if (rawStr) {
      item.outputText = rawStr.slice(0, 4000);
      applyToolOutputMetadata(item, rawStr.split(/\r?\n/)[0].slice(0, 120));
    }
  }
}
