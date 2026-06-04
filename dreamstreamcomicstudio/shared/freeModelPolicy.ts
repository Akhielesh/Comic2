// Single source of truth for the free-tier text-model rollover.
//
// This was previously duplicated in services/modelPolicy.ts (client) and
// server/src/services/modelAccessPolicy.ts (server) — the SAME date and model ids
// under different names ("rollover" vs "sunset") — which could silently drift apart.
// Both now import from here so the free-tier model and switch date are defined once.

/** Free-tier text model before the rollover date. */
export const FREE_TEXT_PRE_ROLLOVER_MODEL = 'gemini-2.0-flash';
/** Free-tier text model on/after the rollover date. */
export const FREE_TEXT_POST_ROLLOVER_MODEL = 'gemini-2.5-flash';
/** Instant the free-tier text model rolls over (pre → post), as an ISO string. */
export const FREE_TEXT_ROLLOVER_AT_ISO = '2026-03-31T00:00:00.000Z';
/** Same instant, as epoch milliseconds. */
export const FREE_TEXT_ROLLOVER_AT_MS = Date.parse(FREE_TEXT_ROLLOVER_AT_ISO);

/** The model ids the free tier is ever pinned to (pre + post rollover). */
export const FREE_TEXT_COMPAT_MODELS: readonly string[] = [
  FREE_TEXT_PRE_ROLLOVER_MODEL,
  FREE_TEXT_POST_ROLLOVER_MODEL
];

/** The free-tier text model effective at a given instant (defaults to now). */
export const resolveFreeTextModel = (atMs: number = Date.now()): string =>
  atMs >= FREE_TEXT_ROLLOVER_AT_MS ? FREE_TEXT_POST_ROLLOVER_MODEL : FREE_TEXT_PRE_ROLLOVER_MODEL;
