/**
 * WHO Child Growth Standards, birth to 24 months — weight-for-age,
 * length-for-age and head-circumference-for-age, for girls and boys.
 *
 *   measurement + age ─→ LMS (L, M, S) for that age, linearly interpolated
 *                        between monthly rows (1 month = 30.4375 days)
 *                     ─→ z = ((X / M)^L − 1) / (L·S)         (Box-Cox / LMS)
 *                     ─→ percentile = Φ(z)                    (normal CDF)
 *
 * Data: World Health Organization. WHO Child Growth Standards:
 * length/height-for-age, weight-for-age, weight-for-length, weight-for-height
 * and body mass index-for-age: methods and development. Geneva: WHO, 2006;
 * and WHO Child Growth Standards: head circumference-for-age …: methods and
 * development. Geneva: WHO, 2007. https://www.who.int/tools/child-growth-standards
 * The Month/L/M/S rows below are copied verbatim from the CSV files the US CDC
 * publishes of those tables (https://www.cdc.gov/growthcharts/who-data-files.htm:
 * WHO-{Boys,Girls}-{Weight,Length,Head-Circumference}-for-age-Percentiles.csv).
 * The WHO standards are freely usable with this attribution. The CDC
 * recommends the WHO standards for all children under 2 in the US too.
 *
 * Notes:
 *  - The standards describe how healthy, breastfed babies in optimal
 *    conditions grow. A single percentile is not a diagnosis — clinicians look
 *    at the trend across several visits.
 *  - WHO publishes daily LMS tables; interpolating the monthly rows by day is a
 *    close approximation (differences are far below measurement error).
 *  - For weight, WHO restricts the LMS curve beyond ±3 SD and extends it
 *    linearly using the 2–3 SD distance (WHO, 2006, ch. 7 "Computation of
 *    centiles and z-scores"), so extreme values aren't compressed by the
 *    skewness term. Length and head circumference have L = 1 (normal), so
 *    no restriction is needed.
 *  - Length is recumbent length (lying down), as measured under 2 years.
 */

export type GrowthMeasure = 'weight' | 'length' | 'head';
export type GrowthSex = 'f' | 'm';
/** [month, L, M, S]. M is the median (kg or cm), S the coefficient of variation, L the Box-Cox power. */
export type LmsRow = readonly [month: number, L: number, M: number, S: number];

export interface Lms {
  L: number;
  M: number;
  S: number;
}

export interface GrowthPoint {
  /** WHO z-score (SD units from the median). */
  z: number;
  /** Percentile 0–100. */
  pct: number;
  /** e.g. "62nd percentile", "below the 1st percentile". */
  label: string;
}

/** Days per month used by the WHO standards (365.25 / 12). */
export const DAYS_PER_MONTH = 30.4375;
/** Oldest age covered by these tables, in days (24 months). */
export const MAX_AGE_DAYS = 24 * DAYS_PER_MONTH;

