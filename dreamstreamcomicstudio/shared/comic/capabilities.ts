// What a user may do in the studio (contract §3.3). Single source: server access.ts and the client read it.
// Mode (Easy/Pro) is a VIEW; `proEditor` is the only permission behind the Pro editor.

import type { QualityTier } from './doc.js';
import type { ContentRating } from './safety.js';
import { DOC_LIMITS } from './limits.js';

export type StudioMode = 'easy' | 'pro';
export type PlanClass = 'free' | 'paid' | 'admin';
/** Single source; server/src/comic/access.ts and services/modelAccessPolicy.ts import it. */
export const PAID_PLAN_IDS = ['creator', 'pro', 'studio', 'custom', 'admin'] as const;
/** decisions-final #1: the Pro editor is free for everyone now. Flip to false → paid plans + admins only. */
export const PRO_EDITOR_FOR_ALL = true;

export interface StudioCaps {
  plan: PlanClass;
  /** Spend runs on the user's own key (labels show no markup). */
  byok: boolean;
  /** Quality tiers that will run for this user. */
  qualityTiers: QualityTier[];
  /** Advanced image-model picker allowed. */
  modelOverride: boolean;
  /** format.pageCount ceiling (≤ DOC_LIMITS.pages). */
  maxPages: number;
  /** UI density default when the user never picked a mode. */
  defaultMode: StudioMode;
  /** Pro lettering inspector + Pro board controls. Mode is a VIEW; this is the only permission. */
  proEditor: boolean;
  /** Reserved paid extra (custom font upload, saved lettering kits). false for everyone this iteration. */
  customFonts: boolean;
  /** Account-age ceiling computed server-side from profile_private.dob; the DOB never leaves the server. */
  ratingCeiling: ContentRating;
  /** UI hint for admin-only consoles (server re-checks requireAdmin). */
  admin: boolean;
}

export const DEFAULT_CAPS: StudioCaps = {
  plan: 'free', byok: false, qualityTiers: ['draft', 'standard'], modelOverride: false,
  maxPages: DOC_LIMITS.pages, defaultMode: 'easy', proEditor: PRO_EDITOR_FOR_ALL,
  customFonts: false, ratingCeiling: 'PG-13', admin: false
};

export function resolveStudioCaps(i: {
  planId?: string | null; byok: boolean; isAdmin: boolean; ratingCeiling?: ContentRating;
}): StudioCaps {
  const plan = (i.planId || 'free').toLowerCase();
  const paid = i.isAdmin || (PAID_PLAN_IDS as readonly string[]).includes(plan);
  const anyKey = paid || i.byok;
  return {
    ...DEFAULT_CAPS,
    plan: i.isAdmin ? 'admin' : paid ? 'paid' : 'free',
    byok: i.byok,
    qualityTiers: anyKey ? ['draft', 'standard', 'pro'] : ['draft', 'standard'],
    modelOverride: anyKey,
    defaultMode: paid ? 'pro' : 'easy',
    proEditor: PRO_EDITOR_FOR_ALL || paid,
    ratingCeiling: i.ratingCeiling ?? 'PG-13',
    admin: i.isAdmin
  };
}
