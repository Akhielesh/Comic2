// Cast tiers (v3 spec §3.3) — classify entities by screen time so the agent spends
// reference-sheet budget where it matters: leads always get a sheet, support when budget
// allows, extras are descriptor-locked (a cheap text lock injected into panel prompts).
// Pure helpers so planning, the cast card, and prompt-building all agree.

import type { CastTier, Character } from '../types';

export const CAST_TIER_ORDER: CastTier[] = ['lead', 'support', 'extra'];

export const castTierLabel = (tier: CastTier): string => {
  switch (tier) {
    case 'lead': return 'Lead';
    case 'support': return 'Support';
    case 'extra':
    default: return 'Extra';
  }
};

/**
 * Resolve a character's tier: an explicit `castTier` wins; otherwise a heuristic by billing
 * order — the first character is the lead, the next few are support, the long tail are extras.
 */
export const resolveCastTier = (character: Pick<Character, 'castTier'>, index: number): CastTier => {
  if (character.castTier) return character.castTier;
  if (index === 0) return 'lead';
  if (index <= 3) return 'support';
  return 'extra';
};

/** Whether this tier should get a generated reference sheet (vs. a text descriptor lock). */
export const tierWantsReferenceSheet = (tier: CastTier): boolean => tier !== 'extra';

/** Count how many characters fall into each tier (explicit or heuristic). */
export const summarizeCastTiers = (characters: Array<Pick<Character, 'castTier'>>): Record<CastTier, number> => {
  const counts: Record<CastTier, number> = { lead: 0, support: 0, extra: 0 };
  characters.forEach((c, i) => { counts[resolveCastTier(c, i)] += 1; });
  return counts;
};
