#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../../../../src/acp/client.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(SKILL_DIR, "../../..");
const BASELINE_PATH = path.join(SKILL_DIR, "baseline.json");
const SWARM_SKILL_NAMES = ["native_swarm", "swarm_pane", "swarm_monitor", "swarm_narrator"];

function parseArgs(argv) {
  const opts = {
    json: false,
    writeBaseline: false,
    noLiveAcp: false,
    skillsDir: path.join(os.homedir(), ".gemini", "antigravity-cli", "builtin", "skills"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--write-baseline") opts.writeBaseline = true;
    else if (arg === "--no-live-acp") opts.noLiveAcp = true;
    else if (arg === "--skills-dir" && argv[i + 1]) opts.skillsDir = path.resolve(argv[++i]);
  }
  return opts;
}

function runAgyCommand(args, timeoutMs = 8000) {
  try {
    const res = spawnSync("agy", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  } catch {
    return "";
  }
}

function compareSemver(a, b) {
  const pa = String(a || "0.0.0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "0.0.0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function parseAcpFlags(helpText) {
  const flags = new Set();
  for (const line of String(helpText || "").split(/\r?\n/)) {
    const match = /^\s+(--[a-z0-9][a-z0-9_-]*)/i.exec(line);
    if (match) flags.add(match[1]);
  }
  return [...flags].sort();
}

function parseSubcommands(helpText) {
  const cmds = new Set();
  let inSection = false;
  for (const line of String(helpText || "").split(/\r?\n/)) {
    if (/^Available subcommands:/i.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (!line.trim()) break;
    const match = /^\s+([a-z0-9][a-z0-9_-]*)\s+/i.exec(line);
    if (match) cmds.add(match[1]);
  }
  return [...cmds].sort();
}

function parseChangelog(changelogText, baselineVersion) {
  const entries = [];
  let current = null;
  for (const rawLine of String(changelogText || "").split(/\r?\n/)) {
    const verMatch = /^(\d+\.\d+\.\d+):\s*$/.exec(rawLine.trim());
    if (verMatch) {
      current = { version: verMatch[1], bullets: [] };
      entries.push(current);
      continue;
    }
    if (current && rawLine.trim()) {
      current.bullets.push(rawLine.trim().replace(/^[·•*-]\s*/, ""));
    }
  }
  if (!baselineVersion) return entries.slice(0, 1);
  return entries.filter((entry) => compareSemver(entry.version, baselineVersion) > 0);
}

function inspectBuiltinSwarmSkills(skillsDir) {
  const result = {};
  for (const name of SWARM_SKILL_NAMES) {
    const filePath = path.join(skillsDir, name, "SKILL.md");
    try {
      const content = fs.readFileSync(filePath);
      result[name] = {
        exists: true,
        bytes: content.length,
        sha256: crypto.createHash("sha256").update(content).digest("hex"),
      };
    } catch {
      result[name] = { exists: false, bytes: 0, sha256: "" };
    }
  }
  return result;
}

async function probeLiveAcpSession() {
  const client = new AcpClient({
    name: "Antigravity",
    command: "agy",
    args: ["acp", "--stdio"],
  });
  const commands = [];
  client.on("sessionUpdate", (params) => {
    if (params?.update?.sessionUpdate === "available_commands_update") {
      for (const cmd of params.update.availableCommands || []) {
        if (cmd?.name && !commands.includes(cmd.name)) commands.push(cmd.name);
      }
    }
  });
  let sessionId = null;
  try {
    const init = await client.start();
    const created = await client.createSession(REPO_ROOT, []);
    sessionId = created?.sessionId || null;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return {
      ok: true,
      agentInfo: init?.agentInfo || null,
      agentCapabilities: init?.agentCapabilities || {},
      configOptions: (created?.configOptions || []).map((opt) => ({
        id: opt.id || "",
        category: opt.category || "",
        optionCount: Array.isArray(opt.options) ? opt.options.length : 0,
      })),
      modes: (created?.modes?.availableModes || []).map((m) => m.id).filter(Boolean).sort(),
      modelCount: Array.isArray(created?.models?.availableModels) ? created.models.availableModels.length : 0,
      availableCommands: [...commands].sort(),
    };
  } catch (err) {
    const detail = client.stderrTail?.slice(-2).join(" | ") || "";
    return {
      ok: false,
      error: detail || err?.message || String(err),
    };
  } finally {
    await client.stop(sessionId).catch(() => {});
  }
}

function diffArrays(prev = [], next = []) {
  const prevSet = new Set(prev);
  const nextSet = new Set(next);
  return {
    added: next.filter((item) => !prevSet.has(item)),
    removed: prev.filter((item) => !nextSet.has(item)),
  };
}

function computeDiffs(baseline, current, changelogEntries) {
  if (!baseline) {
    return {
      hasBaseline: false,
      hasChanges: true,
      versionChanged: true,
      addedAcpFlags: current.acpFlags,
      removedAcpFlags: [],
      addedSubcommands: current.cliSubcommands,
      removedSubcommands: [],
      changedSwarmSkills: SWARM_SKILL_NAMES.filter((n) => current.builtinSwarmSkills[n]?.exists).map((n) => ({
        name: n,
        reason: "initial",
      })),
      newChangelogVersions: changelogEntries.map((c) => c.version),
      liveAcpDiffs: null,
    };
  }

  const flagDiff = diffArrays(baseline.acpFlags || [], current.acpFlags || []);
  const subDiff = diffArrays(baseline.cliSubcommands || [], current.cliSubcommands || []);
  const changedSwarmSkills = [];
  for (const name of SWARM_SKILL_NAMES) {
    const prev = baseline.builtinSwarmSkills?.[name];
    const next = current.builtinSwarmSkills?.[name];
    if (!prev?.exists && next?.exists) changedSwarmSkills.push({ name, reason: "added" });
    else if (prev?.exists && !next?.exists) changedSwarmSkills.push({ name, reason: "removed" });
    else if (prev?.sha256 !== next?.sha256) changedSwarmSkills.push({ name, reason: "modified" });
  }

  let liveAcpDiffs = null;
  if (baseline.liveAcp?.ok && current.liveAcp?.ok) {
    const cmdDiff = diffArrays(baseline.liveAcp.availableCommands || [], current.liveAcp.availableCommands || []);
    const modeDiff = diffArrays(baseline.liveAcp.modes || [], current.liveAcp.modes || []);
    const optDiff = diffArrays(
      (baseline.liveAcp.configOptions || []).map((o) => o.id),
      (current.liveAcp.configOptions || []).map((o) => o.id),
    );
    const capsChanged =
      JSON.stringify(baseline.liveAcp.agentCapabilities || {}) !==
      JSON.stringify(current.liveAcp.agentCapabilities || {});
    const modelDelta = (current.liveAcp.modelCount || 0) - (baseline.liveAcp.modelCount || 0);
    if (
      cmdDiff.added.length > 0 ||
      cmdDiff.removed.length > 0 ||
      modeDiff.added.length > 0 ||
      modeDiff.removed.length > 0 ||
      optDiff.added.length > 0 ||
      optDiff.removed.length > 0 ||
      capsChanged ||
      modelDelta !== 0
    ) {
      liveAcpDiffs = { cmdDiff, modeDiff, optDiff, capsChanged, modelDelta };
    }
  }

  const versionChanged = baseline.agyVersion !== current.agyVersion;
  const hasChanges =
    versionChanged ||
    flagDiff.added.length > 0 ||
    flagDiff.removed.length > 0 ||
    subDiff.added.length > 0 ||
    subDiff.removed.length > 0 ||
    changedSwarmSkills.length > 0 ||
    Boolean(liveAcpDiffs);

  return {
    hasBaseline: true,
    hasChanges,
    versionChanged,
    addedAcpFlags: flagDiff.added,
    removedAcpFlags: flagDiff.removed,
    addedSubcommands: subDiff.added,
    removedSubcommands: subDiff.removed,
    changedSwarmSkills,
    newChangelogVersions: changelogEntries.map((c) => c.version),
    liveAcpDiffs,
  };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function formatTextReport(report) {
  const { baselineVersion, current, diffs, changelog } = report;
  const lines = [
    "=== agy-sync probe ===",
    `Baseline agy : ${baselineVersion || "(none)"}`,
    `Current agy  : ${current.agyVersion || "(not installed)"}`,
    `ACP flags    : ${current.acpFlags.length} | CLI subcommands: ${current.cliSubcommands.length}`,
  ];
  if (current.liveAcp?.skipped) {
    lines.push("Live ACP     : skipped (--no-live-acp)");
  } else if (current.liveAcp?.ok) {
    lines.push(
      `Live ACP     : ok (${current.liveAcp.modes.length} modes, ${current.liveAcp.modelCount} models, ${current.liveAcp.availableCommands.length} commands)`,
    );
  } else {
    lines.push(`Live ACP     : unavailable (${current.liveAcp?.error || "unknown error"})`);
  }

  if (!diffs.hasBaseline) {
    lines.push("Status       : no baseline.json recorded yet (run with --write-baseline).");
  } else if (!diffs.hasChanges) {
    lines.push("Status       : No changes detected vs baseline.");
  } else {
    lines.push("Status       : Changes detected!");
    if (diffs.addedAcpFlags.length) lines.push(`  +ACP flags    : ${diffs.addedAcpFlags.join(", ")}`);
    if (diffs.removedAcpFlags.length) lines.push(`  -ACP flags    : ${diffs.removedAcpFlags.join(", ")}`);
    if (diffs.addedSubcommands.length) lines.push(`  +Subcommands  : ${diffs.addedSubcommands.join(", ")}`);
    if (diffs.removedSubcommands.length) lines.push(`  -Subcommands  : ${diffs.removedSubcommands.join(", ")}`);
    if (diffs.changedSwarmSkills.length) {
      lines.push(
        `  Swarm skills  : ${diffs.changedSwarmSkills.map((s) => `${s.name} (${s.reason})`).join(", ")}`,
      );
    }
    if (diffs.liveAcpDiffs) {
      const ld = diffs.liveAcpDiffs;
      if (ld.cmdDiff.added.length) lines.push(`  +Commands     : ${ld.cmdDiff.added.join(", ")}`);
      if (ld.cmdDiff.removed.length) lines.push(`  -Commands     : ${ld.cmdDiff.removed.join(", ")}`);
      if (ld.modeDiff.added.length) lines.push(`  +Modes        : ${ld.modeDiff.added.join(", ")}`);
      if (ld.optDiff.added.length) lines.push(`  +ConfigOpts   : ${ld.optDiff.added.join(", ")}`);
      if (ld.capsChanged) lines.push("  Capabilities  : agentCapabilities changed");
      if (ld.modelDelta !== 0) lines.push(`  Model count   : delta ${ld.modelDelta > 0 ? "+" : ""}${ld.modelDelta}`);
    }
  }

  if (changelog.length > 0) {
    lines.push("", "Recent changelog entries:");
    for (const entry of changelog) {
      lines.push(`  ${entry.version}: ${entry.bullets.length} items`);
      for (const b of entry.bullets.slice(0, 6)) {
        lines.push(`    - ${b.slice(0, 140)}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const baseline = readJsonSafe(BASELINE_PATH);

  const agyVersion = runAgyCommand(["--version"]).trim().split(/\r?\n/)[0] || "";
  const acpFlags = parseAcpFlags(runAgyCommand(["acp", "--help"]));
  const cliSubcommands = parseSubcommands(runAgyCommand(["--help"]));
  const changelog = parseChangelog(runAgyCommand(["changelog"]), baseline?.agyVersion || "");
  const builtinSwarmSkills = inspectBuiltinSwarmSkills(opts.skillsDir);
  const liveAcp = opts.noLiveAcp ? { skipped: true } : await probeLiveAcpSession();

  const current = { agyVersion, acpFlags, cliSubcommands, builtinSwarmSkills, liveAcp };
  const diffs = computeDiffs(baseline, current, changelog);

  if (opts.writeBaseline) {
    const nextBaseline = {
      schemaVersion: 1,
      agyVersion,
      acpFlags,
      cliSubcommands,
      builtinSwarmSkills,
      liveAcp: liveAcp?.ok ? liveAcp : baseline?.liveAcp || null,
    };
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(nextBaseline, null, 2)}\n`, "utf8");
  }

  const report = {
    baselinePath: BASELINE_PATH,
    baselineVersion: baseline?.agyVersion || "",
    wroteBaseline: opts.writeBaseline,
    current,
    diffs,
    changelog,
  };

  process.stdout.write(opts.json ? `${JSON.stringify(report, null, 2)}\n` : formatTextReport(report));
}

main().catch((err) => {
  process.stderr.write(`probe_agy failed: ${err?.message || err}\n`);
  process.exit(1);
});
