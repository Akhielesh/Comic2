export const TEXT_MODEL = "gemini-2.5-flash";
export const TEXT_MODELS: Array<{ id: string; label: string }> = [
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" }
];
export const IMAGE_MODEL = "gemini-2.5-flash-image";
export const MAX_CONTINUITY_PANELS = 2;
export const NO_TEXT_IN_IMAGE = true;

export const IMAGE_TEXT_BLOCKER =
  "No text, no letters, no speech bubbles, no signage text. No UI frames, page borders, layout grids, boxes, placeholders, or blank rectangles. Single full-bleed image only; no inset panels, no multi-panel layouts.";
