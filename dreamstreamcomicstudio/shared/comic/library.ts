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
