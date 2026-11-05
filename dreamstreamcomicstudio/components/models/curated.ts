// One caption for the numbers that come from the bundled, hand-curated datasets
// (services/modelBenchmarks.ts, modelParams.ts, imageModelRanking.ts), not from a live source.
// The wording is fixed ("Approximate, vendor-reported"); the date is read from the rows actually
// shown, so it never claims a year the data is not from: "as of 2025" when every row is a 2025
// snapshot, "as of 2024–2026" when the rows span years.

export const CURATED_PREFIX = 'Approximate, vendor-reported';

const yearOf = (asOf: string | null | undefined): number | null => {
  const m = typeof asOf === 'string' ? /^(\d{4})/.exec(asOf.trim()) : null;
  return m ? Number(m[1]) : null;
};

/** "Approximate, vendor-reported, as of 2025" (or a year span), from the rows' asOf stamps. */
export const curatedLabel = (asOfs: Array<string | null | undefined>): string => {
  const years = asOfs.map(yearOf).filter((y): y is number => y !== null);
  if (!years.length) return CURATED_PREFIX;
  const min = Math.min(...years);
  const max = Math.max(...years);
  return `${CURATED_PREFIX}, as of ${min === max ? min : `${min}–${max}`}`;
};