// ── WHO LMS tables, months 0–24 (from the CDC-hosted WHO CSVs) ─────────────
// Weight-for-age (kg).
const WEIGHT_BOYS: readonly LmsRow[] = [
  [0, 0.3487, 3.3464, 0.14602], [1, 0.2297, 4.4709, 0.13395], [2, 0.197, 5.5675, 0.12385],
  [3, 0.1738, 6.3762, 0.11727], [4, 0.1553, 7.0023, 0.11316], [5, 0.1395, 7.5105, 0.1108],
  [6, 0.1257, 7.934, 0.10958], [7, 0.1134, 8.297, 0.10902], [8, 0.1021, 8.6151, 0.10882],
  [9, 0.0917, 8.9014, 0.10881], [10, 0.082, 9.1649, 0.10891], [11, 0.073, 9.4122, 0.10906],
  [12, 0.0644, 9.6479, 0.10925], [13, 0.0563, 9.8749, 0.10949], [14, 0.0487, 10.0953, 0.10976],
  [15, 0.0413, 10.3108, 0.11007], [16, 0.0343, 10.5228, 0.11041], [17, 0.0275, 10.7319, 0.11079],
  [18, 0.0211, 10.9385, 0.11119], [19, 0.0148, 11.143, 0.11164], [20, 0.0087, 11.3462, 0.11211],
  [21, 0.0029, 11.5486, 0.11261], [22, -0.0028, 11.7504, 0.11314], [23, -0.0083, 11.9514, 0.11369],
  [24, -0.0137, 12.1515, 0.11426],
];
const WEIGHT_GIRLS: readonly LmsRow[] = [
  [0, 0.3809, 3.2322, 0.14171], [1, 0.1714, 4.1873, 0.13724], [2, 0.0962, 5.1282, 0.13],
  [3, 0.0402, 5.8458, 0.12619], [4, -0.005, 6.4237, 0.12402], [5, -0.043, 6.8985, 0.12274],
  [6, -0.0756, 7.297, 0.12204], [7, -0.1039, 7.6422, 0.12178], [8, -0.1288, 7.9487, 0.12181],
  [9, -0.1507, 8.2254, 0.12199], [10, -0.17, 8.48, 0.12223], [11, -0.1872, 8.7192, 0.12247],
  [12, -0.2024, 8.9481, 0.12268], [13, -0.2158, 9.1699, 0.12283], [14, -0.2278, 9.387, 0.12294],
  [15, -0.2384, 9.6008, 0.12299], [16, -0.2478, 9.8124, 0.12303], [17, -0.2562, 10.0226, 0.12306],
  [18, -0.2637, 10.2315, 0.12309], [19, -0.2703, 10.4393, 0.12315], [20, -0.2762, 10.6464, 0.12323],
  [21, -0.2815, 10.8534, 0.12335], [22, -0.2862, 11.0608, 0.1235], [23, -0.2903, 11.2688, 0.12369],
  [24, -0.2941, 11.4775, 0.1239],
];
// Length-for-age (cm, recumbent).
const LENGTH_BOYS: readonly LmsRow[] = [
  [0, 1, 49.8842, 0.03795], [1, 1, 54.7244, 0.03557], [2, 1, 58.4249, 0.03424], [3, 1, 61.4292, 0.03328],
  [4, 1, 63.886, 0.03257], [5, 1, 65.9026, 0.03204], [6, 1, 67.6236, 0.03165], [7, 1, 69.1645, 0.03139],
  [8, 1, 70.5994, 0.03124], [9, 1, 71.9687, 0.03117], [10, 1, 73.2812, 0.03118], [11, 1, 74.5388, 0.03125],
  [12, 1, 75.7488, 0.03137], [13, 1, 76.9186, 0.03154], [14, 1, 78.0497, 0.03174], [15, 1, 79.1458, 0.03197],
  [16, 1, 80.2113, 0.03222], [17, 1, 81.2487, 0.0325], [18, 1, 82.2587, 0.03279], [19, 1, 83.2418, 0.0331],
  [20, 1, 84.1996, 0.03342], [21, 1, 85.1348, 0.03376], [22, 1, 86.0477, 0.0341], [23, 1, 86.941, 0.03445],
  [24, 1, 87.8161, 0.03479],
];
const LENGTH_GIRLS: readonly LmsRow[] = [
  [0, 1, 49.1477, 0.0379], [1, 1, 53.6872, 0.0364], [2, 1, 57.0673, 0.03568], [3, 1, 59.8029, 0.0352],
  [4, 1, 62.0899, 0.03486], [5, 1, 64.0301, 0.03463], [6, 1, 65.7311, 0.03448], [7, 1, 67.2873, 0.03441],
  [8, 1, 68.7498, 0.0344], [9, 1, 70.1435, 0.03444], [10, 1, 71.4818, 0.03452], [11, 1, 72.771, 0.03464],
  [12, 1, 74.015, 0.03479], [13, 1, 75.2176, 0.03496], [14, 1, 76.3817, 0.03514], [15, 1, 77.5099, 0.03534],
  [16, 1, 78.6055, 0.03555], [17, 1, 79.671, 0.03576], [18, 1, 80.7079, 0.03598], [19, 1, 81.7182, 0.0362],
  [20, 1, 82.7036, 0.03643], [21, 1, 83.6654, 0.03666], [22, 1, 84.604, 0.03688], [23, 1, 85.5202, 0.03711],
  [24, 1, 86.4153, 0.03734],
];
// Head circumference-for-age (cm).
const HEAD_BOYS: readonly LmsRow[] = [
  [0, 1, 34.4618, 0.03686], [1, 1, 37.2759, 0.03133], [2, 1, 39.1285, 0.02997], [3, 1, 40.5135, 0.02918],
  [4, 1, 41.6317, 0.02868], [5, 1, 42.5576, 0.02837], [6, 1, 43.3306, 0.02817], [7, 1, 43.9803, 0.02804],
  [8, 1, 44.53, 0.02796], [9, 1, 44.9998, 0.02792], [10, 1, 45.4051, 0.0279], [11, 1, 45.7573, 0.02789],
  [12, 1, 46.0661, 0.02789], [13, 1, 46.3395, 0.02789], [14, 1, 46.5844, 0.02791], [15, 1, 46.806, 0.02792],
  [16, 1, 47.0088, 0.02795], [17, 1, 47.1962, 0.02797], [18, 1, 47.3711, 0.028], [19, 1, 47.5357, 0.02803],
  [20, 1, 47.6919, 0.02806], [21, 1, 47.8408, 0.0281], [22, 1, 47.9833, 0.02813], [23, 1, 48.1201, 0.02817],
  [24, 1, 48.2515, 0.02821],
];
const HEAD_GIRLS: readonly LmsRow[] = [
  [0, 1, 33.8787, 0.03496], [1, 1, 36.5463, 0.0321], [2, 1, 38.2521, 0.03168], [3, 1, 39.5328, 0.0314],
  [4, 1, 40.5817, 0.03119], [5, 1, 41.459, 0.03102], [6, 1, 42.1995, 0.03087], [7, 1, 42.829, 0.03075],
  [8, 1, 43.3671, 0.03063], [9, 1, 43.83, 0.03053], [10, 1, 44.2319, 0.03044], [11, 1, 44.5844, 0.03035],
  [12, 1, 44.8965, 0.03027], [13, 1, 45.1752, 0.03019], [14, 1, 45.4265, 0.03012], [15, 1, 45.6551, 0.03006],
  [16, 1, 45.865, 0.02999], [17, 1, 46.0598, 0.02993], [18, 1, 46.2424, 0.02987], [19, 1, 46.4152, 0.02982],
  [20, 1, 46.5801, 0.02977], [21, 1, 46.7384, 0.02972], [22, 1, 46.8913, 0.02967], [23, 1, 47.0391, 0.02962],
  [24, 1, 47.1822, 0.02957],
];

