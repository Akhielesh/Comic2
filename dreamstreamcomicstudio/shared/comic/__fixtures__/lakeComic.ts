// Test fixture shaped like the owner's comic f8312c86 (models.md §3.5 example 1 / §5.1): 4:5 storybook, Draft
// tier, BYOK, 5 drawn pages (page 1 at 2K, pages 2–5 at 1K), 4 character sheets and a cover, all on
// Nano Banana 2.1; 15 image calls totalling $0.7513 plus vision QC and director chat. Synthetic data only.

import { createEmptyDoc, type AssetRef, type ComicDoc, type Page, type RenderState, type Resolution, type SpendEntry } from '../doc.js';

export const LAKE_NOW = 1_761_100_000_000;
export const LAKE_MODEL = 'nano-banana-2.1';

const gen = (path: string, at: number, w: number, h: number, model = LAKE_MODEL): AssetRef => ({ path, source: 'generated', model, at, w, h });

const ready = (path: string, at: number, res: Resolution, w: number, h: number, history: AssetRef[] = [], model = LAKE_MODEL): RenderState => ({
  status: 'ready',
  asset: gen(path, at, w, h, model),
  history,
  model,
  resolution: res,
  aspect: '4:5',
  updatedAt: at
});

const page = (n: number, castIds: string[], render: RenderState): Page => ({
  id: `pg_${n}`,
  n,
  summary: `Page ${n} by the lake`,
  layout: 'Row 1: two equal panels. Row 2: two equal panels.',
  panels: [1, 2].map((k) => ({
    id: `pg_${n}_p${k}`,
    n: k,
    size: 'medium',
    shot: 'medium',
    action: `Panel ${k} on page ${n}`,
    castIds: k === 1 ? castIds : castIds.slice(0, 1),
    lines: [{ id: `pg_${n}_l${k}`, kind: 'caption', text: `Line ${k}` }]
  })),
  render,
  balloons: []
});

/** 15 image calls on Nano Banana 2.1 = $0.7513 (5 current pages, 5 older page versions, 4 sheets, 1 cover). */
const IMAGE_ENTRIES: [kind: SpendEntry['kind'], label: string, usd: number, target: string, res: Resolution][] = [
  ['page', 'Page 1', 0.0579, 'page:pg_1', '2K'],
  ['page', 'Page 2', 0.0428, 'page:pg_2', '1K'],
  ['page', 'Page 3', 0.0465, 'page:pg_3', '1K'],
  ['page', 'Page 4', 0.0474, 'page:pg_4', '1K'],
  ['page', 'Page 5', 0.0538, 'page:pg_5', '1K'],
  ['page', 'Page 1 (v1)', 0.06, 'page:pg_1', '2K'],
  ['page', 'Page 2 (v1)', 0.06, 'page:pg_2', '2K'],
  ['page', 'Page 3 (v1)', 0.06, 'page:pg_3', '2K'],
  ['page', 'Page 4 (v1)', 0.06, 'page:pg_4', '2K'],
  ['page', 'Page 5 (v1)', 0.0598, 'page:pg_5', '2K'],
  ['sheet', 'BABY sheet', 0.0373, 'sheet:c_baby', '1K'],
  ['sheet', 'DUCKLINGS sheet', 0.0376, 'sheet:c_ducks', '1K'],
  ['sheet', 'FROG sheet', 0.0375, 'sheet:c_frog', '1K'],
  ['sheet', 'BUNNY sheet', 0.0374, 'sheet:c_bunny', '1K'],
  ['cover', 'Cover', 0.0533, 'cover', '1K']
];

