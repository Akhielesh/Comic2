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

export const normalizePanelDialogue = (panel: ComicPanel): ComicPanel => {
  const blocks = ensureDialogueBlocks(panel.dialogue, panel.dialogueBlocks, panel.description);
  return {
    ...panel,
    dialogueBlocks: blocks,
    dialogue: blocks.map((block) => block.text).filter(Boolean).join(" ")
  };
};
