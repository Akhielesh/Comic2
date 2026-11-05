// How the Model Library shows what a model costs (Models Phase 0, finding 3). ONE rule for every
// Models surface: the catalog cards, the detail and compare modals, top picks, the leaderboards, the
// providers table and the image ranking.
//
//   Signed out                → list prices in dollars, labelled "list price".
//   Signed in, per row (the provider p that serves it):
//     payer[p] === 'user'     → dollars, labelled "on your <Provider> key" (the user pays that provider);
//     viewer === 'admin' and costView === 'dollars'
//                             → dollars, labelled "list price";
//     costView === 'share' and a per-call share is known
//                             → "≈0.3% of your usage per image";
//     anything else           → relative usage bands, no numbers: Lower / Moderate / Higher usage
//                               (tertiles among comparable listed models).
//   Allowance not read yet    → a skeleton for at most ALLOWANCE_WAIT_MS, then bands. Never blocks a table.
//   No price listed at all    → "Price not listed", for everyone (never "free", never a band).
//
// The model's own words (description, editorial note, drawbacks, possibilities) follow the same rule
// through costSafeText: unchanged where the row is in dollars, otherwise "$0" reads "free" and any
// sentence that still carries a dollar figure is left out.
//
// `viewer`, `costView` and `payer` are additive fields DreamStream is adding to GET /api/usage/allowance.
// Until they arrive, every signed-in viewer gets bands: the reader tolerates any missing or malformed field
// and fails closed. Exempt and metering-off viewers never see dollars (they are not admins). `viewer` is
// for display only; admin UI stays gated on useIsAdmin().
//
// The share: services/costDisplay.costContextFromAllowance gives `pctPerUsd` (percent of the user's usage
// one provider dollar takes). It only becomes a per-model figure where the model states a per-call unit
// (per image, per request). Token-priced rows need a workload (a "chat reply" of N tokens), which is not
// co-signed yet, so they stay in bands.

import { useEffect, useMemo, useState } from 'react';
import type { CatalogModel } from '../../services/modelCatalog';
import { describeCost } from '../../shared/pricing';
import { providerLabel } from '../../shared/providers';
import { compactUsageShare, costContextFromAllowance, formatCostForUser } from '../../services/costDisplay';
import { refreshAllowanceStatus, subscribeAllowanceStatus, type AllowanceStatus } from '../../services/usageAllowance';

// ---------------------------------------------------------------------------------------------------------
// Allowance fields. A local mirror of DreamStream's `AllowanceCostFields` (shared/billing/payer.ts, not on dev
// yet); costView.test.ts checks the parity. Swap this block for the shared type once it lands.
// ---------------------------------------------------------------------------------------------------------

export const COST_VIEWERS = ['admin', 'governed', 'exempt', 'metering_off'] as const;
export type CostViewer = (typeof COST_VIEWERS)[number];
export const COST_VIEW_MODES = ['dollars', 'share', 'bands'] as const;
export type CostViewMode = (typeof COST_VIEW_MODES)[number];
export const PAYERS = ['user', 'platform', 'none'] as const;
export type Payer = (typeof PAYERS)[number];
export const PAYER_PROVIDERS = ['openrouter', 'gemini', 'nvidia', 'pixazo', 'openai', 'anthropic', 'deepseek', 'zai', 'minimax', 'tencent', 'xai'] as const;
export type PayerProvider = (typeof PAYER_PROVIDERS)[number];

export interface AllowanceCostFields {
  viewer: CostViewer;
  costView: CostViewMode;
  payer: Partial<Record<PayerProvider, Payer>>;
}

/** How long a signed-in viewer sees cost skeletons before the page settles on bands. */
export const ALLOWANCE_WAIT_MS = 3_000;

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined;

