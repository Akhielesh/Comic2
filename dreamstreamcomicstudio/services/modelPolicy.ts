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

// ---------------------------------------------------------------------------
// Generation pipeline constants
// ---------------------------------------------------------------------------

/** Max panels generated concurrently in a single batch. */
export const GENERATION_BATCH_SIZE = 3;

/** Model used for character sheet generation (Phase 0). */
export const CHARACTER_SHEET_MODEL = "gemini-2.5-flash-image";

// ---------------------------------------------------------------------------
// Feature flags — toggle each workstream independently
// ---------------------------------------------------------------------------

export const FEATURE_FLAGS = {
  /** Phase 1: Filter grid templates by form-factor compatibility. */
  ENABLE_FORM_FACTOR_FILTERING: true,
  /** Phase 2: Generate character turnaround sheets before panels. */
  ENABLE_CHAR_SHEETS: false,
  /** Phase 3: Generate panels in parallel batches. */
  ENABLE_PARALLEL_GEN: false,
  /** Phase 4: Compose panels into full-page images on the server. */
  ENABLE_SERVER_COMPOSITING: false,
  /** Phase 5: In-panel inpainting / editing. */
  ENABLE_INPAINTING: false,
} as const;
