// House comics contract (daily comics spec, package DC-H1). One pure source (shared modules only, no I/O) for the daily
// run the platform makes on its own account: the compiled spending ceilings, the payers, the statuses the SQL mirrors,
// the daily slate planner, the calibration set, the content check, the runway maths and the console's config sanitizer.
//
// Nothing here fetches, times, logs or spends, and nothing calls it yet. The server (house runner, billing, routes) and
// the admin console will import it; the SQL (server/sql/house_comics.sql) mirrors the lists and ceilings, and a parity
// test on the server side keeps them equal.
//
// Money rules this file encodes (the owner's authorisation for house comics): at most $7 per comic, a hard ceiling,
// and at most 10 comics a day. The console can only lower these; the defaults are lower still.

import type { AspectRatio, ColorMode, ComicKind, Gate, Resolution } from './doc.js';
import { hashString } from './hash.js';
import { HOUSE_CALL_KIND_PREFIX, LIBRARY_IP_BLOCKLIST } from './library.js';
import type { HealthState } from './modelHealth.js';
import { IMAGE_MODELS, getImageModel, nearestAspect, nearestResolution, type ImageModelSpec } from './models.js';
import type { ContentRating } from './safety.js';
import { STYLE_PRESETS, type StylePreset } from './stylePresets.js';

const freezeDeep = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) freezeDeep(v);
    Object.freeze(value);
  }
  return value;
};

// ── Ceilings ─────────────────────────────────────────────────────────────────────────────────

/**
 * Compiled ceilings. The SQL repeats the money and count ceilings as CHECKs; the console can only lower the config
 * below them (sanitizeHouseConfigPatch refuses anything above).
 */
export const HOUSE_LIMITS = Object.freeze({
  /** The owner's hard cap per comic (USD, provider cost). */
  capComicMaxUsd: 7,
  /** The owner's cap on comics per day. */
  dailyCountMax: 10,
  /** capComicMaxUsd × dailyCountMax. */
  capDayMaxUsd: 70,
  /** Images one step may draw at once. */
  imageSlotsMax: 2,
  /** A hold left pending (a restart mid-call) expires after this and is counted as spent. */
  holdTtlMs: 15 * 60_000,
  /** Attempts per stage of one comic. */
  stageAttemptsMax: 2,
  /** Wall-clock time one comic may take. */
  comicWallMs: 45 * 60_000,
  /** Wall-clock time one run may take. */
  runWallMs: 5 * 3_600_000,
  /** Redraws per comic after a low page check. */
  redrawsMax: 2,
  /** Releases to the public Library per run day. */
  releasePerDayMax: 10,
  /** The finishing reserve (lettering and the gate after the drawing stops) is carved from the comic cap. */
  finishReserveMaxUsd: 2,
  /** A credit is never planned past this share of what the owner entered (the ledger is an estimate). */
  stopFractionMax: 0.95,
  /** The largest credit amount the console accepts per payer. */
  creditMaxUsd: 5_000,
  /** The owner's model weights run from 0 (never) to this. */
  modelWeightMax: 10,
  /** Editions per day beyond the English edition every non-English source gets. */
  extraEditionsMax: 2,
  /** Time budget of one step (one HTTP call). */
  stepBudgetMs: 6 * 60_000,
  /** The run lease a step holds. */
  leaseMs: 9 * 60_000
} as const);

// ── Lists the SQL mirrors ────────────────────────────────────────────────────────────────────

export type HouseMode = 'off' | 'rehearsal' | 'calibration' | 'daily';
export const HOUSE_MODES: readonly HouseMode[] = Object.freeze(['off', 'rehearsal', 'calibration', 'daily'] as HouseMode[]);

/**
 * Who pays a call. `platform` (the safety checks on DreamStream's own key) is recorded for information only and never
 * capped by house code.
 */
export type HousePayer = 'openai_credit' | 'anthropic_credit' | 'house_openrouter' | 'platform';
export const HOUSE_PAYERS: readonly HousePayer[] = Object.freeze(['openai_credit', 'anthropic_credit', 'house_openrouter', 'platform'] as HousePayer[]);
export type HouseCappedPayer = Exclude<HousePayer, 'platform'>;
export const HOUSE_CAPPED_PAYERS: readonly HouseCappedPayer[] = Object.freeze(['openai_credit', 'anthropic_credit', 'house_openrouter'] as HouseCappedPayer[]);

/** Vendors whose keys sit in the house OpenRouter account's BYOK settings (env HOUSE_BYOK_VENDORS, set after M8). */
export type HouseByokVendor = 'openai' | 'anthropic';
export const HOUSE_BYOK_VENDORS: readonly HouseByokVendor[] = Object.freeze(['openai', 'anthropic'] as HouseByokVendor[]);

/** house_comics.status. */
export type HouseStatus = 'queued' | 'running' | 'held' | 'ready' | 'released' | 'skipped' | 'discarded' | 'purged';
export const HOUSE_STATUSES: readonly HouseStatus[] = Object.freeze(['queued', 'running', 'held', 'ready', 'released', 'skipped', 'discarded', 'purged'] as HouseStatus[]);

/** house_comics.stage: S0 slate … S10 done. */
export type HouseStage = 'slate' | 'brief' | 'create' | 'plan' | 'sheets' | 'pages' | 'cover' | 'letter' | 'editions' | 'publish' | 'done';
export const HOUSE_STAGES: readonly HouseStage[] = Object.freeze(['slate', 'brief', 'create', 'plan', 'sheets', 'pages', 'cover', 'letter', 'editions', 'publish', 'done'] as HouseStage[]);

/** house_runs.status. */
export type HouseRunStatus = 'running' | 'done' | 'stopped';
export const HOUSE_RUN_STATUSES: readonly HouseRunStatus[] = Object.freeze(['running', 'done', 'stopped'] as HouseRunStatus[]);
/** house_runs.started_by. */
export type HouseRunStarter = 'schedule' | 'dispatch' | 'admin';
export const HOUSE_RUN_STARTERS: readonly HouseRunStarter[] = Object.freeze(['schedule', 'dispatch', 'admin'] as HouseRunStarter[]);
/** house_spend.status. Expired holds are counted as spent, never released. */
export type HouseSpendStatus = 'pending' | 'settled' | 'released' | 'expired';
export const HOUSE_SPEND_STATUSES: readonly HouseSpendStatus[] = Object.freeze(['pending', 'settled', 'released', 'expired'] as HouseSpendStatus[]);
/** house_comics.judgement: the owner's verdict against the quality bar. */
export type HouseJudgement = 'bar' | 'close' | 'no';
export const HOUSE_JUDGEMENTS: readonly HouseJudgement[] = Object.freeze(['bar', 'close', 'no'] as HouseJudgement[]);

type GateHeldReason = `gate_${Gate['reason']}`;
/** Why a comic was held (house_comics.held_reason). A gate card an action still posts holds it as gate_<reason>. */
export type HeldReason =
  | 'brief_rejected'
  | 'topic_blocked'
  | 'incomplete'
  | 'overfull'
  | 'low_quality'
  | 'gate_blocked'
  | 'rating_above_slate'
  | 'payer_cap'
  | 'timeout'
  | 'switched_off'
  | 'pipeline_mismatch'
  | 'model_paused'
  | 'error'
  | GateHeldReason;

const GATE_HELD: Readonly<Record<Gate['reason'], GateHeldReason>> = Object.freeze({
  policy: 'gate_policy',
  budget: 'gate_budget',
  first_render: 'gate_first_render',
  plan_review: 'gate_plan_review',
  redraw: 'gate_redraw',
  no_intent: 'gate_no_intent'
});
export const HOUSE_HELD_REASONS: readonly HeldReason[] = Object.freeze([
  'brief_rejected',
  'topic_blocked',
  'incomplete',
  'overfull',
  'low_quality',
  'gate_blocked',
  'rating_above_slate',
  'payer_cap',
  'timeout',
  'switched_off',
  'pipeline_mismatch',
  'model_paused',
  'error',
  ...Object.values(GATE_HELD)
] as HeldReason[]);
/** The held reason for a gate card an action posted during a house run. */
export const heldReasonForGate = (reason: Gate['reason']): HeldReason => GATE_HELD[reason] ?? 'gate_blocked';
export const isHeldReason = (v: unknown): v is HeldReason => typeof v === 'string' && (HOUSE_HELD_REASONS as readonly string[]).includes(v);

/** The comic_image_calls kind a house call is recorded under (kept out of users' model statistics). */
export const houseCallKind = (kind: string): string => `${HOUSE_CALL_KIND_PREFIX}${kind}`;

// ── Days (UTC calendar days, YYYY-MM-DD; the run day, never "now") ───────────────────────────

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
export const isHouseDay = (v: unknown): v is string => {
  if (typeof v !== 'string') return false;
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
/** The day `n` days after `day` (negative goes back). */
export const addHouseDays = (day: string, n: number): string => new Date(dayMs(day) + n * DAY_MS).toISOString().slice(0, 10);
/** Whole days from `from` to `to` (positive when `to` is later). */
export const houseDaysBetween = (from: string, to: string): number => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);

// ── Config ───────────────────────────────────────────────────────────────────────────────────

