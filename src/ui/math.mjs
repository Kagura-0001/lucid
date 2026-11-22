/**
 * Lightweight, zero-dependency LaTeX math to Unicode terminal renderer.
 * Converts common inline/display LaTeX expressions into clean monospace Unicode
 * while keeping exact single-column BMP symbols so terminal table alignment holds.
 */

const SUPERSCRIPT_MAP = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "−": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  n: "ⁿ",
  i: "ⁱ",
};

const SUBSCRIPT_MAP = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "−": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

const BLACKBOARD_MAP = {
  C: "ℂ",
  E: "𝔼",
  H: "ℍ",
  N: "ℕ",
  P: "ℙ",
  Q: "ℚ",
  R: "ℝ",
  Z: "ℤ",
};

const COMBINING_ACCENTS = {
  hat: "\u0302",
  widehat: "\u0302",
  bar: "\u0304",
  overline: "\u0304",
  tilde: "\u0303",
  widetilde: "\u0303",
  vec: "\u20d7",
  dot: "\u0307",
  ddot: "\u0308",
};

const SYMBOLS = {
  // Greek lowercase
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "ϖ",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",

  // Greek uppercase
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",

  // Relations & operators
  propto: "∝",
  approx: "≈",
  sim: "∼",
  simeq: "≃",
  cong: "≅",
  equiv: "≡",
  le: "≤",
  leq: "≤",
  leqslant: "≤",
  ge: "≥",
  geq: "≥",
  geqslant: "≥",
  ne: "≠",
  neq: "≠",
  ll: "≪",
  gg: "≫",
  pm: "±",
  mp: "∓",
  times: "×",
  cdot: "·",
  div: "÷",
  circ: "∘",
  bullet: "•",
  ast: "∗",
  star: "⋆",
  odot: "⊙",
  otimes: "⊗",
  oplus: "⊕",
  ominus: "⊖",
  dagger: "†",
  ddagger: "‡",

  // Arrows
  to: "→",
  rightarrow: "→",
  longrightarrow: "→",
  leftarrow: "←",
  longleftarrow: "←",
  leftrightarrow: "↔",
  longleftrightarrow: "↔",
  Rightarrow: "⇒",
  implies: "⇒",
  Leftarrow: "⇐",
  Leftrightarrow: "⇔",
  iff: "⇔",
  mapsto: "↦",
  uparrow: "↑",
  downarrow: "↓",
  updownarrow: "↕",

  // Big operators, calculus, sets, logic
  sum: "∑",
  prod: "∏",
  coprod: "∐",
  int: "∫",
  iint: "∬",
  iiint: "∭",
  oint: "∮",
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  in: "∈",
  notin: "∉",
  ni: "∋",
  subset: "⊂",
  subseteq: "⊆",
  supset: "⊃",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  bigcup: "⋃",
  bigcap: "⋂",
  setminus: "∖",
  emptyset: "∅",
  varnothing: "∅",
  forall: "∀",
  exists: "∃",
  nexists: "∄",
  neg: "¬",
  lnot: "¬",
  land: "∧",
  wedge: "∧",
  lor: "∨",
  vee: "∨",
  top: "⊤",
  bot: "⊥",
  perp: "⊥",
  parallel: "∥",
  angle: "∠",
  triangle: "△",
  therefore: "∴",
  because: "∵",
  ell: "ℓ",
  hbar: "ℏ",
  prime: "′",
  degree: "°",
  dots: "…",
  ldots: "…",
  cdots: "⋯",
  vdots: "⋮",
  ddots: "⋱",
  langle: "⟨",
  rangle: "⟩",
  lfloor: "⌊",
  rfloor: "⌋",
  lceil: "⌈",
  rceil: "⌉",
  mid: "|",
};

const TEXT_WRAPPERS = new Set([
  "text",
  "textrm",
  "textbf",
  "textit",
  "textsf",
  "texttt",
  "mathrm",
  "mathbf",
  "mathit",
  "mathsf",
  "mathtt",
  "boldsymbol",
  "bm",
  "operatorname",
  "mbox",
  "hbox",
]);

const IGNORED_MACROS = new Set([
  "left",
  "right",
  "big",
  "Big",
  "bigg",
  "Bigg",
  "bigl",
  "bigr",
  "Bigl",
  "Bigr",
  "biggl",
  "biggr",
  "displaystyle",
  "textstyle",
  "scriptstyle",
  "scriptscriptstyle",
  "limits",
  "nolimits",
]);

const FUNCTION_NAMES = new Set([
  "log",
  "ln",
  "lg",
  "exp",
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "arcsin",
  "arccos",
  "arctan",
  "sinh",
  "cosh",
  "tanh",
  "min",
  "max",
  "arg",
  "argmax",
  "argmin",
  "lim",
  "limsup",
  "liminf",
  "sup",
  "inf",
  "det",
  "dim",
  "ker",
  "deg",
  "gcd",
  "Pr",
  "mod",
  "bmod",
  "pmod",
  "softmax",
  "sigmoid",
]);

