// Platform asset library — types and constants (contract §11.6; real from wave 0).
// Library assets auto-publish at or above LIBRARY_MIN_SCORE; below goes to the admin review queue.
// The build is client-driven step by step by an admin (decisions-final #4).

import type { AspectRatio } from './doc.js';

export const LIBRARY_MANIFEST_VERSION = 1;
export type LibraryKind = 'style_preview' | 'style_anchor' | 'genre_example' | 'cover_example' | 'empty_state' | 'onboarding' | 'texture_seed';
export const LIBRARY_KINDS: readonly LibraryKind[] = ['style_preview', 'style_anchor', 'genre_example', 'cover_example', 'empty_state', 'onboarding', 'texture_seed'];
export type LibraryTheme = 'any' | 'light' | 'dark';
export type LibraryAssetStatus = 'pending' | 'generating' | 'analyzing' | 'needs_review' | 'published' | 'rejected' | 'failed';
//   ('approved' is dropped: score ≥ minScore ⇒ published automatically; below ⇒ needs_review admin queue)
export const LIBRARY_ID_RE = /^[a-z]+(?:\.[a-z0-9-]+){1,3}$/;
export const LIBRARY_MIN_SCORE = 0.75;
export const LIBRARY_BUDGET_DEFAULT_USD = 5;
export const LIBRARY_BUDGET_MAX_USD = 25;
/** "style.<id>" */
export const stylePreviewId = (presetId: string): string => `style.${presetId}`;

export interface LibraryAssetPublic {
  id: string; kind: LibraryKind; presetId?: string; genre?: string; theme: LibraryTheme; aspect: AspectRatio;
  w: number; h: number; url: string; thumbs: { 320?: string; 640?: string }; alt: string; caption?: string;
  tags: string[]; palette: string[]; rev: number;
  /** How the published image was made (P3-ST2). Absent on assets published before provenance existed. */
  provenance?: LibraryProvenance;
  /** A ~300-byte blurred WebP preview (data:image/webp;base64,…) painted before the image loads (P3-ST2). */
  lqip?: string;
}
export interface LibraryIndex { manifestVersion: number; generatedAt: number; assets: LibraryAssetPublic[] }
/** Admin client-driven build (decisions-final #4): each step advances ≤ n assets; idempotent; resumable. */
export interface LibraryRunView {
  id: string; status: 'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'failed';
  budgetUsd: number; spentUsd: number;
  counts: { total: number; done: number; published: number; review: number; failed: number; skipped: number; pending: number };
  assets: Array<{ id: string; status: LibraryAssetStatus; attempts: number; score?: number; lastIssue?: string }>;
}
export interface LibraryQuote { usd: number; worstCaseUsd: number; images: number; lines: { kind: LibraryKind; count: number; usd: number }[]; skipped: { id: string; reason: string }[] }

/** Status a freshly analyzed asset lands in. */
export const libraryStatusForScore = (score: number | undefined): LibraryAssetStatus =>
  typeof score === 'number' && Number.isFinite(score) && score >= LIBRARY_MIN_SCORE ? 'published' : 'needs_review';
/** Clamp an admin-entered run budget to (0, LIBRARY_BUDGET_MAX_USD]; default LIBRARY_BUDGET_DEFAULT_USD. */
export const clampLibraryBudget = (usd: unknown): number =>
  typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? Math.min(LIBRARY_BUDGET_MAX_USD, usd) : LIBRARY_BUDGET_DEFAULT_USD;

// ── Wave 1 additions (P1-LIBRARY; additive — the wave-0 exports above are unchanged) ─────────

/** "anchor.<id>": optional content-neutral style swatch (phase 2, built only on request). */
export const styleAnchorId = (presetId: string): string => `anchor.${presetId}`;
/** Assets one admin `step` call may advance (contract §14.1: n ≤ 3). */
export const LIBRARY_STEP_MAX = 3;
/** A `generating`/`analyzing` row untouched for this long belongs to a dead step and is reset. */
export const LIBRARY_STUCK_MS = 10 * 60_000;
/** Refine attempts after the first (assets.md §4.4: at most 2 retries). */
export const LIBRARY_MAX_RETRIES = 2;
/**
 * Artist, studio and brand names that must never appear in library prompts, alt text or preset
 * copy (assets.md §13). Library art is generated fresh from descriptions of drawable traits.
 */
export const LIBRARY_IP_BLOCKLIST =
  /\b(?:ghibli|miyazaki|tintin|marvel|dc comics|disney|pixar|toriyama|spider[- ]?man|batman|superman|pok[eé]mon|naruto|shin[- ]?chan|lego|dreamworks|nintendo|dragon ball|moebius|ditko|jack kirby)\b|\bherg[eé]|webtoon™/i;

/** Empty-state ids to try for a variant and theme (dark → light → theme-less), most specific first. */
export const libraryEmptyIds = (variant: string, theme: 'light' | 'dark'): string[] => {
  const alias: Record<string, string> = { studio: 'studio-hero', reader: 'reader-missing' };
  const v = alias[variant] || variant;
  const ids = theme === 'dark' ? [`empty.${v}.dark`, `empty.${v}.light`, `empty.${v}`] : [`empty.${v}.light`, `empty.${v}`];
  return ids.filter((id) => LIBRARY_ID_RE.test(id));
};

