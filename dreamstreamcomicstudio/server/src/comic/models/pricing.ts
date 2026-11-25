// Prices for Comic Studio image models (models.md §2.3 quotes, §4.3 price mapping rules, §4.6 missing-data copy).
//
// Two pure pieces:
//   1. `mapEndpointPricing` turns OpenRouter's documented per-endpoint `pricing[]` lines into one price per
//      resolution with a basis and, where a number cannot honestly be derived, `null` plus the exact copy.
//   2. `priceBookFromSources` (shared/comic/priceBook.ts, re-exported here) implements the shared PriceBook contract:
//      unit = max(list + perRefUsd × refs, observed median), where the observed median is the user's last ≤ 20 same
//      model/kind/resolution calls when n ≥ 3 (platform aggregate as a fallback when it has ≥ 5 distinct users);
//      QC = max(observed median when n ≥ 5, QC_USD_PER_PAGE); text rates from textRates.ts. models/index.ts wraps
//      it as `createPriceBook(deps)`, which loads the sources for one user first; the client builds the same book
//      from the sources GET /api/comic/models/prices serves.
//
// Nothing here fetches, times or guesses: every number is either a live OpenRouter line, a vendor-published
// tokens-per-image table, the registry's dated price list, or our own observed costs.

import type { Resolution } from '../../../../shared/comic/doc.js';
import type { ImageModelSpec } from '../../../../shared/comic/models.js';
import { NO_OPENROUTER_PRICE_COPY, registryPrices, type SharedPriceBook } from '../../../../shared/comic/priceBook.js';
import type { CatalogPrice, OrImageEndpoint, OrPricingLine, PriceBasis } from './catalog.js';

// The PriceBook itself lives in shared/comic/priceBook.ts (the client builds the same book from the sources the
// server serves); these names stay importable from here.
export {
  NO_OPENROUTER_PRICE_COPY,
  OBSERVED_MIN_N,
  OBSERVED_WINDOW,
  PRICE_UNPUBLISHED_COPY,
  QC_OBSERVED_MIN_N,
  priceBookFromSources,
  registryPrices,
  type JobQuote,
  type ObservedMedian,
  type PriceBookRow,
  type PriceBookSources,
  type PriceQuote,
  type QuoteBasis
} from '../../../../shared/comic/priceBook.js';
/** The server's name for the shared book (the same type). */
export type ServerPriceBook = SharedPriceBook;

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

// ── §4.6 exact copy ───────────────────────────────────────────────────────────

/** The note on a `unit: token` line with no published tokens-per-image table. */
export const PER_TOKEN_NOTE = 'billed per token; tokens per image not published';

// ── Vendor tokens-per-image tables (only where published) ────────────────────

/**
 * Google's image-output tokens per image (ai.google.dev pricing + image-generation pages, re-checked 2026-10-22,
 * models.md §1.1 #1–4, #25 and §7.1). Keyed by OpenRouter id. 4K on Nano Banana 2.1 is a documented conflict
 * (2520 tokens on the image-generation token table vs 3780 on the pricing page); we quote the higher, the
 * pricing page's (§1.6 #2), and say so with both numbers (§4.6).
 */
export const GOOGLE_TOKENS_PER_IMAGE: Record<string, Partial<Record<Resolution, number>>> = {
  'google/gemini-nano-banana-2.1': { '1K': 1120, '2K': 1680, '4K': 3780 },
  'google/gemini-3-pro-image': { '1K': 1120, '2K': 1120, '4K': 2000 },
  'google/gemini-3.1-flash-image': { '512': 750, '1K': 1120, '2K': 1680, '4K': 2520 },
  'google/gemini-3.1-flash-lite-image': { '1K': 1120 },
  'google/gemini-2.5-flash-image': { '1K': 1290 }
};
export const GOOGLE_TOKEN_TABLE_SOURCE = 'Google image token table (ai.google.dev, 2026-10-22)';
const GOOGLE_PRICING_PAGE_SOURCE = 'Google pricing page (ai.google.dev, 2026-10-22)';
/** models.md §4.6 "Data sources disagree", with the number we actually quote. */
export const google4kConflictNote = (quotedUsd: number) => `Google lists 4K as $0.076 in one place and $0.113 in another; we quote ${money(quotedUsd)}`;

