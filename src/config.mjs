import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LUCID_VERSION = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const CONFIG_LOAD_ERROR = Symbol("configLoadError");

export function getConfigLoadError(config) {
  return config?.[CONFIG_LOAD_ERROR] || "";
}

export function isAgyCommand(command) {
  return /(^|\/)agy$/i.test(String(command || "").trim());
}

export function supportsNativeBypassFlag(launchSpec) {
  if (!launchSpec || typeof launchSpec !== "object") return false;
  if (typeof launchSpec.supportsDangerouslySkipPermissions === "boolean") {
    return launchSpec.supportsDangerouslySkipPermissions;
  }
  return isAgyCommand(launchSpec.command);
}

export function withDangerouslySkipPermissions(launchSpec, enabled) {
  if (!launchSpec || typeof launchSpec !== "object") return launchSpec;
  const filteredArgs = Array.isArray(launchSpec.args)
    ? launchSpec.args.filter((arg) => arg !== "--dangerously-skip-permissions")
    : [];
  if (enabled) {
    filteredArgs.push("--dangerously-skip-permissions");
  }
  return {
    ...launchSpec,
    args: filteredArgs,
  };
}

const AGY_PRESET = {
  name: "Antigravity",
  command: "agy",
  args: ["acp", "--stdio"],
  loginArgs: ["acp", "--login"],
  supportsQuotaCli: true,
};

export const AGENT_PRESETS = {
  agy: AGY_PRESET,
  antigravity: AGY_PRESET,
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

export function writeJsonAtomic(filePath, data, { ensureDir = null } = {}) {
  const dir = path.dirname(filePath);
  if (ensureDir) {
    ensureDir(dir);
  } else {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error
    }
    throw err;
  }
}

export function loadUserConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getConfigPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config.json must be a JSON object");
    }
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      customAgents: {
        ...DEFAULT_CONFIG.customAgents,
        ...(parsed.customAgents && typeof parsed.customAgents === "object" ? parsed.customAgents : {}),
      },
    };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    const fallback = { ...DEFAULT_CONFIG };
    Object.defineProperty(fallback, CONFIG_LOAD_ERROR, {
      value: err?.message || "Cannot load config",
      enumerable: false,
    });
    return fallback;
  }
}

export function saveUserConfig(config) {
  if (getConfigLoadError(config)) {
    return false;
  }
  try {
    writeJsonAtomic(getConfigPath(), config);
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
      supportsQuotaCli: isAgyCommand(parts[0]),
      supportsDangerouslySkipPermissions: isAgyCommand(parts[0]),
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
      supportsDangerouslySkipPermissions: Boolean(customPreset.supportsDangerouslySkipPermissions),
    };
  }

  const builtinPreset = AGENT_PRESETS[agentKey];
  if (!builtinPreset) {
    const known = Object.keys(AGENT_PRESETS).join(", ");
    throw new Error(`Unknown agent preset "${agentKey}". Known presets: ${known}. Or use --cmd "<command>".`);
  }

  const args = [...builtinPreset.args];
  const isAgy = isAgyCommand(builtinPreset.command);
  if (options.sandbox && isAgy) {
    args.push("--sandbox");
  }
  if ((options.dangerouslySkipPermissions || userConfig.dangerouslySkipPermissions) && isAgy) {
    args.push("--dangerously-skip-permissions");
  }
  if (Array.isArray(options.addDirs) && isAgy) {
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
    supportsDangerouslySkipPermissions: isAgy,
  };
}

const BOOL_FLAGS = {
  "-h": "help",
  "--help": "help",
  "-v": "version",
  "--version": "version",
  "--direct": "direct",
  "-c": "continueLatest",
  "--continue": "continueLatest",
  "--sandbox": "sandbox",
  "--dangerously-skip-permissions": "dangerouslySkipPermissions",
  "--bypass": "dangerouslySkipPermissions",
  "--yolo": "dangerouslySkipPermissions",
  "--no-mouse": "noMouse",
};

const VALUE_FLAGS = {
  "--internal-host": "internalHost",
  "-s": "session",
  "--session": "session",
  "-a": "agent",
  "--agent": "agent",
  "--cmd": "cmd",
  "-t": "theme",
  "--theme": "theme",
  "-m": "model",
  "--model": "model",
  "--mode": "mode",
  "--cwd": "cwd",
};

export function parseCliArgs(argv) {
  const opts = {
    addDirs: [],
  };

  let inBgSubcommand = false;
  const bgPositional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "bg" && !inBgSubcommand && i === 0) {
      inBgSubcommand = true;
      continue;
    }
    if (Object.hasOwn(BOOL_FLAGS, arg)) {
      opts[BOOL_FLAGS[arg]] = true;
    } else if (Object.hasOwn(VALUE_FLAGS, arg)) {
      opts[VALUE_FLAGS[arg]] = argv[++i];
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
    } else if (arg === "--add-dir") {
      opts.addDirs.push(argv[++i]);
    } else if (inBgSubcommand && !arg.startsWith("-")) {
      bgPositional.push(arg);
    } else {
      throw new Error(`Unknown argument: ${arg} (run "lucid --help" for usage)`);
    }
  }

  if (inBgSubcommand) {
    const first = bgPositional[0] || "";
    if (!first || first === "ls" || first === "list") {
      opts.bgList = true;
    } else if (first === "stop" || first === "kill") {
      opts.bgStop = bgPositional[1] || "";
      if (!opts.bgStop) {
        throw new Error('Usage: lucid bg stop <id|all>');
      }
    } else {
      opts.bgPrompt = bgPositional.join(" ");
    }
  }

  return opts;
}
