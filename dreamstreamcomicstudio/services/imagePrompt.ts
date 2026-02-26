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
  const styleLine = clean(options.stylePrompt);

  if (options.stage === "style") {
    return [
      "Style exploration board for comic production.",
      "No named characters, no named items, no named locations, and no plot events.",
      "Focus on line quality, brushwork, shading language, color palette, and atmospheric mood.",
      "Single full-bleed frame, no panel borders, no text, no logos.",
      styleLine ? `Art Style: ${styleLine}` : "",
      clean(options.extraNotes) ? `Creative Direction: ${clean(options.extraNotes)}` : ""
    ].filter(Boolean).join("\n");
  }

  // USER REQUEST: STRICT FORMULA FOR WORLD BUILDING & COVER STAGES
  // 1. Characters: "Show the character in three poses: front, three-quarter, and back view" + Style + Description
  if (options.stage === "character_sheet") {
    return [
      "Show the character in three poses: front, three-quarter, and back view.",
      styleLine ? `Art Style: ${styleLine}` : "",
      options.subjectDescription ? `Character Description: ${clean(options.subjectDescription)}` : "",
      "Turnaround sheet only, neutral/plain background, no environment storytelling, no action scene, no other characters.",
      "Consistent proportions and outfit across all views. No text labels."
    ].filter(Boolean).join(" ");
  }

  // 2. Items/Locations (World): Description + Style
  if (options.stage === "world") {
    const isItem = options.extraNotes?.includes("Item");
    const label = isItem ? "Item Description" : "Location Description";

    return [
      options.subjectDescription ? `${label}: ${clean(options.subjectDescription)}` : "",
      styleLine ? `Art Style: ${styleLine}` : "",
      "Single concept image of the subject only.",
      "No narrative scene, no sequence, no montage, no implied story progression, no extra named characters."
    ].filter(Boolean).join(" ");
  }

  // 3. Cover: Template Design + Style
  if (options.stage === "cover") {
    return [
      "Professional comic-book cover design.",
      "No text rendering required in-image; leave clean text-safe zones for title/subtitle overlays.",
      "Strong silhouette hierarchy, readable at thumbnail size, and high-impact focal composition.",
      "Avoid poster-like clutter and avoid multi-frame comic page layouts.",
      options.sceneAction ? `Template Composition Rules: ${clean(options.sceneAction)}` : "Template Composition Rules: balanced dramatic cover composition.",
      options.setting ? `World/Environment Cues: ${clean(options.setting)}` : "",
      options.characters ? `Core Cast Presence: ${clean(options.characters)}` : "",
      options.items ? `Key Props/Symbols: ${clean(options.items)}` : "",
      styleLine ? `Art Style: ${styleLine}` : "",
      clean(options.extraNotes) ? `Creative Brief: ${clean(options.extraNotes)}` : "",
      "High quality full-color illustration with intentional negative space for masthead."
    ].filter(Boolean).join(" ");
  }

  // 4. Panel Generation (Standard Rich Prompt)
  // Keeps the robust structured format for complex scenes
  switch (options.stage) {
    case "panel":
      lines.push("Comic panel illustration.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      lines.push("Single frame only. No split panels, no montage, no comic page layout, no gutters, no panel numbering.");
      lines.push("Strict continuity mode: keep the same character identity, wardrobe silhouettes, and key props.");
      break;
    case "panel_regen":
      lines.push("Regenerate the comic panel with updates.");
      lines.push("Single full-bleed image, no panel borders or frames.");
      lines.push("Single frame only. No split panels, no montage, no comic page layout, no gutters, no panel numbering.");
      lines.push("Strict continuity mode: preserve canonical character/prop/location identity.");
      break;
    default:
      break;
  }

  if (clean(options.projectTitle)) lines.push(`Project: ${clean(options.projectTitle)}.`);
  if (styleLine) lines.push(`IMPORTANT — Art style (match exactly): ${styleLine}.`);
  if (
    clean(options.layoutType)
    && options.stage !== "panel"
    && options.stage !== "panel_regen"
  ) {
    lines.push(`Layout: ${clean(options.layoutType)}.`);
  }
  if (clean(options.subjectName)) lines.push(`Subject: ${clean(options.subjectName)}.`);
  // Description is handled in the custom blocks above for world/char stages, 
  // but kept here for fallback/panel stages if needed.
  if (clean(options.subjectDescription)) {
    lines.push(`Description: ${clean(options.subjectDescription)}.`);
  }
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
