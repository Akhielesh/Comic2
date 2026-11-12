// Admin image spend (Program 3 ST-A; styles §6.3, PROGRAM3 §5, decision D4): which key the library runner and
// Model Lab spend on, the app-side monthly cap, and the comic_image_calls ledger for library attempts.
//
// The key is DREAMSTREAMSTUDIO_MODELTEST: an OpenRouter key kept out of the user-serving pool, so admin test spend
// never mixes with user spend and either key can be capped or rotated on its own. It is referred to by NAME only:
// the value is read here, per call, handed to keys.ts → the image and text clients, and never logged, returned,
// stored or put in an error. COMIC_ADMIN_SPEND_KEY=platform is the explicit escape hatch onto the platform
// (DREAMSTREAMSTUDIO_ALL) OpenRouter key; anything else, unset included, means the model-test key, and an unset
// model-test key FAILS CLOSED (nothing can be built). OpenRouter only: the platform Gemini key is never used here.
//
// The env is read lazily (here, not in config.ts) so tests use fake values and importing this module reads, fetches
// and schedules nothing.

import {
  LIBRARY_CALL_KIND,
  LIBRARY_MONTHLY_CAP_DEFAULT_USD,
  type AdminSpendKey
} from '../../../../shared/comic/library.js';
import type { Resolution } from '../../../../shared/comic/doc.js';
import { logger } from '../../lib/logger.js';
// Types only: billing.ts imports keys.ts, which imports this module, so the recorder factory is passed in
// (library/index.ts wires billing.ts's createImageCallRecorder) instead of imported here.
import type { ImageCallRecord, ImageCallRecorder, ImageCallRecorderDeps } from '../billing.js';

/** The model-test key's env var (a NAME; its value never leaves the server process). */
export const ADMIN_SPEND_KEY_ENV = 'DREAMSTREAMSTUDIO_MODELTEST';
/** `platform` = the explicit escape hatch onto the platform OpenRouter key; anything else = the model-test key. */
export const ADMIN_SPEND_MODE_ENV = 'COMIC_ADMIN_SPEND_KEY';
/** App-side monthly cap on library builds, in USD (default LIBRARY_MONTHLY_CAP_DEFAULT_USD). */
export const LIBRARY_MONTHLY_CAP_ENV = 'COMIC_LIBRARY_MONTHLY_CAP_USD';

type Env = Record<string, string | undefined>;
const read = (env: Env, ...names: string[]): string => {
  for (const n of names) {
    const v = (env[n] || '').trim();
    if (v) return v;
  }
  return '';
};

/** Which key admin spend runs on: 'platform' only when COMIC_ADMIN_SPEND_KEY is platform (any case, surrounding spaces trimmed). */
export const adminSpendMode = (env: Env = process.env): AdminSpendKey => (read(env, ADMIN_SPEND_MODE_ENV).toLowerCase() === 'platform' ? 'platform' : 'modeltest');

/**
 * The OpenRouter key admin spend uses in the active mode, or '' when it is unset (the caller fails closed).
 * The platform mode reads the same names config.ts resolves the platform key from.
 */
export const adminSpendKeyValue = (env: Env = process.env): string =>
  adminSpendMode(env) === 'platform'
    ? read(env, 'DREAMSTREAMSTUDIO_ALL', 'dreamstreamstudio_all', 'OPENROUTER_API_KEY')
    : read(env, ADMIN_SPEND_KEY_ENV, 'dreamstreamstudio_modeltest');

/** COMIC_LIBRARY_MONTHLY_CAP_USD: a finite number ≥ 0 (0 stops every build); anything else → the default. */
export const libraryMonthlyCapUsd = (env: Env = process.env): number => {
  const raw = read(env, LIBRARY_MONTHLY_CAP_ENV);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : LIBRARY_MONTHLY_CAP_DEFAULT_USD;
};

/** The key in words, for copy ("the model-test key isn't set"). Never the value. */
export const adminSpendKeyLabel = (key: AdminSpendKey): string => (key === 'platform' ? 'platform OpenRouter key' : 'model-test key');