/** The cost fields of an allowance payload. Missing or malformed fields are left out (never guessed). */
export const readAllowanceCostFields = (raw: unknown): Partial<AllowanceCostFields> => {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<AllowanceCostFields> = {};
  const viewer = oneOf(COST_VIEWERS, r.viewer);
  if (viewer) out.viewer = viewer;
  const costView = oneOf(COST_VIEW_MODES, r.costView);
  if (costView) out.costView = costView;
  if (r.payer && typeof r.payer === 'object' && !Array.isArray(r.payer)) {
    const source = r.payer as Record<string, unknown>;
    const payer: Partial<Record<PayerProvider, Payer>> = {};
    for (const p of PAYER_PROVIDERS) {
      const v = Object.prototype.hasOwnProperty.call(source, p) ? oneOf(PAYERS, source[p]) : undefined;
      if (v) payer[p] = v;
    }
    out.payer = payer;
  }
  return out;
};

// ---------------------------------------------------------------------------------------------------------
// Who is looking, and what each row shows them.
// ---------------------------------------------------------------------------------------------------------

export type CostAudience =
  | { kind: 'signed_out' }
  | { kind: 'loading' }
  | { kind: 'signed_in'; fields: Partial<AllowanceCostFields>; pctPerUsd: number | null };

export const costAudience = (input: {
  signedIn: boolean;
  status: AllowanceStatus | null | undefined;
  timedOut: boolean;
}): CostAudience => {
  if (!input.signedIn) return { kind: 'signed_out' };
  if (!input.status) return input.timedOut ? { kind: 'signed_in', fields: {}, pctPerUsd: null } : { kind: 'loading' };
  const fields = readAllowanceCostFields(input.status);
  const pct = fields.costView === 'share' ? costContextFromAllowance(input.status).pctPerUsd : null;
  return { kind: 'signed_in', fields, pctPerUsd: typeof pct === 'number' && Number.isFinite(pct) && pct > 0 ? pct : null };
};

export type RowCostMode =
  /** `label` is what the figure is ("list price", "on your OpenRouter key"); `tag` its short form for a cell. */
  | { mode: 'dollars'; label: string; tag: string }
  | { mode: 'share'; pctPerUsd: number }
  | { mode: 'bands' }
  | { mode: 'loading' };

const LIST_PRICE: RowCostMode = { mode: 'dollars', label: 'list price', tag: 'list price' };

/** The view for one row, served by `provider` (a catalog model's `source`; null for rows with no route). */
export const rowCostMode = (audience: CostAudience, provider?: string | null): RowCostMode => {
  if (audience.kind === 'signed_out') return LIST_PRICE;
  if (audience.kind === 'loading') return { mode: 'loading' };
  const { viewer, costView, payer } = audience.fields;
  const p = oneOf(PAYER_PROVIDERS, provider);
  if (p && payer?.[p] === 'user') return { mode: 'dollars', label: `on your ${providerLabel(p) || p} key`, tag: 'your key' };
  if (viewer === 'admin' && costView === 'dollars') return LIST_PRICE;
  if (costView === 'share' && audience.pctPerUsd) return { mode: 'share', pctPerUsd: audience.pctPerUsd };
  return { mode: 'bands' };
};

/** True when every row of a table shows dollars, so it can keep its per-axis dollar columns. */
export const allRowsInDollars = (audience: CostAudience): boolean =>
  audience.kind === 'signed_out' ||
  (audience.kind === 'signed_in' && audience.fields.viewer === 'admin' && audience.fields.costView === 'dollars');

// ---------------------------------------------------------------------------------------------------------
// The yardstick a row is banded on, and the bands.
// ---------------------------------------------------------------------------------------------------------

type PriceGroup = 'text' | 'text_input' | 'image' | 'image_tokens' | 'request';
const GROUP_NOUN: Record<PriceGroup, string> = {
  text: 'text models',
  text_input: 'text models',
  image: 'image models',
  image_tokens: 'token-billed image models',
  request: 'per-request models'
};

export type Yardstick =
  | { kind: 'free' }
  /** A negative axis: the provider's "variable" / "not published" marker. Never banded, never "free". */
  | { kind: 'unpublished' }
  /** No price we can compare on. */
  | { kind: 'unknown' }
  | { kind: 'priced'; group: PriceGroup; usd: number; unit: 'image' | 'request' | 'mtok_out' | 'mtok_in' };

type PricedModel = Pick<CatalogModel, 'pricing' | 'supportsImageOutput' | 'isFree'>;

