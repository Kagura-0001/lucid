export function extractChunkText(update) {
  if (!update) return "";
  if (typeof update.text === "string") return update.text;
  const content = update.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    if (typeof content.text === "string") return content.text;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        if (part?.content && typeof part.content.text === "string") return part.content.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Parses a single NDJSON line and returns a plain JSON object, or null otherwise.
 */
export function parseJsonObjectLine(line) {
  try {
    const msg = JSON.parse(line);
    return msg && typeof msg === "object" && !Array.isArray(msg) ? msg : null;
  } catch {
    return null;
  }
}

/**
 * Returns an incremental NDJSON chunk consumer calling `onLine(trimmedLine)`.
 */
export function createLineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    if (!chunk) return;
    let start = 0;
    let nlIdx = chunk.indexOf("\n");
    while (nlIdx !== -1) {
      const line = (buffer + chunk.slice(start, nlIdx)).trim();
      buffer = "";
      if (line) {
        onLine(line);
      }
      start = nlIdx + 1;
      nlIdx = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) {
      buffer += chunk.slice(start);
    }
  };
}

function getSessionCaps(caps) {
  return caps?.sessionCapabilities || caps?.session_capabilities || {};
}

export function supportsSessionList(caps) {
  return Boolean(getSessionCaps(caps).list);
}

export function supportsSessionLoad(caps) {
  return Boolean(caps?.loadSession || caps?.load_session || getSessionCaps(caps).load);
}

export function supportsSessionResume(caps) {
  return Boolean(getSessionCaps(caps).resume);
}

export function findConfigOption(configOptions, idOrCategory) {
  if (!Array.isArray(configOptions)) return undefined;
  return configOptions.find(
    (opt) => opt && (opt.id === idOrCategory || opt.category === idOrCategory),
  );
}

export function mergeConfigOption(configOptions, singleOption) {
  const list = Array.isArray(configOptions) ? [...configOptions] : [];
  if (!singleOption || typeof singleOption !== "object") return list;
  const idx = list.findIndex((c) => c && c.id === singleOption.id);
  if (idx >= 0) {
    list[idx] = singleOption;
  } else {
    list.push(singleOption);
  }
  return list;
}

/**
 * Merges session/config metadata updates into `rawMeta` and returns only the
 * derived UI fields present in `payload` (or derived from present `configOptions`).
 */
export function mergeSessionMetadata(rawMeta, payload) {
  const derived = {};
  if (!rawMeta || typeof rawMeta !== "object" || !payload || typeof payload !== "object") {
    return derived;
  }

  if (Array.isArray(payload.availableCommands)) {
    rawMeta.availableCommands = payload.availableCommands;
    derived.agentCommands = payload.availableCommands;
  }

  let touchedConfigOptions = false;
  if (Array.isArray(payload.configOptions)) {
    rawMeta.configOptions = payload.configOptions;
    derived.configOptions = payload.configOptions;
    touchedConfigOptions = true;
  } else if (payload.configOption && typeof payload.configOption === "object") {
    rawMeta.configOptions = mergeConfigOption(rawMeta.configOptions, payload.configOption);
    derived.configOptions = rawMeta.configOptions;
    touchedConfigOptions = true;
  }

  if (payload.modes && typeof payload.modes === "object") {
    rawMeta.modes = { ...(rawMeta.modes || {}), ...payload.modes };
    if (Array.isArray(payload.modes.availableModes)) {
      derived.modes = payload.modes.availableModes;
    }
    if (payload.modes.currentModeId) {
      derived.modeId = payload.modes.currentModeId;
    }
  }

  if (payload.models && typeof payload.models === "object") {
    rawMeta.models = { ...(rawMeta.models || {}), ...payload.models };
    const available = Array.isArray(payload.models.availableModels)
      ? payload.models.availableModels
      : rawMeta.models.availableModels;
    if (Array.isArray(payload.models.availableModels)) {
      derived.models = payload.models.availableModels;
    }
    if (payload.models.currentModelId) {
      const match = Array.isArray(available)
        ? available.find((m) => m.modelId === payload.models.currentModelId)
        : null;
      derived.modelLabel = match ? match.name : payload.models.currentModelId;
    }
  }

  // Canonical configOptions override legacy model/mode fields when present.
  if (touchedConfigOptions) {
    const opts = rawMeta.configOptions;
    const modelOpt = findConfigOption(opts, "model");
    if (modelOpt) {
      const optMatch = (modelOpt.options || []).find((o) => o.value === modelOpt.currentValue);
      const label = optMatch ? optMatch.name : modelOpt.currentValue;
      if (label) derived.modelLabel = label;
    }

    const effortOpt = findConfigOption(opts, "thought_level") || findConfigOption(opts, "effort");
    if (effortOpt) {
      const optMatch = (effortOpt.options || []).find((o) => o.value === effortOpt.currentValue);
      derived.effortLabel = optMatch ? optMatch.name : effortOpt.currentValue || "";
    } else {
      // Clear stale effort label when switching to a model without thought_level
      // (e.g. Orchestrator in agy acp).
      derived.effortLabel = "";
    }

    const modeOpt = findConfigOption(opts, "mode");
    if (modeOpt) {
      if (modeOpt.currentValue) {
        derived.modeId = modeOpt.currentValue;
      }
      if (Array.isArray(modeOpt.options) && modeOpt.options.length > 0) {
        derived.modes = modeOpt.options.map((o) => ({
          id: o.value,
          name: o.name || o.value,
          description: o.description || "",
        }));
      }
    }
  }

  return derived;
}

/**
 * Matches an item by case-insensitive exact key or unique prefix of at least `minPrefixLen`.
 */
export function matchByIdOrPrefix(items, query, getKeys, minPrefixLen = 4) {
  const qLower = String(query || "").trim().toLowerCase();
  if (!qLower || !Array.isArray(items) || items.length === 0) return null;

  const extractKeys = (item) =>
    (getKeys(item) || [])
      .map((k) => String(k || "").trim().toLowerCase())
      .filter(Boolean);

  const exact = items.find((item) => extractKeys(item).includes(qLower));
  if (exact) return exact;

  if (qLower.length < minPrefixLen) return null;
  const prefixMatches = items.filter((item) => extractKeys(item).some((k) => k.startsWith(qLower)));
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}
