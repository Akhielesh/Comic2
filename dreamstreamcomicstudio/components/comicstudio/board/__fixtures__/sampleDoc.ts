// Sample ComicDoc + StudioController fakes shared by the board, reader and export tests.
//
// The doc covers every render state a page card can be in: page 1 drawn (balloons for
// all but one line, so the fallback path is exercised), page 2 planned, page 3 queued,
// page 4 drawing, page 5 drawn but out of date, page 6 failed.

import { vi } from 'vitest';
import {
  createEmptyDoc,
  pageSpecHash,
  type AssetRef,
  type Balloon,
  type ComicDoc,
  type Line,
  type Page,
  type Panel
} from '../../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities';
import type { StudioController } from '../../types';

export const SAMPLE_NOW = 1_760_000_000_000;

export const asset = (path: string, extra: Partial<AssetRef> = {}): AssetRef => ({ path, source: 'generated', at: SAMPLE_NOW, ...extra });

const line = (id: string, kind: Line['kind'], text: string, speakerId?: string): Line => ({
  id,
  kind,
  text,
  ...(speakerId ? { speakerId } : {})
});

const panel = (id: string, n: number, patch: Partial<Panel>): Panel => ({
  id,
  n,
  size: 'medium',
  shot: 'medium',
  action: '',
  castIds: [],
  lines: [],
  ...patch
});

const page = (id: string, n: number, patch: Partial<Page>): Page => ({
  id,
  n,
  summary: `Page ${n} summary`,
  layout: 'Row 1: one wide panel (panel 1). Row 2: two equal panels side by side (panels 2–3).',
  panels: [
    panel(`${id}_p1`, 1, {
      size: 'wide',
      shot: 'establishing',
      action: 'The spice market at dawn, stalls opening under striped awnings.',
      castIds: [],
      placeId: 'pl_market',
      lines: [line(`${id}_l1`, 'caption', 'Old Delhi. Before the heat.')]
    }),
    panel(`${id}_p2`, 2, {
      shot: 'close_up',
      action: 'Maya slips a saffron tin into her satchel.',
      castIds: ['ch_maya'],
      lines: [line(`${id}_l2`, 'whisper', 'Just one more…', 'ch_maya')]
    }),
    panel(`${id}_p3`, 3, {
      shot: 'medium',
      action: 'Arjun grabs her wrist; the vendor gapes behind them.',
      castIds: ['ch_maya', 'ch_arjun', 'ch_vendor'],
      lines: [
        line(`${id}_l3`, 'shout', 'Thief!', 'ch_vendor'),
        line(`${id}_l4`, 'speech', 'You owe me an explanation, Maya.', 'ch_arjun'),
        line(`${id}_l5`, 'sfx', 'GRAB')
      ]
    })
  ],
  render: { status: 'none', history: [] },
  balloons: [],
  ...patch
});

const balloonsFor = (id: string): Balloon[] => [
  { lineId: `${id}_l1`, x: 0.04, y: 0.04, w: 0.3 },
  { lineId: `${id}_l2`, x: 0.06, y: 0.5, w: 0.22, tailX: 0.2, tailY: 0.7 },
  { lineId: `${id}_l3`, x: 0.55, y: 0.5, w: 0.2, tailX: 0.8, tailY: 0.75, pinned: true },
  { lineId: `${id}_l5`, x: 0.6, y: 0.8, w: 0.2 }
  // l4 has no balloon on purpose (fallback placement).
];