function mapAllChars(text, table) {
  if (!text) return null;
  let out = "";
  for (const ch of text) {
    const mapped = table[ch];
    if (!mapped) return null;
    out += mapped;
  }
  return out;
}

function needsFractionParens(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    let depth = 0;
    let wrappedWhole = true;
    for (let i = 0; i < trimmed.length - 1; i += 1) {
      if (trimmed[i] === "(") depth += 1;
      else if (trimmed[i] === ")") depth -= 1;
      if (depth === 0) {
        wrappedWhole = false;
        break;
      }
    }
    if (wrappedWhole) return false;
  }
  let depth = 0;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === " " || ch === "+" || ch === "-" || ch === "−" || ch === "±")) {
      // Allow leading unary minus like -1/2
      if (i === 0 && (ch === "-" || ch === "−")) continue;
      return true;
    }
  }
  return false;
}

function readBalancedGroup(src, startIdx, openChar = "{", closeChar = "}") {
  let i = startIdx;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (i >= src.length || src[i] !== openChar) return null;
  let depth = 0;
  let pos = i;
  while (pos < src.length) {
    const ch = src[pos];
    if (ch === "\\" && pos + 1 < src.length) {
      pos += 2;
      continue;
    }
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return { content: src.slice(i + 1, pos), nextIndex: pos + 1 };
      }
    }
    pos += 1;
  }
  return { content: src.slice(i + 1), nextIndex: src.length };
}

function readNextAtom(src, startIdx) {
  let i = startIdx;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  if (i >= src.length) return { content: "", nextIndex: i };
  if (src[i] === "{") {
    const group = readBalancedGroup(src, i, "{", "}");
    return group || { content: "", nextIndex: i + 1 };
  }
  if (src[i] === "\\") {
    let end = i + 1;
    if (end < src.length && /[A-Za-z]/.test(src[end])) {
      while (end < src.length && /[A-Za-z]/.test(src[end])) end += 1;
    } else if (end < src.length) {
      end += 1;
    }
    return { content: src.slice(i, end), nextIndex: end };
  }
  return { content: src[i], nextIndex: i + 1 };
}

const MAX_MATH_DEPTH = 32;

function formatScript(rawContent, kind, depth = 0) {
  const rendered = parseMathSegment(rawContent, depth + 1).trim();
  if (!rendered) return "";
  const table = kind === "^" ? SUPERSCRIPT_MAP : SUBSCRIPT_MAP;
  const unicodeMapped = mapAllChars(rendered, table);
  if (unicodeMapped !== null) {
    return unicodeMapped;
  }
  const isCompound = /[\s+\-−=*/,]/.test(rendered);
  return isCompound ? `${kind}(${rendered})` : `${kind}${rendered}`;
}