export const makeLakeComic = (mutate?: (doc: ComicDoc) => void): ComicDoc => {
  const doc = createEmptyDoc('f8312c86-test', 'Playtime at the Lake', LAKE_NOW - 3_600_000);
  doc.rev = 40;
  doc.format = { ...doc.format, kind: 'storybook', pageCount: 5, pageAspect: '4:5', panelsPerPage: 2 };
  doc.settings = { ...doc.settings, quality: 'draft' };
  doc.style = { ...doc.style, status: 'locked', spec: 'Soft storybook watercolor.', board: gen('u/o/p/f/board.webp', LAKE_NOW - 3_000_000, 1024, 1024) };
  const cast = (id: string, name: string, at: number) => ({
    id,
    name,
    tier: 'lead' as const,
    look: { summary: `${name} by the lake` },
    refs: [],
    sheet: ready(`u/o/p/f/${id}.webp`, at, '1K', 1264, 848)
  });
  doc.cast = [
    cast('c_baby', 'The Baby', LAKE_NOW - 2_900_000),
    cast('c_ducks', 'Ducklings', LAKE_NOW - 2_800_000),
    cast('c_frog', 'Frog', LAKE_NOW - 2_700_000),
    cast('c_bunny', 'Bunny', LAKE_NOW - 2_600_000)
  ];
  doc.pages = [
    page(1, ['c_baby', 'c_ducks'], ready('u/o/p/f/p1.webp', LAKE_NOW - 2_000_000, '2K', 1856, 2304, [gen('u/o/p/f/p1-v1.webp', LAKE_NOW - 2_400_000, 1856, 2304)])),
    page(2, ['c_baby', 'c_frog'], ready('u/o/p/f/p2.webp', LAKE_NOW - 1_900_000, '1K', 928, 1152, [gen('u/o/p/f/p2-v1.webp', LAKE_NOW - 2_300_000, 1856, 2304)])),
    page(3, ['c_baby', 'c_bunny'], ready('u/o/p/f/p3.webp', LAKE_NOW - 1_800_000, '1K', 928, 1152, [gen('u/o/p/f/p3-v1.webp', LAKE_NOW - 2_200_000, 1856, 2304)])),
    page(4, ['c_baby', 'c_ducks', 'c_frog'], ready('u/o/p/f/p4.webp', LAKE_NOW - 1_700_000, '1K', 928, 1152, [gen('u/o/p/f/p4-v1.webp', LAKE_NOW - 2_100_000, 1856, 2304)])),
    page(5, ['c_baby', 'c_ducks', 'c_frog', 'c_bunny'], ready('u/o/p/f/p5.webp', LAKE_NOW - 1_600_000, '1K', 928, 1152, [gen('u/o/p/f/p5-v1.webp', LAKE_NOW - 2_050_000, 1856, 2304)]))
  ];
  doc.cover = { title: 'Playtime at the Lake', render: ready('u/o/p/f/cover.webp', LAKE_NOW - 1_500_000, '1K', 928, 1152) };
  doc.planStatus = 'approved';
  const entries: SpendEntry[] = [];
  let at = LAKE_NOW - 2_500_000;
  IMAGE_ENTRIES.forEach(([kind, label, usd, target, res], i) => {
    at += 60_000;
    entries.push({ id: `sp_img_${i}`, at, kind, label, usd, model: LAKE_MODEL, byok: true, estimated: false, target, res, route: 'openrouter', outcome: 'ok' });
  });
  for (let i = 0; i < 7; i += 1) {
    at += 30_000;
    entries.push({ id: `sp_qc_${i}`, at, kind: 'qc', label: `QC page ${(i % 5) + 1}`, usd: 0.0049, model: 'gemini-3.8-flash', byok: true, estimated: false, target: `page:pg_${(i % 5) + 1}` });
  }
  at += 30_000;
  entries.push({ id: 'sp_chat_0', at, kind: 'chat', label: 'Director', usd: 0.0062, model: 'director', byok: false, estimated: false });
  entries.sort((a, b) => b.at - a.at); // newest first, like the server writes them
  const byKind: Record<string, number> = {};
  for (const e of entries) byKind[e.kind] = Math.round(((byKind[e.kind] || 0) + e.usd) * 10000) / 10000;
  doc.spend = { totalUsd: Math.round(entries.reduce((s, e) => s + e.usd, 0) * 10000) / 10000, byKind, entries };
  mutate?.(doc);
  return doc;
};