/** Square-image megapixels per resolution tier (long side 512 / 1024 / 2048 / 4096). */
export const MEGAPIXELS: Record<Resolution, number> = { '512': 0.262144, '1K': 1.048576, '2K': 4.194304, '4K': 16.777216 };
const SQUARE_SIDE: Record<Resolution, number> = { '512': 512, '1K': 1024, '2K': 2048, '4K': 4096 };

const RESOLUTION_ORDER: Resolution[] = ['512', '1K', '2K', '4K'];

/** OpenRouter variant / resolution-enum spelling → our Resolution ('1k', '2K', '4k', '512'); undefined when it is not one. */
export const variantToResolution = (raw: unknown): Resolution | undefined => {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '512') return '512';
  if (v === '1k' || v === '1024') return '1K';
  if (v === '2k' || v === '2048') return '2K';
  if (v === '4k' || v === '4096') return '4K';
  return undefined;
};

const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const money = (n: number) => `$${round4(n)}`;

export interface EndpointPricingInput {
  /** OpenRouter model id, e.g. 'google/gemini-nano-banana-2.1'. */
  modelId: string;
  endpoints: OrImageEndpoint[];
  /** The registry entry when the model is one of ours (fallbacks, perRefUsd, factsAsOf). */
  spec?: ImageModelSpec;
  /** ISO time of the fetch these endpoints came from (for the notes). */
  fetchedAt?: string;
}

export interface EndpointPricingResult {
  price: Partial<Record<Resolution, CatalogPrice>>;
  perRefUsd: number | null;
  /** Provider names that carried an output_image price line. */
  providers: string[];
}

interface Candidate {
  provider: string;
  usd: number | null;
  basis: PriceBasis;
  note?: string;
}

/** Resolutions an endpoint says it serves (its `resolution` enum), mapped; empty when it takes no resolution. */
const endpointResolutions = (ep: OrImageEndpoint): Resolution[] => {
  const values = (ep.supported_parameters?.resolution as { values?: unknown[] } | undefined)?.values;
  if (!Array.isArray(values)) return [];
  return values.map(variantToResolution).filter((r): r is Resolution => !!r);
};

/**
 * How an endpoint is named in notes: its provider name, plus its tag when another endpoint of the same model has
 * the same name ("Google Vertex (google-vertex/us)" next to "Google Vertex (google-vertex/global)").
 */
export const imageEndpointLabel = (ep: OrImageEndpoint, all: OrImageEndpoint[]): string => {
  const name = String(ep.provider_name || ep.provider_slug || 'OpenRouter');
  const tag = ep.provider_tag || ep.provider_slug;
  const shared = all.filter((o) => String(o.provider_name || o.provider_slug || 'OpenRouter') === name).length > 1;
  return shared && tag && tag !== name ? `${name} (${tag})` : name;
};

