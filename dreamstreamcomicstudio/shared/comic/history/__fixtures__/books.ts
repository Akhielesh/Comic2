// Synthetic Comic History fixtures (versions plan §11; package H0). SYNTHETIC ONLY: no real user's text, images or
// ids — every path, id and line here is invented, shaped like the stored docs the plan measured:
//   historyV4Doc     a pure v4 doc shaped like f8312c86 (storybook 4:5, 5 drawn pages with older versions, 4 sheets,
//                    a cover; none of the v5 keys — letterStyle, book, reader, archive, trash, refInbox, i18n — exist)
//   historyV5Doc     a v5 doc shaped like b4b5774f (6 pages, Telugu + Hindi editions, glossary, style options + board,
//                    cropped/checked refs, places, archive, trash, the model lock, a publication mirror…)
//   historyEmptyDoc  a brand-new comic
//   classicProjectState  a classic (pre-v4) projects.state with in-state snapshots (`versions`)

import {
  createEmptyDoc,
  pageSpecHash,
  type AssetRef,
  type Balloon,
  type Character,
  type ComicDoc,
  type Line,
  type Page,
  type Panel,
  type RenderState,
  type RenderVersion
} from '../../doc.js';
import { lineSourceHash } from '../../i18n.js';

export const BOOK_NOW = 1_761_700_000_000;
const MODEL = 'nano-banana-2.1';

const img = (path: string, at: number, extra: Partial<AssetRef> = {}): AssetRef => ({ path, source: 'generated', model: MODEL, at, w: 928, h: 1392, ...extra });
const version = (path: string, at: number, extra: Partial<RenderVersion> = {}): RenderVersion => ({ ...img(path, at), origin: 'render', costUsd: 0.04, ...extra });
const ready = (path: string, at: number, history: RenderVersion[] = [], extra: Partial<RenderState> = {}): RenderState => ({
  status: 'ready',
  asset: img(path, at),
  history,
  model: MODEL,
  resolution: '1K',
  origin: 'render',
  costUsd: 0.045,
  updatedAt: at,
  ...extra
});

const line = (id: string, kind: Line['kind'], text: string, speakerId?: string): Line => ({ id, kind, text, ...(speakerId ? { speakerId } : {}) });

// ── v4 (f8312c86-shaped) ─────────────────────────────────────────────────────

const V4 = 'u/user-a/p/proj-v4/img';

/** A pure v4 doc: none of the v5 keys exist (stored v4 docs never had them). */
export const historyV4Doc = (): ComicDoc => {
  const doc = createEmptyDoc('proj-v4', 'A Day at the Pond', BOOK_NOW - 9_000_000) as Partial<ComicDoc> & { id: string };
  for (const k of ['letterStyle', 'book', 'reader', 'archive', 'trash', 'refInbox', 'i18n'] as const) delete doc[k];
  doc.rev = 41;
  doc.brief = { title: 'A Day at the Pond', audience: 'kids 2–6', setting: 'a sunny pond', notes: ['gentle, no scary moments'] };
  doc.format = { kind: 'storybook', pageCount: 5, pageAspect: '4:5', panelsPerPage: 2, readingDirection: 'ltr', lettering: 'overlay', colorMode: 'color', language: 'en' };
  doc.style = { status: 'locked', name: 'Soft watercolor', spec: 'Soft storybook watercolor, rounded shapes, warm pastels.', refs: [], options: [], board: img(`${V4}/board.webp`, BOOK_NOW - 8_000_000) };
  const cast = (id: string, name: string, n: number): Character => ({
    id,
    name,
    tier: 'lead',
    look: { summary: `${name} at the pond` },
    refs: [],
    sheet: ready(`${V4}/${id}.webp`, BOOK_NOW - 7_000_000 + n)
  });
  doc.cast = [cast('c_kid', 'The Kid', 1), cast('c_ducks', 'Ducklings', 2), cast('c_frog', 'Frog', 3), cast('c_bunny', 'Bunny', 4)];
  const page = (n: number, castIds: string[]): Page => ({
    id: `pg_${n}`,
    n,
    summary: `Page ${n} at the pond`,
    layout: 'Row 1: two equal panels side by side (panels 1–2).',
    panels: [1, 2].map(
      (k): Panel => ({
        id: `pg_${n}_p${k}`,
        n: k,
        size: 'medium',
        shot: 'medium',
        action: `Moment ${k} of page ${n}`,
        castIds: k === 1 ? castIds : castIds.slice(0, 1),
        lines: [line(`pg_${n}_l${k}`, k === 1 ? 'caption' : 'speech', `Line ${k} of page ${n}`, k === 1 ? undefined : castIds[0])]
      })
    ),
    render: ready(`${V4}/p${n}.webp`, BOOK_NOW - 6_000_000 + n, [version(`${V4}/p${n}-v1.webp`, BOOK_NOW - 6_500_000 + n)]),
    balloons: [{ lineId: `pg_${n}_l2`, x: 0.55, y: 0.1, w: 0.3 }]
  });
  doc.pages = [page(1, ['c_kid', 'c_ducks']), page(2, ['c_kid', 'c_frog']), page(3, ['c_kid', 'c_bunny']), page(4, ['c_kid']), page(5, ['c_kid', 'c_ducks', 'c_frog'])];
  doc.cover = { title: 'A Day at the Pond', render: ready(`${V4}/cover.webp`, BOOK_NOW - 5_000_000) };
  doc.planStatus = 'approved';
  doc.spend = {
    totalUsd: 0.2,
    byKind: { page: 0.2 },
    entries: [{ id: 'sp_1', at: BOOK_NOW - 6_000_000, kind: 'page', label: 'Page 1', usd: 0.2, model: MODEL, byok: true, estimated: false, target: 'page:pg_1' }]
  };
  const d = doc as ComicDoc;
  for (const p of d.pages) p.render.specHash = pageSpecHash(d, p);
  return d;
};

