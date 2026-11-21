import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT_PRESETS = {
  agy: {
    name: "Antigravity",
    command: "agy",
    args: ["acp", "--stdio"],
    loginArgs: ["acp", "--login"],
    supportsQuotaCli: true,
  },
  antigravity: {
    name: "Antigravity",
    command: "agy",
    args: ["acp", "--stdio"],
    loginArgs: ["acp", "--login"],
    supportsQuotaCli: true,
  },
  gemini: {
    name: "Gemini CLI",
    command: "gemini",
    args: ["--experimental-acp"],
    supportsQuotaCli: false,
  },
  opencode: {
    name: "OpenCode",
    command: "opencode",
    args: ["acp"],
    supportsQuotaCli: false,
  },
  goose: {
    name: "Goose",
    command: "goose",
    args: ["acp"],
    supportsQuotaCli: false,
  },
  claude: {
    name: "Claude Code (ACP)",
    command: "claude-code-acp",
    args: [],
    supportsQuotaCli: false,
  },
  codex: {
    name: "Codex (ACP)",
    command: "codex-acp",
    args: [],
    supportsQuotaCli: false,
  },
};

export const DEFAULT_CONFIG = {
  theme: "transparent",
  agent: "agy",
  mode: "auto",
  dangerouslySkipPermissions: false,
  mouseCapture: true,
  thoughtMode: "fold",
  showThoughts: false,
  expandTools: false,
  customAgents: {},
};

export function getConfigDir() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome && xdgConfigHome.trim().length > 0) {
    return path.join(xdgConfigHome, "lucid");
  }
  return path.join(os.homedir(), ".config", "lucid");
}

export function getConfigPath() {
  return path.join(getConfigDir(), "config.json");
}

export function loadUserConfig() {
  const configPath = getConfigPath();
  try {
    const rawText = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(rawText);
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      customAgents: {
        ...DEFAULT_CONFIG.customAgents,
        ...(parsed.customAgents || {}),
      },
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveUserConfig(config) {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

export function splitCommandLine(commandString) {
  const tokens = [];
  let current = "";
  let quoteChar = null;
  let escaping = false;

  for (const ch of commandString) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quoteChar !== "'") {
      escaping = true;
      continue;
    }
    if (quoteChar) {
      if (ch === quoteChar) {
        quoteChar = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoteChar = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

export function resolveAgentLaunch(options, userConfig) {
  if (options.cmd) {
    const parts = splitCommandLine(options.cmd);
    if (parts.length === 0) {
      throw new Error("Empty --cmd argument.");
    }
    return {
      name: path.basename(parts[0]),
      command: parts[0],
      args: parts.slice(1),
      supportsQuotaCli: parts[0] === "agy",
    };
  }

  const agentKey = (options.agent || userConfig.agent || "agy").toLowerCase();
  const customPreset = userConfig.customAgents && userConfig.customAgents[agentKey];
  if (customPreset && customPreset.command) {
    return {
      name: customPreset.name || agentKey,
      command: customPreset.command,
      args: Array.isArray(customPreset.args) ? [...customPreset.args] : [],
      supportsQuotaCli: Boolean(customPreset.supportsQuotaCli),
    };
  }

  const builtinPreset = AGENT_PRESETS[agentKey];
  if (!builtinPreset) {
    const known = Object.keys(AGENT_PRESETS).join(", ");
    throw new Error(`Unknown agent preset "${agentKey}". Known presets: ${known}. Or use --cmd "<command>".`);
  }

  const args = [...builtinPreset.args];
  if (options.sandbox && (agentKey === "agy" || agentKey === "antigravity")) {
    args.push("--sandbox");
  }
  if ((options.dangerouslySkipPermissions || userConfig.dangerouslySkipPermissions) && (agentKey === "agy" || agentKey === "antigravity")) {
    args.push("--dangerously-skip-permissions");
  }
  if (Array.isArray(options.addDirs) && (agentKey === "agy" || agentKey === "antigravity")) {
    for (const extraDir of options.addDirs) {
      args.push("--add-dir", extraDir);
    }
  }

  return {
    name: builtinPreset.name,
    command: builtinPreset.command,
    args,
    loginArgs: builtinPreset.loginArgs || null,
    supportsQuotaCli: builtinPreset.supportsQuotaCli,
  };
}

export function parseCliArgs(argv) {
  const opts = {
    addDirs: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "-v" || arg === "--version") {
      opts.version = true;
    } else if (arg === "-r" || arg === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        opts.session = next;
        i += 1;
      } else {
        opts.resumePicker = true;
      }
    } else if (arg.startsWith("--resume=")) {
      const val = arg.slice("--resume=".length).trim();
      if (val) {
        opts.session = val;
      } else {
        opts.resumePicker = true;
      }
    } else if (arg === "-c" || arg === "--continue") {
      opts.continueLatest = true;
    } else if (arg === "-s" || arg === "--session") {
      opts.session = argv[++i];
    } else if (arg === "-a" || arg === "--agent") {
      opts.agent = argv[++i];
    } else if (arg === "--cmd") {
      opts.cmd = argv[++i];
    } else if (arg === "-t" || arg === "--theme") {
      opts.theme = argv[++i];
    } else if (arg === "-m" || arg === "--model") {
      opts.model = argv[++i];
    } else if (arg === "--mode") {
      opts.mode = argv[++i];
    } else if (arg === "--cwd") {
      opts.cwd = argv[++i];
    } else if (arg === "--add-dir") {
      opts.addDirs.push(argv[++i]);
    } else if (arg === "--sandbox") {
      opts.sandbox = true;
    } else if (arg === "--dangerously-skip-permissions" || arg === "--bypass" || arg === "--yolo") {
      opts.dangerouslySkipPermissions = true;
    } else if (arg === "--no-mouse") {
      opts.noMouse = true;
    } else {
      throw new Error(`Unknown argument: ${arg} (run "lucid --help" for usage)`);
    }
  }
  return opts;
}
