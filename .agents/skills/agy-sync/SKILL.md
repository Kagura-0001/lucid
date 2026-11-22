---
name: agy-sync
description: >-
  Audit changes in the locally installed `agy` CLI/ACP server against lucid's recorded baseline
  and adapt Tier A compatibility gaps cleanly without bloating lucid. Use when the user asks
  to sync lucid with a new `agy` version, invokes `/agy-sync`, or reports Swarm/ACP drift.
---

# Sync lucid with Antigravity (`agy`) Updates

Keep lucid compatible with updates to `agy` while preserving its zero-dependency architecture, transparent TUI invariants, and strict module boundaries defined in [`AGENTS.md`](../../../AGENTS.md).

## Workflow

1. **Probe local `agy` vs baseline**
   Run the zero-quota probe script from the repository root (`/vlm/lws/repos/lucid`):
   ```bash
   node .agents/skills/agy-sync/scripts/probe_agy.mjs
   ```
   - Inspect [`baseline.json`](./baseline.json) alongside the probe output.
   - If running inside a read-only sandbox that blocks `agy acp --stdio` (e.g. writing `~/.gemini/antigravity-cli/installation_id`), inspect static CLI/changelog/skill diffs with `--no-live-acp` first and request running `probe_agy.mjs` outside the sandbox only if live ACP probing is needed.

2. **Triage diffs using `AGENTS.md` Tiers**
   Compare what changed since `baseline.json`:
   - `agyVersion` and `changelogSinceBaseline`
   - `acpFlags` (`agy acp --help`) and `cliSubcommands` (`agy --help`)
   - `builtinSwarmSkills` SHA-256 hashes (`native_swarm`, `swarm_pane`, `swarm_monitor`, `swarm_narrator`) and any schema shifts on disk under `~/.gemini/antigravity-cli/brain/<session>/.system_generated/`
   - `liveAcp` diffs (`agentCapabilities`, `configOptions`, `modes`, `modelCount`, `availableCommands`)
   Sort each finding into:
   - **Tier A (auto-adapt)**: ACP metadata/capability/flag drift, `agy_state.mjs` disk schema changes, Swarm/subagent status/result presentation bugs, or `agy -p "/usage"` parser fixes.
   - **Tier B (propose first)**: New terminal UX features or views — wait for user approval before coding.
   - **Tier C (do not mirror)**: Native `agy` browser/voice/plugin-UI features — document `agy --conversation <id>` if helpful, do not reimplement.

3. **Implement cleanly in owning modules**
   - Put ACP protocol/state fixes in [`src/acp/agy_state.mjs`](../../../src/acp/agy_state.mjs), [`src/acp/protocol.mjs`](../../../src/acp/protocol.mjs), or [`src/acp/client.mjs`](../../../src/acp/client.mjs).
   - Put UI/rendering fixes in [`src/ui/swarm.mjs`](../../../src/ui/swarm.mjs), [`src/ui/tool_format.mjs`](../../../src/ui/tool_format.mjs), or [`src/ui/views.mjs`](../../../src/ui/views.mjs).
   - Keep `src/app.mjs` under `1,000` lines and deduplicate rather than adding special-case copies.
   - Add or update unit tests with realistic fixtures under [`test/`](../../../test/).

4. **Verify everything**
   ```bash
   npm run assets && npm test && npm run preview && npm --cache /tmp/npm-cache pack --dry-run
   ```
   Confirm 0 failed/skipped tests, 0 opaque backgrounds, 0 width overflows across all 5 themes, and no non-runtime files added to the npm pack list.

5. **Refresh `baseline.json`**
   Once verified cleanly:
   ```bash
   node .agents/skills/agy-sync/scripts/probe_agy.mjs --write-baseline
   ```
   Verify `baseline.json` contains no secrets, auth tokens, or user data, and re-run `node .agents/skills/agy-sync/scripts/probe_agy.mjs --no-live-acp` to confirm zero remaining drift.

6. **Report and stop before releasing**
   Summarize Tier A changes made, Tier B proposals (if any), skipped Tier C items, and verification results. Wait for explicit user confirmation before committing, pushing, tagging, or running `npm publish`.