/** A fully populated sample comic. `mutate` can tweak the result before stale hashes are computed. */
export const makeSampleDoc = (mutate?: (doc: ComicDoc) => void): ComicDoc => {
  const doc = createEmptyDoc('proj_sample', 'The Saffron Thief', SAMPLE_NOW);
  doc.rev = 12;
  doc.brief = {
    title: 'The Saffron Thief',
    logline: 'A pickpocket steals saffron to pay for her brother’s surgery.',
    premise: 'Maya works the Old Delhi spice market; her best friend Arjun is a cop.',
    genre: 'Crime drama',
    tone: 'Warm, tense',
    audience: 'Teens and up',
    setting: 'Old Delhi, present day',
    themes: ['family', 'loyalty'],
    notes: ['No gore', 'Ends on a cliffhanger']
  };
  doc.source = { script: Array.from({ length: 30 }, (_, i) => `LINE ${i + 1}: Maya runs through the market.`).join('\n'), updatedAt: SAMPLE_NOW };
  doc.style = {
    status: 'locked',
    name: 'Modern heroic',
    spec: 'Bold inks, cel shading, saturated palette.',
    palette: ['#1d3557', '#e63946', '#f1faee'],
    linework: 'Tapered brush inks',
    avoid: ['photorealism'],
    presetId: 'modern-heroic',
    refs: [],
    board: asset('u/proj/style/board.png', { w: 800, h: 1000 }),
    options: [
      { id: 'so_a', name: 'Heroic', spec: 'Bold inks', render: { status: 'ready', history: [], asset: asset('u/proj/style/board.png', { w: 800, h: 1000 }) } },
      { id: 'so_b', name: 'Noir', spec: 'Black and white', render: { status: 'rendering', history: [], updatedAt: SAMPLE_NOW - 5000 } },
      { id: 'so_c', name: 'Riso', spec: 'Two-color', render: { status: 'failed', history: [], error: 'The model refused this one.' } }
    ]
  };
  doc.cast = [
    {
      id: 'ch_maya',
      name: 'Maya',
      role: 'Pickpocket',
      tier: 'lead',
      look: { summary: 'Wiry 19-year-old in a mustard kurta', hair: 'black braid', marks: 'scar on left eyebrow' },
      refs: [asset('u/proj/refs/maya.jpg', { source: 'upload' })],
      sheet: {
        status: 'ready',
        history: [asset('u/proj/sheets/maya-v1.png')],
        asset: asset('u/proj/sheets/maya-v2.png', { w: 1536, h: 1024 }),
        updatedAt: SAMPLE_NOW - 60_000
      }
    },
    { id: 'ch_arjun', name: 'Arjun', role: 'Cop', tier: 'support', look: { summary: 'Tall, neat beard, khaki uniform' }, refs: [], sheet: { status: 'none', history: [] } },
    { id: 'ch_vendor', name: 'Vendor', tier: 'extra', look: { summary: 'Portly spice seller' }, refs: [], sheet: { status: 'none', history: [] } }
  ];
  doc.places = [{ id: 'pl_market', name: 'Spice market', look: 'Narrow lanes, sacks of turmeric', refs: [], sheet: { status: 'none', history: [] } }];
  const ready = (path: string): Page['render'] => ({
    status: 'ready',
    asset: asset(path, { w: 1000, h: 1500 }),
    history: [asset(`${path}.old`)],
    model: 'nano-banana-2.1',
    updatedAt: SAMPLE_NOW - 120_000,
    qc: { score: 0.82, issues: ['Arjun’s beard is missing in panel 3'], checkedAt: SAMPLE_NOW - 100_000 }
  });
  doc.pages = [
    page('pg_1', 1, { render: ready('u/proj/pages/p1.png'), balloons: balloonsFor('pg_1') }),
    page('pg_2', 2, {}),
    page('pg_3', 3, { render: { status: 'queued', history: [], updatedAt: SAMPLE_NOW - 2000 } }),
    page('pg_4', 4, { render: { status: 'rendering', history: [], updatedAt: SAMPLE_NOW - 12_000 } }),
    page('pg_5', 5, { render: { ...ready('u/proj/pages/p5.png'), specHash: 'deadbeef' }, balloons: balloonsFor('pg_5') }),
    page('pg_6', 6, { render: { status: 'failed', history: [], error: 'The image model timed out.', updatedAt: SAMPLE_NOW - 30_000 } })
  ];
  doc.format = { ...doc.format, pageCount: 6 };
  doc.planStatus = 'draft';
  doc.spend = {
    totalUsd: 0.42,
    byKind: { style: 0.13, sheet: 0.07, page: 0.2, chat: 0.02 },
    entries: [
      { id: 'sp_1', at: SAMPLE_NOW - 10_000, kind: 'page', label: 'Page 1', usd: 0.0655, model: 'nano-banana-2.1', byok: true, estimated: false },
      { id: 'sp_2', at: SAMPLE_NOW - 20_000, kind: 'sheet', label: 'Maya sheet', usd: 0.0655, model: 'nano-banana-2.1', byok: false, estimated: true },
      { id: 'sp_3', at: SAMPLE_NOW - 30_000, kind: 'chat', label: 'Director', usd: 0.004, byok: false, estimated: false }
    ]
  };
  mutate?.(doc);
  // Page 1 is drawn from its current spec (not stale).
  const p1 = doc.pages.find((p) => p.id === 'pg_1');
  if (p1 && p1.render.status === 'ready' && !p1.render.specHash) p1.render.specHash = pageSpecHash(doc, p1);
  return doc;
};

/** URL resolver used by tests: `url:<path>` for every path. */
export const fakeUrlFor = (asset?: AssetRef | string | null): string | undefined => {
  if (!asset) return undefined;
  const path = typeof asset === 'string' ? asset : asset.path;
  return path ? `https://cdn.test/${path}` : undefined;
};

/** A StudioController with spy methods around a fixed doc. */
export const makeStudio = (doc: ComicDoc | null = makeSampleDoc(), overrides: Partial<StudioController> = {}): StudioController => ({
  doc,
  loading: false,
  loadError: null,
  busy: false,
  drafts: {},
  activity: [],
  error: null,
  clearError: vi.fn(),
  urlFor: vi.fn(fakeUrlFor),
  send: vi.fn(async () => undefined),
  act: vi.fn(async () => undefined),
  patch: vi.fn(async () => undefined),
  cancel: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  tab: 'pages',
  setTab: vi.fn(),
  focusedPageId: null,
  openPage: vi.fn(),
  isRendering: vi.fn(() => false),
  caps: DEFAULT_CAPS,
  mode: 'easy',
  setMode: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  canUndo: false,
  canRedo: false,
  selection: null,
  setSelection: vi.fn(),
  runNextStep: vi.fn(async () => undefined),
  runClientAction: vi.fn(),
  uploadRef: vi.fn(async () => ({})),
  publication: null,
  refreshPublication: vi.fn(async () => undefined),
  ...overrides
});