export type LibraryRefineStrategy = 'first' | 'rerequest' | 'edit' | 'regenerate' | 'rewrite';

/** POST /api/comic/admin/library/{quote,runs}: what to build. Unknown ids → 400. */
export interface LibraryBuildRequest {
  ids?: string[];
  kinds?: LibraryKind[];
  /** Rebuild even published, up-to-date assets (and ones waiting for review or rejected). */
  force?: boolean;
  /** Include optional entries (style anchors) in the selection. */
  includeOptional?: boolean;
  /** Clamped to (0, LIBRARY_BUDGET_MAX_USD]; default LIBRARY_BUDGET_DEFAULT_USD. */
  budgetUsd?: number;
  /** 0–2 refine attempts after the first (default 2). */
  maxRetries?: 0 | 1 | 2;
}

/** One candidate image of an asset as the admin console sees it. */
export interface LibraryCandidateView {
  rev: number; url: string; thumb?: string; w: number; h: number; score: number; issues: string[];
  strategy: LibraryRefineStrategy; at: number; caption?: string; alt?: string; tags?: string[]; palette?: string[]; textFound?: string[];
  /** The candidate was drawn from the current prompt (older prompts' candidates can't be published). */
  current: boolean;
}

/** One manifest entry plus its stored state (admin console grid). */
export interface LibraryEntryView {
  id: string; kind: LibraryKind; model: string; resolution: string; aspect: AspectRatio; theme: LibraryTheme;
  presetId?: string; genre?: string; optional?: boolean; promptHash: string; alt: string; estimateUsd: number;
  row?: {
    status: LibraryAssetStatus; score?: number; rev: number; attempts: number; costUsd: number; issues: string[];
    url?: string; thumb?: string; upToDate: boolean; published?: { rev: number; url: string; thumb?: string; at?: number };
    error?: string; candidates: LibraryCandidateView[];
  };
}

/** GET /api/comic/admin/library/manifest */
export interface LibraryManifestView {
  manifestVersion: number;
  bucket: string;
  /** The admin spend key is configured (a build can run). Kept under its wave-1 name. */
  platformKey: boolean;
  /** Which key builds spend on, this month's spend against the app cap, and the provider limit as last checked (P3-ST1). */
  billing?: LibraryBillingView;
  /** library_assets/library_runs exist (server/sql/comic_library.sql applied). */
  tableReady: boolean;
  entries: LibraryEntryView[];
  activeRun?: LibraryRunView;
  lastRun?: LibraryRunSummary;
}

export interface LibraryRunSummary {
  id: string; status: LibraryRunView['status']; budgetUsd: number; spentUsd: number; total: number; done: number;
  startedAt: number; finishedAt?: number; error?: string;
}

/** A step's answer: the run plus whether another step is still holding it (wait and retry). */
export interface LibraryStepView extends LibraryRunView {
  /** Another step is still working on this run (a retry after a dropped connection); try again shortly. */
  busy?: boolean;
  /** Honest one-line summary of what this step did. */
  message: string;
  /** Suggested wait before the next step (ms); 0 = step again now. */
  waitMs: number;
}

// ── Program 3 ST-A additions (admin spend key, caps, provenance, ledger; additive) ─────────────

/**
 * Which OpenRouter key admin image spend (library builds, Model Lab) runs on: the model-test key
 * (DREAMSTREAMSTUDIO_MODELTEST, the default) or the platform key, only when COMIC_ADMIN_SPEND_KEY=platform.
 * A name for copy and the billing line, never the key itself.
 */
export type AdminSpendKey = 'modeltest' | 'platform';
/** App-side monthly cap on library spend when COMIC_LIBRARY_MONTHLY_CAP_USD is unset (decision D4). */
export const LIBRARY_MONTHLY_CAP_DEFAULT_USD = 20;
/** The budget the console's "Seed styles" selection starts with (styles §6.3: the worst case of the style seed). */
export const LIBRARY_SEED_STYLES_BUDGET_USD = 15;
/** Longest exact prompt a public provenance carries (the client sanitizer drops longer ones). */
export const LIBRARY_PROMPT_MAX = 6000;
/** Longest LQIP data URL the public index carries. */
export const LIBRARY_LQIP_MAX = 1200;
/** comic_image_calls.kind of a library attempt (admin spend: kept out of every user-facing model stat). */
export const LIBRARY_CALL_KIND = 'library';
/** comic_image_calls.kind prefix of a Model Lab call ('lab_page', 'lab_sheet'): admin spend too. */
export const LAB_CALL_KIND_PREFIX = 'lab_';
/** The comic_image_calls kind a Model Lab call is recorded under. */
export const labCallKind = (kind: string): string => `${LAB_CALL_KIND_PREFIX}${kind}`.slice(0, 20);
/** A comic_image_calls row written by admin spend (library or lab): never part of users' model stats. */
export const isAdminSpendCallKind = (kind: string | null | undefined): boolean =>
  typeof kind === 'string' && (kind === LIBRARY_CALL_KIND || kind.startsWith(LAB_CALL_KIND_PREFIX));