/** One endpoint's candidate price per resolution (models.md §4.3 mapping rules). */
const endpointCandidates = (modelId: string, ep: OrImageEndpoint, wanted: Resolution[], provider: string, spec?: ImageModelSpec): Map<Resolution, Candidate> => {
  const out = new Map<Resolution, Candidate>();
  const lines: OrPricingLine[] = Array.isArray(ep.pricing) ? ep.pricing : [];
  const outputs = lines.filter((l) => l && (l.billable === undefined || l.billable === 'output_image'));
  if (!outputs.length) {
    for (const r of wanted) out.set(r, { provider, usd: null, basis: 'openrouter_endpoint', note: NO_OPENROUTER_PRICE_COPY });
    return out;
  }
  const served = endpointResolutions(ep);
  const imageLines = outputs.filter((l) => l.unit === 'image');
  const mpLine = outputs.find((l) => l.unit === 'megapixel' && isFiniteNumber(l.cost_usd));
  const tokenLine = outputs.find((l) => l.unit === 'token' && isFiniteNumber(l.cost_usd));

  if (imageLines.length) {
    const base = imageLines.find((l) => !l.variant && isFiniteNumber(l.cost_usd));
    const variants = imageLines.filter((l) => typeof l.variant === 'string' && isFiniteNumber(l.cost_usd));
    const mapped = new Map<Resolution, number>();
    const unmapped: string[] = [];
    for (const v of variants) {
      const res = variantToResolution(v.variant);
      if (res) mapped.set(res, v.cost_usd as number);
      else unmapped.push(String(v.variant));
    }
    // A base price with resolution variants is the LOWEST tier (Riverflow: base = 1K); without variants it
    // applies to every resolution.
    if (base) {
      if (variants.length) {
        const tiers = served.length ? served : wanted;
        const lowest = RESOLUTION_ORDER.find((r) => tiers.includes(r)) ?? '1K';
        if (!mapped.has(lowest)) mapped.set(lowest, base.cost_usd as number);
      } else {
        for (const r of wanted) if (!mapped.has(r)) mapped.set(r, base.cost_usd as number);
      }
    }
    for (const r of wanted) {
      const usd = mapped.get(r);
      if (isFiniteNumber(usd)) out.set(r, { provider, usd: round6(usd), basis: 'openrouter_endpoint' });
      else if (unmapped.length) out.set(r, { provider, usd: null, basis: 'openrouter_endpoint', note: `unmapped variant "${unmapped.join('", "')}"` });
      else out.set(r, { provider, usd: null, basis: 'openrouter_endpoint', note: `OpenRouter lists no ${r} price on ${provider}` });
    }
    return out;
  }
  if (mpLine) {
    for (const r of wanted) {
      const usd = round6((mpLine.cost_usd as number) * MEGAPIXELS[r]);
      out.set(r, { provider, usd, basis: 'derived_mp', note: `${money(mpLine.cost_usd as number)} per megapixel × ${MEGAPIXELS[r].toFixed(2)} MP (${SQUARE_SIDE[r]}² square)` });
    }
    return out;
  }
  if (tokenLine) {
    const table = GOOGLE_TOKENS_PER_IMAGE[modelId];
    for (const r of wanted) {
      const tokens = table?.[r];
      if (isFiniteNumber(tokens)) {
        const usd = round6(tokens * (tokenLine.cost_usd as number));
        const conflicted = modelId === 'google/gemini-nano-banana-2.1' && r === '4K';
        const source = conflicted ? GOOGLE_PRICING_PAGE_SOURCE : GOOGLE_TOKEN_TABLE_SOURCE;
        out.set(r, { provider, usd, basis: 'vendor_table', note: `${tokens} tokens × $${round4((tokenLine.cost_usd as number) * 1_000_000)}/M (${source})${conflicted ? ` · ${google4kConflictNote(usd)}` : ''}` });
      } else if (r === '1K' && isFiniteNumber(spec?.outputTokenEstimate)) {
        const estimate = spec.outputTokenEstimate;
        const usd = round6(estimate * (tokenLine.cost_usd as number));
        out.set(r, { provider, usd, basis: 'vendor_table', note: `Estimated ${estimate.toLocaleString('en-US')} output tokens at ${spec.fixedQuality} quality (OpenAI image calculator; input tokens billed separately)` });
      } else {
        out.set(r, { provider, usd: null, basis: 'openrouter_endpoint', note: PER_TOKEN_NOTE });
      }
    }
    return out;
  }
  for (const r of wanted) out.set(r, { provider, usd: null, basis: 'openrouter_endpoint', note: NO_OPENROUTER_PRICE_COPY });
  return out;
};

/**
 * True when OpenRouter can be told which endpoints may serve a call: only the Images-API transport sends
 * `provider.only` (models.md §2.4 R3.4). On the chat transport (the default) OpenRouter may route a call to any
 * endpoint of the model, so a quote must cover the dearest one (§2.3 "never under-quotes").
 */
export const pinsEndpoints = (spec?: ImageModelSpec): boolean => spec?.api?.openrouter === 'images';

/** Per-reference charge from the endpoints' `input_image` lines (null = unpublished / per token with no table). */
const perReferenceUsd = (endpoints: OrImageEndpoint[], spec?: ImageModelSpec): number | null => {
  const lines = endpoints.flatMap((ep) => (Array.isArray(ep.pricing) ? ep.pricing : [])).filter((l) => l && l.billable === 'input_image');
  const perImage = lines.filter((l) => l.unit === 'image' && isFiniteNumber(l.cost_usd)).map((l) => l.cost_usd as number);
  if (perImage.length) return round6(pinsEndpoints(spec) ? Math.min(...perImage) : Math.max(...perImage));
  if (isFiniteNumber(spec?.perRefUsd)) return spec!.perRefUsd as number; // Google's 560-token table (registry, dated)
  return null;
};