export interface HousePayerConfig {
  /** The payer's day budget before any runway spreading (USD). */
  dayCapUsd: number;
  /**
   * The credit the owner entered (USD). null = no credit stop, allowed only on the house OpenRouter key (it has its own
   * daily limit); the OpenAI and Anthropic credits always carry an amount (houseCreditOptional).
   */
  creditUsd: number | null;
  /** Spending stops at creditUsd × stopFraction. */
  stopFraction: number;
  /** Spread what is left of the credit evenly until this day (inclusive); null = no runway date. */
  runwayUntil: string | null;
  /** The day the credit expires (usable that day, not after); null = unknown. */
  expiresOn: string | null;
}

/** The house_config row (single row), camel-cased. */
export interface HouseConfig {
  enabled: boolean;
  mode: HouseMode;
  dailyCount: number;
  capComicUsd: number;
  finishReserveUsd: number;
  capDayUsd: number;
  imageSlots: number;
  allow4k: boolean;
  releasePerDay: number;
  /** Registry model id → weight 0..modelWeightMax (absent = 1). 0 removes a model from the slate. */
  modelWeights: Readonly<Record<string, number>>;
  payers: Readonly<Record<HouseCappedPayer, Readonly<HousePayerConfig>>>;
}

/** Switched off, in mode 'off', with the spec's lower day and payer caps (owner questions 2 and 4). */
export const HOUSE_CONFIG_DEFAULTS: HouseConfig = freezeDeep<HouseConfig>({
  enabled: false,
  mode: 'off',
  dailyCount: 3,
  capComicUsd: 7,
  finishReserveUsd: 0.4,
  capDayUsd: 30,
  imageSlots: 2,
  allow4k: false,
  releasePerDay: 2,
  modelWeights: {},
  payers: {
    openai_credit: { dayCapUsd: 12, creditUsd: 200, stopFraction: 0.9, runwayUntil: null, expiresOn: null },
    anthropic_credit: { dayCapUsd: 5, creditUsd: 200, stopFraction: 0.9, runwayUntil: null, expiresOn: null },
    house_openrouter: { dayCapUsd: 10, creditUsd: null, stopFraction: 0.9, runwayUntil: null, expiresOn: null }
  }
});

export type HousePayerPatch = Partial<HousePayerConfig>;
export interface HouseConfigPatch {
  enabled?: boolean;
  mode?: HouseMode;
  dailyCount?: number;
  capComicUsd?: number;
  finishReserveUsd?: number;
  capDayUsd?: number;
  imageSlots?: number;
  allow4k?: boolean;
  releasePerDay?: number;
  modelWeights?: Record<string, number>;
  payers?: Partial<Record<HouseCappedPayer, HousePayerPatch>>;
}
export interface HouseConfigError {
  field: string;
  reason: string;
}
/** Both arms name every field, so non-strict callers (the client build) can read `errors` without narrowing. */
export type HouseConfigPatchResult =
  | { ok: true; patch: HouseConfigPatch; config: HouseConfig; errors?: undefined }
  | { ok: false; errors: HouseConfigError[]; patch?: undefined; config?: undefined };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);

type Check = (v: unknown, field: string, errors: HouseConfigError[]) => boolean;
const boolCheck: Check = (v, field, errors) => (typeof v === 'boolean' ? true : (errors.push({ field, reason: 'must be true or false' }), false));
const intCheck = (min: number, max: number): Check => (v, field, errors) =>
  isInt(v) && v >= min && v <= max ? true : (errors.push({ field, reason: isNum(v) && v > max ? `above the ceiling of ${max}` : `must be a whole number from ${min} to ${max}` }), false);
/** A positive amount (or ≥ 0 when `zeroOk`) no higher than `max`. */
const usdCheck = (max: number, zeroOk = false): Check => (v, field, errors) => {
  if (!isNum(v)) return errors.push({ field, reason: 'must be a number' }), false;
  if (v > max) return errors.push({ field, reason: `above the ceiling of ${max}` }), false;
  if (zeroOk ? v < 0 : v <= 0) return errors.push({ field, reason: zeroOk ? 'cannot be negative' : 'must be above 0' }), false;
  return true;
};
const dayOrNullCheck: Check = (v, field, errors) => (v === null || isHouseDay(v) ? true : (errors.push({ field, reason: 'must be a date (YYYY-MM-DD) or empty' }), false));

/** Every image model a house slate may use, per family and tier (the registry's `pickable` still decides). */
export type HouseImageFamily = 'gemini' | 'openai';
export type HouseTier = 'standard' | 'pro';
export const HOUSE_FAMILY_MODELS: Readonly<Record<HouseImageFamily, Readonly<Record<HouseTier, readonly string[]>>>> = freezeDeep({
  gemini: { standard: ['nano-banana-2.1'], pro: ['nano-banana-pro'] },
  openai: { standard: ['gpt-image-2.6-sunburst', 'gpt-image-2.6-flare'], pro: ['gpt-image-2.5', 'gpt-image-2.5-flare'] }
});
const HOUSE_MODEL_IDS: ReadonlySet<string> = new Set(
  (Object.values(HOUSE_FAMILY_MODELS) as Readonly<Record<HouseTier, readonly string[]>>[]).flatMap((t) => [...t.standard, ...t.pro])
);

/**
 * Payers whose credit may be left empty (no credit stop): only the house OpenRouter key, which has its own daily limit.
 * The owner's OpenAI and Anthropic credits always carry an amount, so their 90% stop can never be switched off.
 */
const CREDIT_OPTIONAL_PAYERS: ReadonlySet<HouseCappedPayer> = new Set<HouseCappedPayer>(['house_openrouter']);
/** True when a payer's credit may be null (no credit stop). */
export const houseCreditOptional = (payer: HouseCappedPayer): boolean => CREDIT_OPTIONAL_PAYERS.has(payer);

/** Field lookups that only see a map's own keys (a body key such as `toString` or `__proto__` is unknown). */
const ownCheck = (fields: Readonly<Record<string, Check>>, key: string): Check | undefined =>
  Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;

const PAYER_FIELDS: Readonly<Record<keyof HousePayerConfig, Check>> = {
  dayCapUsd: usdCheck(HOUSE_LIMITS.capDayMaxUsd, true),
  // Null is accepted here only for a credit-optional payer; the payer loop refuses it for the others.
  creditUsd: (v, field, errors) => (v === null ? true : usdCheck(HOUSE_LIMITS.creditMaxUsd)(v, field, errors)),
  stopFraction: (v, field, errors) => {
    if (!isNum(v) || v <= 0) return errors.push({ field, reason: 'must be a share above 0' }), false;
    if (v > HOUSE_LIMITS.stopFractionMax) return errors.push({ field, reason: `above the ceiling of ${HOUSE_LIMITS.stopFractionMax}` }), false;
    return true;
  },
  runwayUntil: dayOrNullCheck,
  expiresOn: dayOrNullCheck
};

const TOP_FIELDS: Readonly<Record<Exclude<keyof HouseConfigPatch, 'modelWeights' | 'payers'>, Check>> = {
  enabled: boolCheck,
  mode: (v, field, errors) => ((HOUSE_MODES as readonly unknown[]).includes(v) ? true : (errors.push({ field, reason: `must be one of ${HOUSE_MODES.join(', ')}` }), false)),
  dailyCount: intCheck(1, HOUSE_LIMITS.dailyCountMax),
  capComicUsd: usdCheck(HOUSE_LIMITS.capComicMaxUsd),
  finishReserveUsd: usdCheck(HOUSE_LIMITS.finishReserveMaxUsd, true),
  capDayUsd: usdCheck(HOUSE_LIMITS.capDayMaxUsd),
  imageSlots: intCheck(1, HOUSE_LIMITS.imageSlotsMax),
  allow4k: boolCheck,
  releasePerDay: intCheck(0, HOUSE_LIMITS.releasePerDayMax)
};

/**
 * The console's PATCH /config body, checked against HOUSE_LIMITS. Values above a ceiling, unknown fields, the
 * `platform` payer and wrong types are refused (never silently clamped), so the owner sees exactly what was not
 * saved. Returns the accepted patch and the merged config; `current` is never mutated.
 */
