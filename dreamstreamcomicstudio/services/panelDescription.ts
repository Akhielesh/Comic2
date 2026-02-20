export const MULTI_FRAME_PATTERNS: Array<{ pattern: RegExp; replacement?: string }> = [
  { pattern: /\bpanel\s*\d+\b/gi, replacement: "" },
  { pattern: /\bsplit\s*panel\b/gi, replacement: "single-frame composition" },
  { pattern: /\btwo[-\s]*part\b/gi, replacement: "single-frame composition" },
  { pattern: /\bmontage\b/gi, replacement: "single-frame composition" },
  { pattern: /\btop\s*half\b/gi, replacement: "foreground" },
  { pattern: /\bbottom\s*half\b/gi, replacement: "background" },
  { pattern: /\btriptych\b/gi, replacement: "single-frame composition" }
];

const normalizeWhitespace = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

export const hasMultiFrameLanguage = (description?: string) => {
  const input = (description || "").trim();
  if (!input) return false;
  return MULTI_FRAME_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
};

export const sanitizePanelDescription = (
  description?: string
): { text: string; changed: boolean; flagged: boolean } => {
  const original = (description || "").trim();
  if (!original) {
    return { text: "", changed: false, flagged: false };
  }

  let rewritten = original;
  let changed = false;
  let flagged = false;
  for (const entry of MULTI_FRAME_PATTERNS) {
    entry.pattern.lastIndex = 0;
    if (!entry.pattern.test(rewritten)) continue;
    flagged = true;
    entry.pattern.lastIndex = 0;
    const next = entry.replacement !== undefined
      ? rewritten.replace(entry.pattern, entry.replacement)
      : rewritten;
    changed = changed || next !== rewritten;
    rewritten = next;
  }

  if (flagged) {
    rewritten = normalizeWhitespace(rewritten);
  }

  return {
    text: rewritten || original,
    changed,
    flagged
  };
};