export const WHO_LMS: Readonly<Record<GrowthMeasure, Readonly<Record<GrowthSex, readonly LmsRow[]>>>> = {
  weight: { m: WEIGHT_BOYS, f: WEIGHT_GIRLS },
  length: { m: LENGTH_BOYS, f: LENGTH_GIRLS },
  head: { m: HEAD_BOYS, f: HEAD_GIRLS },
};

/** The percentile lines WHO draws on its charts, with their z-scores. */
export const WHO_CHART_LINES: readonly { pct: number; z: number }[] = [
  { pct: 3, z: -1.880794 },
  { pct: 15, z: -1.036433 },
  { pct: 50, z: 0 },
  { pct: 85, z: 1.036433 },
  { pct: 97, z: 1.880794 },
];

/** L, M, S at an age in days (linear between monthly rows), or null outside 0–24 months / unknown sex. */
export function lmsAt(measure: GrowthMeasure, sex: GrowthSex | null, ageDays: number): Lms | null {
  if (sex !== 'f' && sex !== 'm') return null;
  const rows = WHO_LMS[measure]?.[sex];
  if (!rows || !Number.isFinite(ageDays) || ageDays < 0) return null;
  const m = ageDays / DAYS_PER_MONTH;
  if (m > 24 + 1e-9) return null;
  const i = Math.min(Math.floor(m), rows.length - 2);
  const t = Math.min(1, m - i);
  const a = rows[i];
  const b = rows[i + 1];
  return { L: a[1] + (b[1] - a[1]) * t, M: a[2] + (b[2] - a[2]) * t, S: a[3] + (b[3] - a[3]) * t };
}

/** The measurement at z for given LMS (the inverse of the LMS transform, no restriction). */
function lmsValue({ L, M, S }: Lms, z: number): number {
  return Math.abs(L) < 1e-9 ? M * Math.exp(S * z) : M * Math.pow(1 + L * S * z, 1 / L);
}

/** Raw LMS z-score of a measurement. */
function lmsZ({ L, M, S }: Lms, x: number): number {
  return Math.abs(L) < 1e-9 ? Math.log(x / M) / S : (Math.pow(x / M, L) - 1) / (L * S);
}