export function sanitizeHouseConfigPatch(raw: unknown, current: HouseConfig = HOUSE_CONFIG_DEFAULTS): HouseConfigPatchResult {
  if (!isPlainObject(raw)) return { ok: false, errors: [{ field: 'patch', reason: 'must be an object' }] };
  const errors: HouseConfigError[] = [];
  const patch: HouseConfigPatch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'modelWeights') {
      if (!isPlainObject(value)) {
        errors.push({ field: key, reason: 'must be an object of model weights' });
        continue;
      }
      const weights: Record<string, number> = {};
      for (const [id, w] of Object.entries(value)) {
        const field = `modelWeights.${id}`;
        if (!HOUSE_MODEL_IDS.has(id)) errors.push({ field, reason: 'not a house image model' });
        else if (!isNum(w) || w < 0) errors.push({ field, reason: 'must be a weight of 0 or more' });
        else if (w > HOUSE_LIMITS.modelWeightMax) errors.push({ field, reason: `above the ceiling of ${HOUSE_LIMITS.modelWeightMax}` });
        else weights[id] = w;
      }
      patch.modelWeights = weights;
      continue;
    }
    if (key === 'payers') {
      if (!isPlainObject(value)) {
        errors.push({ field: key, reason: 'must be an object of payers' });
        continue;
      }
      const payers: Partial<Record<HouseCappedPayer, HousePayerPatch>> = {};
      for (const [payer, p] of Object.entries(value)) {
        const base = `payers.${payer}`;
        if (!(HOUSE_CAPPED_PAYERS as readonly string[]).includes(payer)) {
          errors.push({ field: base, reason: payer === 'platform' ? 'the platform payer is never capped here' : 'not a house payer' });
          continue;
        }
        if (!isPlainObject(p)) {
          errors.push({ field: base, reason: 'must be an object' });
          continue;
        }
        const out: HousePayerPatch = {};
        for (const [f, v] of Object.entries(p)) {
          const check = ownCheck(PAYER_FIELDS, f);
          if (!check) errors.push({ field: `${base}.${f}`, reason: 'unknown field' });
          else if (f === 'creditUsd' && v === null && !houseCreditOptional(payer as HouseCappedPayer)) {
            errors.push({ field: `${base}.${f}`, reason: 'a credit amount is required' });
          } else if (check(v, `${base}.${f}`, errors)) (out as Record<string, unknown>)[f] = v;
        }
        payers[payer as HouseCappedPayer] = out;
      }
      patch.payers = payers;
      continue;
    }
    const check = ownCheck(TOP_FIELDS, key);
    if (!check) errors.push({ field: key, reason: 'unknown field' });
    else if (check(value, key, errors)) (patch as Record<string, unknown>)[key] = value;
  }
  if (errors.length) return { ok: false, errors };
  const config = mergeConfig(current, patch);
  if (config.finishReserveUsd >= config.capComicUsd) {
    return { ok: false, errors: [{ field: 'finishReserveUsd', reason: 'must stay below the comic cap' }] };
  }
  return { ok: true, patch, config };
}

const mergeConfig = (current: HouseConfig, patch: HouseConfigPatch): HouseConfig => {
  const { modelWeights, payers, ...top } = patch;
  const mergedPayers = {} as Record<HouseCappedPayer, HousePayerConfig>;
  for (const p of HOUSE_CAPPED_PAYERS) mergedPayers[p] = { ...current.payers[p], ...(payers?.[p] ?? {}) };
  return { ...current, ...top, modelWeights: { ...current.modelWeights, ...(modelWeights ?? {}) }, payers: mergedPayers };
};

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => (isNum(v) ? Math.min(max, Math.max(min, v)) : fallback);
const clampInt = (v: unknown, min: number, max: number, fallback: number): number => (isNum(v) ? Math.min(max, Math.max(min, Math.floor(v))) : fallback);

/**
 * A stored config read back (the house_config row, camel-cased): every value clamped into HOUSE_LIMITS, unknown or
 * broken values replaced by the defaults. Fails closed: the run is on only for a literal `enabled: true`.
 */
export function normalizeHouseConfig(raw: unknown): HouseConfig {
  if (!isPlainObject(raw)) return HOUSE_CONFIG_DEFAULTS;
  const d = HOUSE_CONFIG_DEFAULTS;
  const capComicUsd = clampNum(raw.capComicUsd, 0, HOUSE_LIMITS.capComicMaxUsd, d.capComicUsd);
  const weights: Record<string, number> = {};
  if (isPlainObject(raw.modelWeights)) {
    for (const [id, w] of Object.entries(raw.modelWeights)) if (HOUSE_MODEL_IDS.has(id) && isNum(w)) weights[id] = Math.min(HOUSE_LIMITS.modelWeightMax, Math.max(0, w));
  }
  const rawPayers = isPlainObject(raw.payers) ? raw.payers : {};
  const payers = {} as Record<HouseCappedPayer, HousePayerConfig>;
  for (const p of HOUSE_CAPPED_PAYERS) {
    const r = isPlainObject(rawPayers[p]) ? (rawPayers[p] as Record<string, unknown>) : {};
    const def = d.payers[p];
    // A negative amount reads as 0 (no room). On the house OpenRouter key null = no credit stop and a missing or broken
    // amount falls back to the default; on the owner's credits a null, missing or broken amount reads as 0 (no room),
    // never as no stop.
    const creditUsd = isNum(r.creditUsd)
      ? Math.min(HOUSE_LIMITS.creditMaxUsd, Math.max(0, r.creditUsd))
      : !houseCreditOptional(p)
        ? 0
        : r.creditUsd === null
          ? null
          : def.creditUsd;
    payers[p] = {
      dayCapUsd: clampNum(r.dayCapUsd, 0, HOUSE_LIMITS.capDayMaxUsd, def.dayCapUsd),
      creditUsd,
      stopFraction: clampNum(r.stopFraction, 0, HOUSE_LIMITS.stopFractionMax, def.stopFraction),
      runwayUntil: isHouseDay(r.runwayUntil) ? r.runwayUntil : null,
      expiresOn: isHouseDay(r.expiresOn) ? r.expiresOn : null
    };
  }
  return {
    enabled: raw.enabled === true,
    mode: (HOUSE_MODES as readonly unknown[]).includes(raw.mode) ? (raw.mode as HouseMode) : 'off',
    dailyCount: clampInt(raw.dailyCount, 0, HOUSE_LIMITS.dailyCountMax, d.dailyCount),
    capComicUsd,
    finishReserveUsd: Math.min(clampNum(raw.finishReserveUsd, 0, HOUSE_LIMITS.finishReserveMaxUsd, d.finishReserveUsd), capComicUsd),
    capDayUsd: clampNum(raw.capDayUsd, 0, HOUSE_LIMITS.capDayMaxUsd, d.capDayUsd),
    imageSlots: clampInt(raw.imageSlots, 1, HOUSE_LIMITS.imageSlotsMax, d.imageSlots),
    allow4k: raw.allow4k === true,
    releasePerDay: clampInt(raw.releasePerDay, 0, HOUSE_LIMITS.releasePerDayMax, d.releasePerDay),
    modelWeights: weights,
    payers
  };
}

// ── Payers and runway ────────────────────────────────────────────────────────────────────────

/** 'openai,anthropic' → ['openai', 'anthropic'] (unknown names dropped; empty or unset = nobody on BYOK). */
export const parseHouseByokVendors = (raw: string | null | undefined): HouseByokVendor[] => {
  const out: HouseByokVendor[] = [];
  for (const part of String(raw ?? '').split(/[\s,]+/)) {
    const v = part.trim().toLowerCase();
    if ((HOUSE_BYOK_VENDORS as readonly string[]).includes(v) && !out.includes(v as HouseByokVendor)) out.push(v as HouseByokVendor);
  }
  return out;
};

const vendorOfModel = (model: string | null | undefined): string | undefined => {
  if (typeof model !== 'string') return undefined;
  const m = model.trim().toLowerCase().replace(/^~/, '');
  if (!m) return undefined;
  const slash = m.indexOf('/');
  if (slash > 0) return m.slice(0, slash);
  return getImageModel(m)?.vendor;
};

/**
 * Who pays a call on the house OpenRouter key, by the model that served it (or was asked for): `openai/*` books to the
 * owner's OpenAI credit and `anthropic/*` to the Anthropic credit only when that vendor is on BYOK; everything else,
 * and every call before BYOK is confirmed (M8), books to the house OpenRouter balance (the conservative choice).
 */
export function payerOfModel(model: string | null | undefined, byokVendors: readonly HouseByokVendor[] = []): HouseCappedPayer {
  const vendor = vendorOfModel(model);
  if (vendor === 'openai' && byokVendors.includes('openai')) return 'openai_credit';
  if (vendor === 'anthropic' && byokVendors.includes('anthropic')) return 'anthropic_credit';
  return 'house_openrouter';
}

const floorCents4 = (usd: number): number => Math.floor(usd * 10_000 + 1e-6) / 10_000;

/**
 * A payer's budget for one run day (USD): its day cap, never past its credit stop (credit × stop − lifetime spend),
 * and, with a runway date, the room left spread evenly over the days left (today included). A runway past the credit's
 * expiry ends at the expiry; after the expiry day the budget is 0. The day cap is never read above
 * HOUSE_LIMITS.capDayMaxUsd, even from a config that skipped normalizeHouseConfig. Any bad input gives 0 (fail closed).
 */
export function dayBudgetUsd(payer: Readonly<HousePayerConfig>, at: { day: string; lifetimeUsd: number }): number {
  if (!isHouseDay(at.day) || !isNum(payer.dayCapUsd) || payer.dayCapUsd <= 0 || !isNum(at.lifetimeUsd)) return 0;
  if (isHouseDay(payer.expiresOn) && at.day > payer.expiresOn) return 0;
  const cap = Math.min(payer.dayCapUsd, HOUSE_LIMITS.capDayMaxUsd);
  if (payer.creditUsd === null) return floorCents4(cap);
  if (!isNum(payer.creditUsd) || !isNum(payer.stopFraction)) return 0;
  const room = payer.creditUsd * Math.min(payer.stopFraction, HOUSE_LIMITS.stopFractionMax) - Math.max(0, at.lifetimeUsd);
  if (!(room > 0)) return 0;
  let budget = Math.min(cap, room);
  if (isHouseDay(payer.runwayUntil)) {
    const end = isHouseDay(payer.expiresOn) && payer.expiresOn < payer.runwayUntil ? payer.expiresOn : payer.runwayUntil;
    const daysLeft = Math.max(1, houseDaysBetween(at.day, end) + 1);
    budget = Math.min(budget, room / daysLeft);
  }
  return floorCents4(budget);
}

