// Synthetic fixtures for the model picker tests and the QA scenes (no real user data). The catalog rows are
// SYNTHETIC, shaped like the 2026-10-22 research data (models.md §1). Where a row carries a public figure it is the
// one §1 records (OpenRouter list prices and 24 h uptime per endpoint, Google's token table, the LMArena and
// Artificial Analysis edit boards), so nothing on a QA screen contradicts the research. Some fields are made up or
// emptied on purpose to exercise a UI state, and are not facts:
//   - Nano Banana 2.1 `reliability` (12 calls · 1 failed · 1 rate-limited) and any `observed` costs a test passes in;
//   - Seedream 5 Pro has no endpoints and no board entries here (§1 lists 1 endpoint at 99.47% and AA edit #8), so the
//     §4.6 "No uptime data right now" and "Not ranked on public leaderboards yet" states render;
//   - `uptime30m` is null throughout (§1 records only the 24 h figure).
//
//   lakeDoc()      f8312c86-shaped: 5 drawn pages, 4 character sheets and a cover on Nano Banana 2.1, Draft (1K),
//                  4:5 pages, locked at the first render.
//   freshDoc()     nothing drawn yet (unlocked), Standard (2K), 2:3 pages.
//   catalogRows()  Nano Banana 2.1 (1 provider), Nano Banana Pro (2 providers), GPT Image 2.5 (hidden, 4:5 blocked),
//                  Seedream 5 Pro (hidden, no 2K price) — as GET /api/comic/models/catalog serves them.

import { createEmptyDoc, emptyRender, type Character, type ComicDoc, type Page, type RenderState } from '../../../../shared/comic/doc';
import type { ModelCatalogRow } from '../../../../shared/comic/modelCatalog';

