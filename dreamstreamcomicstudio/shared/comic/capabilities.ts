// What a user may do in the studio (contract §3.3). Single source: server access.ts and the client read it.
// Mode (Easy/Pro) is a VIEW; `proEditor` is the only permission behind the Pro editor.

import type { AnchorKinds } from './anchors.js';
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
  // --- consistency anchors (pro plan §4.8; B4) ---
  /** The anchor kinds the server's runs use: anchorKindsFromFlag(COMIC_CONSISTENCY_ANCHORS), filled by access.ts
   *  studioCapsFor. Unset env = ANCHOR_KINDS_OFF (every kind off). The client passes it to summarizeBook's
   *  `consistency` option and quoteRenderPages' `anchors`, so its quotes use the server's kinds. Absent = every kind off. */
  anchorKinds?: AnchorKinds;
  // --- live agent, dialogue and the Pro editor v2 (agent-editor plan §5; K3). Optional: absent = off (an older server) ---
  /** The live agent's parts: the visible message queue (A1), server steering (A2/A4), the conflict guard and card (A3).
   *  Filled by access.ts from COMIC_LIVE_QUEUE / COMIC_STEER / COMIC_CONFLICT_GUARD (stages off | admins | all). */
  liveAgent?: LiveAgentCaps;
  /** Clear dialogue edits answered with no model call (B3 fast path; COMIC_DIALOGUE_FAST). */
  dialogueFast?: boolean;
  /** The Pro editor v2: docked inspector, numeric fields, Layers, rotation, named styles (C-*; COMIC_PRO_EDITOR_V2). */
  proEditorV2?: boolean;
  // --- Pro Edit (master plan §2.10; PE-0). Optional: absent = off (an older server). Filled by access.ts. ---
  /** The Easy Animate row, the Animate timeline, motion in the editor and "Export this page as video" (COMIC_PRO_MOTION). */
  proMotion?: boolean;
  /** The Stickers tab (COMIC_PRO_STICKERS; after the licence gate and the credits block). */
  proStickers?: boolean;
  /** Readers play the creator's motion (COMIC_READER_MOTION; stages off | all only: readers are not signed in). */
  readerMotion?: boolean;
}

/** agent-editor plan §3 Track A, one switch per part (each its own flag stage). */
export interface LiveAgentCaps {
  queue: boolean;
  steer: boolean;
  conflicts: boolean;
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

// --- live agent, dialogue and the Pro editor v2 (agent-editor plan §5; owner decision D9; K3) ---

/** Who a feature flag admits (the shared/platform/flags.ts stage pattern, with 'all' for everyone). */
export type FlagStage = 'off' | 'admins' | 'all';

/** The server env var behind each studio flag. The client never reads env: it reads the caps access.ts fills. */
export const LIVE_FLAG_ENV = {
  queue: 'COMIC_LIVE_QUEUE',
  steer: 'COMIC_STEER',
  conflicts: 'COMIC_CONFLICT_GUARD',
  dialogueFast: 'COMIC_DIALOGUE_FAST',
  proEditorV2: 'COMIC_PRO_EDITOR_V2'
} as const;
export type LiveFlag = keyof typeof LIVE_FLAG_ENV;

/** Stage when the env var is unset or unreadable (plan §5, D9): the queue, the conflict guard and the Pro editor v2 start
 *  with admins; steering (D2) and the dialogue fast path (D4) start off. */
export const LIVE_FLAG_DEFAULTS: Readonly<Record<LiveFlag, FlagStage>> = {
  queue: 'admins',
  steer: 'off',
  conflicts: 'admins',
  dialogueFast: 'off',
  proEditorV2: 'admins'
};

/**
 * One env value → a stage. 'off' | 'admins' | 'all' (case and spaces ignored); 'everyone' = 'all'; a bare switch
 * ('on', 'true', '1', 'yes') turns a flag on for ADMINS only (D4: "admins when on"; everyone needs an explicit 'all');
 * 'false' / '0' / 'no' = off; unset or anything else → `fallback`. Pure; never throws.
 */
export const parseFlagStage = (value: unknown, fallback: FlagStage): FlagStage => {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return 'off';
  if (v === 'admins' || v === 'admin' || v === 'on' || v === 'true' || v === '1' || v === 'yes') return 'admins';
  if (v === 'all' || v === 'everyone') return 'all';
  return fallback;
};

/** Whether a stage admits this user (admin status decides 'admins'). */
export const stageAllows = (stage: FlagStage, isAdmin: boolean): boolean => stage === 'all' || (stage === 'admins' && isAdmin);

/** The live-agent, dialogue and Pro editor v2 caps for one user, from the server env (access.ts studioCapsFor). */
export const liveCapsFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  isAdmin: boolean
): Required<Pick<StudioCaps, 'liveAgent' | 'dialogueFast' | 'proEditorV2'>> => {
  const on = (flag: LiveFlag) => stageAllows(parseFlagStage(env[LIVE_FLAG_ENV[flag]], LIVE_FLAG_DEFAULTS[flag]), isAdmin);
  return {
    liveAgent: { queue: on('queue'), steer: on('steer'), conflicts: on('conflicts') },
    dialogueFast: on('dialogueFast'),
    proEditorV2: on('proEditorV2')
  };
};