/**
 * True when a payer's credit is at its stop: the lifetime spend has reached credit × stopFraction (owner question 5:
 * that half stops, its slots are not moved). A payer without a credit (null, the house OpenRouter key) never stops
 * here; a broken credit, share or spend reads as stopped (fail closed).
 */
export function houseCreditStopped(payer: Readonly<HousePayerConfig>, at: { lifetimeUsd: number }): boolean {
  if (payer.creditUsd === null) return false;
  if (!isNum(payer.creditUsd) || !isNum(payer.stopFraction) || !isNum(at.lifetimeUsd)) return true;
  const stopAt = payer.creditUsd * Math.min(Math.max(0, payer.stopFraction), HOUSE_LIMITS.stopFractionMax);
  return Math.max(0, at.lifetimeUsd) >= stopAt;
}

// ── Content rules ────────────────────────────────────────────────────────────────────────────

/** The rules the brief prompt states (the first of the two checks; checkHouseText is the second). */
export const HOUSE_CONTENT_RULES: readonly string[] = Object.freeze([
  'Original stories, casts and worlds only.',
  'No religious texts, deities, prophets or other religious figures.',
  'No real people, living or historical, and no real historical events.',
  'No politics: no parties, elections, leaders or campaigns.',
  'No brands, products or logos, and no existing characters from books, films, games or comics.',
  'Nothing above the slate\'s rating, and never above PG-13.'
]);

export type HouseBlockedTopic = 'religion' | 'real_person' | 'real_event' | 'politics' | 'brand' | 'existing_character';
export interface HouseTopicRule {
  topic: HouseBlockedTopic;
  re: RegExp;
}

/** Letters or marks around a word in any script (JS \b only knows ASCII). */
const W_BEFORE = '(?<![\\p{L}\\p{M}\\p{N}])';
const W_AFTER = '(?![\\p{L}\\p{M}\\p{N}])';
const words = (alternatives: string, flags = 'iu'): RegExp => new RegExp(`${W_BEFORE}(?:${alternatives})${W_AFTER}`, flags);

/**
 * Topics a house comic never touches (the owner's content rules), checked on the normalised text of every brief and
 * plan. Kept narrow on purpose: a hit holds the comic `topic_blocked` with one retry, so a false hit costs one brief.
 */
export const HOUSE_TOPIC_BLOCKLIST: readonly HouseTopicRule[] = Object.freeze([
  // Religious texts (English, Spanish, Portuguese, French spellings after accents are stripped).
  {
    topic: 'religion',
    re: words("ramayana?|ramayan|mahabharata?|bhagavad[ -]?gita|rig ?veda|vedas|upanishads?|puranas|bible|biblical|biblia|quran|qur'?an|koran|coran|alcoran|torah|talmud|guru granth sahib|tripitaka|new testament|old testament")
  },
  // Deities, prophets and religious figures. Rama, Sita and Kali are also everyday words and names ("la rama" is a
  // branch in Spanish and Portuguese, Kali a pet's name), so on their own they pass: Rama with Sita, a title before
  // the name, or the epic's other figures hold the text.
  {
    topic: 'religion',
    re: words(
      'lord (?:rama?|krishna|shiva|vishnu|ganesha?|hanuman|brahma|buddha)|(?:sri|shri|shree) (?:rama?|krishna)|jai shri ram|goddess kali|maa? kali|kali (?:maa?|mata)|rama(?=[\\s\\S]*' + W_BEFORE + 'sita' + W_AFTER + ')|sita(?=[\\s\\S]*' + W_BEFORE + 'rama?' + W_AFTER + ')|ravana|lakshmana|krishna|arjuna|shiva|vishnu|ganesha|ganesh|hanuman|durga|lakshmi|parvati|saraswati|brahma|jesus|jesucristo|christ|cristo|virgin mary|virgen maria|virgem maria|vierge marie|moses|prophet muhammad|muhammad|mohammed|mahoma|mahomet|maome|allah|the prophet|el profeta|o profeta|le prophete|buddha|buda|guru nanak|mahavira|yahweh|jehovah|holy spirit|pope|dalai lama'
    )
  },
  // The same in Devanagari (Hindi sources).
  { topic: 'religion', re: words('रामायण|महाभारत|भगवद्गीता|कुरान|बाइबिल|बाइबल|श्रीराम|राम|सीता|रावण|कृष्ण|शिव|विष्णु|हनुमान|गणेश|दुर्गा|ब्रह्मा|अल्लाह|यीशु|ईसा मसीह|बुद्ध|पैगंबर') },
  // Japanese (no spaces between words: plain substrings). Bare イエス is also the everyday word for "yes".
  { topic: 'religion', re: /聖書|コーラン|キリスト|イエス様|イエス・|仏陀|ブッダ|釈迦|預言者|ムハンマド|アッラー/u },
  // Real people: a political or religious title before a capitalised name (invented or not), and true-life framings.
  // English, Spanish, Portuguese and French (accents stripped).
  {
    topic: 'real_person',
    re: /(?<!(?:[Cc]lass|[Cc]lub|[Cc]ouncil|[Tt]eam|[Ss]tudent|[Ss]chool) )\b(?:[Pp]resident[ea]?|[Pp]rime [Mm]inister|[Cc]hief [Mm]inister|[Vv]ice [Pp]resident|[Ss]enator|[Ss]enador(?:a)?|[Ss]enateur|[Gg]overnor|[Gg]obernador(?:a)?|[Gg]overnador(?:a)?|[Gg]ouverneur|[Cc]hancellor|[Mm]inister|[Cc]ongress(?:man|woman)|[Aa]yatollah|[Pp]rimer [Mm]inistro|[Pp]rimera [Mm]inistra|[Pp]rimeiro[- ][Mm]inistro|[Pp]rimeira[- ][Mm]inistra|[Pp]remier [Mm]inistre)\s+[A-Z][\p{L}'’-]+/u
  },
  // Hindi titles of office (Devanagari has no capitals, so the title alone holds the text).
  { topic: 'real_person', re: words('प्रधानमंत्री|प्रधान मंत्री|मुख्यमंत्री|मुख्य मंत्री|राष्ट्रपति') },
  { topic: 'real_person', re: /大統領|首相|総理大臣/u },
  {
    topic: 'real_person',
    re: words('based on the (?:true |real )?(?:life|story) of|biopic|biography of|real[- ]life (?:person|people|figure|hero)|famous (?:actor|actress|singer|cricketer|footballer|politician|scientist|celebrity)|celebrit(?:y|ies)')
  },
  // Real historical events. "A cold war between two cats" and "her crusade" are figures of speech: only the named
  // events hold the text.
  {
    topic: 'real_event',
    re: words(
      'world war(?: (?:i{1,2}|one|two|1|2))?|ww ?(?:i{1,2}|1|2)|holocaust|9/11|september 11|partition of india|the cold war|the crusades|hiroshima|nagasaki|genocide|apartheid|french revolution|russian revolution|chernobyl|(?:primera|segunda|primeira) guerra mundial|(?:premiere|seconde|deuxieme) guerre mondiale|(?:la|a) guerra fria|la guerre froide|holocausto|holocauste|las cruzadas|as cruzadas|les croisades|विश्व ?युद्ध'
    )
  },
  { topic: 'real_event', re: /世界大戦|ホロコースト/u },
  // Politics. "Office politics" and "a parliament of owls" are everyday phrases: only party, campaign and election
  // framings hold the text.
  {
    topic: 'politics',
    re: words(
      'political part(?:y|ies)|party politics|political campaign|politician|election campaign|campaign rally|parliamentary election|general election|presidential election|prime minister|chief minister|bjp|democratic party|republican party|labour party|conservative party|communis[mt]|fascis[mt]|nazis?|left[- ]wing|right[- ]wing|partidos? politicos?|campana electoral|campanha eleitoral|elecciones (?:generales|presidenciales)|eleicoes (?:gerais|presidenciais)|eleicao presidencial|partis? politiques?|campagne electorale|election presidentielle|राजनीतिक (?:दल|पार्टी)|चुनाव प्रचार|आम चुनाव|चुनावी'
    )
  },
  { topic: 'politics', re: /政党/u },
  // Brands and products.
  {
    topic: 'brand',
    re: words("coca[- ]?cola|pepsi|mcdonald'?s|starbucks|nike|adidas|iphone|ipad|samsung|google|facebook|instagram|tiktok|youtube|netflix|playstation|xbox|fortnite|roblox|red bull|ferrari|lamborghini")
  },
  // Existing characters (public domain included: house stories are original). Studio and artist names are in
  // LIBRARY_IP_BLOCKLIST; trademarked characters are found by the server's detectNamedIp (passed as `namedIp`).
  // Hercules is also a beetle and a moth: those pass.
  {
    topic: 'existing_character',
    re: words('sherlock holmes|dr\\.? watson|dracula|frankenstein|alice in wonderland|peter pan|robin hood|tarzan|pinocchio|cinderella|snow white|rapunzel|little red riding hood|aladdin|sinbad|hercules(?! (?:beetles?|moths?))|heracles')
  }
] as HouseTopicRule[]);

export interface HouseTextHit {
  topic: HouseBlockedTopic;
  term: string;
}
export interface HouseTextCheck {
  ok: boolean;
  hits: HouseTextHit[];
  /**
   * Set when the check could not run, so the text is refused without hits (fail closed): `not_text` when the input is
   * not a string or an array of strings (pass the brief's or plan's text fields, not the object), `no_named_ip_check`
   * when the caller gave no named-IP detector.
   */
  refused?: 'not_text' | 'no_named_ip_check';
}

/** Invisible characters (soft hyphen, zero-width and direction marks, word joiners, BOM) dropped before matching. */
const stripInvisible = (text: string): string => text.replace(/[­​-‏⁠-⁤﻿]/g, '');

/**
 * Compatibility forms folded, Latin accents and invisible characters removed, spaces collapsed, then recomposed (so
 * Japanese voiced kana and half-width forms read as their usual letters): "Rām​āyaṇa" → "Ramayana".
 */
const normalizeForCheck = (text: string): string =>
  stripInvisible(
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/़/g, '') // Devanagari nukta
  )
    .normalize('NFC')
    .replace(/\s+/g, ' ');

