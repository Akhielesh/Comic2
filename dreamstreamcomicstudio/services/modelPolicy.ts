import type { BillingPlanTier } from '../shared/types/billing';

export const FREE_TEXT_PRE_ROLLOVER_MODEL = 'gemini-2.0-flash';
export const FREE_TEXT_POST_ROLLOVER_MODEL = 'gemini-2.5-flash';
export const FREE_TEXT_ROLLOVER_AT_ISO = '2026-03-31T00:00:00.000Z';
const FREE_TEXT_ROLLOVER_AT_MS = Date.parse(FREE_TEXT_ROLLOVER_AT_ISO);

export const PRO_PLAN_TIERS: BillingPlanTier[] = ['pro', 'studio', 'admin'];

export type TextModelDefinition = {
  id: string;
  label: string;
  minimumPlanTier?: 'pro';
};

export const TEXT_MODEL =
  Date.now() >= FREE_TEXT_ROLLOVER_AT_MS
    ? FREE_TEXT_POST_ROLLOVER_MODEL
    : FREE_TEXT_PRE_ROLLOVER_MODEL;

export const TEXT_MODELS: TextModelDefinition[] = [
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', minimumPlanTier: 'pro' },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash (Preview)', minimumPlanTier: 'pro' },
  { id: 'gemini-3-pro-preview', label: 'Gemini 3 Pro (Preview)', minimumPlanTier: 'pro' }
];

export const IMAGE_MODEL = 'gemini-2.5-flash-image';
export const MAX_CONTINUITY_PANELS = 2;
export const NO_TEXT_IN_IMAGE = true;

export const IMAGE_TEXT_BLOCKER =
  'No text, no letters, no speech bubbles, no signage text. No UI frames, page borders, layout grids, boxes, placeholders, or blank rectangles. Single full-bleed image only; no inset panels, no multi-panel layouts.';

export const resolveEffectivePlanTier = (planTier?: string | null): BillingPlanTier => {
  const normalized = String(planTier || 'free').trim().toLowerCase();
  if (normalized === 'creator') return 'creator';
  if (normalized === 'pro') return 'pro';
  if (normalized === 'studio') return 'studio';
  if (normalized === 'custom') return 'custom';
  if (normalized === 'admin') return 'admin';
  return 'free';
};

export const isProPlanTier = (planTier?: string | null) =>
  PRO_PLAN_TIERS.includes(resolveEffectivePlanTier(planTier));

export const resolveFreeTextModelForDate = (at: Date = new Date()) =>
  at.getTime() >= FREE_TEXT_ROLLOVER_AT_MS
    ? FREE_TEXT_POST_ROLLOVER_MODEL
    : FREE_TEXT_PRE_ROLLOVER_MODEL;

export const getAllowedTextModelIdsForPlan = (
  planTier?: string | null,
  at: Date = new Date()
) => {
  if (isProPlanTier(planTier)) {
    return TEXT_MODELS.map((model) => model.id);
  }
  return [resolveFreeTextModelForDate(at)];
};

export const getAllowedTextModelsForPlan = (
  planTier?: string | null,
  at: Date = new Date()
) => {
  const allowed = new Set(getAllowedTextModelIdsForPlan(planTier, at));
  return TEXT_MODELS.filter((model) => allowed.has(model.id));
};

export const isTextModelAllowedForPlan = (
  modelId: string,
  planTier?: string | null,
  at: Date = new Date()
) => getAllowedTextModelIdsForPlan(planTier, at).includes(modelId);

export const getDefaultTextModelForPlan = (
  planTier?: string | null,
  at: Date = new Date()
) => {
  const allowed = getAllowedTextModelIdsForPlan(planTier, at);
  return allowed[0] || TEXT_MODEL;
};

// ---------------------------------------------------------------------------
// Generation pipeline constants
// ---------------------------------------------------------------------------

/** Max panels generated concurrently in a single batch. */
export const GENERATION_BATCH_SIZE = 3;

/** Model used for character sheet generation (Phase 0). */
export const CHARACTER_SHEET_MODEL = 'gemini-2.5-flash-image';

// ---------------------------------------------------------------------------
// Feature flags — toggle each workstream independently
// ---------------------------------------------------------------------------

export const FEATURE_FLAGS = {
  /** Phase 1: Filter grid templates by form-factor compatibility. */
  ENABLE_FORM_FACTOR_FILTERING: true,
  /** Phase 2: Generate character turnaround sheets before panels. */
  ENABLE_CHAR_SHEETS: true,
  /** Phase 3: Generate panels in parallel batches. */
  ENABLE_PARALLEL_GEN: false,
  /** Phase 4: Compose panels into full-page images on the server. */
  ENABLE_SERVER_COMPOSITING: false,
  /** Phase 5: In-panel inpainting / editing. */
  ENABLE_INPAINTING: false,
} as const;
