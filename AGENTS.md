# AGENTS.md — lucid project rules

## Runtime & UI Invariants
- **Node.js `>= 20` ESM, zero runtime dependencies**: Never add runtime entries to `dependencies` in `package.json`. Use built-in `node:*` modules only.
- **Transparent background**: Never emit opaque SGR background sequences across views, markdown, diffs, modals, or Swarm panes. Keep 0 opaque bg and 0 column width overflow across all 5 themes in `npm run preview`.
- **Default behavior & UX contracts**: Keep `DEFAULT_CONFIG.mode === "auto"`, keep permission modals immediately responsive (no keystroke-swallowing delay), and keep `buildPromptBlocks` compatible when `mentionSourceText` is omitted.

## Architecture & Module Map
Keep changes focused in the owning module — never let `src/app.mjs` grow back into a god object (must stay `< 1,000` lines):
- `bin/lucid.mjs`: CLI entry, `bg` subcommands, fatal handler
- `src/app.mjs`: `LucidApp` state assembly, mode/config toggles, modal state, frame rendering
- `src/app/session.mjs`: ACP connection lifecycle, `SessionHost` attach/replay, `/resume`, tool & streaming updates
- `src/app/input.mjs`: keyboard/mouse/selection dispatch, viewport slicing, modal & board navigation
- `src/app/commands.mjs`: `COMMAND_SPECS` registry (autocomplete + dispatch)
- `src/app/local_shell.mjs`: `!command` direct workspace runner
- `src/acp/`: `client.mjs`, `host.mjs`, `host_client.mjs`, `bg_registry.mjs`, `jsonrpc.mjs`, `protocol.mjs`, `permissions.mjs`, `agy_state.mjs`
- `src/ui/`: `views.mjs`, `swarm.mjs`, `tool_format.mjs`, `composer.mjs`, `files.mjs`, `markdown.mjs`, `math.mjs`, `diff.mjs`, `selection.mjs`, `themes.mjs`, `format.mjs`
- `src/term/`: `renderer.mjs`, `input.mjs`, `unicode.mjs`, `ansi.mjs`
- `src/config.mjs`: CLI flag parsing, presets, atomic corrupt-safe `config.json` persistence

## Security & Stability Red Lines
- **Safe paste / injection**: Check `!` and `/` triggers strictly on unexpanded `displayRaw` (`Composer.text`); extract `@file` mentions from `displayText || text` and enforce `realpathSync` containment within `cwd`.
- **Sanitization**: Pass untrusted agent/tool/swarm/board strings through `sanitizeUntrustedText()` and window titles through `sanitizeTerminalTitle()` (`renderer.setTitle()`).
- **Private runtime files**: Enforce `0700` dir ownership (non-symlink), `0600`/`wx` atomic writes, socket ownership verification, and `umask(0o077)` in `SessionHost`.
- **Permissions**: Share `selectBypassAllowOption` (`allow_once` first, rejecting negative phrases) and sync `sessionBypass` from `SessionHost` snapshots.
- **Resilience**: Guard JSON-RPC/socket handlers against `null`/non-objects and `stdin` errors; guard lookup tables with `Object.hasOwn`; cap LaTeX recursion depth and tool output buffers (`64 KB`); cache terminal tool classifications and archived timeline blocks with `WeakMap`.

## Syncing with `agy` Updates (`/agy-sync`)
Classify `agy` changes into three tiers before touching code (run `.agents/skills/agy-sync/scripts/probe_agy.mjs` first):
- **Tier A — Auto-adapt (safe & bounded)**: Changes in `agy acp` capabilities, `configOptions`, `modes`, `models`, `availableCommands`, `agy acp` CLI flags, `agy` disk state schema (`members.json`, `plan.json`, `board.jsonl`, `subagents/*.json`, `transcript.jsonl`), or `agy -p "/usage"` output format. Fix in the owning `src/acp/` or `src/ui/` module and add fixture tests in `test/`.
- **Tier B — Propose first, implement on approval**: Terminal-friendly UX enhancements (new tool summaries, compact Swarm/subagent views, new prompt flags). Summarize options and ask before implementing.
- **Tier C — Explicitly out of scope**: `agy`-exclusive heavy UIs (`remote-control`, `generative_ui` / MCP Apps, `mic-serve`, interactive `plugin`/`mcp`/`settings` managers). Leave out of lucid and direct users to `agy --conversation <id>`.

## Verification & Release Gate
- Before wrapping up any code change, run from `/vlm/lws/repos/lucid`:
  `npm run assets && npm test && npm run preview && npm --cache /tmp/npm-cache pack --dry-run`
- Verify `src/app.mjs < 1,000` lines and zero unwanted files in the npm tarball list.
- Never `git commit`, `git push`, create a tag/release, or run `npm publish` without explicit user confirmation.
