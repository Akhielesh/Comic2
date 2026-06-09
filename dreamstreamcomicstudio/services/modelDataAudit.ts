// Freshness auditing for the curated model datasets (benchmarks, image ranking, sizes).
//
// These datasets are hand-curated point-in-time snapshots — the user explicitly wants to treat
// them as "possibly wrong, needs verification". This module parses each entry's `asOf` quarter and
// flags anything older than a cutoff so the UI can prompt a re-check and link to the source.

/** Encode an "YYYY-Qn" string as a sortable integer (year*4 + quarter). null when unparseable. */
export const quarterValue = (asOf: string | undefined): number | null => {
  const m = /(\d{4})-Q([1-4])/i.exec(asOf || '');
  if (!m) return null;
  return Number(m[1]) * 4 + Number(m[2]);
};

/** Entries at/older than this quarter are flagged "review" (2025-Q3). */
export const STALE_CUTOFF = 2025 * 4 + 3;

/** True when an entry's snapshot quarter is older than STALE_CUTOFF (unknown quarters are not stale). */
export const isStale = (asOf: string | undefined): boolean => {
  const v = quarterValue(asOf);
  return v !== null && v < STALE_CUTOFF;
};