export const modelYardstick = (m: PricedModel): Yardstick => {
  const p = m.pricing;
  const axes = [p.promptPerToken, p.completionPerToken, p.imagePerImage, p.requestFlat];
  if (axes.some((v) => typeof v === 'number' && v < 0)) return { kind: 'unpublished' };
  if (m.isFree) return { kind: 'free' };
  if (m.supportsImageOutput && p.imagePerImage > 0) return { kind: 'priced', group: 'image', usd: p.imagePerImage, unit: 'image' };
  if (p.completionPerToken > 0) {
    return { kind: 'priced', group: m.supportsImageOutput ? 'image_tokens' : 'text', usd: p.completionPerToken * 1_000_000, unit: 'mtok_out' };
  }
  if (p.requestFlat > 0) return { kind: 'priced', group: 'request', usd: p.requestFlat, unit: 'request' };
  if (p.promptPerToken > 0) return { kind: 'priced', group: 'text_input', usd: p.promptPerToken * 1_000_000, unit: 'mtok_in' };
  return { kind: 'unknown' };
};

/** A curated per-image price (services/imageModelRanking). `undefined` = not known. */
export const perImageYardstick = (usd: number | undefined): Yardstick =>
  typeof usd !== 'number' || !Number.isFinite(usd) ? { kind: 'unknown' }
    : usd < 0 ? { kind: 'unpublished' }
    : usd === 0 ? { kind: 'free' }
    : { kind: 'priced', group: 'image', usd, unit: 'image' };

export type UsageBand = 'lower' | 'moderate' | 'higher';
export const USAGE_BAND_LABEL: Record<UsageBand, string> = {
  lower: 'Lower usage',
  moderate: 'Moderate usage',
  higher: 'Higher usage'
};
/** Below this many priced models in a group, a tertile says nothing: the rows are not banded. */
export const MIN_BAND_GROUP = 3;

/** row key → band. A key that is absent is not banded (free, unpublished, unknown, or a tiny group). */
export type BandIndex = ReadonlyMap<string, UsageBand>;

export const buildBandIndex = <T>(items: readonly T[], keyOf: (item: T) => string, stickOf: (item: T) => Yardstick): BandIndex => {
  const groups = new Map<PriceGroup, Array<{ key: string; usd: number }>>();
  for (const item of items) {
    const y = stickOf(item);
    if (y.kind !== 'priced') continue;
    const list = groups.get(y.group) ?? [];
    list.push({ key: keyOf(item), usd: y.usd });
    groups.set(y.group, list);
  }
  const out = new Map<string, UsageBand>();
  for (const list of groups.values()) {
    if (list.length < MIN_BAND_GROUP) continue;
    const sorted = list.map((x) => x.usd).sort((a, b) => a - b);
    const n = sorted.length;
    for (const { key, usd } of list) {
      // Rows priced below this one (ties share a band, so equal prices never land in different bands).
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < usd) lo = mid + 1;
        else hi = mid;
      }
      out.set(key, lo * 3 < n ? 'lower' : lo * 3 < 2 * n ? 'moderate' : 'higher');
    }
  }
  return out;
};

export const modelCostKey = (m: Pick<CatalogModel, 'source' | 'id'>): string => `${m.source}:${m.id}`;

/** Bands for the catalog the page lists (every model in scope, not just the filtered rows). */
export const modelBandIndex = (models: readonly CatalogModel[]): BandIndex =>
  buildBandIndex<CatalogModel>(models, modelCostKey, modelYardstick);

// ---------------------------------------------------------------------------------------------------------
// The words (and, only in dollar mode, the figures).
// ---------------------------------------------------------------------------------------------------------

export interface CostText {
  /** 'fixed' = the same words for everyone (Free, Price not published). */
  mode: 'dollars' | 'share' | 'bands' | 'loading' | 'fixed';
  /** Short form for a cell, a chip or a pick: "$15.00/M out", "≈0.3% per image", "Lower usage". Empty while loading. */
  short: string;
  /** A sentence for a card or the detail modal. Empty while loading. */
  sentence: string;
  /** What a dollar figure is ("list price", "on your OpenRouter key"); empty otherwise. */
  note: string;
  /** The note's short form for a table cell or chip ("list price", "your key"); empty otherwise. */
  noteShort: string;
}

