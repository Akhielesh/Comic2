export type ImagePromptStage =
  | "style"
  | "world"
  | "cover"
  | "panel"
  | "panel_regen"
  | "page_grid";

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
  panels?: Array<{ index: number; description: string }>;
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
    case "cover":
      lines.push("Comic book cover illustration.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      break;
    case "panel":
      lines.push("Comic panel illustration.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      break;
    case "panel_regen":
      lines.push("Regenerate the comic panel with updates.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      break;
    case "page_grid":
      lines.push("Comic page layout with a 2x2 grid of panels.");
      lines.push("Draw exactly 4 panels separated by white gutters.");
      lines.push("Ensure consistent character appearance across all panels.");
      break;
    default:
      break;
  }

  if (clean(options.projectTitle)) lines.push(`Project: ${clean(options.projectTitle)}.`);
  if (clean(options.stylePrompt)) lines.push(`Style: ${clean(options.stylePrompt)}.`);
  if (clean(options.layoutType)) lines.push(`Layout: ${clean(options.layoutType)}.`);
  if (clean(options.subjectName)) lines.push(`Subject: ${clean(options.subjectName)}.`);
  if (clean(options.subjectDescription)) lines.push(`Description: ${clean(options.subjectDescription)}.`);
  if (clean(options.sceneAction)) lines.push(`Scene: ${clean(options.sceneAction)}.`);
  if (clean(options.setting)) lines.push(`Setting: ${clean(options.setting)}.`);
  if (clean(options.characters)) lines.push(`Characters: ${clean(options.characters)}.`);
  if (clean(options.items)) lines.push(`Items: ${clean(options.items)}.`);
  if (clean(options.locations)) lines.push(`Locations: ${clean(options.locations)}.`);

  // Specific handling for page grid
  if (options.stage === "page_grid" && options.panels) {
      lines.push("\nPanels:");
      options.panels.forEach(p => {
          lines.push(`Panel ${p.index + 1}: ${p.description}`);
      });
  }

  if (clean(options.continuitySummary)) lines.push(`Continuity Summary: ${clean(options.continuitySummary)}.`);
  if (clean(options.recentPanels)) lines.push(`Recent Panels: ${clean(options.recentPanels)}.`);
  if (clean(options.instructions)) lines.push(`Instructions: ${clean(options.instructions)}.`);
  if (clean(options.extraNotes)) lines.push(`Extra Notes: ${clean(options.extraNotes)}.`);

  return lines.filter(Boolean).join("\n");
};