/**
 * WHO z-score for a measurement: weight in kg, length / head circumference in
 * cm. Null outside 0–24 months, without a sex, or for a non-positive value.
 * For weight, values beyond ±3 SD use WHO's restricted (linear) extension.
 */
export function zScore(measure: GrowthMeasure, sex: GrowthSex | null, ageDays: number, value: number): number | null {
  const lms = lmsAt(measure, sex, ageDays);
  if (!lms || !Number.isFinite(value) || value <= 0) return null;
  const z = lmsZ(lms, value);
  if (measure !== 'weight' || Math.abs(z) <= 3) return z;
  if (z > 3) {
    const sd3 = lmsValue(lms, 3);
    const sd23 = sd3 - lmsValue(lms, 2);
    return 3 + (value - sd3) / sd23;
  }
  const sd3 = lmsValue(lms, -3);
  const sd23 = lmsValue(lms, -2) - sd3;
  return -3 + (value - sd3) / sd23;
}

/** The measurement at a z-score (e.g. to draw percentile curves); weight honours the ±3 SD restriction. */
export function valueAtZ(measure: GrowthMeasure, sex: GrowthSex | null, ageDays: number, z: number): number | null {
  const lms = lmsAt(measure, sex, ageDays);
  if (!lms || !Number.isFinite(z)) return null;
  if (measure === 'weight' && z > 3) {
    const sd3 = lmsValue(lms, 3);
    return sd3 + (z - 3) * (sd3 - lmsValue(lms, 2));
  }
  if (measure === 'weight' && z < -3) {
    const sd3 = lmsValue(lms, -3);
    return sd3 + (z + 3) * (lmsValue(lms, -2) - sd3);
  }
  return lmsValue(lms, z);
}

/**
 * Standard normal CDF Φ(z), double-precision accurate (Hart 1968, algorithm
 * 5666, as given by G. West, "Better approximations to cumulative normal
 * functions", Wilmott Magazine 2005).
 */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return NaN;
  const x = Math.abs(z);
  let c: number;
  if (x > 37) {
    c = 0;
  } else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let n = 3.52624965998911e-2 * x + 0.700383064443688;
      n = n * x + 6.37396220353165;
      n = n * x + 33.912866078383;
      n = n * x + 112.079291497871;
      n = n * x + 221.213596169931;
      n = n * x + 220.206867912376;
      let d = 8.83883476483184e-2 * x + 1.75566716318264;
      d = d * x + 16.064177579207;
      d = d * x + 86.7807322029461;
      d = d * x + 296.564248779674;
      d = d * x + 637.333633378831;
      d = d * x + 793.826512519948;
      d = d * x + 440.413735824752;
      c = (e * n) / d;
    } else {
      let b = x + 0.65;
      b = x + 4 / b;
      b = x + 3 / b;
      b = x + 2 / b;
      b = x + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return z > 0 ? 1 - c : c;
}

/** Percentile (0–100) for a z-score. */
export function percentile(z: number): number {
  return 100 * normalCdf(z);
}

/** "1st", "2nd", "3rd", "11th", "62nd"… */
export function ordinal(n: number): string {
  const v = Math.abs(Math.trunc(n));
  const teen = v % 100;
  const suffix = teen >= 11 && teen <= 13 ? 'th' : v % 10 === 1 ? 'st' : v % 10 === 2 ? 'nd' : v % 10 === 3 ? 'rd' : 'th';
  return `${Math.trunc(n)}${suffix}`;
}

/** "62nd percentile"; extremes read "below the 1st percentile" / "above the 99th percentile". */
export function percentileLabel(pct: number): string {
  if (pct < 1) return 'below the 1st percentile';
  if (pct > 99) return 'above the 99th percentile';
  return `${ordinal(Math.min(99, Math.max(1, Math.round(pct))))} percentile`;
}

/** z-score, percentile and a friendly label for one measurement, or null when it can't be placed. */
export function growthPoint(measure: GrowthMeasure, sex: GrowthSex | null, ageDays: number, value: number): GrowthPoint | null {
  const z = zScore(measure, sex, ageDays, value);
  if (z === null || !Number.isFinite(z)) return null;
  const pct = percentile(z);
  return { z, pct, label: percentileLabel(pct) };
}