type LiveCapsView = Pick<StudioCaps, 'liveAgent' | 'dialogueFast' | 'proEditorV2'> | null | undefined;
/** Readers (absent = off, so DEFAULT_CAPS and an older server leave every new behaviour off). */
export const liveQueueOn = (caps: LiveCapsView): boolean => caps?.liveAgent?.queue === true;
export const steerOn = (caps: LiveCapsView): boolean => caps?.liveAgent?.steer === true;
export const conflictGuardOn = (caps: LiveCapsView): boolean => caps?.liveAgent?.conflicts === true;
export const dialogueFastOn = (caps: LiveCapsView): boolean => caps?.dialogueFast === true;
export const proEditorV2On = (caps: LiveCapsView): boolean => caps?.proEditorV2 === true;

// --- Pro Edit (master plan §2.10; PE-0): the motion, stickers and reader-motion flags ---

/** The server env var behind each Pro Edit flag (read by access.ts; the client reads caps only). */
export const PRO_FLAG_ENV = {
  proMotion: 'COMIC_PRO_MOTION',
  proStickers: 'COMIC_PRO_STICKERS',
  readerMotion: 'COMIC_READER_MOTION'
} as const;
export type ProFlag = keyof typeof PRO_FLAG_ENV;

/** Every Pro Edit flag starts off (§2.10): motion goes to admins after S3, stickers after D6 and the licence gate,
 *  reader motion to everyone once the reduced-motion and Calm checks pass on the public reader. */
export const PRO_FLAG_DEFAULTS: Readonly<Record<ProFlag, FlagStage>> = {
  proMotion: 'off',
  proStickers: 'off',
  readerMotion: 'off'
};

/** The COMIC_READER_MOTION values that turn reader motion on for everyone (case and spaces ignored). */
const READER_MOTION_ON: ReadonlySet<string> = new Set(['on', 'true', '1', 'all', 'everyone']);

/**
 * COMIC_READER_MOTION's stage: 'off' | 'all' only. A bare switch ('on', 'true', '1') or 'all' / 'everyone' turns it on
 * for EVERYONE: unlike the other flags there is no admins-only reading of a bare 'on', since that would leave a
 * switched-on flag silently off. 'admins' stays OFF for readers: the public reader serves signed-out readers, whose
 * admin status cannot be checked, so an admins stage cannot be honoured there, and it must never widen to everyone.
 * Unset, 'off' and any other value are off (PRO_FLAG_DEFAULTS.readerMotion is 'off').
 */
export const readerMotionStage = (value: unknown): 'off' | 'all' =>
  typeof value === 'string' && READER_MOTION_ON.has(value.trim().toLowerCase()) ? 'all' : 'off';

/** The Pro Edit caps for one user, from the server env (access.ts studioCapsFor). The W0 stage pattern: off | admins |
 *  all for motion and stickers (a bare switch = admins only), off | all for reader motion (a bare switch = everyone;
 *  readerMotionStage). */
export const proCapsFromEnv = (
  env: Readonly<Record<string, string | undefined>>,
  isAdmin: boolean
): Required<Pick<StudioCaps, 'proMotion' | 'proStickers' | 'readerMotion'>> => {
  const on = (flag: Exclude<ProFlag, 'readerMotion'>) => stageAllows(parseFlagStage(env[PRO_FLAG_ENV[flag]], PRO_FLAG_DEFAULTS[flag]), isAdmin);
  return {
    proMotion: on('proMotion'),
    proStickers: on('proStickers'),
    readerMotion: readerMotionStage(env[PRO_FLAG_ENV.readerMotion]) === 'all'
  };
};

type ProCapsView = Pick<StudioCaps, 'proMotion' | 'proStickers' | 'readerMotion'> | null | undefined;
/** Readers (absent = off, so DEFAULT_CAPS and an older server leave every Pro Edit behaviour off). */
export const proMotionOn = (caps: ProCapsView): boolean => caps?.proMotion === true;
export const proStickersOn = (caps: ProCapsView): boolean => caps?.proStickers === true;
export const readerMotionOn = (caps: ProCapsView): boolean => caps?.readerMotion === true;
