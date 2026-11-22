# Reference

## CLI Options

```bash
lucid [options]
lucid bg [prompt]             # start or list detached background sessions
lucid bg stop <id|all>        # stop background session(s)
```

| Flag | Description |
| :--- | :--- |
| `-r, --resume [id]` | Open session picker, or resume by full ID / `>=4`-char prefix (`--resume=<id>`) |
| `-c, --continue` | Resume the most recent conversation in `--cwd` |
| `-s, --session <id>` | Resume a specific session ID or `>=4`-char unique prefix |
| `-a, --agent <preset>` | ACP preset (`agy`, `antigravity`, `gemini`, `opencode`, `goose`, `claude`, `codex`) |
| `--cmd "<command>"` | Launch any custom ACP stdio command |
| `-t, --theme <name>` | Theme (`transparent`, `tokyo-night`, `catppuccin`, `solarized`, `mono`) |
| `-m, --model <id>` | Override initial model |
| `--mode <mode>` | Initial mode (`default`, `accept-edits`, `auto`, `plan`) |
| `--cwd <dir>` | Workspace directory (default: current directory) |
| `--add-dir <dir>` | Add extra workspace directory (repeatable, `agy`) |
| `--sandbox` | Pass `--sandbox` to `agy acp` |
| `--bypass` / `--yolo` / `--dangerously-skip-permissions` | Pass `--dangerously-skip-permissions` to `agy acp` |
| `--no-mouse` | Disable mouse wheel capture so native drag-select is always active |
| `--direct` | Run ACP child directly without the background session host |
| `-v, --version` / `-h, --help` | Print version or help |

## Keybindings & Slash Commands

| Shortcut / Command | Action |
| :--- | :--- |
| `Enter` | Send prompt (or steer while running) |
| `!<command>` | Run a local shell command directly in the workspace (bypasses agent; `Esc`/`Ctrl+C` cancels) |
| `Ctrl+J` / `Shift+Enter` / `Alt+Enter` / `\`+`Enter` | Insert newline in composer |
| `Esc` | Close popup/modal, exit agent inspect view, cancel turn, or jump to bottom |
| `Shift+Tab` | Cycle mode (`default` / `accept-edits` / `auto` / `plan` / session-only `bypass`, which also hot-restarts `agy acp` with `--dangerously-skip-permissions` via `session/resume` so Swarm sub-workers auto-approve too) |
| `Ctrl+O` / `/expand` | Expand or collapse tool details and archived turns |
| `Ctrl+T` / `/thoughts [fold\|show\|hide]` | Fold, expand, or hide thinking blocks |
| `Alt+[` / `Alt+]` (or `Shift+←/→` when empty) | Cycle main conversation and individual Swarm workers / subagents live |
| `Alt+B` / `/dock` | Fold or expand the bottom multi-agent progress dock |
| `Ctrl+B` / `/board` | Toggle the full-screen Swarm & Subagent split-pane board |
| `Ctrl+Y` / `/copy` | Copy latest assistant reply via OSC 52 |
| `Ctrl+G` / `/mouse` | Toggle mouse capture (ON = wheel scrolls & drag-copy; OFF = native drag-select, PgUp/PgDn or Alt+↑/↓ to scroll) |
| `Ctrl+V` / `/image <path>` / `/unattach` | Attach clipboard or local image (`@img.png` and drag-drop also work) |
| `Ctrl+P` / `Ctrl+N` | Previous / next prompt history |
| `Ctrl+L` | Force full screen repaint |
| `PgUp` / `PgDn` / `Alt+↑` / `Alt+↓` / Wheel | Scroll timeline |
| `Ctrl+D` / `Ctrl+C` ×2 / `/quit` | Exit cleanly |
| `/resume [id\|filter]` (`/sessions`) | Browse or resume live background and saved sessions |
| `/bg [prompt]` (`/detach`) | Move current session to the background (also automatic on SSH disconnect) |
| `/new` · `/clear` · `/help` | Fresh session · clear visible timeline · open shortcuts modal |
| `/model` · `/effort` · `/mode [name]` | Pick model, thinking level, or execution mode |
| `/artifacts` · `/theme [name]` · `/usage` (`/quota`) | Read Markdown artifacts · switch palette · check context & Antigravity quota |
| `@path` | Fuzzy-search and attach workspace file |

## Permissions & Bypass

| Mode | Effect | Scope |
| :--- | :--- | :--- |
| Default | Switches agent to `auto`; modes chosen via `Shift+Tab` / `/mode` persist | Persistent |
| `Shift+Tab` → `bypass` (`/mode bypass`) | Agent runs in `auto` and lucid auto-approves every permission prompt; red `bypass` badge in header | Current session only (never saved) |
| `lucid --bypass` | Launches `agy acp` with `--dangerously-skip-permissions` | Entire process |
| `"dangerouslySkipPermissions": true` | Same as always passing `--bypass` | Persistent |

> Session-level `bypass` only approves prompts the agent sends to lucid; hard sandbox denials inside `agy` are not overridden.

## Supported ACP Presets

| Preset (`-a`) | Underlying Command |
| :--- | :--- |
| `agy` *(default)* / `antigravity` | `agy acp --stdio` |
| `gemini` | `gemini --experimental-acp` |
| `opencode` | `opencode acp` |
| `goose` | `goose acp` |
| `claude` | `claude-code-acp` |
| `codex` | `codex-acp` |

## Configuration

Preferences live at `~/.config/lucid/config.json` (respects `XDG_CONFIG_HOME`):

```json
{
  "theme": "tokyo-night",
  "agent": "agy",
  "mode": "auto",
  "dangerouslySkipPermissions": false,
  "mouseCapture": true,
  "thoughtMode": "fold",
  "expandTools": false,
  "agyDataDir": "",
  "customAgents": {
    "my-agent": {
      "name": "My ACP Agent",
      "command": "my-agent-bin",
      "args": ["acp", "--stdio"],
      "supportsQuotaCli": false
    }
  }
}
```

## Development

```bash
npm test          # unit and mock-ACP test suite
npm run preview   # check all 5 themes for 0 opaque bg codes and 0 width overflow
npm run assets    # regenerate README/docs SVG previews
```