/** Canonical composition only (no compatibility folding, accents kept): "Webtoon™" keeps its ™. */
const composeForCheck = (text: string): string => stripInvisible(text.normalize('NFC')).replace(/\s+/g, ' ');

const HITS_MAX = 10;

/** The server's named-IP detector (server/src/comic/replies.ts detectNamedIp, which shared code cannot import). */
export type HouseNamedIpDetector = (text: string) => readonly string[];

/**
 * The second content check (the first is the brief prompt): refuses a brief or plan whose text names a blocked topic
 * (HOUSE_TOPIC_BLOCKLIST), a studio, artist or brand from LIBRARY_IP_BLOCKLIST, or a name the server's named-IP
 * detector finds (`opts.namedIp`, required). Fails closed: input that is not text, or a missing detector, is refused
 * with `refused` set rather than passed.
 */
export function checkHouseText(text: string | readonly string[], opts: { namedIp: HouseNamedIpDetector }): HouseTextCheck {
  const parts: readonly unknown[] = typeof text === 'string' ? [text] : Array.isArray(text) ? text : [text];
  if (!parts.every((t): t is string => typeof t === 'string')) return { ok: false, hits: [], refused: 'not_text' };
  if (typeof opts?.namedIp !== 'function') return { ok: false, hits: [], refused: 'no_named_ip_check' };
  const joined = parts.join('\n');
  const norm = normalizeForCheck(joined);
  const hits: HouseTextHit[] = [];
  const add = (topic: HouseBlockedTopic, term: string) => {
    const t = term.trim().slice(0, 60);
    if (t && hits.length < HITS_MAX && !hits.some((h) => h.topic === topic && h.term.toLowerCase() === t.toLowerCase())) hits.push({ topic, term: t });
  };
  if (norm.trim()) {
    for (const rule of HOUSE_TOPIC_BLOCKLIST) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      for (const m of norm.matchAll(re)) add(rule.topic, m[0]);
    }
    // The IP list is read on the composed text too: compatibility folding turns its "webtoon™" into "webtoonTM".
    const ip = new RegExp(LIBRARY_IP_BLOCKLIST.source, `${LIBRARY_IP_BLOCKLIST.flags.replace('g', '')}g`);
    for (const t of [composeForCheck(joined), norm]) for (const m of t.matchAll(ip)) add('existing_character', m[0]);
    for (const name of opts.namedIp(norm)) add('existing_character', name);
  }
  return { ok: hits.length === 0, hits };
}

// ── Slate dimensions ─────────────────────────────────────────────────────────────────────────

export type HouseFormat = 'silent' | 'dialogue';
export type HouseAudience = 'children' | 'general' | 'teen';
/** The ratings each audience may carry; nothing is ever above PG-13. */
export const HOUSE_AUDIENCE_RATINGS: Readonly<Record<HouseAudience, readonly ContentRating[]>> = freezeDeep({
  children: ['G', 'PG'],
  general: ['PG'],
  teen: ['PG-13']
});

/** Words on a silent page: at most this many caption boxes, each at most this many words. */
export const HOUSE_SILENT_CAPTIONS_PER_PAGE = 1;
export const HOUSE_SILENT_CAPTION_MAX_WORDS = 12;

export type HouseShapeId = 'comic' | 'manga' | 'webtoon' | 'storybook' | 'strip' | 'short';
export interface HouseShape {
  id: HouseShapeId;
  kind: ComicKind;
  /** Inclusive page range. */
  pages: readonly [number, number];
  /** The page aspect asked for; each model draws its nearest listed aspect. */
  aspect: AspectRatio;
  /** A short piece of 1–3 pages: always silent (the quality bar is two wordless pages). */
  short: boolean;
}
export const HOUSE_SHAPES: readonly HouseShape[] = freezeDeep<HouseShape[]>([
  { id: 'comic', kind: 'comic', pages: [4, 8], aspect: '2:3', short: false },
  { id: 'manga', kind: 'manga', pages: [6, 8], aspect: '2:3', short: false },
  { id: 'webtoon', kind: 'webtoon', pages: [8, 12], aspect: '9:16', short: false },
  { id: 'storybook', kind: 'storybook', pages: [4, 6], aspect: '4:5', short: false },
  { id: 'strip', kind: 'strip', pages: [1, 3], aspect: '16:9', short: true },
  // The Last Tram's shape: a short landscape comic page.
  { id: 'short', kind: 'comic', pages: [2, 3], aspect: '5:4', short: true }
]);
const shapeOf = (id: HouseShapeId): HouseShape => HOUSE_SHAPES.find((s) => s.id === id)!;

export interface HouseGenre {
  id: string;
  label: string;
  audiences: readonly HouseAudience[];
}
const EVERYONE: readonly HouseAudience[] = ['children', 'general', 'teen'];
/** Original genres (no genre twice a day). Horror stays light and teen-only (PG-13). */
export const HOUSE_GENRES: readonly HouseGenre[] = freezeDeep<HouseGenre[]>([
  { id: 'slice-of-life', label: 'Slice of life', audiences: EVERYONE },
  { id: 'mystery', label: 'Mystery', audiences: EVERYONE },
  { id: 'sci-fi', label: 'Science fiction', audiences: EVERYONE },
  { id: 'comedy', label: 'Comedy', audiences: EVERYONE },
  { id: 'sports', label: 'Sports', audiences: EVERYONE },
  { id: 'nature', label: 'Nature', audiences: EVERYONE },
  { id: 'fable', label: 'Fable', audiences: ['children', 'general'] },
  { id: 'horror-lite', label: 'Light horror', audiences: ['teen'] },
  { id: 'adventure', label: 'Adventure', audiences: EVERYONE },
  { id: 'fantasy', label: 'Fantasy', audiences: EVERYONE },
  { id: 'friendship', label: 'Friendship', audiences: EVERYONE },
  { id: 'heist', label: 'Heist caper', audiences: ['general', 'teen'] },
  { id: 'coming-of-age', label: 'Coming of age', audiences: ['general', 'teen'] },
  { id: 'food', label: 'Food and cooking', audiences: EVERYONE },
  { id: 'inventions', label: 'Inventors and gadgets', audiences: EVERYONE },
  { id: 'music', label: 'Music', audiences: EVERYONE },
  { id: 'survival', label: 'Survival', audiences: ['general', 'teen'] },
  { id: 'animal-tales', label: 'Animal tales', audiences: EVERYONE }
]);

/** Non-English source languages (drawable scripts in languages.ts); every one gets an English edition. */
export const HOUSE_SOURCE_LANGUAGES: readonly string[] = Object.freeze(['es', 'hi', 'pt', 'fr', 'ja']);

/**
 * Looks a house comic never uses: their prompt text asks for deities and devotional imagery, which the house content
 * rules forbid, and checkHouseText never reads a preset's text (it goes straight into the writer and image prompts).
 */
export const HOUSE_EXCLUDED_PRESETS: readonly string[] = Object.freeze(['mythic-icon', 'indian-miniature']);
/** The looks a house slate may use. */
export const HOUSE_STYLE_PRESETS: readonly StylePreset[] = Object.freeze(STYLE_PRESETS.filter((p) => !HOUSE_EXCLUDED_PRESETS.includes(p.id)));
const housePreset = (id: string): StylePreset | undefined => HOUSE_STYLE_PRESETS.find((p) => p.id === id);

/** Looks too dark for a children's comic (a preference: relaxed only when nothing else is left). */
const CHILD_UNSUITED_LOOKS: ReadonlySet<string> = new Set(['noir-ink', 'dark-fantasy', 'woodcut', 'brutalist', 'cyberpunk']);
/** At least this many distinct looks a day (or every slot when fewer). */
const LOOKS_MIN_DISTINCT = 7;
/** A look used on a day is not used on either of the next two days ("no preset twice in 3 days"). */
const LOOK_GAP_DAYS = 2;
const PRO_SHARE = 0.4;
const NON_ENGLISH_SHARE = 0.3;
const AUDIENCE_SHARE = { children: 0.3, teen: 0.3 } as const;

