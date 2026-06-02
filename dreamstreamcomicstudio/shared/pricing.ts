// Canonical, multi-dimensional pricing model.
//
// The four axes are INDEPENDENT (any combination can be > 0):
//   - promptPerToken      USD per input token
//   - completionPerToken  USD per output token
//   - imagePerImage       USD per generated image
//   - requestFlat         USD per request (flat)
//
// "Free" and "cost" are RELATIVE to which axes apply and how the model is used.
// We do not collapse a model to a single "free/paid" boolean — see classifyModel().

export type PricingAxes = {
  promptPerToken: number;
  completionPerToken: number;
  imagePerImage: number;
  requestFlat: number;
};

/**
 * Cost classification (replaces the old single `isFree` boolean).
 *
 *  - `free_verified`            id ends `:free` OR all four axes are 0.
 *                               Genuinely no cost on the provider.
 *  - `zero_priced_token_billed` $0 per-image, but tokens are billed.
 *                               Image models like Gemini "Nano Banana" land here:
 *                               imagePerImage = 0 but completionPerToken > 0.
 *                               NOT free — your key still gets charged per call.
 *  - `per_image_only`           Tokens are 0, but imagePerImage > 0.
 *                               Pay-per-image models (Flux-style).
 *  - `paid`                     Anything else with a non-zero axis.
 */
export type CostClass =
  | 'free_verified'
  | 'zero_priced_token_billed'
  | 'per_image_only'
  | 'paid';

export type ClassifyInput = {
  modelId?: string;
  pricing: PricingAxes;
  /** True if the model produces images (drives the token-billed-image trap detection). */
  supportsImageOutput?: boolean;
};

export const hasFreeSuffix = (modelId?: string | null): boolean =>
  Boolean(modelId && modelId.trim().toLowerCase().endsWith(':free'));

const allZero = (p: PricingAxes): boolean =>
  p.promptPerToken === 0 && p.completionPerToken === 0 && p.imagePerImage === 0 && p.requestFlat === 0;

const anyTokenCost = (p: PricingAxes): boolean =>
  p.promptPerToken > 0 || p.completionPerToken > 0;

/** Stable cost class for a model. Replaces the old `isFree` boolean across the app. */
export const classifyModel = (input: ClassifyInput): CostClass => {
  const { pricing, modelId, supportsImageOutput } = input;
  if (hasFreeSuffix(modelId)) return 'free_verified';
  if (allZero(pricing)) return 'free_verified';
  if (supportsImageOutput && pricing.imagePerImage === 0 && anyTokenCost(pricing)) {
    return 'zero_priced_token_billed';
  }
  const tokensFree = !anyTokenCost(pricing) && pricing.requestFlat === 0;
  if (tokensFree && pricing.imagePerImage > 0) return 'per_image_only';
  return 'paid';
};

/** Short label suitable for a badge. */
export const classBadge = (cls: CostClass): string => {
  switch (cls) {
    case 'free_verified': return 'Free';
    case 'zero_priced_token_billed': return 'Token-billed';
    case 'per_image_only': return 'Per image';
    case 'paid': return 'Paid';
  }
};

/** Plain-language explanation; never collapses cost to a single misleading number. */
export const describeCost = (input: ClassifyInput): string => {
  const cls = classifyModel(input);
  const p = input.pricing;
  if (cls === 'free_verified') {
    if (hasFreeSuffix(input.modelId)) {
      return "Free on the provider's :free tier — exempt from key spend limits.";
    }
    return 'No cost on any axis (input tokens, output tokens, per-image, per-request).';
  }
  const parts: string[] = [];
  if (p.promptPerToken > 0) parts.push(`$${perMillion(p.promptPerToken)} / 1M input tokens`);
  if (p.completionPerToken > 0) parts.push(`$${perMillion(p.completionPerToken)} / 1M output tokens`);
  if (p.imagePerImage > 0) parts.push(`$${p.imagePerImage.toFixed(3)} per image`);
  if (p.requestFlat > 0) parts.push(`$${p.requestFlat.toFixed(4)} per request`);
  if (cls === 'zero_priced_token_billed') {
    return `NOT free — produces images but is billed per token: ${parts.join(', ')}.`;
  }
  if (cls === 'per_image_only') {
    return `Pay per image only — no token charge: ${parts.join(', ')}.`;
  }
  return parts.length ? parts.join(', ') + '.' : 'Pricing unknown.';
};

/** Pretty per-million-token figure. Returns "—" for zero. */
export const perMillion = (perToken: number): string => {
  if (!perToken || perToken <= 0) return '—';
  const perMil = perToken * 1_000_000;
  if (perMil < 0.01) return perMil.toFixed(4);
  if (perMil < 1) return perMil.toFixed(3);
  return perMil.toFixed(2);
};

/** Estimate USD cost for a planned generation using the canonical 4 axes. */
export type EstimateInput = {
  pricing: PricingAxes;
  /** Estimated input tokens. */
  inputTokens?: number;
  /** Estimated output tokens. */
  outputTokens?: number;
  /** Number of images to generate. */
  imageCount?: number;
  /** Number of requests this generation will make. */
  requestCount?: number;
};

export const estimateUsd = (input: EstimateInput): number => {
  const p = input.pricing;
  const it = Math.max(0, input.inputTokens || 0);
  const ot = Math.max(0, input.outputTokens || 0);
  const img = Math.max(0, input.imageCount || 0);
  const req = Math.max(0, input.requestCount || 0);
  return (
    it * p.promptPerToken +
    ot * p.completionPerToken +
    img * p.imagePerImage +
    req * p.requestFlat
  );
};

/**
 * Legacy frontend pricing shape uses inputPer1k / outputPer1k / imagePerOutput
 * (and no requestFlat). Bridge to the canonical 4-axis shape so the rest of the
 * app can deal with one number system.
 */
export type LegacyPerThousand = {
  inputPer1k?: number;
  outputPer1k?: number;
  imagePerOutput?: number;
};

export const fromLegacyPer1k = (legacy: LegacyPerThousand): PricingAxes => ({
  promptPerToken: (legacy.inputPer1k || 0) / 1000,
  completionPerToken: (legacy.outputPer1k || 0) / 1000,
  imagePerImage: legacy.imagePerOutput || 0,
  requestFlat: 0
});

/** Inverse — for surfaces that still consume the per-1k shape. */
export const toLegacyPer1k = (axes: PricingAxes): LegacyPerThousand => ({
  inputPer1k: axes.promptPerToken * 1000,
  outputPer1k: axes.completionPerToken * 1000,
  imagePerOutput: axes.imagePerImage
});
