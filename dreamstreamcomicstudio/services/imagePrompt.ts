export type ImagePromptStage =
  | "style"
  | "world"
  | "cover"
  | "panel"
  | "panel_regen"
  | "character_sheet";

export type ImagePromptOptions = {
  stage: ImagePromptStage;
  stylePrompt?: string;
  layoutType?: string;
  sceneAction?: string;
  setting?: string;
  characters?: string;
  items?: string;
  locations?: string;
  continuitySummary?: string;
  recentPanels?: string;
  extraNotes?: string;
  subjectName?: string;
  subjectDescription?: string;
  instructions?: string;
  projectTitle?: string;
  requiredEntityNames?: string;
  continuityLock?: string;
  lockedLocation?: string;
  entityVisualRef?: string;
};

const clean = (value?: string) => (value || "").trim();

export const buildImagePrompt = (options: ImagePromptOptions): string => {
  const lines: string[] = [];

  switch (options.stage) {
    case "style":
      lines.push("Comic panel style preview.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      break;
    case "world":
      lines.push("Concept art sheet.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      break;
    case "character_sheet":
      lines.push("Character reference sheet in the project's established art style.");
      lines.push("Show the character in three poses: front, three-quarter, and back view.");
      lines.push("Consistent proportions and outfit across all views. No text labels.");
      break;
    case "cover":
      lines.push("Comic book cover illustration.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      break;
    case "panel":
      lines.push("Comic panel illustration.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      lines.push("Strict continuity mode: keep the same character identity, wardrobe silhouettes, and key props.");
      break;
    case "panel_regen":
      lines.push("Regenerate the comic panel with updates.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      lines.push("Strict continuity mode: preserve canonical character/prop/location identity.");
      break;
    default:
      break;
  }

  if (clean(options.projectTitle)) lines.push(`Project: ${clean(options.projectTitle)}.`);
  if (clean(options.stylePrompt)) lines.push(`IMPORTANT — Art style (match exactly): ${clean(options.stylePrompt)}.`);
  if (clean(options.layoutType)) lines.push(`Layout: ${clean(options.layoutType)}.`);
  if (clean(options.subjectName)) lines.push(`Subject: ${clean(options.subjectName)}.`);
  if (clean(options.subjectDescription)) lines.push(`Description: ${clean(options.subjectDescription)}.`);
  if (clean(options.sceneAction)) lines.push(`Scene: ${clean(options.sceneAction)}.`);
  if (clean(options.setting)) lines.push(`Setting: ${clean(options.setting)}.`);
  if (clean(options.characters)) lines.push(`Characters: ${clean(options.characters)}.`);
  if (clean(options.items)) lines.push(`Items: ${clean(options.items)}.`);
  if (clean(options.locations)) lines.push(`Locations: ${clean(options.locations)}.`);
  if (clean(options.continuitySummary)) lines.push(`Continuity Summary: ${clean(options.continuitySummary)}.`);
  if (clean(options.requiredEntityNames)) lines.push(`Required entities: ${clean(options.requiredEntityNames)}.`);
  if (clean(options.lockedLocation)) lines.push(`Locked location: ${clean(options.lockedLocation)}.`);
  if (clean(options.continuityLock)) lines.push(`Continuity lock: ${clean(options.continuityLock)}.`);
  if (clean(options.entityVisualRef)) lines.push(`VISUAL REFERENCES:\n${clean(options.entityVisualRef)}`);
  if (clean(options.recentPanels)) lines.push(`Recent Panels: ${clean(options.recentPanels)}.`);
  if (clean(options.instructions)) lines.push(`Instructions: ${clean(options.instructions)}.`);
  if (clean(options.extraNotes)) lines.push(`Extra Notes: ${clean(options.extraNotes)}.`);

  return lines.filter(Boolean).join("\n");
};