/** Admin-only billing line of GET /manifest. Never carries a key. */
export interface LibraryBillingView {
  /** The key builds spend on; null = it isn't set, so nothing can be built (fail closed). */
  key: AdminSpendKey | null;
  /** library_runs.spent_usd summed over this UTC month; absent when it couldn't be read. */
  monthSpentUsd?: number;
  /** COMIC_LIBRARY_MONTHLY_CAP_USD (default LIBRARY_MONTHLY_CAP_DEFAULT_USD). */
  monthCapUsd: number;
  /** The key's OpenRouter limit when the last build started (null = no limit set). Never fetched on page load. */
  limitUsd?: number | null;
  /** What was left under that limit (or the budget that blocks first) when the last build started. */
  remainingUsd?: number | null;
  /** When that provider check ran (ms). */
  checkedAt?: number;
}

/**
 * How a published library image was made (P3-ST2; PROGRAM3 §5 provenance table). Platform-authored facts only:
 * never a cost (computed client-side for admins), a run id, an admin id, a provider job id or a key.
 */
export interface LibraryProvenance {
  /** Registry id. */
  model: string;
  /** Registry label and nickname, and the date the registry's facts were read. */
  modelLabel?: string;
  nickname?: string;
  factsAsOf?: string;
  /** The provider's model id that was requested. */
  providerModel?: string;
  /** The model version the provider reported, when it did. */
  modelVersion?: string;
  /** The route that drew it (admin spend is OpenRouter only from ST-A on). */
  route: 'openrouter' | 'gemini';
  /** Which platform key paid ("OpenRouter · DreamStream test key"). */
  key: AdminSpendKey;
  /** The exact final prompt sent (platform-authored, IP-linted, never user content) and its hash. */
  prompt: string;
  promptHash: string;
  /** Models the registry marks seedless: null with seedSupported false ("Not supported by this model"). */
  seed: null;
  seedSupported: boolean;
  resolution: string;
  aspect: AspectRatio;
  /** The check result (0–1) and the vision model that checked it. */
  score: number;
  checkerModel?: string;
  /** Attempts the publishing build made for this image (refines included), and how this one was drawn. */
  attempts: number;
  strategy: LibraryRefineStrategy;
  generatedAt: number;
}

const PROVENANCE_STRATEGIES: ReadonlySet<string> = new Set(['first', 'rerequest', 'edit', 'regenerate', 'rewrite']);
const provText = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v && v.length <= max ? v : undefined);
const provNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The allow-listed public provenance (server index and client sanitizer alike): only the fields LibraryProvenance
 * names, each type-checked and size-bounded; anything else (a run id, an admin id, a cost, a key) is dropped. An
 * oversized or missing exact prompt drops the whole record (a cut prompt is no longer the exact one).
 */
export function sanitizeLibraryProvenance(raw: unknown): LibraryProvenance | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const model = provText(o.model, 80);
  const prompt = provText(o.prompt, LIBRARY_PROMPT_MAX);
  const promptHash = provText(o.promptHash, 80);
  const route = o.route === 'openrouter' || o.route === 'gemini' ? o.route : undefined;
  const key = o.key === 'modeltest' || o.key === 'platform' ? o.key : undefined;
  const resolution = provText(o.resolution, 8);
  const aspect = provText(o.aspect, 8) as AspectRatio | undefined;
  const score = provNum(o.score);
  const attempts = provNum(o.attempts);
  const generatedAt = provNum(o.generatedAt);
  const strategy = typeof o.strategy === 'string' && PROVENANCE_STRATEGIES.has(o.strategy) ? (o.strategy as LibraryRefineStrategy) : undefined;
  if (!model || !prompt || !promptHash || !route || !key || !resolution || !aspect || score === undefined || attempts === undefined || generatedAt === undefined || !strategy) return undefined;
  const opt = (name: string, max: number) => {
    const v = provText(o[name], max);
    return v ? { [name]: v } : {};
  };
  return {
    model,
    ...opt('modelLabel', 80),
    ...opt('nickname', 60),
    ...opt('factsAsOf', 24),
    ...opt('providerModel', 160),
    ...opt('modelVersion', 160),
    route,
    key,
    prompt,
    promptHash,
    seed: null,
    seedSupported: o.seedSupported === true,
    resolution,
    aspect,
    score: Math.max(0, Math.min(1, score)),
    ...opt('checkerModel', 160),
    attempts: Math.max(1, Math.min(99, Math.round(attempts))),
    strategy,
    generatedAt
  };
}

/** A well-formed LQIP data URL within LIBRARY_LQIP_MAX, or undefined. */
export const sanitizeLibraryLqip = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length <= LIBRARY_LQIP_MAX && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(v) ? v : undefined;
