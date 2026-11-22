const NEGATIVE_OPTION_RE = /\b(?:don'?t|not|dis|reject|deny|cancel|refuse|never)\b/i;
const POSITIVE_OPTION_RE = /\b(?:allow|approve|yes|permit)\b/i;

/**
 * Selects the least-persistent allow option for session-level bypass mode.
 * Prefers `allow_once` over `allow_always` and guards keyword matching against
 * negative phrases such as "Don't allow".
 */
export function selectBypassAllowOption(options) {
  if (!Array.isArray(options) || options.length === 0) return null;

  const allowOnce = options.find((option) => option && option.kind === "allow_once");
  if (allowOnce) return allowOnce;

  const allowAlways = options.find((option) => option && option.kind === "allow_always");
  if (allowAlways) return allowAlways;

  return (
    options.find((option) => {
      if (!option) return false;
      const text = `${option.optionId || ""} ${option.name || ""}`;
      if (NEGATIVE_OPTION_RE.test(text)) return false;
      return POSITIVE_OPTION_RE.test(text);
    }) || null
  );
}

/**
 * Answers a permission request with the agent's selected allow option.
 * Returns false when no safe allow-like option is offered.
 */
export function autoApprovePermission(req) {
  const options = req?.params?.options;
  const allowOption = selectBypassAllowOption(options);
  if (!allowOption) return false;
  req.selectOption(allowOption.optionId);
  return true;
}