// ── v5 (b4b5774f-shaped) ─────────────────────────────────────────────────────

const V5 = 'u/user-b/p/proj-v5/img';
const REF = 'u/user-b/p/proj-v5/ref';

const balloonsOf = (page: Page): Balloon[] =>
  page.panels.flatMap((p) => p.lines).filter((l) => l.kind !== 'caption').map((l, i) => ({ lineId: l.id, x: 0.08 + 0.3 * (i % 3), y: 0.08 + 0.25 * Math.floor(i / 3), w: 0.28 }));

export const historyV5Doc = (): ComicDoc => {
  const doc = createEmptyDoc('proj-v5', 'The Saffron Thief', BOOK_NOW - 20_000_000);
  doc.rev = 233;
  doc.brief = { title: 'The Saffron Thief', logline: 'A market thief steals the wrong tin.', genre: 'adventure', tone: 'playful', notes: ['ends on a cliffhanger'] };
  doc.format = { ...doc.format, kind: 'comic', pageCount: 6, pageAspect: '2:3', lettering: 'overlay', language: 'en' };
  doc.source = { script: 'PAGE 1. The spice market at dawn. MAYA slips a tin into her satchel…', updatedAt: BOOK_NOW - 19_000_000 };
  doc.style = {
    status: 'locked',
    name: 'Ink and wash',
    spec: 'Bold ink outlines, flat saffron and teal washes.',
    palette: ['#e8a33d', '#1f6f78'],
    presetId: 'ink-wash',
    refs: [
      {
        path: `${REF}/style1.webp`,
        source: 'upload',
        at: BOOK_NOW - 18_000_000,
        w: 800,
        h: 800,
        label: 'linework',
        variants: [{ path: `${REF}/style1_w480.webp`, w: 480, h: 480 }],
        safety: { assessed: 'G', at: BOOK_NOW - 18_000_000 }
      }
    ],
    board: img(`${V5}/board.webp`, BOOK_NOW - 17_000_000),
    options: [
      { id: 'so_ink', name: 'Ink', spec: 'Ink and wash', render: ready(`${V5}/so_ink.webp`, BOOK_NOW - 17_500_000) },
      { id: 'so_flat', name: 'Flat', spec: 'Flat color', render: ready(`${V5}/so_flat.webp`, BOOK_NOW - 17_400_000) }
    ]
  };
  doc.cast = [
    {
      id: 'ch_maya',
      name: 'Maya',
      role: 'thief',
      tier: 'lead',
      look: { summary: 'A wiry girl in a saffron scarf', hair: 'black braid', marks: 'scar over left eyebrow' },
      voice: 'quick, teasing',
      refs: [
        {
          path: `${REF}/maya_crop.webp`,
          source: 'upload',
          at: BOOK_NOW - 16_000_000,
          label: 'face',
          note: 'her scarf',
          original: { path: `${REF}/maya_orig.webp`, w: 1200, h: 1600 },
          crop: { x: 0.1, y: 0.1, w: 0.6, h: 0.6 }
        }
      ],
      sheet: ready(`${V5}/maya.webp`, BOOK_NOW - 15_000_000, [version(`${V5}/maya-v1.webp`, BOOK_NOW - 15_500_000)])
    },
    { id: 'ch_arjun', name: 'Arjun', tier: 'support', look: { summary: 'A tall boy in a blue kurta' }, refs: [], sheet: ready(`${V5}/arjun.webp`, BOOK_NOW - 14_900_000) },
    { id: 'ch_cat', name: 'Kesar', tier: 'support', kind: 'animal', look: { summary: 'An orange market cat', species: 'cat' }, refs: [], sheet: { status: 'none', history: [] } }
  ];
  doc.places = [
    { id: 'pl_market', name: 'Spice market', look: 'Striped awnings, sacks of chilli', refs: [], sheet: ready(`${V5}/market.webp`, BOOK_NOW - 14_000_000) },
    { id: 'pl_roof', name: 'Rooftops', look: 'Flat roofs, laundry lines', refs: [], sheet: { status: 'none', history: [] } }
  ];
  const mkPage = (n: number, history: RenderVersion[] = []): Page => {
    const id = `pg_${n}`;
    const p: Page = {
      id,
      n,
      summary: `Page ${n}: the chase continues`,
      layout: 'Row 1: one wide panel (panel 1). Row 2: two equal panels side by side (panels 2–3).',
      turnHook: n === 6 ? 'The tin is empty.' : undefined,
      panels: [
        { id: `${id}_p1`, n: 1, size: 'wide', shot: 'establishing', action: `Market at dawn, page ${n}`, castIds: [], placeId: 'pl_market', lines: [line(`${id}_l1`, 'caption', `Dawn ${n}.`)] },
        { id: `${id}_p2`, n: 2, size: 'medium', shot: 'close_up', action: `Maya grabs a tin (${n})`, castIds: ['ch_maya'], lines: [line(`${id}_l2`, 'whisper', `Just one more, ${n}…`, 'ch_maya')] },
        {
          id: `${id}_p3`,
          n: 3,
          size: 'medium',
          shot: 'medium',
          action: `Arjun catches her wrist (${n})`,
          castIds: ['ch_maya', 'ch_arjun'],
          mood: 'tense',
          lines: [line(`${id}_l3`, 'speech', `You owe me an answer, Maya (${n}).`, 'ch_arjun'), line(`${id}_l4`, 'sfx', 'GRAB')]
        }
      ],
      render: ready(`${V5}/p${n}.webp`, BOOK_NOW - 12_000_000 + n, history, { aspect: '2:3' }),
      balloons: []
    };
    if (!p.turnHook) delete p.turnHook;
    if (n === 4) p.chapterTitle = 'The Rooftops';
    p.balloons = balloonsOf(p);
    return p;
  };
  const fullHistory = Array.from({ length: 8 }, (_, i) => version(`${V5}/p1-v${8 - i}.webp`, BOOK_NOW - 13_000_000 + (8 - i) * 1000));
  doc.pages = [mkPage(1, fullHistory), mkPage(2, [version(`${V5}/p2-v1.webp`, BOOK_NOW - 13_100_000)]), mkPage(3), mkPage(4), mkPage(5), mkPage(6)];
  doc.pages[1].render.asset!.variants = [{ path: `${V5}/p2_w480.webp`, w: 480, h: 720 }];
  doc.pages[1].render.qc = { score: 0.86, issues: [], checkedAt: BOOK_NOW - 11_000_000, panelBoxes: [{ x: 0, y: 0, w: 1, h: 0.4 }] };
  doc.pages[1].render.asset!.safety = { assessed: 'G', at: BOOK_NOW - 11_000_000 };
  doc.cover = {
    title: 'The Saffron Thief',
    tagline: 'One tin. Many problems.',
    lettering: 'overlay',
    titleStyle: { box: { x: 0.06, y: 0.04, w: 0.88, h: 0.2 } },
    render: ready(`${V5}/cover.webp`, BOOK_NOW - 10_000_000, [version(`${V5}/cover-v1.webp`, BOOK_NOW - 10_500_000)])
  };
  doc.planStatus = 'approved';
  doc.letterStyle = { presetId: 'manga', base: { fill: '#fafafa' } };
  doc.book = { titlePage: true, endPage: true, backCover: 'auto', blurb: 'A chase through the spice market.', firstPageRight: true, uniformTrim: true };
  doc.reader = { turn: 'slide', guidedOverview: true, paperTexture: false, ambient: true, dedication: 'For the market cats.' };
  doc.planInputHash = 'plan-hash-v5';
  // Translations: Telugu complete for pages 1–2, Hindi partial; one orphan line (on no page) in Telugu.
  const tr = (text: string, l: Line, status: 'machine' | 'reviewed' | 'edited' = 'reviewed') => ({ text, status, sourceHash: lineSourceHash(l), at: BOOK_NOW - 9_000_000 });
  const te: Record<string, ReturnType<typeof tr>> = {};
  const hi: Record<string, ReturnType<typeof tr>> = {};
  for (const p of doc.pages.slice(0, 2)) for (const panel of p.panels) for (const l of panel.lines) te[l.id] = tr(`తెలుగు ${l.id}`, l);
  hi[doc.pages[0].panels[1].lines[0].id] = tr('बस एक और…', doc.pages[0].panels[1].lines[0], 'machine');
  te.orphan_line = { text: 'పాత పంక్తి', status: 'edited', sourceHash: 'old', at: BOOK_NOW - 9_500_000 };
  doc.i18n = {
    editions: {
      te: { lang: 'te', lines: te, balloons: { pg_1_l2: { y: 0.12 } }, register: 'everyday', cover: { title: { text: 'కుంకుమపువ్వు దొంగ', status: 'edited', sourceHash: 'c', at: BOOK_NOW - 9_000_000 } } },
      hi: { lang: 'hi', lines: hi, balloons: {}, register: 'formal' }
    },
    glossary: [
      { id: 'g_maya', term: 'Maya', kind: 'character', refId: 'ch_maya', policy: 'transliterate', forms: { te: 'మాయ', hi: 'माया' } },
      { id: 'g_saffron', term: 'saffron', kind: 'term', policy: 'translate', forms: { te: 'కుంకుమపువ్వు' } }
    ]
  };
  doc.archive = Array.from({ length: 5 }, (_, i) => ({
    ...img(`${V5}/arch-${i}.webp`, BOOK_NOW - 30_000_000 + i),
    targetKey: 'page:pg_1',
    label: 'Page 1',
    archivedAt: BOOK_NOW - 12_500_000 + i,
    origin: 'render' as const
  }));
  const deleted = mkPage(7);
  deleted.id = 'pg_old';
  deleted.render = ready(`${V5}/old.webp`, BOOK_NOW - 12_900_000);
  doc.trash = [{ page: { ...deleted, n: 7 }, fromN: 7, deletedAt: BOOK_NOW - 8_000_000 }];
  doc.refInbox = [{ path: `${REF}/inbox1.webp`, source: 'upload', at: BOOK_NOW - 1_000 }];
  doc.conversation = [
    { id: 'msg_1', role: 'user', text: 'Make it a chase', at: BOOK_NOW - 19_000_000, attachments: [{ path: `${REF}/attach1.webp`, source: 'upload', at: BOOK_NOW - 19_000_000 }] },
    { id: 'msg_2', role: 'assistant', text: 'Here is the plan.', at: BOOK_NOW - 18_900_000, cards: [{ type: 'plan', id: 'card_plan' }] }
  ];
  doc.memory = 'The user wants a playful chase.';
  doc.settings = { ...doc.settings, quality: 'standard', budgetUsd: 5 };
  doc.spend = {
    totalUsd: 0.5,
    byKind: { page: 0.45, chat: 0.05 },
    entries: [
      { id: 'sp_a', at: BOOK_NOW - 12_000_000, kind: 'page', label: 'Page 1', usd: 0.45, model: MODEL, byok: false, estimated: false, target: 'page:pg_1' },
      { id: 'sp_b', at: BOOK_NOW - 11_000_000, kind: 'chat', label: 'Director', usd: 0.05, byok: false, estimated: false }
    ]
  };
  doc.safety = { ipNoted: ['LEGO'], text: { hash: 'th', categories: [], at: BOOK_NOW - 9_000_000 } };
  doc.publication = { visibility: 'unlisted', status: 'live', publishedRev: 200, publishedAt: BOOK_NOW - 7_000_000, languages: ['en', 'te'] };
  doc.imageModel = { modelId: MODEL, lockedAt: BOOK_NOW - 17_500_000, origin: 'first_render' };
  for (const p of doc.pages) p.render.specHash = pageSpecHash(doc, p);
  return doc;
};

