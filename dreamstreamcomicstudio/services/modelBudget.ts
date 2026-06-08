// modelBudget.ts — the pure "what may this project spend, and on which model tier" brain.
//
// Ties together: the app's model catalog (free vs paid), a per-project spend limit the user sets,
// and the OpenRouter key's REAL remaining credit (from /api/models → key.limit_remaining /
// is_free_tier). A project can never be allowed to spend more than the key has, and when the budget
// is exhausted (or the key is free-tier) builds are forced onto free models. Kept dependency-free so
// it's fully unit-testable; the studio/loop call it to pick a cost preference per build.

export interface BudgetModel {
  id: string;
  isFree?: boolean;
}

export const categorizeModels = <T extends BudgetModel>(models: T[]): { free: T[]; paid: T[] } => {
  const free: T[] = [];
  const paid: T[] = [];
  for (const m of models) (m.isFree ? free : paid).push(m);
  return { free, paid };
};

/**
 * Clamp a user's requested project spend limit to the key's remaining credit — the project can
 * never be allowed to spend more than the key can pay for. `requestedUsd` null = no explicit project
 * cap (fall back to the key's remaining). `keyRemainingUsd` null = unknown (don't clamp).
 */
export const clampProjectLimit = (
  requestedUsd: number | null,
  keyRemainingUsd: number | null
): { limitUsd: number | null; clamped: boolean } => {
  if (requestedUsd == null) return { limitUsd: keyRemainingUsd ?? null, clamped: false };
  const req = Math.max(0, requestedUsd);
  if (keyRemainingUsd == null) return { limitUsd: req, clamped: false };
  const cap = Math.max(0, keyRemainingUsd);
  if (req > cap) return { limitUsd: cap, clamped: true };
  return { limitUsd: req, clamped: false };
};

export type BuildTier = 'free' | 'quality';

/**
 * Which model tier a build may use, given the project budget + the key's nature:
 *  - a free-tier key (no paid credits) can only use FREE models;
 *  - an exhausted project budget (remaining <= 0) forces FREE too;
 *  - otherwise paid/frontier ('quality') is allowed.
 */
export const resolveBuildTier = (opts: {
  projectLimitUsd: number | null;
  spentUsd: number;
  keyIsFreeTier: boolean;
}): BuildTier => {
  if (opts.keyIsFreeTier) return 'free';
  if (opts.projectLimitUsd != null && opts.projectLimitUsd - Math.max(0, opts.spentUsd) <= 0) return 'free';
  return 'quality';
};

/**
 * Pick a model id for the chosen tier from the catalog, ranked by the caller's scorer (e.g. strong
 * coders first). The paid tier falls back to free models when no paid model is available (so a build
 * never dead-ends just because the catalog/key has no paid options right now). Null = no models.
 */
export const pickForTier = (
  models: BudgetModel[],
  tier: BuildTier,
  rank: (m: BudgetModel) => number = () => 0
): string | null => {
  const { free, paid } = categorizeModels(models);
  const pool = tier === 'free' ? free : paid.length ? paid : free;
  if (!pool.length) return null;
  return [...pool].sort((a, b) => rank(b) - rank(a))[0].id;
};
