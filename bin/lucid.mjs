#!/usr/bin/env node
import { LucidApp } from "../src/app.mjs";
import { AGENT_PRESETS, parseCliArgs } from "../src/config.mjs";
import { listThemes } from "../src/ui/themes.mjs";

const VERSION = "0.1.0";

function printHelp() {
  const presets = Object.keys(AGENT_PRESETS).join(", ");
  const themes = listThemes()
    .map((t) => t.name)
    .join(", ");

  process.stdout.write(`lucid ${VERSION} — transparent, flicker-free TUI for Antigravity & ACP agents

Usage:
  lucid [options]

Options:
  -r, --resume [id]             Open session picker or resume a specific session ID
  -c, --continue                Resume the most recent conversation in this directory
  -s, --session <id>            Resume a specific session ID
  -a, --agent <preset>          ACP agent preset (default: agy)
                                Built-in: ${presets}
      --cmd "<command>"         Launch a custom ACP stdio server command
  -t, --theme <name>            Transparent color theme (${themes})
  -m, --model <id>              Override initial model
      --mode <mode>             Override initial mode (default|accept-edits|auto|plan)
      --cwd <dir>               Set workspace directory (default: current directory)
      --add-dir <dir>           Add extra workspace directory (repeatable, agy)
      --sandbox                 Pass --sandbox to agy acp
      --dangerously-skip-permissions
                                Pass --dangerously-skip-permissions to agy acp
      --no-mouse                Disable mouse wheel capture (native drag-select always on)
  -v, --version                 Show version
  -h, --help                    Show this help

Examples:
  lucid                         Start a fresh Antigravity session
  lucid -r                      Pick and resume an existing Antigravity conversation
  lucid -c                      Resume the latest Antigravity conversation here
  lucid --theme tokyo-night     Use Tokyo Night accents on transparent terminal bg
  lucid --cmd "gemini --experimental-acp"
`);
}

let activeApp = null;

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));

  if (opts.help) {
    printHelp();
    return;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const app = new LucidApp(opts);
  activeApp = app;

  const handleFatal = async (label, err) => {
    app.restoreTerminalSync();
    await app.shutdown(1);
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
}

main().catch((err) => {
  if (activeApp) {
    activeApp.restoreTerminalSync();
  }
  process.stderr.write(`Error: ${err?.message || err}\n`);
  process.exit(1);
});
