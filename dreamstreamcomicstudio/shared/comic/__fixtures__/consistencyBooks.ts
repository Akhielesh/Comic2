// Synthetic books for the Ship 2 consistency core tests (B4: continuity, directions, anchors, plan quotes).
// Shapes only — no production data:
//  - harbourComic(): shaped like b4b5774f — a 6-page comic, three places that each recur (≥ 2 pages, ≥ 3 panels), a
//    lead and a support with sheets, a recurring extra without a sheet, a recurring prop (an 'object' cast member).
//  - lakeStory(): shaped like f8312c86 — a 5-page 4:5 storybook whose protagonist is an EXTRA in every one of its 20
//    panels and has a ready sheet, plus four animal friends.

import { createEmptyDoc, emptyRender, type AssetRef, type Character, type ComicDoc, type Line, type Page, type Panel, type RenderState, type ShotType } from '../doc.js';

export const BOOK_NOW = 1_761_100_000_000;

export const asset = (path: string, extra: Partial<AssetRef> = {}): AssetRef => ({ path, source: 'generated', at: BOOK_NOW - 1_000_000, w: 1024, h: 1536, ...extra });
export const readyRender = (path: string, extra: Partial<RenderState> = {}): RenderState => ({ status: 'ready', history: [], asset: asset(path), ...extra });

export const being = (id: string, name: string, tier: Character['tier'], opts: Partial<Character> & { sheetPath?: string } = {}): Character => {
  const { sheetPath, ...rest } = opts;
  return {
    id,
    name,
    tier,
    look: { summary: `${name}, drawn the same on every page` },
    refs: [],
    sheet: sheetPath ? readyRender(sheetPath) : emptyRender(),
    ...rest
  };
};

export interface PanelSpec {
  cast: string[];
  place?: string;
  shot?: ShotType;
  lines?: { speaker?: string; text: string; kind?: Line['kind'] }[];
}

export const pageOf = (n: number, panels: PanelSpec[], render: RenderState = emptyRender(), extra: Partial<Page> = {}): Page => ({
  id: `pg_${n}`,
  n,
  summary: `Page ${n}`,
  layout: panels.length === 3 ? 'Row 1: one wide panel. Row 2: two equal panels.' : 'Row 1: two equal panels. Row 2: two equal panels.',
  panels: panels.map(
    (s, i): Panel => ({
      id: `pg_${n}_p${i + 1}`,
      n: i + 1,
      size: 'medium',
      shot: s.shot ?? 'medium',
      action: `Moment ${i + 1} of page ${n}`,
      castIds: s.cast,
      ...(s.place ? { placeId: s.place } : {}),
      lines: (s.lines ?? []).map((l, k) => ({
        id: `pg_${n}_p${i + 1}_l${k + 1}`,
        kind: l.kind ?? (l.speaker ? 'speech' : 'caption'),
        ...(l.speaker ? { speakerId: l.speaker } : {}),
        text: l.text
      }))
    })
  ),
  render,
  balloons: [],
  ...extra
});

