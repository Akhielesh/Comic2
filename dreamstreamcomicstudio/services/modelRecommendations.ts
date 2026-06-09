// "Best accuracy yet cheap" recommendation logic for the model catalog.
//
// Combines the curated benchmark snapshot (Arena Elo) with the model's real $/M output price to
// score value — a strong-but-cheap model beats both a pricey frontier model and a weak free one.
// Pure + dependency-light so it's unit-testable and shared by the Library + the recommended strip.

import type { CatalogModel } from './modelCatalog';
import { getModelBenchmarks } from './modelBenchmarks';

/** Arena Elo for a model (0 when we have no benchmark snapshot for its family). */
export const accuracyElo = (m: CatalogModel): number => getModelBenchmarks(m.id)?.scores.arena_elo ?? 0;

/** $ per 1M output tokens (text models). */
export const pricePerMillionOut = (m: CatalogModel): number => (m.pricing.completionPerToken || 0) * 1_000_000;

/**
 * Value score for a TEXT model: Arena-Elo headroom above a 1200 baseline divided by ($/M out + 1),
 * so accuracy is rewarded and price penalised. Requires benchmark data and a hosted-callable,
 * text-output model (returns 0 otherwise, so it's never recommended without evidence).
 */
export const valueScore = (m: CatalogModel): number => {
  if (m.supportsImageOutput) return 0;
  if (m.apiCallable === false) return 0;
  const elo = accuracyElo(m);
  if (!elo) return 0;
  const headroom = Math.max(0, elo - 1200);
  return headroom / (pricePerMillionOut(m) + 1);
};

export interface ModelPicks {
  /** Top accuracy-yet-cheap text models (de-duped by model family). */
  bestValue: CatalogModel[];
  /** Best image model (reference-capable first, then cheapest per image). */
  topImage: CatalogModel | null;
}

export const recommendModels = (models: CatalogModel[], count = 2): ModelPicks => {
  const ranked = models
    .filter((m) => valueScore(m) > 0)
    .sort((a, b) => valueScore(b) - valueScore(a));

  // De-dupe by benchmark family so we don't surface two variants of the same model.
  const seenFamily = new Set<string>();
  const bestValue: CatalogModel[] = [];
  for (const m of ranked) {
    const family = getModelBenchmarks(m.id)?.family ?? m.id;
    if (seenFamily.has(family)) continue;
    seenFamily.add(family);
    bestValue.push(m);
    if (bestValue.length >= count) break;
  }

  const images = models
    .filter((m) => m.supportsImageOutput && m.apiCallable !== false)
    .sort((a, b) => {
      // Reference/edit-capable first (matters for consistent comic panels), then cheapest per image.
      const refDelta = Number(b.supportsImageInput) - Number(a.supportsImageInput);
      if (refDelta) return refDelta;
      return (a.pricing.imagePerImage || Number.POSITIVE_INFINITY) - (b.pricing.imagePerImage || Number.POSITIVE_INFINITY);
    });

  return { bestValue, topImage: images[0] ?? null };
};
