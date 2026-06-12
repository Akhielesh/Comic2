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
  /** Mood/atmosphere from the user's opening scene, used to ground style previews. */
  sceneContext?: string;
  /** The concrete thing this panel is about (e.g. "a wooden fishing boat at the dock"). Leads the prompt. */
  focalSubject?: string;
  /** Raw scene synopsis, injected so the story subject survives even if the breakdown drifts. */
  sceneSynopsis?: string;
  /** Author's creative direction / story intent — honoured across stages. */
  creativeDirection?: string;
  /** Story-mood guardrail (palette/lighting) so renders match the story's tone instead
   *  of defaulting to dark & moody. See services/storyMood.ts. */
  moodGuidance?: string;
  /** Camera/shot direction for the panel. */
  shotType?: string;
  cameraAngle?: string;
  composition?: string;
};

const clean = (value?: string) => (value || "").trim();

export const buildImagePrompt = (options: ImagePromptOptions): string => {
  const lines: string[] = [];
  const styleLine = clean(options.stylePrompt);

  if (options.stage === "style") {
    const sceneCtx = clean(options.sceneContext);
    return [
      "Style exploration board for comic production.",
      "Focus on line quality, brushwork, shading language, color palette, and atmospheric mood.",
      "Single full-bleed frame, no panel borders, no text, no logos.",
      sceneCtx
        ? `Ground the look in this story's opening — match its environment, lighting and tone (no named characters, no readable text, no plot beats): ${sceneCtx}`
        : "No named characters, no named items, no named locations, and no plot events.",
      styleLine ? `Art Style: ${styleLine}` : "",
      clean(options.moodGuidance) ? `Mood & palette: ${clean(options.moodGuidance)}` : "",
      clean(options.creativeDirection) ? `Author's creative direction (tone/mood only): ${clean(options.creativeDirection)}` : "",
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

  // 3. Cover: full trade dress — a real comic cover IS art + title masthead + tagline,
  // so (unlike every other stage) text is rendered in-image here.
  if (options.stage === "cover") {
    const title = clean(options.projectTitle);
    return [
      "Professional published comic-book FRONT COVER with full trade dress.",
      title
        ? `Render the comic's title "${title.toUpperCase()}" as a large, bold masthead logotype integrated into the design — custom display lettering that matches the art style, perfectly spelled, highly readable at thumbnail size.`
        : "Reserve a clean masthead band for the title logotype.",
      clean(options.instructions) ? `Tagline (render small, near the masthead or lower third, exactly this text): ${clean(options.instructions)}` : "",
      "Typography is part of the illustration: masthead, optional small issue badge (#1) — nothing else; no fake publisher barcodes, no lorem ipsum, no gibberish text anywhere.",
      "Strong silhouette hierarchy, one high-impact focal composition, readable at thumbnail size.",
      "Single cover image — no multi-frame comic page layout, no panel gutters.",
      options.sceneAction ? `Cover design direction: ${clean(options.sceneAction)}` : "Cover design direction: balanced dramatic cover composition.",
      options.setting ? `World/Environment Cues: ${clean(options.setting)}` : "",
      options.characters ? `Core Cast Presence: ${clean(options.characters)}` : "",
      options.items ? `Key Props/Symbols: ${clean(options.items)}` : "",
      styleLine ? `Art Style: ${styleLine}` : "",
      clean(options.moodGuidance) ? `Mood & palette: ${clean(options.moodGuidance)}` : "",
      clean(options.creativeDirection) ? `Author's creative direction: ${clean(options.creativeDirection)}` : "",
      clean(options.extraNotes) ? `Creative Brief: ${clean(options.extraNotes)}` : "",
      "High quality full-color illustration; the title treatment and art read as one designed cover."
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
  // Subject and story lead, BEFORE style, so the rendering look can never override WHAT is
  // depicted (this is what caused e.g. a boat story to render generic superheroes).
  if (clean(options.focalSubject)) lines.push(`Primary subject — must be clearly and accurately depicted: ${clean(options.focalSubject)}.`);
  if (clean(options.sceneSynopsis)) lines.push(`Story context to stay faithful to: ${clean(options.sceneSynopsis)}.`);
  if (clean(options.creativeDirection)) lines.push(`Author's creative direction (honour this tone/intent): ${clean(options.creativeDirection)}.`);
  if (styleLine) lines.push(`Art style (rendering/look ONLY — do not change the subject, setting, or genre): ${styleLine}.`);
  if (clean(options.moodGuidance)) lines.push(`Mood & palette (lighting/colour guidance — keep the subject unchanged): ${clean(options.moodGuidance)}.`);
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
  if (clean(options.shotType)) lines.push(`Shot type: ${clean(options.shotType)}.`);
  if (clean(options.cameraAngle)) lines.push(`Camera angle: ${clean(options.cameraAngle)}.`);
  if (clean(options.composition)) lines.push(`Composition: ${clean(options.composition)}.`);
  // Multi-character panels: the reference images are separate per-character
  // turnaround sheets. Without this, a 2+ character panel tends to render the
  // dominant identity twice (e.g. a male vendor drawn as a clone of the lead).
  // Spell out the 1-sheet-per-named-character mapping and forbid identity bleed.
  const distinctEntityCount = clean(options.requiredEntityNames)
    ? clean(options.requiredEntityNames).split(",").map((n) => n.trim()).filter(Boolean).length
    : clean(options.entityVisualRef).split("\n").filter((l) => l.trim().startsWith("[")).length;
  if ((options.stage === "panel" || options.stage === "panel_regen") && distinctEntityCount >= 2) {
    lines.push(
      `Multiple DISTINCT characters appear (${clean(options.requiredEntityNames) || "see visual references"}). The reference images are separate turnaround sheets, one per named character. Render EACH named character using ONLY their own sheet's face, age, gender, body type and wardrobe. Never merge two characters, and never duplicate one character's appearance onto another — they must look clearly different from each other.`
    );
  }
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
