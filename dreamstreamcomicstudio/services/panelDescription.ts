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

/**
 * A short, human-readable label for a panel. Prefers the breakdown's `title`, then derives
 * a concise caption from the focal subject / description so older comics (with no title)
 * still get something meaningful instead of a wall of prompt text. Never returns a raw
 * full-sentence prompt.
 */
export const derivePanelTitle = (
  panel: { title?: string; focalSubject?: string; description?: string; prompt?: string },
  index?: number
): string => {
  const clean = (value?: string) => normalizeWhitespace(value || "");
  const title = clean(panel.title);
  if (title) return title;

  const source = clean(panel.focalSubject) || clean(panel.description) || clean(panel.prompt);
  if (source) {
    // First clause only, drop a leading article, cap to ~6 words.
    let label = (source.split(/[.,;:\n]/)[0] || source).replace(/^(the|a|an)\s+/i, "");
    label = label.split(" ").slice(0, 6).join(" ").trim();
    if (label) return label.charAt(0).toUpperCase() + label.slice(1);
  }
  return `Panel ${(index ?? 0) + 1}`;
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