/**
 * Live OpenRouter endpoint pricing → one price per resolution. Only endpoints that serve a resolution are its
 * candidates (an endpoint's `resolution` enum, when it has one, must list it: Nano Banana Pro on Vertex lists
 * no 4K). Several endpoints of one model can differ (Nano Banana 2: $60/M on AI Studio, $66/M on Vertex-US):
 * on the Images-API transport the quote uses the lowest, because the transport pins `provider.only` to the
 * endpoints at or under the quote (§2.4 R3.4); on the chat transport nothing is pinned and OpenRouter may route
 * to any endpoint, so the quote is the highest (§2.3 never under-quotes). The note carries every value with its
 * provider so nothing is smoothed over (§4.6 "data sources disagree").
 */
export const mapEndpointPricing = (input: EndpointPricingInput): EndpointPricingResult => {
  const endpoints = Array.isArray(input.endpoints) ? input.endpoints : [];
  const fromEndpoints = endpoints.flatMap(endpointResolutions);
  const fromSpec = input.spec?.resolutions ?? [];
  const wantedSet = new Set<Resolution>([...fromSpec, ...fromEndpoints]);
  if (!wantedSet.size) wantedSet.add('1K'); // fixed-size transports (OpenAI): one price
  const wanted = RESOLUTION_ORDER.filter((r) => wantedSet.has(r));
  const price: Partial<Record<Resolution, CatalogPrice>> = {};
  const providers = new Set<string>();
  const when = input.fetchedAt ? ` (OpenRouter, ${input.fetchedAt})` : ' (OpenRouter)';
  const pinned = pinsEndpoints(input.spec);
  for (const r of wanted) {
    const serving = endpoints.filter((ep) => {
      const served = endpointResolutions(ep);
      return !served.length || served.includes(r);
    });
    const candidates = serving.map((ep) => endpointCandidates(input.modelId, ep, wanted, imageEndpointLabel(ep, endpoints), input.spec).get(r)).filter((c): c is Candidate => !!c);
    const priced = candidates.filter((c) => isFiniteNumber(c.usd));
    if (priced.length) {
      priced.forEach((c) => providers.add(c.provider));
      const best = priced.reduce((a, b) => (pinned ? (b.usd as number) < (a.usd as number) : (b.usd as number) > (a.usd as number)) ? b : a);
      const distinct = new Set(priced.map((c) => c.usd as number));
      const differ = distinct.size > 1 ? ` · endpoints differ: ${priced.map((c) => `${c.provider} ${money(c.usd as number)}`).join(' · ')}; we quote ${money(best.usd as number)}` : '';
      price[r] = { usd: best.usd, basis: best.basis, note: `${best.note ? `${best.note}` : `${best.provider} endpoint price`}${when}${differ}` };
    } else if (candidates.length) {
      const notes = [...new Set(candidates.map((c) => c.note).filter(Boolean))];
      price[r] = { usd: null, basis: 'openrouter_endpoint', note: notes.join(' · ') || NO_OPENROUTER_PRICE_COPY };
    } else if (endpoints.length) {
      price[r] = { usd: null, basis: 'openrouter_endpoint', note: `No OpenRouter endpoint lists ${r}` };
    }
  }
  return { price, perRefUsd: perReferenceUsd(endpoints, input.spec), providers: [...providers] };
};

/**
 * Live prices first; a resolution OpenRouter cannot price falls back to the registry's dated number
 * (models.md §2.3 step 1), keeping the live note so the UI can say why. Resolutions neither side can price
 * stay null with their copy.
 */
export const mergeWithRegistry = (live: Partial<Record<Resolution, CatalogPrice>>, spec: ImageModelSpec): Partial<Record<Resolution, CatalogPrice>> => {
  const registry = registryPrices(spec);
  const out: Partial<Record<Resolution, CatalogPrice>> = {};
  const keys = RESOLUTION_ORDER.filter((r) => r in live || r in registry);
  for (const r of keys) {
    const l = live[r];
    const g = registry[r];
    if (l && isFiniteNumber(l.usd)) out[r] = l;
    else if (g && isFiniteNumber(g.usd)) out[r] = { ...g, note: l?.note ? `${g.note} · OpenRouter: ${l.note}` : g.note };
    else out[r] = l ?? g!;
  }
  return out;
};