/** 2026-10-29T12:00:00Z — every relative time in the tests reads from here. */
export const NOW = Date.parse('2026-10-29T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

const drawn = (path: string, model: string, at: number, w = 864, h = 1080): RenderState => ({
  status: 'ready',
  history: [],
  asset: { path, source: 'generated', at, model, w, h },
  model,
  updatedAt: at
});

const page = (n: number, castIds: string[], render: RenderState): Page => ({
  id: `pg_${n}`,
  n,
  summary: `Page ${n}: the lake at dusk`,
  layout: 'Row 1: one wide panel. Row 2: two equal panels.',
  panels: [
    { id: `pg_${n}_p1`, n: 1, size: 'wide', shot: 'establishing', action: 'Mist over the lake', castIds, lines: [] },
    { id: `pg_${n}_p2`, n: 2, size: 'medium', shot: 'medium', action: 'They row out', castIds, lines: [] }
  ],
  render,
  balloons: []
});

const member = (id: string, name: string, sheet: RenderState): Character => ({
  id,
  name,
  tier: 'lead',
  look: { summary: `${name}, synthetic test character` },
  refs: [],
  sheet
});

export interface LakeOptions {
  model?: string;
  /** Characters on page 3 (5 → the "holds up to 4" warning on Nano Banana 2.1). */
  page3Cast?: number;
  budgetUsd?: number;
  spentUsd?: number;
  locked?: boolean;
}

export const lakeDoc = (opts: LakeOptions = {}): ComicDoc => {
  const model = opts.model ?? 'nano-banana-2.1';
  const base = createEmptyDoc('proj_lake', 'The Lake', NOW - 86_400_000);
  const cast = ['Asha', 'Ravi', 'Mira', 'Dev', 'Kiran'].map((name, i) =>
    member(`c_${name.toLowerCase()}`, name, i < 4 ? drawn(`u/x/p/sheet_${i}.webp`, model, NOW - 80_000_000 + i) : emptyRender())
  );
  const castIds = cast.map((c) => c.id);
  const pages = [1, 2, 3, 4, 5].map((n) => page(n, n === 3 ? castIds.slice(0, opts.page3Cast ?? 2) : castIds.slice(0, 2), drawn(`u/x/p/page_${n}.webp`, model, NOW - 70_000_000 + n)));
  const doc: ComicDoc = {
    ...base,
    rev: 42,
    format: { ...base.format, pageAspect: '4:5', pageCount: 5 },
    settings: { ...base.settings, quality: 'draft', ...(opts.budgetUsd ? { budgetUsd: opts.budgetUsd } : {}) },
    cast,
    pages,
    cover: { ...base.cover, render: drawn('u/x/p/cover.webp', model, NOW - 60_000_000) },
    spend: { ...base.spend, totalUsd: opts.spentUsd ?? 0.75 },
    planStatus: 'approved'
  };
  if (opts.locked !== false) doc.imageModel = { modelId: model, lockedAt: NOW - 80_000_000, origin: 'first_render' };
  return doc;
};

export const freshDoc = (): ComicDoc => {
  const base = createEmptyDoc('proj_fresh', 'Fresh Start', NOW - 3_600_000);
  return {
    ...base,
    format: { ...base.format, pageAspect: '2:3', pageCount: 4 },
    settings: { ...base.settings, quality: 'standard' },
    cast: [member('c_asha', 'Asha', emptyRender()), member('c_ravi', 'Ravi', emptyRender())],
    pages: [1, 2, 3, 4].map((n) => page(n, ['c_asha', 'c_ravi'], emptyRender()))
  };
};

const LMA_SOURCE = 'LMArena leaderboard-dataset (Hugging Face, CC BY 4.0), image_edit · latest split, published 2026-10-20';
const AA_SOURCE = 'Artificial Analysis Image Arena v2.1, image editing leaderboard (artificialanalysis.ai), page data 2026-10-22T17:51Z — research pull; refreshed only by the owner-run script';

export interface CatalogOptions {
  /** How old the price/uptime fetch is (default 5 min). */
  ageMs?: number;
  stale?: boolean;
  /** Nano Banana 2.1 observed page costs (n, median, min, max at 1K). */
  observed?: { n: number; median: number; min: number; max: number };
}

export const catalogRows = (opts: CatalogOptions = {}): ModelCatalogRow[] => {
  const fetched = iso(NOW - (opts.ageMs ?? 5 * 60_000));
  const at = { catalog: fetched, uptime: fetched, quality: '2026-10-22T17:51:00Z' };
  const stale = !!opts.stale;
  return [
    {
      id: 'nano-banana-2.1',
      nickname: 'Nano Banana 2.1',
      providerModel: 'google/gemini-nano-banana-2.1',
      canonicalSlug: 'google/gemini-nano-banana-2.1-20261006',
      pickable: true,
      lifecycle: 'ga',
      price: {
        '1K': { usd: 0.0336, basis: 'vendor_table' },
        '2K': { usd: 0.0504, basis: 'vendor_table' },
        '4K': { usd: 0.113, basis: 'vendor_table' }
      },
      perRefUsd: null,
      // §1.1 #1: 1 endpoint · Google AI Studio 97.72%. §1.2 #1: LMArena edit #5 · 1426.2, AA Edit #4 · 1152 ±13.
      endpoints: [{ provider: 'Google AI Studio', uptime1d: 97.72, uptime30m: null }],
      quality: [
        { board: 'lmarena_edit', rank: 5, of: 60, score: 1426.2, asOf: '2026-10-20', source: LMA_SOURCE },
        { board: 'aa_edit', rank: 4, of: 74, score: 1152, ci: [1139, 1165], asOf: '2026-10-22T17:51:00Z', source: AA_SOURCE }
      ],
      observed: opts.observed
        ? [{ kind: 'page', res: '1K', n: opts.observed.n, medianUsd: opts.observed.median, minUsd: opts.observed.min, maxUsd: opts.observed.max, from: iso(NOW - 9e8), to: iso(NOW - 1e7), scope: 'you' }]
        : [],
      reliability: { windowH: 24, calls: 12, failed: 1, rateLimited: 1, scope: 'you' },
      fetchedAt: at,
      stale
    },
    {
      id: 'nano-banana-pro',
      nickname: 'Nano Banana Pro',
      providerModel: 'google/gemini-3-pro-image',
      pickable: true,
      lifecycle: 'ga',
      price: {
        '1K': { usd: 0.1344, basis: 'vendor_table' },
        '2K': { usd: 0.1344, basis: 'vendor_table' },
        '4K': { usd: 0.24, basis: 'vendor_table' }
      },
      perRefUsd: null,
      // §1.1 #2: 2 endpoints · AI Studio 98.33%, Vertex 100%.
      endpoints: [
        { provider: 'Google AI Studio', uptime1d: 98.33, uptime30m: null },
        { provider: 'Google Vertex', uptime1d: 100, uptime30m: null }
      ],
      quality: [
        { board: 'lmarena_edit', rank: 13, of: 60, score: 1390.2, asOf: '2026-10-20', source: LMA_SOURCE },
        { board: 'aa_edit', rank: 16, of: 74, score: 1108, ci: [1096, 1120], asOf: '2026-10-22T17:51:00Z', source: AA_SOURCE }
      ],
      observed: [],
      fetchedAt: at,
      stale
    },
    {
      id: 'gpt-image-2.5',
      nickname: 'GPT Image 2.5',
      providerModel: 'openai/gpt-image-2.5-sunburst',
      pickable: false,
      lifecycle: 'experimental',
      price: { '1K': { usd: 0.2107, basis: 'registry', note: 'from our price list, 2026-10-22' } },
      perRefUsd: null,
      // §1.1 #5: 1 endpoint · OpenAI 100%. §1.2 #5: LMArena edit #1 · 1514.4, AA Edit #1 · 1200 ±11.
      endpoints: [{ provider: 'OpenAI', uptime1d: 100, uptime30m: null }],
      quality: [
        { board: 'lmarena_edit', rank: 1, of: 60, score: 1514.4, asOf: '2026-10-20', source: LMA_SOURCE },
        { board: 'aa_edit', rank: 1, of: 74, score: 1200, ci: [1189, 1211], asOf: '2026-10-22T17:51:00Z', source: AA_SOURCE }
      ],
      observed: [],
      fetchedAt: at,
      stale
    },
    {
      id: 'seedream-5-pro',
      nickname: 'Seedream 5 Pro',
      providerModel: 'bytedance-seed/seedream-5-0-pro',
      pickable: false,
      lifecycle: 'experimental',
      price: {
        '1K': { usd: 0.045, basis: 'openrouter_endpoint' },
        '2K': { usd: null, basis: 'openrouter_endpoint', note: "Price per image isn't published · you'll see the real cost after the first image" }
      },
      perRefUsd: 0.003,
      endpoints: [],
      quality: [],
      observed: [],
      fetchedAt: at,
      stale
    }
  ];
};