const LOADING: CostText = { mode: 'loading', short: '', sentence: '', note: '', noteShort: '' };
const UNPUBLISHED: CostText = { mode: 'fixed', short: 'Price not published', sentence: 'The provider does not publish a fixed price for this model.', note: '', noteShort: '' };
/** No price on any axis, and not marked free (a live listing without prices): no "free", no band. */
const NOT_LISTED: CostText = { mode: 'fixed', short: 'Price not listed', sentence: 'The provider does not list a price for this model.', note: '', noteShort: '' };
/** A priced row in a group too small to band (or with no comparable price): no relative claim is made. */
const NOT_BANDED: CostText = { mode: 'bands', short: 'Uses your usage', sentence: 'Uses your usage. Too few similar models are listed here to compare.', note: '', noteShort: '' };
const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const usd2 = (n: number) => `$${n.toFixed(2)}`;
/** "$15.00/M out", "$0.040/img": one figure per row, the same yardstick the bands use. */
const dollarsShort = (y: Extract<Yardstick, { kind: 'priced' }>): string => {
  switch (y.unit) {
    case 'image': return `$${y.usd.toFixed(3)}/img`;
    case 'request': return `$${y.usd.toFixed(4)}/req`;
    case 'mtok_out': return `${usd2(y.usd)}/M out`;
    case 'mtok_in': return `${usd2(y.usd)}/M in`;
  }
};

/** Usage words for a priced row that is not in dollars (share where a per-call unit exists, else its band). */
const usageWords = (y: Extract<Yardstick, { kind: 'priced' }>, mode: RowCostMode, band: UsageBand | undefined): CostText => {
  if (mode.mode === 'share' && (y.unit === 'image' || y.unit === 'request')) {
    const share = formatCostForUser(y.usd, { governed: true, pctPerUsd: mode.pctPerUsd });
    const compact = compactUsageShare(share);
    if (compact) return { mode: 'share', short: `${compact} per ${y.unit}`, sentence: `Each ${y.unit} uses ${share}.`, note: '', noteShort: '' };
  }
  if (!band) return NOT_BANDED;
  const noun = GROUP_NOUN[y.group];
  const sentence = band === 'moderate' ? `Moderate usage for ${noun} listed here.` : `${USAGE_BAND_LABEL[band]} than most ${noun} listed here.`;
  return { mode: 'bands', short: USAGE_BAND_LABEL[band], sentence, note: '', noteShort: '' };
};

/** Cost words for a catalog model under this audience. */
export const modelCostText = (m: CatalogModel, audience: CostAudience, bands: BandIndex): CostText => {
  const y = modelYardstick(m);
  if (y.kind === 'unpublished') return UNPUBLISHED;
  // Checked before any dollar or band wording: describeCost would call an all-zero row "free".
  if (y.kind === 'unknown') return NOT_LISTED;
  const describe = () => describeCost({ modelId: m.id, pricing: m.pricing, supportsImageOutput: m.supportsImageOutput });
  // describeCost's free sentences carry no figure ("No cost on any axis …"), so they read the same for everyone.
  if (y.kind === 'free') return { mode: 'fixed', short: 'Free', sentence: describe(), note: '', noteShort: '' };
  const mode = rowCostMode(audience, m.source);
  if (mode.mode === 'loading') return LOADING;
  if (mode.mode === 'dollars') {
    return { mode: 'dollars', short: dollarsShort(y), sentence: `${describe()} ${capitalise(mode.label)}.`, note: mode.label, noteShort: mode.tag };
  }
  return usageWords(y, mode, bands.get(modelCostKey(m)));
};

/**
 * Cost words for a curated row with no route of its own (the image ranking): no payer applies, so it is
 * dollars only for a signed-out visitor or an admin. `dollars` is the caller's own approximate figure.
 */
export const curatedCostText = (y: Yardstick, audience: CostAudience, band: UsageBand | undefined, dollars: string): CostText => {
  if (y.kind === 'unpublished') return UNPUBLISHED;
  if (y.kind === 'unknown') return NOT_LISTED;
  if (y.kind === 'free') return { mode: 'fixed', short: 'Free', sentence: 'Free.', note: '', noteShort: '' };
  const mode = rowCostMode(audience, null);
  if (mode.mode === 'loading') return LOADING;
  if (mode.mode === 'dollars') return { mode: 'dollars', short: dollars, sentence: `${dollars} (${mode.label}).`, note: mode.label, noteShort: mode.tag };
  return usageWords(y, mode, band);
};