/** b4b5774f-shaped: GATE (p1–p2), MARKET (p3–p4), TEMPLE (p5–p6), each on 2 pages and 6 panels. */
export const harbourComic = (mutate?: (doc: ComicDoc) => void): ComicDoc => {
  const doc = createEmptyDoc('b4-harbour', 'The Harbour Gate', BOOK_NOW - 3_600_000);
  doc.format = { ...doc.format, kind: 'comic', pageAspect: '2:3', pageCount: 6 };
  doc.style = { ...doc.style, status: 'locked', spec: 'Inked line, flat colour.', board: asset('u/o/h/board.webp') };
  doc.cast = [
    being('c_meera', 'Meera', 'lead', { sheetPath: 'u/o/h/meera.webp' }),
    being('c_ravi', 'Ravi', 'support', { sheetPath: 'u/o/h/ravi.webp' }),
    being('c_guard', 'Gate Guard', 'extra'),
    being('c_lantern', 'Brass Lantern', 'extra', { kind: 'object' })
  ];
  doc.places = [
    { id: 'pl_gate', name: 'Chitrakulam Gate', look: 'Stone gate with a recessed metal plate', refs: [], sheet: emptyRender() },
    { id: 'pl_market', name: 'Night Market', look: 'Lanterns over spice stalls', refs: [], sheet: emptyRender() },
    { id: 'pl_temple', name: 'Sea Temple', look: 'Wet steps, carved pillars', refs: [], sheet: emptyRender() }
  ];
  const three = (place: string, cast: string[][]): PanelSpec[] => cast.map((c) => ({ cast: c, place }));
  doc.pages = [
    pageOf(1, three('pl_gate', [['c_meera'], ['c_meera', 'c_guard'], ['c_guard']])),
    pageOf(2, three('pl_gate', [['c_meera', 'c_ravi'], ['c_meera', 'c_lantern'], ['c_ravi', 'c_guard']])),
    pageOf(3, three('pl_market', [['c_meera', 'c_lantern'], ['c_ravi'], ['c_meera', 'c_ravi']])),
    pageOf(4, three('pl_market', [['c_meera'], ['c_ravi', 'c_lantern'], ['c_meera']])),
    pageOf(5, three('pl_temple', [['c_meera', 'c_ravi'], ['c_meera'], ['c_ravi']])),
    pageOf(6, three('pl_temple', [['c_meera'], ['c_ravi'], ['c_meera', 'c_ravi']]))
  ];
  doc.planStatus = 'approved';
  mutate?.(doc);
  return doc;
};

/** f8312c86-shaped: THE BABY (an extra with a ready sheet) is in all 20 panels; four friends come and go. */
export const lakeStory = (mutate?: (doc: ComicDoc) => void): ComicDoc => {
  const doc = createEmptyDoc('f8-lake', 'Playtime at the Lake', BOOK_NOW - 3_600_000);
  doc.format = { ...doc.format, kind: 'storybook', pageAspect: '4:5', pageCount: 5, panelsPerPage: 4 };
  doc.settings = { ...doc.settings, quality: 'draft' };
  doc.style = { ...doc.style, status: 'locked', spec: 'Soft storybook watercolour.', board: asset('u/o/l/board.webp') };
  doc.cast = [
    being('c_baby', 'The Baby', 'extra', { sheetPath: 'u/o/l/baby.webp' }),
    being('c_ducks', 'Ducklings', 'lead', { kind: 'animal', count: 3, sheetPath: 'u/o/l/ducks.webp' }),
    being('c_frog', 'Frog', 'lead', { kind: 'animal', sheetPath: 'u/o/l/frog.webp' }),
    being('c_bunny', 'Bunny', 'lead', { kind: 'animal', sheetPath: 'u/o/l/bunny.webp' }),
    being('c_heron', 'Heron', 'lead', { kind: 'animal', sheetPath: 'u/o/l/heron.webp' })
  ];
  doc.places = [{ id: 'pl_lake', name: 'The Lake', look: 'Reeds and lily pads', refs: [], sheet: readyRender('u/o/l/lake.webp') }];
  const friends = [['c_ducks'], ['c_frog'], ['c_bunny'], ['c_ducks', 'c_frog'], ['c_ducks', 'c_frog', 'c_bunny', 'c_heron']];
  doc.pages = friends.map((f, i) =>
    pageOf(
      i + 1,
      [0, 1, 2, 3].map((k) => ({ cast: k === 0 ? ['c_baby', ...f] : ['c_baby'], place: 'pl_lake', lines: [{ text: `Caption ${k + 1}` }] })),
      readyRender(`u/o/l/p${i + 1}.webp`)
    )
  );
  doc.planStatus = 'approved';
  mutate?.(doc);
  return doc;
};
