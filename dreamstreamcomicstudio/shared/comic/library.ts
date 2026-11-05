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
  /** The platform image key is configured (a build can run). */
  platformKey: boolean;
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