function parseMathSegment(src, depth = 0) {
  if (depth >= MAX_MATH_DEPTH) {
    return src;
  }
  let out = "";
  let i = 0;
  const len = src.length;

  while (i < len) {
    const ch = src[i];

    // Braced group without leading macro
    if (ch === "{") {
      const group = readBalancedGroup(src, i, "{", "}");
      if (group) {
        out += parseMathSegment(group.content, depth + 1);
        i = group.nextIndex;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "}") {
      i += 1;
      continue;
    }

    // Subscript / superscript
    if (ch === "_" || ch === "^") {
      const atom = readNextAtom(src, i + 1);
      out += formatScript(atom.content, ch, depth);
      i = atom.nextIndex;
      continue;
    }

    // LaTeX macro / escaped char
    if (ch === "\\") {
      if (i + 1 >= len) {
        i += 1;
        continue;
      }
      const next = src[i + 1];

      // Non-alphabetic control symbols
      if (!/[A-Za-z]/.test(next)) {
        if (next === "," || next === ";" || next === ":" || next === " ") {
          out += " ";
        } else if (next === "!") {
          // negative thin space -> omit
        } else if (next === "|") {
          out += "‖";
        } else if (next === "\\") {
          out += " ; ";
        } else {
          out += next;
        }
        i += 2;
        continue;
      }

      let cmdEnd = i + 1;
      while (cmdEnd < len && /[A-Za-z]/.test(src[cmdEnd])) cmdEnd += 1;
      const cmd = src.slice(i + 1, cmdEnd);
      i = cmdEnd;

      if (IGNORED_MACROS.has(cmd)) {
        // Skip optional delimiter after \left. / \right.
        if ((cmd === "left" || cmd === "right") && src[i] === ".") {
          i += 1;
        }
        continue;
      }

      if (cmd === "quad") {
        out += "  ";
        continue;
      }
      if (cmd === "qquad") {
        out += "    ";
        continue;
      }

      if (cmd === "frac" || cmd === "dfrac" || cmd === "tfrac" || cmd === "cfrac") {
        const numAtom = readNextAtom(src, i);
        const denAtom = readNextAtom(src, numAtom.nextIndex);
        const num = parseMathSegment(numAtom.content, depth + 1).trim();
        const den = parseMathSegment(denAtom.content, depth + 1).trim();
        const numStr = needsFractionParens(num) ? `(${num})` : num;
        const denStr = needsFractionParens(den) ? `(${den})` : den;
        out += `${numStr}/${denStr}`;
        i = denAtom.nextIndex;
        continue;
      }

      if (cmd === "sqrt") {
        let indexPrefix = "";
        let pos = i;
        while (pos < len && /\s/.test(src[pos])) pos += 1;
        if (src[pos] === "[") {
          const opt = readBalancedGroup(src, pos, "[", "]");
          if (opt) {
            const optRendered = parseMathSegment(opt.content, depth + 1).trim();
            const sup = mapAllChars(optRendered, SUPERSCRIPT_MAP);
            indexPrefix = sup || optRendered;
            pos = opt.nextIndex;
          }
        }
        const arg = readNextAtom(src, pos);
        const inner = parseMathSegment(arg.content, depth + 1).trim();
        const simple = /^[A-Za-z0-9α-ωΑ-Ω]+$/.test(inner);
        out += simple ? `${indexPrefix}√${inner}` : `${indexPrefix}√(${inner})`;
        i = arg.nextIndex;
        continue;
      }

      if (TEXT_WRAPPERS.has(cmd)) {
        const arg = readNextAtom(src, i);
        // Preserve literal text inside \text{...} without mangling spaces/hyphens
        const textInner = cmd.startsWith("text") || cmd === "mbox" || cmd === "hbox"
          ? arg.content.replace(/\\([%&_#${}])/g, "$1")
          : parseMathSegment(arg.content, depth + 1);
        out += textInner;
        i = arg.nextIndex;
        continue;
      }

      if (cmd === "mathbb") {
        const arg = readNextAtom(src, i);
        const inner = parseMathSegment(arg.content, depth + 1).trim();
        out += [...inner].map((c) => (Object.hasOwn(BLACKBOARD_MAP, c) ? BLACKBOARD_MAP[c] : c)).join("");
        i = arg.nextIndex;
        continue;
      }

      if (cmd === "mathcal" || cmd === "mathscr" || cmd === "mathfrak") {
        const arg = readNextAtom(src, i);
        out += parseMathSegment(arg.content, depth + 1);
        i = arg.nextIndex;
        continue;
      }

      if (Object.hasOwn(COMBINING_ACCENTS, cmd)) {
        const arg = readNextAtom(src, i);
        const inner = parseMathSegment(arg.content, depth + 1).trim();
        if (inner.length === 1 && /[A-Za-zα-ωΑ-Ω]/.test(inner)) {
          out += `${inner}${COMBINING_ACCENTS[cmd]}`;
        } else {
          out += `${cmd}(${inner})`;
        }
        i = arg.nextIndex;
        continue;
      }

      if (Object.hasOwn(SYMBOLS, cmd)) {
        const sym = SYMBOLS[cmd];
        // Add subtle spacing when a symbol follows an identifier without space (e.g. a\times b)
        if (out.length > 0 && /[A-Za-z0-9)\]}]$/.test(out) && /^[∝≈∼≃≅≡≤≥≠≪≫±∓×·÷→←↔⇒⇐⇔↦∈∉⊂⊆⊃⊇∪∩∧∨]$/.test(sym)) {
          out += " ";
        }
        out += sym;
        if (i < len && !/[\s_^})\\\].,;:]/.test(src[i]) && /^[∝≈∼≃≅≡≤≥≠≪≫±∓×·÷→←↔⇒⇐⇔↦∈∉⊂⊆⊃⊇∪∩∧∨]$/.test(sym)) {
          out += " ";
        }
        continue;
      }

      if (FUNCTION_NAMES.has(cmd)) {
        out += cmd;
        continue;
      }

      // Unknown macro: keep its name cleanly without raw backslash clutter
      out += cmd;
      continue;
    }

    // Collapse runs of whitespace to a single space
    if (/\s/.test(ch)) {
      if (out.length > 0 && !out.endsWith(" ")) {
        out += " ";
      }
      while (i < len && /\s/.test(src[i])) i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  return out.replace(/\s{2,}/g, " ").trim();
}

/**
 * Converts a LaTeX math expression (without outer `$`/`$$`/`\(...\)` delimiters)
 * into clean Unicode text suitable for monospace terminal display.
 */
export function renderLatexMath(expr) {
  if (!expr) return "";
  return parseMathSegment(String(expr));
}