/** The colour mode a look draws in. */
export const colourModeOfPreset = (p: Pick<StylePreset, 'colorMode'>): ColorMode => p.colorMode ?? 'color';

// ── The slate ────────────────────────────────────────────────────────────────────────────────

export type HouseCalibrationStory = 'last-tram' | 'paper-boat';

/** One planned comic of a day. */
export interface HouseSlate {
  day: string;
  /** 1-based, unique per run. */
  slot: number;
  shape: HouseShapeId;
  kind: ComicKind;
  pages: number;
  short: boolean;
  format: HouseFormat;
  presetId: string;
  colorMode: ColorMode;
  family: HouseImageFamily;
  tier: HouseTier;
  /** Registry id of the page and cover model. */
  model: string;
  resolution: Resolution;
  aspect: AspectRatio;
  readingDirection: 'ltr' | 'rtl';
  audience: HouseAudience;
  rating: ContentRating;
  /** Source language (BCP-47). */
  language: string;
  /** Translated editions to make (never the source language). */
  editions: string[];
  genre: string;
  /** Who pays this slate's pictures (by model and the BYOK vendors). */
  imagePayer: HouseCappedPayer;
  /** The planned model was paused (models/health.ts): swapped within its family. */
  swap?: { from: string; reason: 'paused' };
  /** Every model of the family is paused: the runner holds this slot instead of drawing it. */
  blocked?: 'model_paused';
  /** A day-0 calibration remake of a quality-bar sample. */
  calibration?: { story: HouseCalibrationStory; title: string; pages: readonly string[] };
}

/** What earlier days made (the house_comics rows of the last 14 days). */
export interface HouseHistoryEntry {
  day: string;
  presetId?: string;
  genre?: string;
  kind?: ComicKind;
  model?: string;
}

export interface PlanDailySlateInput {
  /** The run day; the seed. */
  day: string;
  /** Slates to plan (default config.dailyCount; never above HOUSE_LIMITS.dailyCountMax). */
  count?: number;
  history14d?: readonly HouseHistoryEntry[];
  config?: Pick<HouseConfig, 'dailyCount' | 'allow4k' | 'modelWeights' | 'payers'>;
  /** The image model registry (default IMAGE_MODELS): only `pickable` models are chosen. */
  registry?: readonly ImageModelSpec[];
  /** Registry id → health; 'down' is paused. */
  health?: Readonly<Record<string, HealthState | undefined>>;
  /**
   * Each capped payer's lifetime spend (USD, from the ledger). The planner then works out from config.payers which
   * credits are at their stop (houseCreditStopped: that half stops) and, for a payer `budgets` does not name, its day
   * budget (dayBudgetUsd). Pass it: a budget of 0 on its own reads as a day with no room and moves the slots.
   */
  lifetimeUsd?: Partial<Readonly<Record<HouseCappedPayer, number>>>;
  /** Each payer's day budget still available (USD); the mix leans away from a payer with little left. */
  budgets?: Partial<Readonly<Record<HouseCappedPayer, number>>>;
  /** Payers at their credit stop: that half stops and its slots are not moved (owner question 5). Added to the ones
   *  `lifetimeUsd` shows at their stop. */
  stopped?: readonly HouseCappedPayer[];
  byokVendors?: readonly HouseByokVendor[];
}

