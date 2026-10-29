import { ComicPanel, DialogueBlock } from "../types";

const makeBlock = (text: string, kind: DialogueBlock["kind"] = "caption", speaker?: string): DialogueBlock => ({
  id: crypto.randomUUID(),
  kind,
  speaker,
  text: text.trim(),
  side: "left"
});

export const ensureDialogueBlocks = (
  dialogue?: string,
  blocks?: DialogueBlock[],
  description?: string
): DialogueBlock[] => {
  const normalizeDialogue = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.filter(Boolean).join(" ");
    if (value && typeof value === "object" && "text" in (value as any)) {
      const text = (value as any).text;
      return typeof text === "string" ? text : String(text ?? "");
    }
    if (value === null || value === undefined) return undefined;
    return String(value);
  };

  if (blocks && blocks.length > 0) {
    return blocks.map((block) => ({
      ...block,
      id: block.id || crypto.randomUUID(),
      text: block.text || ""
    }));
  }

  const normalizedDialogue = normalizeDialogue(dialogue);
  if (normalizedDialogue && normalizedDialogue.trim()) {
    return [makeBlock(normalizedDialogue, "speech")];
  }

  if (description && description.trim()) {
    const trimmed = description.trim();
    const text = trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
    return [makeBlock(text, "caption")];
  }

  return [];
};

// ── Readers: never show the scene description as dialogue ────────────────────────────────────────────────────
// ensureDialogueBlocks' description fallback (above) is how the generator gave a silent panel *something*: it was
// stored by normalizePanelDialogue into both dialogueBlocks and dialogue, so some legacy panels "say" their own scene
// description. Readers render with readerDialogueBlocks instead: no fallback, and stored blocks that echo the
// description are hidden. Stored data is never rewritten; the editor and the generator keep the helpers above.

/** Shortest text (after normalising) that can count as an echo, so a short real line is never hidden. */
const ECHO_MIN_CHARS = 40;

const normalizeForEcho = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(\.\.\.|…)$/, "")
    .trim();

/**
 * True when `text` is the panel's scene description (or the fallback's 157-character cut of it): one is a prefix of
 * the other, ignoring case, spacing and a trailing ellipsis, and both are at least 40 characters long.
 */
export const isDescriptionEcho = (text: string | undefined, description: string | undefined): boolean => {
  if (!text || !description) return false;
  const t = normalizeForEcho(text);
  const d = normalizeForEcho(description);
  if (t.length < ECHO_MIN_CHARS || d.length < ECHO_MIN_CHARS) return false;
  return d.startsWith(t) || t.startsWith(d);
};

/** The dialogue a reader shows for a panel: its own lines only — never the scene description. */
export const readerDialogueBlocks = (
  panel: Partial<Pick<ComicPanel, "dialogue" | "dialogueBlocks" | "description">>
): DialogueBlock[] =>
  ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks).filter((block) => !isDescriptionEcho(block.text, panel.description));

export const normalizePanelDialogue = (panel: ComicPanel): ComicPanel => {
  const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
  return {
    ...panel,
    dialogueBlocks: blocks,
    dialogue: blocks.map((block) => block.text).filter(Boolean).join(" ")
  };
};
