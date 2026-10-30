// What a user may do in the studio (contract §3.3). Single source: server access.ts and the client read it.
// Mode (Easy/Pro) is a VIEW; `proEditor` is the only permission behind the Pro editor.

import type { QualityTier } from './doc.js';
import type { ContentRating } from './safety.js';
import { DOC_LIMITS, MAX_ALTERNATIVES } from './limits.js';

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
  /** Optional usage snapshot (P2-AMEND, from P1-LIMITS). Never dollars: governed users see "usage left" only.
   *  Absent = unknown; UsageSlot fetches /api/usage/allowance itself, so nothing depends on it. */
  usage?: StudioUsage;
  // --- history (versions plan §3.3; H0). Optional: absent = off, so caps without them are unchanged on the wire ---
  /** Comic History is on (server env COMIC_HISTORY=1, set after the client ships). Read via historyEnabled(). */
  history?: boolean;
  /** "Try another version" lines per comic (default MAX_ALTERNATIVES; the decisions-final #1 pattern). */
  maxAlternatives?: number;
}

/** "Usage left" for the header meter and quotes (percentages only — no USD ever reaches a governed user). */
export interface StudioUsage {
  /** The account runs on the platform allowance (not BYOK, not admin). */
  governed: boolean;
  /** 0..100. */
  pctLeft: number;
  exhausted: boolean;
  /** Share of the allowance one Standard page costs (0..100), or null when unknown. */
  pctPerStandardPage: number | null;
}

/** A well-formed StudioUsage (numbers clamped to 0..100) or undefined. */
export function sanitizeStudioUsage(value: unknown): StudioUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.governed !== 'boolean' || typeof v.pctLeft !== 'number' || !Number.isFinite(v.pctLeft)) return undefined;
  const pct = (n: number) => Math.min(100, Math.max(0, n));
  const per = typeof v.pctPerStandardPage === 'number' && Number.isFinite(v.pctPerStandardPage) ? pct(v.pctPerStandardPage) : null;
  return { governed: v.governed, pctLeft: pct(v.pctLeft), exhausted: v.exhausted === true, pctPerStandardPage: per };
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

// --- history (versions plan §3.3; H0) ---

/** The server env flag that turns Comic History on ('1' / 'true'). Unset = off: nothing observable changes. */
export const HISTORY_ENV = 'COMIC_HISTORY';
export const historyFlagOn = (value: unknown): boolean => value === '1' || value === 'true';
/** History is on for these caps (absent = off). */
export const historyEnabled = (caps: Pick<StudioCaps, 'history'> | null | undefined): boolean => caps?.history === true;
/** "Try another version" lines allowed (always ≥ 1, never above MAX_ALTERNATIVES unless raised there). */
export const maxAlternativesOf = (caps: Pick<StudioCaps, 'maxAlternatives'> | null | undefined): number => {
  const n = caps?.maxAlternatives;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : MAX_ALTERNATIVES;
};
/** Caps with history turned on when `on` (and the SAME object when off, so nothing changes on the wire). */
export const withHistoryCaps = (caps: StudioCaps, on: boolean): StudioCaps =>
  on ? { ...caps, history: true, maxAlternatives: maxAlternativesOf(caps) } : caps;