/** Per-axis list prices for the detail and compare views, or null unless this row shows dollars. */
export const dollarAxes = (
  m: CatalogModel,
  mode: RowCostMode
): { input: string; output: string; image: string; request: string } | null => {
  if (mode.mode !== 'dollars') return null;
  const p = m.pricing;
  const pos = (v: number) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  return {
    input: pos(p.promptPerToken) ? `${usd2(p.promptPerToken * 1_000_000)}/M` : '—',
    output: pos(p.completionPerToken) ? `${usd2(p.completionPerToken * 1_000_000)}/M` : '—',
    image: pos(p.imagePerImage) ? `$${p.imagePerImage.toFixed(3)}` : '—',
    request: pos(p.requestFlat) ? `$${p.requestFlat.toFixed(4)}` : '—'
  };
};

/** A dollar figure: "$3", "$ 0.04", "$15.00". */
const DOLLAR_FIGURE = /\$\s?\d/;
/** "$0", "$0.00" (and not "$0.04"): reads "free" outside dollars. */
const ZERO_DOLLARS = /\$\s?0(?:\.0+)?(?![\d,]|\.\d)/g;

/**
 * A model's own words (description, editorial note, a drawback or a possibility) as the viewer of that
 * row may read them. In dollars (`mode` from rowCostMode for the model's provider) the text is unchanged.
 * Otherwise "$0" reads "free" ("Labelled \"free per image\" but actually billed per token"), and any
 * sentence that still carries a dollar figure is left out; the result may be empty (then show nothing).
 */
export const costSafeText = (text: string | null | undefined, mode: RowCostMode): string => {
  if (!text) return '';
  if (mode.mode === 'dollars') return text;
  const freed = text.replace(ZERO_DOLLARS, 'free');
  if (!DOLLAR_FIGURE.test(freed)) return freed;
  // Sentences end at . ! or ? followed by whitespace, so "$3.00" never splits.
  return freed
    .replace(/([.!?])\s+/g, '$1\u0001')
    .split('\u0001')
    .filter((sentence) => !DOLLAR_FIGURE.test(sentence))
    .join(' ')
    .trim();
};

// ---------------------------------------------------------------------------------------------------------
// The page's view: who is looking (read fresh for each visit) and the catalog's bands.
// ---------------------------------------------------------------------------------------------------------

export interface CostView {
  audience: CostAudience;
  bands: BandIndex;
}

/**
 * Who is looking. Signed out: no request. Signed in: ONE fresh GET /api/usage/allowance per visit (and per
 * change of user) through the shared store (services/usageAllowance; coalesced with any read already in
 * flight, never on a timer). The store's cached status is never shown first: it is not tied to a user and
 * survives sign-out, so it could be someone else's. Until our own read answers, cost cells are skeletons;
 * after ALLOWANCE_WAIT_MS without an answer (or an answer without the cost fields) they settle on bands.
 * Later publishes (a spend, a billing-prefs change) are followed once our read has answered.
 */
export const useCostAudience = (userId: string | null | undefined): CostAudience => {
  const signedIn = Boolean(userId);
  const [status, setStatus] = useState<AllowanceStatus | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    setStatus(null);
    setTimedOut(false);
    if (!userId) return;
    let active = true;
    let answered = false;
    const off = subscribeAllowanceStatus((s) => {
      if (active && answered) setStatus(s);
    });
    void refreshAllowanceStatus(0).then((s) => {
      if (!active || !s) return;
      answered = true;
      setStatus(s);
    });
    const timer = setTimeout(() => {
      if (active) setTimedOut(true);
    }, ALLOWANCE_WAIT_MS);
    return () => {
      active = false;
      off();
      clearTimeout(timer);
    };
  }, [userId]);

  return useMemo(() => costAudience({ signedIn, status, timedOut }), [signedIn, status, timedOut]);
};