// Seeded randomness: mulberry32 over the FNV-1a hash of the day.
type Rng = () => number;
const rngFor = (seed: string): Rng => {
  let a = parseInt(hashString(seed), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
const shuffle = <T>(rng: Rng, xs: readonly T[]): T[] => {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const intIn = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
const weightedPick = <T>(rng: Rng, items: readonly { value: T; weight: number }[]): T | undefined => {
  const live = items.filter((i) => i.weight > 0);
  const total = live.reduce((s, i) => s + i.weight, 0);
  if (!live.length || !(total > 0)) return undefined;
  let r = rng() * total;
  for (const i of live) {
    r -= i.weight;
    if (r < 0) return i.value;
  }
  return live[live.length - 1].value;
};

const weightOf = (weights: Readonly<Record<string, number>> | undefined, id: string): number => {
  const w = weights?.[id];
  return isNum(w) ? Math.min(HOUSE_LIMITS.modelWeightMax, Math.max(0, w)) : 1;
};

interface Candidate {
  id: string;
  weight: number;
}
/** The family's usable models per tier: pickable in the registry and weighted above 0. */
const familyPool = (registry: readonly ImageModelSpec[], weights: Readonly<Record<string, number>> | undefined, family: HouseImageFamily): Record<HouseTier, Candidate[]> => {
  const usable = (id: string) => registry.some((m) => m.id === id && m.pickable);
  const tier = (t: HouseTier) => HOUSE_FAMILY_MODELS[family][t].filter(usable).map((id) => ({ id, weight: weightOf(weights, id) })).filter((c) => c.weight > 0);
  return { standard: tier('standard'), pro: tier('pro') };
};
const familyPayer = (family: HouseImageFamily, byok: readonly HouseByokVendor[]): HouseCappedPayer =>
  payerOfModel(family === 'openai' ? 'openai/image' : 'google/image', byok);
const isPaused = (health: PlanDailySlateInput['health'], id: string): boolean => health?.[id] === 'down';

/** The resolution a slate draws at: 2K, 4K for pro pages only when allowed, and a fixed-size model's own row. */
const slateResolution = (spec: ImageModelSpec, tier: HouseTier, allow4k: boolean): Resolution => {
  if (spec.fixedResolution) return spec.fixedResolution;
  if (!spec.resolutions.length) return '1K'; // a fixed-size transport with its 1K catalog row
  return nearestResolution(spec, tier === 'pro' && allow4k ? '4K' : '2K');
};

const ratingFor = (audience: HouseAudience, shape: HouseShape): ContentRating =>
  audience === 'teen' ? 'PG-13' : audience === 'general' ? 'PG' : shape.short || shape.kind === 'storybook' ? 'G' : 'PG';

interface Draft {
  shape: HouseShape;
  pages: number;
  format: HouseFormat;
  audience: HouseAudience;
  family: HouseImageFamily;
  tier: HouseTier;
  model: string;
  swap?: HouseSlate['swap'];
  blocked?: HouseSlate['blocked'];
  presetId: string;
  genre: string;
  language: string;
  editions: string[];
}

/** Uses per id in the history, and the last day each was used. */
const usage = (history: readonly HouseHistoryEntry[], key: 'presetId' | 'genre') => {
  const count = new Map<string, number>();
  const last = new Map<string, string>();
  for (const h of history) {
    const id = h[key];
    if (!id) continue;
    count.set(id, (count.get(id) ?? 0) + 1);
    if (!last.has(id) || last.get(id)! < h.day) last.set(id, h.day);
  }
  /** Least used first, then least recently used; ties in the (seeded) incoming order. */
  const order = <T extends { id: string }>(xs: T[]): T[] =>
    xs.slice().sort((a, b) => (count.get(a.id) ?? 0) - (count.get(b.id) ?? 0) || (last.get(a.id) ?? '').localeCompare(last.get(b.id) ?? ''));
  return { order };
};

/**
 * The day's slates (spec §5.2). Deterministic: the seed is the day, so the same inputs give the same slate.
 *
 * - Image families: 5 Gemini and 5 OpenAI by default, re-weighted by the owner's model weights and by the share of each
 *   payer's day budget still available; a payer at its credit stop (`stopped`, or worked out from `lifetimeUsd`) stops
 *   its half without moving it.
 * - Tiers standard (about 60%) and pro (about 40% of each family that has a pickable pro model); never draft; 4K only
 *   for pro pages when `allow4k`.
 * - Kinds: at least 4 a day; at least 2 short silent pieces; long pieces in their kind's page range.
 * - Looks: at least 7 distinct a day, none used on either of the 2 days before; at least 2 non-colour looks (3 on a
 *   day of 6 or more); never a look in HOUSE_EXCLUDED_PRESETS.
 * - Audiences 30% children, 40% general, 30% teen; at least 70% English sources; editions as HOUSE_LIMITS says.
 * - A paused model is swapped within its family (recorded); a family with every model paused is held, not moved.
 */
export function planDailySlate(input: PlanDailySlateInput): HouseSlate[] {
  const { day } = input;
  if (!isHouseDay(day)) return [];
  const config = input.config ?? HOUSE_CONFIG_DEFAULTS;
  const want = clampInt(input.count ?? config.dailyCount, 0, HOUSE_LIMITS.dailyCountMax, 0);
  if (want <= 0) return [];
  const registry = input.registry ?? IMAGE_MODELS;
  const byok = input.byokVendors ?? [];
  const history = (input.history14d ?? []).filter((h) => isHouseDay(h.day) && h.day < day && houseDaysBetween(h.day, day) <= 14);
  const rng = rngFor(`house-slate:${day}`);

  // 1. Families: the owner's weights × the share of the payer's day budget left. A stopped payer keeps its nominal
  //    share in the split and is then dropped, so its half is not moved to the other payer. With lifetime spend the
  //    stops and the missing budgets come from config.payers.
  const stopped = new Set<HouseCappedPayer>(input.stopped ?? []);
  const budgets: Partial<Record<HouseCappedPayer, number>> = { ...(input.budgets ?? {}) };
  for (const p of HOUSE_CAPPED_PAYERS) {
    const spent = input.lifetimeUsd?.[p];
    const payer = config.payers[p];
    if (spent === undefined || !payer) continue;
    if (houseCreditStopped(payer, { lifetimeUsd: spent })) stopped.add(p);
    if (budgets[p] === undefined) budgets[p] = dayBudgetUsd(payer, { day, lifetimeUsd: spent });
  }
  const pools = { gemini: familyPool(registry, config.modelWeights, 'gemini'), openai: familyPool(registry, config.modelWeights, 'openai') };
  const familyWeight = (f: HouseImageFamily): number => {
    // The family's weight is its most-wanted model's: turning one model off moves its slots to its sibling, not to
    // the other family; turning every model of a family off (or hiding them all) removes the family.
    const all = [...pools[f].standard, ...pools[f].pro];
    if (!all.length) return 0;
    const best = Math.max(...all.map((c) => c.weight));
    const payer = familyPayer(f, byok);
    const left = budgets[payer];
    const cap = config.payers[payer]?.dayCapUsd ?? 0;
    const share = stopped.has(payer) || left === undefined ? 1 : cap > 0 && isNum(left) ? Math.min(1, Math.max(0, left / cap)) : 0;
    return best * share;
  };
  const wG = familyWeight('gemini');
  const wO = familyWeight('openai');
  if (!(wG + wO > 0)) return [];
  let nO = Math.floor((want * wO) / (wG + wO) + 1e-9);
  let nG = want - nO;
  if (stopped.has(familyPayer('openai', byok))) nO = 0;
  if (stopped.has(familyPayer('gemini', byok))) nG = 0;
  const total = nG + nO;
  if (!total) return [];

  // 2. Shapes: up to 2 short silent pieces (one a strip), then the long kinds, each at least once before any repeats.
  const nShort = Math.min(2, total);
  const nLong = total - nShort;
  const shapes: HouseShape[] = [];
  if (nShort === 1) shapes.push(shapeOf(rng() < 0.5 ? 'strip' : 'short'));
  if (nShort === 2) shapes.push(shapeOf('strip'), shapeOf(nLong >= 3 && rng() < 0.5 ? 'strip' : 'short'));
  const firstCycle: HouseShapeId[] = [...shuffle<HouseShapeId>(rng, ['manga', 'webtoon', 'storybook']), 'comic'];
  const LONG_WEIGHTS: { value: HouseShapeId; weight: number }[] = [
    { value: 'comic', weight: 3 },
    { value: 'manga', weight: 2 },
    { value: 'webtoon', weight: 2 },
    { value: 'storybook', weight: 1 }
  ];
  for (let i = 0; i < nLong; i += 1) shapes.push(shapeOf(i < firstCycle.length ? firstCycle[i] : weightedPick(rng, LONG_WEIGHTS)!));
  const drafts: Draft[] = shuffle(rng, shapes).map((shape) => ({
    shape,
    pages: intIn(rng, shape.pages[0], shape.pages[1]),
    format: shape.short || (shape.kind !== 'storybook' && rng() < 0.2) ? 'silent' : 'dialogue',
    audience: 'general',
    family: 'gemini',
    tier: 'standard',
    model: '',
    presetId: '',
    genre: '',
    language: 'en',
    editions: []
  }));
  const idx = drafts.map((_, i) => i);

  // 3. Audiences: teens never on a storybook; children on storybooks first.
  const nChild = Math.round(total * AUDIENCE_SHARE.children);
  const nTeen = Math.min(total - nChild, Math.round(total * AUDIENCE_SHARE.teen));
  const notStorybook = shuffle(rng, idx.filter((i) => drafts[i].shape.kind !== 'storybook'));
  const teen = new Set(notStorybook.slice(0, nTeen));
  const rest = shuffle(rng, idx.filter((i) => !teen.has(i))).sort((a, b) => Number(drafts[b].shape.kind === 'storybook') - Number(drafts[a].shape.kind === 'storybook'));
  const child = new Set(rest.slice(0, nChild));
  for (const i of idx) drafts[i].audience = teen.has(i) ? 'teen' : child.has(i) ? 'children' : 'general';

  // 4. Families, tiers and models.
  const famOrder = shuffle<HouseImageFamily>(rng, [...Array<HouseImageFamily>(nG).fill('gemini'), ...Array<HouseImageFamily>(nO).fill('openai')]);
  idx.forEach((i) => (drafts[i].family = famOrder[i]));
  for (const f of ['gemini', 'openai'] as const) {
    const mine = shuffle(rng, idx.filter((i) => drafts[i].family === f));
    const pool = pools[f];
    const nPro = pool.pro.length && pool.standard.length ? Math.round(mine.length * PRO_SHARE) : pool.pro.length ? mine.length : 0;
    mine.forEach((i, k) => (drafts[i].tier = k < nPro ? 'pro' : 'standard'));
  }
  for (const d of drafts) {
    const pool = pools[d.family];
    const planned = weightedPick(rng, pool[d.tier].map((c) => ({ value: c.id, weight: c.weight })))!;
    d.model = planned;
    if (isPaused(input.health, planned)) {
      const other: HouseTier = d.tier === 'pro' ? 'standard' : 'pro';
      const live = (cs: Candidate[]) => cs.filter((c) => c.id !== planned && !isPaused(input.health, c.id)).map((c) => ({ value: c.id, weight: c.weight }));
      const swapTo = weightedPick(rng, live(pool[d.tier])) ?? weightedPick(rng, live(pool[other]));
      if (swapTo) {
        d.model = swapTo;
        d.swap = { from: planned, reason: 'paused' };
      } else d.blocked = 'model_paused';
    }
  }

  // 5. Looks.
  const recentDays = new Set(Array.from({ length: LOOK_GAP_DAYS }, (_, k) => addHouseDays(day, -(k + 1))));
  const recent = new Set(history.filter((h) => recentDays.has(h.day) && h.presetId).map((h) => h.presetId!));
  const looks = usage(history, 'presetId');
  const distinctTarget = Math.min(total, LOOKS_MIN_DISTINCT);
  // Three non-colour looks on a day of 6 or more, so the colour looks (13 for house comics) last the 3-day gap.
  const nNonColour = Math.min(total, total >= 6 ? 3 : 2);
  const nonColourSlots = new Set(
    [...shuffle(rng, idx.filter((i) => drafts[i].audience !== 'children')), ...shuffle(rng, idx.filter((i) => drafts[i].audience === 'children'))].slice(0, nNonColour)
  );
  const KIND_BOUND = new Set(HOUSE_STYLE_PRESETS.filter((p) => p.kind).map((p) => p.kind!));
  const lookOrder = [
    ...shuffle(rng, idx.filter((i) => nonColourSlots.has(i))),
    ...shuffle(rng, idx.filter((i) => !nonColourSlots.has(i) && KIND_BOUND.has(drafts[i].shape.kind))),
    ...shuffle(rng, idx.filter((i) => !nonColourSlots.has(i) && !KIND_BOUND.has(drafts[i].shape.kind)))
  ];
  const chosen: string[] = [];
  for (const i of lookOrder) {
    const d = drafts[i];
    const nonColour = nonColourSlots.has(i);
    const colourOk = (p: StylePreset) => (colourModeOfPreset(p) !== 'color') === nonColour;
    const kindOk = (p: StylePreset) => !p.kind || p.kind === d.shape.kind;
    const audienceOk = (p: StylePreset) => d.audience !== 'children' || !CHILD_UNSUITED_LOOKS.has(p.id);
    let pick: string | undefined;
    if (chosen.length >= distinctTarget) {
      const reuse = (f: (p: StylePreset) => boolean) => {
        const xs = chosen.filter((id) => f(housePreset(id)!));
        return xs.length ? xs[Math.floor(rng() * xs.length)] : undefined;
      };
      pick = reuse((p) => colourOk(p) && kindOk(p) && audienceOk(p)) ?? reuse((p) => colourOk(p) && audienceOk(p)) ?? reuse(colourOk);
    }
    if (!pick) {
      const fresh = (p: StylePreset) => !chosen.includes(p.id);
      const avail = (p: StylePreset) => fresh(p) && !recent.has(p.id);
      // Relaxed one preference at a time; the spec rules (3-day gap, colour) are the last to give.
      const tiers: ((p: StylePreset) => boolean)[] = [
        (p) => avail(p) && colourOk(p) && kindOk(p) && audienceOk(p),
        (p) => avail(p) && colourOk(p) && audienceOk(p),
        (p) => avail(p) && colourOk(p),
        (p) => fresh(p) && colourOk(p) && audienceOk(p),
        (p) => fresh(p),
        () => true
      ];
      for (const tier of tiers) {
        const cands = looks.order(shuffle(rng, HOUSE_STYLE_PRESETS.filter(tier)));
        if (cands.length) {
          pick = cands[0].id;
          break;
        }
      }
    }
    d.presetId = pick!;
    if (!chosen.includes(pick!)) chosen.push(pick!);
  }

  // 6. Genres: never twice a day; the least used of the last 14 days first.
  const genres = usage(history, 'genre');
  const usedGenres = new Set<string>();
  const genreOrder = [
    ...shuffle(rng, idx.filter((i) => drafts[i].audience === 'children')),
    ...shuffle(rng, idx.filter((i) => drafts[i].audience === 'teen')),
    ...shuffle(rng, idx.filter((i) => drafts[i].audience === 'general'))
  ];
  for (const i of genreOrder) {
    const d = drafts[i];
    const cands = genres.order(shuffle(rng, HOUSE_GENRES.filter((g) => g.audiences.includes(d.audience) && !usedGenres.has(g.id))));
    const g = cands[0] ?? genres.order(shuffle(rng, HOUSE_GENRES.filter((x) => !usedGenres.has(x.id))))[0];
    d.genre = g.id;
    usedGenres.add(g.id);
  }

  // 7. Languages: silent pieces are English with no editions; up to 30% non-English dialogue sources (each with an
  //    English edition, Japanese preferring a manga); then up to 2 extra editions of English dialogue sources.
  const dialogue = shuffle(rng, idx.filter((i) => drafts[i].format === 'dialogue'));
  const nNonEn = Math.min(dialogue.length, Math.floor(total * NON_ENGLISH_SHARE));
  const nonEn = dialogue.slice(0, nNonEn).sort((a, b) => Number(drafts[b].shape.kind === 'manga') - Number(drafts[a].shape.kind === 'manga'));
  const langs = shuffle(rng, HOUSE_SOURCE_LANGUAGES).slice(0, nNonEn);
  if (langs.includes('ja')) langs.sort((a, b) => Number(b === 'ja') - Number(a === 'ja'));
  nonEn.forEach((i, k) => {
    drafts[i].language = langs[k];
    drafts[i].editions = ['en'];
  });
  const englishDialogue = dialogue.filter((i) => !nonEn.includes(i));
  const nExtra = Math.min(englishDialogue.length, HOUSE_LIMITS.extraEditionsMax, 1 + (rng() < 0.5 ? 1 : 0));
  for (const i of englishDialogue.slice(0, nExtra)) drafts[i].editions = [HOUSE_SOURCE_LANGUAGES[Math.floor(rng() * HOUSE_SOURCE_LANGUAGES.length)]];

  // 8. The slates.
  return drafts.map((d, i): HouseSlate => {
    const spec = registry.find((m) => m.id === d.model)!;
    const preset = housePreset(d.presetId)!;
    return {
      day,
      slot: i + 1,
      shape: d.shape.id,
      kind: d.shape.kind,
      pages: d.pages,
      short: d.shape.short,
      format: d.format,
      presetId: d.presetId,
      colorMode: colourModeOfPreset(preset),
      family: d.family,
      tier: d.tier,
      model: d.model,
      resolution: slateResolution(spec, d.tier, config.allow4k),
      aspect: nearestAspect(spec, d.shape.aspect),
      readingDirection: d.shape.kind === 'manga' ? 'rtl' : 'ltr',
      audience: d.audience,
      rating: ratingFor(d.audience, d.shape),
      language: d.language,
      editions: d.editions,
      genre: d.genre,
      imagePayer: payerOfModel(spec.routes.openrouter ?? spec.id, byok),
      ...(d.swap ? { swap: d.swap } : {}),
      ...(d.blocked ? { blocked: d.blocked } : {})
    };
  });
}

// ── Calibration (day 0) ──────────────────────────────────────────────────────────────────────

/**
 * The two quality-bar samples, with the public story text of the landing page's sample reader
 * (components/comicshost/ComicSampleReader.tsx STORIES; a test keeps them equal).
 */
export const HOUSE_CALIBRATION_STORIES: Readonly<
  Record<HouseCalibrationStory, { title: string; pages: readonly string[]; presetId: string; audience: HouseAudience; genre: string }>
> = freezeDeep({
  'last-tram': {
    title: 'The Last Tram',
    pages: [
      'A traveler watches the moonlit harbor, then boards the last tram along the coast.',
      'The traveler steps off the tram, sets a paper boat afloat, and watches it drift across the moonlit harbor.'
    ],
    presetId: 'graphic-novel-painterly',
    audience: 'general',
    genre: 'slice-of-life'
  },
  'paper-boat': {
    title: 'The Paper Boat',
    pages: [
      'Mira and Biscuit spot a paper boat drifting down the canal at dusk.',
      'They race along the canal to catch the paper boat before the rain.'
    ],
    presetId: 'cozy-anime',
    audience: 'children',
    genre: 'friendship'
  }
});

/**
 * The fixed day-0 set: each sample remade on each image family, silent, 2 pages, English. The Last Tram on Nano Banana
 * Pro (5:4) and on GPT Image 2.5 once pickable, else 2.6 Sunburst (4:3); The Paper Boat on Nano Banana 2.1 and GPT
 * Image 2.6 Flare (2:3). A hidden or paused model is swapped within its family like any slate.
 */
export function calibrationSlates(input: { day: string; registry?: readonly ImageModelSpec[]; byokVendors?: readonly HouseByokVendor[]; health?: PlanDailySlateInput['health'] }): HouseSlate[] {
  const registry = input.registry ?? IMAGE_MODELS;
  const byok = input.byokVendors ?? [];
  const pickable = (id: string) => registry.some((m) => m.id === id && m.pickable);
  const gpt25 = pickable('gpt-image-2.5');
  const plan: { story: HouseCalibrationStory; family: HouseImageFamily; tier: HouseTier; model: string; aspect: AspectRatio }[] = [
    { story: 'last-tram', family: 'gemini', tier: 'pro', model: 'nano-banana-pro', aspect: '5:4' },
    { story: 'last-tram', family: 'openai', tier: gpt25 ? 'pro' : 'standard', model: gpt25 ? 'gpt-image-2.5' : 'gpt-image-2.6-sunburst', aspect: '5:4' },
    { story: 'paper-boat', family: 'gemini', tier: 'standard', model: 'nano-banana-2.1', aspect: '2:3' },
    { story: 'paper-boat', family: 'openai', tier: 'standard', model: 'gpt-image-2.6-flare', aspect: '2:3' }
  ];
  const shape = shapeOf('short');
  return plan.map((p, i): HouseSlate => {
    const story = HOUSE_CALIBRATION_STORIES[p.story];
    let model = p.model;
    let swap: HouseSlate['swap'];
    let blocked: HouseSlate['blocked'];
    if (!pickable(model) || isPaused(input.health, model)) {
      const alt = [...HOUSE_FAMILY_MODELS[p.family][p.tier], ...HOUSE_FAMILY_MODELS[p.family][p.tier === 'pro' ? 'standard' : 'pro']].find(
        (id) => id !== model && pickable(id) && !isPaused(input.health, id)
      );
      if (alt) {
        if (isPaused(input.health, model)) swap = { from: model, reason: 'paused' };
        model = alt;
      } else blocked = 'model_paused';
    }
    const spec = registry.find((m) => m.id === model) ?? getImageModel(model)!;
    const preset = housePreset(story.presetId)!;
    return {
      day: input.day,
      slot: i + 1,
      shape: shape.id,
      kind: shape.kind,
      pages: 2,
      short: true,
      format: 'silent',
      presetId: story.presetId,
      colorMode: colourModeOfPreset(preset),
      family: p.family,
      tier: p.tier,
      model,
      resolution: slateResolution(spec, p.tier, false),
      aspect: nearestAspect(spec, p.aspect),
      readingDirection: 'ltr',
      audience: story.audience,
      rating: ratingFor(story.audience, shape),
      language: 'en',
      editions: [],
      genre: story.genre,
      imagePayer: payerOfModel(spec.routes.openrouter ?? spec.id, byok),
      ...(swap ? { swap } : {}),
      ...(blocked ? { blocked } : {}),
      calibration: { story: p.story, title: story.title, pages: story.pages }
    };
  });
}

// ── Writer instructions and display ──────────────────────────────────────────────────────────

/** The writer's format instructions for a silent (wordless) slate. */
export function silentFormatInstructions(slate: Pick<HouseSlate, 'kind' | 'pages'>): string {
  const pages = `${slate.pages} page${slate.pages === 1 ? '' : 's'}`;
  return [
    `FORMAT: a silent (wordless) ${slate.kind} of ${pages}.`,
    '- No speech balloons, no thought balloons and no sound-effect words.',
    `- At most one caption box per page, of no more than ${HOUSE_SILENT_CAPTION_MAX_WORDS} words; most pages need none.`,
    '- Tell the story through acting, expressions, staging and panel rhythm: one clear beat per panel.',
    '- Write the whole story line in one or two sentences as the comic\'s description, not on the pages.'
  ].join('\n');
}

/** One line per slate for the console and test read-throughs (no amounts, no ids beyond the registry's). */
export const describeSlate = (s: HouseSlate): string =>
  [
    `#${s.slot}`,
    `${s.shape} ${s.pages}p ${s.format}`,
    `${s.presetId} (${s.colorMode})`,
    `${s.model}${s.swap ? ` for ${s.swap.from}` : ''} ${s.tier} ${s.resolution} ${s.aspect}`,
    `${s.audience} ${s.rating}`,
    `${s.language}${s.editions.length ? ` +${s.editions.join(',')}` : ''}`,
    s.genre,
    s.blocked ? `held: ${s.blocked}` : ''
  ]
    .filter(Boolean)
    .join(' · ');
