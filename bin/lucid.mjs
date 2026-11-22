#!/usr/bin/env node
import path from "node:path";
import { findLiveBgSession, listLiveBgSessions, stopBgSession, terminatePid } from "../src/acp/bg_registry.mjs";
import { runSessionHostFromFile } from "../src/acp/host.mjs";
import { HostAcpClient, spawnSessionHost } from "../src/acp/host_client.mjs";
import { LucidApp } from "../src/app.mjs";
import { AGENT_PRESETS, LUCID_VERSION, loadUserConfig, parseCliArgs, resolveAgentLaunch } from "../src/config.mjs";
import { formatElapsed } from "../src/ui/format.mjs";
import { listThemes } from "../src/ui/themes.mjs";

function statusIcon(status) {
  switch (status) {
    case "waiting_permission":
      return "⚠ permission";
    case "running":
    case "starting":
      return "● running";
    case "done":
      return "✓ done";
    default:
      return "◌ idle";
  }
}

function printHelp() {
  const presets = Object.keys(AGENT_PRESETS).join(", ");
  const themes = listThemes()
    .map((t) => t.name)
    .join(", ");

  process.stdout.write(`lucid ${LUCID_VERSION} — transparent, flicker-free TUI for Antigravity & ACP agents

Usage:
  lucid [options]
  lucid bg ["<prompt>"]         Start a background task or list live background sessions
  lucid bg stop <id|all>        Stop one or all background sessions

Options:
  -r, --resume [id]             Open session picker (live bg sessions first) or resume by ID
  -c, --continue                Resume the latest live background or saved conversation here
  -s, --session <id>            Resume a specific live or saved session ID
  -a, --agent <preset>          ACP agent preset (default: agy)
                                Built-in: ${presets}
      --cmd "<command>"         Launch a custom ACP stdio server command
  -t, --theme <name>            Transparent color theme (${themes})
  -m, --model <id>              Override initial model
      --mode <mode>             Override initial mode (default|accept-edits|auto|plan)
      --cwd <dir>               Set workspace directory (default: current directory)
      --add-dir <dir>           Add extra workspace directory (repeatable, agy)
      --sandbox                 Pass --sandbox to agy acp
      --bypass, --yolo, --dangerously-skip-permissions
                                Auto-approve all tool permission requests
      --no-mouse                Disable mouse wheel capture (native drag-select always on)
      --direct                  Run ACP child directly without background session host
  -v, --version                 Show version
  -h, --help                    Show this help

Examples:
  lucid                         Start a fresh Antigravity session (type /bg anytime to detach)
  lucid -r                      Pick a live background or saved conversation to resume
  lucid -c                      Resume the latest conversation here
  lucid bg "Run tests and fix"  Start a task in the background without tmux
  lucid bg                      List live background sessions
  lucid --theme tokyo-night     Use Tokyo Night accents on transparent terminal bg
`);
}

async function runBgList(opts) {
  const sessions = listLiveBgSessions({
    cwd: opts.cwd ? path.resolve(opts.cwd) : "",
    allCwd: !opts.cwd,
    includeAttached: true,
  });
  if (sessions.length === 0) {
    process.stdout.write("No active background lucid sessions.\n");
    return;
  }
  for (const s of sessions) {
    const dir = path.basename(s.cwd || "") || s.cwd || "";
    const age = formatElapsed(s.startedAt);
    const title = (s.title || s.lastSummary || "Untitled").slice(0, 72);
    const attachedTag = s.attached ? " [attached]" : "";
    process.stdout.write(
      `  ${s.hostId}  ${statusIcon(s.status).padEnd(13)} ${age.padEnd(7)} ${dir.padEnd(18)} ${title}${attachedTag}\n`,
    );
  }
  process.stdout.write("\nResume any session with: lucid -r <id>  (or lucid -r)\n");
}

async function runBgStop(opts) {
  if (opts.bgStop.toLowerCase() === "all") {
    const sessions = listLiveBgSessions({ allCwd: true, includeAttached: true });
    if (sessions.length === 0) {
      process.stdout.write("No active background lucid sessions.\n");
      return;
    }
    for (const s of sessions) {
      await stopBgSession(s);
      process.stdout.write(`Stopped ${s.hostId} (${s.title || "session"})\n`);
    }
    return;
  }

  const match = findLiveBgSession(opts.bgStop);
  if (!match) {
    process.stderr.write(`No live background session matching "${opts.bgStop}". Run "lucid bg" to list.\n`);
    process.exitCode = 1;
    return;
  }
  await stopBgSession(match);
  process.stdout.write(`Stopped ${match.hostId} (${match.title || "session"})\n`);
}

async function runBgPrompt(opts) {
  const userConfig = loadUserConfig();
  const launchSpec = resolveAgentLaunch(opts, userConfig);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const bypassPermissions = Boolean(
    opts.dangerouslySkipPermissions ||
      userConfig.dangerouslySkipPermissions ||
      (launchSpec.args || []).includes("--dangerously-skip-permissions"),
  );

  const spawned = spawnSessionHost({
    cwd,
    launchSpec,
    addDirs: opts.addDirs || [],
    initialPrompt: opts.bgPrompt,
    initialMode: opts.mode || userConfig.mode || "",
    initialModel: opts.model || "",
    startBackgrounded: true,
    bypassPermissions,
  });

  // Verify the host booted and started the ACP agent before returning.
  const probe = new HostAcpClient({
    hostId: spawned.hostId,
    socketPath: spawned.socketPath,
    launchSpec,
    hostPid: spawned.pid,
  });
  try {
    await probe.start(25000);
    await probe.detach();
  } catch (err) {
    terminatePid(spawned.pid);
    throw err;
  }

  process.stdout.write(`Started background session ${spawned.hostId} (${launchSpec.name} · ${cwd})\n`);
  process.stdout.write(`Resume anytime: lucid -r ${spawned.hostId}  (or lucid -r)\n`);
  process.stdout.write(`List / stop:    lucid bg  |  lucid bg stop ${spawned.hostId}\n`);
}

let activeApp = null;

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.internalHost) {
    await runSessionHostFromFile(opts.internalHost);
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.version) {
    process.stdout.write(`${LUCID_VERSION}\n`);
    return;
  }
  if (opts.bgList) {
    await runBgList(opts);
    return;
  }
  if (opts.bgStop) {
    await runBgStop(opts);
    return;
  }
  if (opts.bgPrompt) {
    await runBgPrompt(opts);
    return;
  }

  const app = new LucidApp(opts);
  activeApp = app;

  let handlingFatal = false;
  const handleFatal = async (label, err) => {
    if (handlingFatal) return;
    handlingFatal = true;
    app.restoreTerminalSync();
    const shouldDetach = Boolean(app.acp?.isHosted);
    await app.shutdown(1, { detach: shouldDetach }).catch(() => {});
    process.stderr.write(`lucid ${label}: ${err?.stack || err}\n`);
    process.exit(1);
  };

  process.on("uncaughtException", (err) => {
    handleFatal("fatal error", err);
  });
  process.on("unhandledRejection", (err) => {
    handleFatal("unhandled rejection", err);
  });

  await app.run();
  if (app.exitNotice) {
    process.stdout.write(`${app.exitNotice}\n`);
  }
}

main().catch((err) => {
  if (activeApp) {
    activeApp.restoreTerminalSync();
  }
  process.stderr.write(`Error: ${err?.message || err}\n`);
  process.exit(1);
});
