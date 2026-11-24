import fs from "node:fs";
import { readAgyOrchestratorSettings } from "../acp/agy_state.mjs";
import { fetchAgyQuota } from "../acp/client.mjs";
import { sanitizeUntrustedText } from "../term/unicode.mjs";
import { formatBytes, loadImageAttachment } from "../ui/files.mjs";
import { parseAutoCompactOverride } from "../ui/format.mjs";
import { listThemes } from "../ui/themes.mjs";
import {
  createFreshSession,
  openResumePicker,
  resetConversationState,
  resolveModeId,
} from "./session.mjs";

const THOUGHT_MODE_ALIASES = {
  show: "expanded",
  expand: "expanded",
  on: "expanded",
  fold: "fold",
  collapse: "fold",
  hide: "hidden",
  off: "hidden",
};

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_DISPLAY_NAMES = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra",
  max: "Max",
};

function discoverModelEfforts(modelId, rawModels, activeEffortOpt, isCurrentModel) {
  const byValue = new Map();

  // Discover exact supported effort variants from `availableModels` (e.g. "gemini-4-neon-xhigh").
  const prefix = `${modelId}-`;
  for (const m of Array.isArray(rawModels) ? rawModels : []) {
    const id = String(m?.modelId || "");
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length).toLowerCase();
    if (!EFFORT_ORDER.includes(suffix)) continue;
    byValue.set(suffix, {
      value: suffix,
      label: EFFORT_DISPLAY_NAMES[suffix] || suffix,
      modelId: id,
    });
  }

  // Prefer canonical labels from active `thought_level` configOption when available.
  if (isCurrentModel && activeEffortOpt && Array.isArray(activeEffortOpt.options)) {
    for (const opt of activeEffortOpt.options) {
      const val = String(opt?.value || "").toLowerCase();
      if (!val) continue;
      const existing = byValue.get(val);
      byValue.set(val, {
        value: opt.value,
        label: opt.name || existing?.label || EFFORT_DISPLAY_NAMES[val] || opt.value,
        modelId: existing?.modelId || "",
      });
    }
  }

  return [...byValue.values()].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(String(a.value).toLowerCase());
    const ib = EFFORT_ORDER.indexOf(String(b.value).toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

function defaultEffortIndex(efforts, currentEffortValue, isCurrentModel) {
  if (!Array.isArray(efforts) || efforts.length === 0) return 0;
  if (isCurrentModel && currentEffortValue) {
    const curIdx = efforts.findIndex((e) => String(e.value).toLowerCase() === String(currentEffortValue).toLowerCase());
    if (curIdx >= 0) return curIdx;
  }
  const highIdx = efforts.findIndex((e) => String(e.value).toLowerCase() === "high");
  if (highIdx >= 0) return highIdx;
  const medIdx = efforts.findIndex((e) => String(e.value).toLowerCase() === "medium");
  if (medIdx >= 0) return medIdx;
  return 0;
}

export function buildModelPickerItems(app) {
  const modelOpt = app.getConfigOption("model");
  const effortOpt = app.getConfigOption("thought_level") || app.getConfigOption("effort");
  const rawModels = Array.isArray(app.state.models) ? app.state.models : [];
  const dataDir = app.agyStateWatcher?.dataDir || "";
  const orchConfigured = readAgyOrchestratorSettings(dataDir);

  if (modelOpt && Array.isArray(modelOpt.options) && modelOpt.options.length > 0) {
    return {
      preferConfig: true,
      currentModelValue: modelOpt.currentValue || "",
      items: modelOpt.options.map((o) => {
        const label = o.name || o.value;
        const isCurrent = o.value === modelOpt.currentValue;
        const isOrchestrator = /orchestrator/i.test(label) || /orchestrator/i.test(o.value);
        const efforts = isOrchestrator ? [] : discoverModelEfforts(o.value, rawModels, effortOpt, isCurrent);
        const selectedEffortIdx = defaultEffortIndex(efforts, effortOpt?.currentValue || "", isCurrent);
        const fixedEffortMatch = !isOrchestrator && efforts.length === 0 ? /\((Low|Medium|High|XHigh|Extra|Max)\)\s*$/i.exec(label) : null;
        const rightTag = isOrchestrator
          ? (orchConfigured || "Planner/Executor · high")
          : fixedEffortMatch
            ? fixedEffortMatch[1]
            : "";
        return {
          label,
          value: o.value,
          description: rightTag || o.value,
          active: isCurrent,
          efforts,
          selectedEffortIdx,
          isOrchestrator,
          rightTag,
          searchText: [label, o.value, rightTag, ...efforts.map((e) => e.label)].join(" "),
        };
      }),
    };
  }

  return {
    preferConfig: false,
    currentModelValue: "",
    items: rawModels.map((m) => ({
      label: m.name || m.modelId,
      value: m.modelId,
      description: m.modelId,
      active: (m.name || m.modelId) === app.state.modelLabel,
      efforts: [],
      selectedEffortIdx: 0,
      isOrchestrator: /orchestrator/i.test(m.name || m.modelId),
      rightTag: "",
    })),
  };
}

export const COMMAND_SPECS = [
  {
    name: "model",
    description: "Switch model & thinking effort (←/→ effort)",
    needsConnection: true,
    async run(app) {
      const { items, preferConfig, currentModelValue } = buildModelPickerItems(app);

      if (items.length === 0) {
        app.pushNotice("warn", "No selectable models exposed by this ACP agent.");
        app.scheduleRender();
        return;
      }

      app.openPickerModal({
        title: "Select Model & Effort",
        layout: "model",
        items,
        onSelect: async (chosen) => {
          const chosenEffort =
            Array.isArray(chosen.efforts) && chosen.efforts.length > 0
              ? chosen.efforts[chosen.selectedEffortIdx || 0]
              : null;

          const modelChanged = !preferConfig || chosen.value !== currentModelValue;
          if (modelChanged) {
            const res = await app.acp.setModel(app.state.sessionId, chosen.value, preferConfig);
            app.applySessionMetadata(res);
            app.state.modelLabel = chosen.label;
          }

          let appliedEffortLabel = app.state.effortLabel || "";
          if (chosenEffort) {
            const latestEffortOpt = app.getConfigOption("thought_level") || app.getConfigOption("effort");
            if (
              latestEffortOpt &&
              String(latestEffortOpt.currentValue || "").toLowerCase() !== String(chosenEffort.value).toLowerCase()
            ) {
              const effortRes = await app.acp.setConfigOption(
                app.state.sessionId,
                latestEffortOpt.id,
                chosenEffort.value,
              );
              app.applySessionMetadata(effortRes);
              app.state.effortLabel = chosenEffort.label;
              appliedEffortLabel = chosenEffort.label;
            } else if (latestEffortOpt) {
              appliedEffortLabel = chosenEffort.label;
            }
          }

          const toastLabel = appliedEffortLabel ? `${chosen.label} (${appliedEffortLabel})` : chosen.label;
          app.showToast(`Model → ${toastLabel}`);
          app.scheduleRender();
        },
      });
    },
  },
  {
    name: "effort",
    aliases: ["thinking"],
    description: "Switch thinking / reasoning level",
    needsConnection: true,
    async run(app) {
      const effortOpt = app.getConfigOption("thought_level") || app.getConfigOption("effort");
      if (!effortOpt || !Array.isArray(effortOpt.options) || effortOpt.options.length === 0) {
        if (/orchestrator/i.test(app.state.modelLabel || "")) {
          const dataDir = app.agyStateWatcher?.dataDir || "";
          const configured = readAgyOrchestratorSettings(dataDir);
          const currentDesc = configured
            ? `Configured in settings.json: ${configured}`
            : "Default Planner/Executor effort in agy 1.5.15+ is high (unless customized in settings.json)";
          app.pushNotice(
            "info",
            `agy acp does not expose Orchestrator Planner/Executor effort over ACP. ${currentDesc}. Configure per-role effort in native agy (/model) or ${dataDir ? `${dataDir}/settings.json` : "settings.json"}.`,
          );
        } else {
          app.pushNotice("warn", "This model/agent does not expose a separate thinking level option.");
        }
        app.scheduleRender();
        return;
      }
      app.openPickerModal({
        title: effortOpt.name || "Thinking Level",
        items: effortOpt.options.map((o) => ({
          label: o.name || o.value,
          value: o.value,
          description: o.description || "",
          active: o.value === effortOpt.currentValue,
        })),
        onSelect: async (chosen) => {
          const res = await app.acp.setConfigOption(app.state.sessionId, effortOpt.id, chosen.value);
          app.applySessionMetadata(res);
          app.state.effortLabel = chosen.label;
          app.showToast(`Thinking → ${chosen.label}`);
          app.scheduleRender();
        },
      });
    },
  },
  {
    name: "mode",
    description: "Switch mode (default / accept-edits / auto / plan / bypass)",
    needsConnection: true,
    async run(app, argText) {
      const cycle = app.getModeCycle();
      if (cycle.length === 0) {
        app.pushNotice("warn", "No execution modes exposed by this ACP agent.");
        app.scheduleRender();
        return;
      }
      if (argText) {
        const requested = argText.trim().toLowerCase();
        const targetId =
          requested === "bypass" || requested === "yolo"
            ? "bypass"
            : resolveModeId(app, requested);
        const target = cycle.find((entry) => entry.id === targetId);
        if (target) {
          await app.switchMode(target.id);
        } else {
          app.pushNotice("warn", `Unknown mode "${argText}". Available: ${cycle.map((e) => e.id).join(", ")}`);
          app.scheduleRender();
        }
        return;
      }
      const currentId = app.currentModeCycleId();
      app.openPickerModal({
        title: "Execution Mode",
        items: cycle.map((entry) => ({
          label: entry.name,
          value: entry.id,
          description: entry.description,
          active: entry.id === currentId,
        })),
        onSelect: async (chosen) => {
          await app.switchMode(chosen.value);
        },
      });
    },
  },
  {
    name: "resume",
    listedAliases: [
      { name: "sessions", description: "Browse & load existing conversations (alias of /resume)" },
    ],
    description: "Resume a live background or saved conversation (/resume [id|filter])",
    needsConnection: true,
    async run(app, argText) {
      await openResumePicker(app, { query: argText, startup: false });
    },
  },
  {
    name: "bg",
    aliases: ["detach"],
    description: "Move session to background (/bg [prompt]) — resume via /resume",
    async run(app, argText) {
      await app.detachToBackground({ promptText: argText });
    },
  },
  {
    name: "new",
    description: "Start a fresh conversation session",
    needsConnection: true,
    async run(app) {
      try {
        if (app.state.sessionId) {
          await app.acp.closeSession(app.state.sessionId);
        }
        resetConversationState(app, { cancelPermissions: true });
        app.state.sessionId = "";
        await createFreshSession(app);
        app.showToast("Started new conversation");
      } catch (err) {
        app.pushNotice("error", `Failed to start new session: ${err.message}`);
      }
      app.scheduleRender();
    },
  },
  {
    name: "board",
    aliases: ["agents"],
    description: "Open Swarm & Subagent multi-pane board (Ctrl+B)",
    run(app) {
      app.toggleSwarmBoard();
    },
  },
  {
    name: "dock",
    description: "Fold or expand the bottom multi-agent progress dock (Alt+B)",
    run(app) {
      app.toggleSwarmDock();
    },
  },
  {
    name: "artifacts",
    description: "Browse & read session Markdown artifacts",
    run(app) {
      const list = app.state.multiAgent.getArtifactsList();
      if (list.length === 0) {
        app.showToast("No Markdown artifacts recorded in this session yet");
        return;
      }
      app.openPickerModal({
        title: "Session Artifacts",
        items: list.map((a) => ({
          label: a.title,
          value: a.path,
          description: a.summary ? a.summary.split("\n")[0] : a.path,
          active: false,
        })),
        onSelect: (chosen) => {
          try {
            const content = sanitizeUntrustedText(fs.readFileSync(chosen.value, "utf8"));
            app.modal = {
              type: "artifact",
              title: chosen.label,
              content,
              scrollOffset: 0,
              maxScroll: 0,
            };
          } catch (err) {
            app.pushNotice("error", `Cannot read artifact ${chosen.value}: ${err.message}`);
          }
          app.scheduleRender();
        },
      });
    },
  },
  {
    name: "image",
    description: "Attach an image file (/image <path>)",
    run(app, argText) {
      if (!argText) {
        app.pushNotice("info", "Usage: /image <path-to-png-jpg-webp-gif>  (or drag/paste an image path, or use @image.png)");
        app.scheduleRender();
        return;
      }
      try {
        const img = loadImageAttachment(argText, app.cwd);
        app.state.stagedImages.push(img);
        app.showToast(`Attached image: ${img.label} (${formatBytes(img.sizeBytes)})`);
      } catch (err) {
        app.pushNotice("error", err.message);
      }
      app.scheduleRender();
    },
  },
  {
    name: "paste-image",
    listed: false,
    description: "Attach clipboard image",
    run(app) {
      app.attachFromClipboard();
    },
  },
  {
    name: "unattach",
    description: "Clear staged image attachments",
    run(app) {
      const count = app.state.stagedImages.length;
      app.state.stagedImages = [];
      app.showToast(count > 0 ? `Cleared ${count} staged image(s)` : "No staged images");
      app.scheduleRender();
    },
  },
  {
    name: "theme",
    description: "Switch transparent color theme",
    run(app, argText) {
      const themes = listThemes();
      if (argText) {
        const match = themes.find((t) => t.name === argText.toLowerCase());
        if (match) {
          app.setTheme(match.name);
        } else {
          app.pushNotice("warn", `Unknown theme "${argText}". Available: ${themes.map((t) => t.name).join(", ")}`);
          app.scheduleRender();
        }
        return;
      }
      app.openPickerModal({
        title: "Select Transparent Theme",
        items: themes.map((t) => ({
          label: t.name,
          value: t.name,
          description: t.description,
          active: t.name === app.style.name,
        })),
        onSelect: (chosen) => app.setTheme(chosen.value),
      });
    },
  },
  {
    name: "copy",
    description: "Copy latest assistant reply (OSC 52)",
    run(app) {
      app.copyLastAssistantReply();
    },
  },
  {
    name: "mouse",
    description: "Toggle mouse wheel capture (OFF = native drag-select)",
    run(app) {
      app.toggleMouseCapture();
    },
  },
  {
    name: "expand",
    description: "Toggle expanded tool outputs & diffs",
    run(app) {
      app.toggleExpandTools();
    },
  },
  {
    name: "thoughts",
    description: "Toggle, fold, or hide thinking blocks (/thoughts [fold|show|hide])",
    run(app, argText) {
      const arg = (argText || "").trim().toLowerCase();
      if (!arg) {
        app.toggleThoughtMode();
        return;
      }
      if (Object.hasOwn(THOUGHT_MODE_ALIASES, arg)) {
        app.setThoughtMode(THOUGHT_MODE_ALIASES[arg]);
        return;
      }
      app.pushNotice("warn", "Usage: /thoughts [fold|show|hide]");
      app.scheduleRender(true);
    },
  },
  {
    name: "usage",
    listedAliases: [
      { name: "quota", description: "Check Antigravity quota (alias of /usage)" },
    ],
    description: "Show context usage & Antigravity quota",
    async run(app) {
      if (app.state.usage && app.state.usage.size > 0) {
        const pct = Math.min(100, Math.round((app.state.usage.used / app.state.usage.size) * 100));
        app.pushNotice("info", `Context window: ${app.state.usage.used.toLocaleString()} / ${app.state.usage.size.toLocaleString()} tokens (${pct}%)`);
      }
      const compact = parseAutoCompactOverride(process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE, app.state.usage?.size || 0);
      if (compact) {
        const detail = compact.tokens > 0
          ? ` (${compact.tokens.toLocaleString()} tokens${compact.pct > 0 ? ` · ${compact.pct}%` : ""})`
          : "";
        app.pushNotice("info", `Auto-compact override: ${compact.label}${detail}`);
      }
      if (!app.launchSpec.supportsQuotaCli) {
        if (!app.state.usage) {
          app.showToast("Quota check is only available for Antigravity (agy)", "error");
        }
        app.scheduleRender();
        return;
      }
      app.showToast("Checking Antigravity quota…");
      const quota = await fetchAgyQuota(15000);
      if (quota) {
        app.state.quotaText = quota.badge;
        for (const line of quota.lines) {
          app.pushNotice("info", line);
        }
        app.showToast(`Quota updated (${quota.badge})`);
      } else {
        app.pushNotice("warn", "Could not fetch quota (API key mode or CLI unavailable).");
      }
      app.scheduleRender();
    },
  },
  {
    name: "clear",
    description: "Clear visible timeline (keeps session alive)",
    run(app) {
      resetConversationState(app, { cancelPermissions: false, keepMultiAgent: true, keepSessionMeta: true });
      app.scheduleRender();
    },
  },
  {
    name: "help",
    description: "Show keyboard shortcuts & commands",
    run(app) {
      app.modal = { type: "help", title: "Lucid Keyboard Shortcuts & Commands" };
      app.scheduleRender();
    },
  },
  {
    name: "quit",
    aliases: ["exit", "q"],
    description: "Exit lucid cleanly",
    async run(app) {
      await app.shutdown(0);
    },
  },
];

const COMMAND_MAP = new Map();
const LISTED_COMMAND_NAMES = new Set();
const LISTED_ENTRIES = [];

for (const spec of COMMAND_SPECS) {
  COMMAND_MAP.set(spec.name, spec);
  for (const alias of spec.aliases || []) {
    COMMAND_MAP.set(alias, spec);
  }
  for (const aliasEntry of spec.listedAliases || []) {
    COMMAND_MAP.set(aliasEntry.name, spec);
  }
  if (spec.listed !== false) {
    LISTED_COMMAND_NAMES.add(spec.name);
    LISTED_ENTRIES.push({ name: spec.name, description: spec.description });
    for (const aliasEntry of spec.listedAliases || []) {
      LISTED_COMMAND_NAMES.add(aliasEntry.name);
      LISTED_ENTRIES.push(aliasEntry);
    }
  }
}

export function findLocalCommand(cmdName) {
  return COMMAND_MAP.get(String(cmdName || "").toLowerCase()) || null;
}

export function buildSlashAutocompleteItems(agentCommands, query) {
  const q = String(query || "").toLowerCase();
  const combined = [
    ...LISTED_ENTRIES.map((c) => ({
      label: `/${c.name}`,
      value: `/${c.name}`,
      description: c.description,
      local: true,
    })),
    ...(agentCommands || [])
      .filter((ac) => !LISTED_COMMAND_NAMES.has(ac.name))
      .map((ac) => ({
        label: `/${ac.name}`,
        value: `/${ac.name}`,
        description: ac.description || "Agent command",
        local: false,
      })),
  ];
  return combined.filter((item) => item.label.slice(1).toLowerCase().includes(q));
}

export async function executeLocalCommand(app, cmdName, argText) {
  const spec = findLocalCommand(cmdName);
  if (!spec) return false;
  if (spec.needsConnection && (!app.state.connected || !app.acp)) {
    app.pushNotice("error", "Not connected to an ACP agent.");
    app.scheduleRender();
    return true;
  }
  await spec.run(app, argText);
  return true;
}
