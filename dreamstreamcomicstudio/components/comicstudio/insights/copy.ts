// Exact Insights copy (models.md §3.6 A lock line, §4.6 missing-data states, decisions-final #6). One place, so
// the tests can hold every string to the spec and a missing figure always reads the same way — never a guess.
// The §4.6 strings mirror the server's (server/src/comic/models/{pricing,quality,observed}.ts); a test keeps
// them equal.

/** §4.6: per-image price unpublished (billed per token). */
export const PRICE_UNPUBLISHED_COPY = "Price per image isn't published · you'll see the real cost after the first image";
/** §4.6: OpenRouter publishes no price (an empty pricing array). */
export const NO_OPENROUTER_PRICE_COPY = "OpenRouter doesn't list a price for this model";
/** §4.6: the fetch failed but a cached value exists. */
export const couldntRefreshCopy = (time: string): string => `as of ${time} · couldn't refresh`;
/** §4.6: the fetch failed and nothing is cached — the registry's dated price list. */
export const priceListCopy = (factsAsOf: string): string => `from our price list, ${factsAsOf}`;
/** §4.6: no uptime figure at all. */
export const NO_UPTIME_COPY = 'No uptime data right now';
/** §4.6: not on any public leaderboard. */
export const NOT_RANKED_COPY = 'Not ranked on public leaderboards yet';
/** §4.6: a platform aggregate below 5 distinct users. */
export const NOT_ENOUGH_DATA_COPY = 'Not enough data yet';

/** decisions-final #6: "saved by software", shown quietly as a trust signal. */
export const SAVED_BY_SOFTWARE_COPY = 'Free — done by the editor, no AI cost.';

/** models.md §3.6 A — the lock line. */
export const lockedLine = (model: string): string => `Drawn with ${model} · locked for this comic`;
export const unlockedLine = (model: string): string => `Will draw with ${model} · locks when the first image is drawn`;
export const LOCK_ICON_LABEL = 'Model locked so every page matches';
export const CHANGE_MODEL_LINK = 'Change…';
export const CHOOSE_MODEL_LINK = 'Choose model…';

/** models.md §2.5 / §3.9: OpenRouter's canonical slug for the locked model is no longer the one recorded at lock time. */
export const newerBuildCopy = (model: string, slug: string): string => `OpenRouter now serves a newer build of ${model} (${slug}). The provider may have updated it.`;

/** models.md §4.2: totals rebuilt from a capped entry list. */
export const recentLabel = (n: number): string => `(recent ${n})`;
/** models.md §3.3: a mixed-model legacy book, said plainly. */
export const mixedModelsCopy = (n: number): string => `This comic has images from ${n} models`;

/** The tab names (models.md §4.1 L2). */
export const INSIGHTS_TAB_LABELS = { overview: 'Overview', pages: 'Pages', models: 'Models', trends: 'Trends' } as const;