/** A brand-new comic. */
export const historyEmptyDoc = (): ComicDoc => createEmptyDoc('proj-empty', 'Untitled comic', BOOK_NOW);

/** A classic (pre-v4) projects.state with snapshots kept in-state (the old 20-snapshot cap; H6 imports them). */
export const classicProjectState = (): { name: string; state: Record<string, unknown> } => ({
  name: 'Rooftop Kites',
  state: {
    title: 'Rooftop Kites',
    overview: 'Two friends race kites across the rooftops.',
    script: 'PAGE 1. Rooftops at noon. RIA lifts a red kite.',
    characters: [
      { id: 'c1', name: 'Ria', description: 'A girl with a red kite', castTier: 'lead', structured: { physicalTraits: 'short hair' } },
      { id: 'c2', name: 'Dev', description: 'Her rival, blue kite', castTier: 'support' }
    ],
    panels: [{ id: 'pn1', description: 'Ria on the roof', imageId: 'u/user-c/classic/pn1.png' }],
    versions: [
      { id: 'snap_1', name: 'Auto - Before Restore', reason: 'auto', createdAt: BOOK_NOW - 50_000_000, state: { title: 'Rooftop Kites', panels: [] } },
      { id: 'snap_2', name: 'Draft with 3 panels', reason: 'manual', createdAt: BOOK_NOW - 40_000_000, state: { title: 'Rooftop Kites', panels: [{ id: 'pn1' }, { id: 'pn2' }, { id: 'pn3' }] } }
    ]
  }
});