/** The env var to set, for an admin's "how do I fix this" line. */
export const adminSpendKeyEnvName = (key: AdminSpendKey): string => (key === 'platform' ? 'DREAMSTREAMSTUDIO_ALL' : ADMIN_SPEND_KEY_ENV);

/** "The model-test key (DREAMSTREAMSTUDIO_MODELTEST) isn't set on this server." */
export const adminSpendKeyMissing = (key: AdminSpendKey = adminSpendMode()): string =>
  `The ${adminSpendKeyLabel(key)} (${adminSpendKeyEnvName(key)}) isn't set on this server.`;

// ── Ledger: one comic_image_calls row per library attempt ────────────────────────────────────────

/**
 * One library image attempt, as comic_image_calls stores it: 'ok' / 'failed' when it reached the provider,
 * 'blocked' when it was stopped before any provider call (the circuit breaker refused the route, or the attempt
 * was cancelled with nothing spent) — the jobs.ts convention, so the admin audit never counts a refusal as a
 * failed provider call.
 */
export interface LibraryImageCall {
  /** The admin who clicked Build (comic_image_calls.user_id is NOT NULL, FK auth.users). */
  userId: string;
  /** Registry id. */
  modelId: string;
  providerModel?: string;
  providerName?: string;
  res: Resolution;
  aspect: string;
  refs: number;
  outcome: 'ok' | 'failed' | 'blocked';
  httpStatus?: number;
  errorCode?: string;
  /** Provider-reported cost; null = not reported. */
  providerCostUsd: number | null;
  latencyMs?: number;
  modelVersion?: string;
}

export interface LibraryCallLedger {
  /** Fire-and-forget: never throws, never awaited by a build step. */
  record(call: LibraryImageCall): void;
}

/**
 * The comic_image_calls row of a library attempt: kind 'library', OpenRouter, platform-paid (billed 0, not BYOK),
 * no project. ImageCallRecord's kind union predates the library kind (USE-1 widens it); the column is plain text.
 */
export const libraryImageCallRecord = (c: LibraryImageCall): ImageCallRecord => ({
  userId: c.userId,
  modelId: c.modelId,
  ...(c.providerModel ? { providerModel: c.providerModel } : {}),
  route: 'openrouter',
  ...(c.providerName ? { providerName: c.providerName } : {}),
  kind: LIBRARY_CALL_KIND as unknown as ImageCallRecord['kind'],
  res: c.res,
  aspect: c.aspect,
  refs: c.refs,
  outcome: c.outcome,
  ...(typeof c.httpStatus === 'number' ? { httpStatus: c.httpStatus } : {}),
  ...(c.errorCode ? { errorCode: c.errorCode } : {}),
  providerCostUsd: c.providerCostUsd,
  billedUsd: 0,
  byok: false,
  ...(typeof c.latencyMs === 'number' ? { latencyMs: c.latencyMs } : {}),
  ...(c.modelVersion ? { modelVersion: c.modelVersion } : {})
});

/**
 * The library's comic_image_calls writer: billing.ts's recorder (service role, model_version fallback, UUID check)
 * with the model_usage_monthly bump turned OFF, so admin test traffic never shows in users' model stats.
 * Built lazily on the first record: creating the ledger writes and connects nothing.
 */
export function createLibraryCallLedger(
  createRecorder: (deps: ImageCallRecorderDeps) => ImageCallRecorder,
  deps: Omit<ImageCallRecorderDeps, 'bumpUsage'> = {}
): LibraryCallLedger {
  let recorder: ImageCallRecorder | null = null;
  return {
    record(call) {
      try {
        (recorder ??= createRecorder({ ...deps, bumpUsage: () => undefined })).record(libraryImageCallRecord(call));
      } catch (err) {
        logger.warn('comic_library_image_call_not_recorded', { message: String((err as Error)?.message || err).slice(0, 200) });
      }
    }
  };
}
