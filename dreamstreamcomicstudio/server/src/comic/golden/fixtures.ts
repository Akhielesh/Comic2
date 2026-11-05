// Director golden-set fixtures (P1-DIRECTOR): synthetic docs at the stages the owner's real
// sessions went through. Pure data — no network, no other users' content. The scenarios in
// ./scenarios/*.json name one of these by key ("doc": "lake-drawn").

import { createEmptyDoc, emptyRender, pageSpecHash, type Character, type ComicDoc, type Page, type Panel } from '../../../../shared/comic/doc.js';

const T0 = 1_792_670_000_000; // 2026-10-22 (fixed so hashes and summaries are stable)

const character = (id: string, name: string, patch: Partial<Character> = {}): Character => ({
  id,
  name,
  tier: 'support',
  look: { summary: '' },
  refs: [],
  sheet: emptyRender(),
  ...patch
});

const panel = (id: string, n: number, action: string, castIds: string[], lines: Panel['lines'] = []): Panel => ({
  id,
  n,
  size: n === 1 ? 'wide' : 'medium',
  shot: n === 1 ? 'establishing' : 'medium',
  action,
  castIds,
  lines
});

/** "baby playing near a lake with other animals — a kids comic, single page" after the first turn. */
export function lakeBriefDoc(): ComicDoc {
  const doc = createEmptyDoc('golden_lake', 'Splash Day', T0);
  doc.brief = { ...doc.brief, premise: 'A baby plays by a lake with friendly animals.', audience: 'kids 2–6', setting: 'a sunny lake shore', tone: 'gentle, playful' };
  doc.format = { ...doc.format, kind: 'storybook', pageCount: 1, pageAspect: '4:5' };
  doc.cast = [
    character('c_baby', 'The Baby', { tier: 'lead', look: { summary: 'A chubby toddler in a yellow sunhat and blue romper' } }),
    character('c_ducks', 'Ducklings', { kind: 'animal', count: 3, look: { summary: 'Three identical fluffy yellow ducklings', species: 'mallard duckling' } }),
    character('c_frog', 'Frog', { kind: 'animal', look: { summary: 'A round green frog with a pale belly', species: 'tree frog' } }),
    character('c_bunny', 'Bunny', { kind: 'animal', look: { summary: 'A small grey bunny with a white tail', species: 'rabbit' } })
  ];
  return doc;
}

/** The same book with a locked style and a one-page plan (not drawn). */
export function lakePlannedDoc(): ComicDoc {
  const doc = lakeBriefDoc();
  doc.style = { ...doc.style, status: 'locked', name: 'Watercolor storybook', spec: 'Soft watercolor washes, gentle ink outlines, warm pastel palette, paper texture.' };
  const page: Page = {
    id: 'pg_lake_1',
    n: 1,
    summary: 'The baby splashes at the lake edge while ducklings, a frog and a bunny join in.',
    layout: 'Row 1: one wide panel. Row 2: two equal panels.',
    panels: [
      panel('pn_l1', 1, 'The Baby sits at the lake edge, splashing; three ducklings paddle close.', ['c_baby', 'c_ducks']),
      panel('pn_l2', 2, 'A frog hops onto a lily pad beside the baby, who giggles.', ['c_baby', 'c_frog'], [{ id: 'ln_l2', kind: 'caption', text: 'Splish! Splash!' }]),
      panel('pn_l3', 3, 'A bunny peeks from the reeds; everyone waves goodbye at sunset.', ['c_baby', 'c_bunny', 'c_ducks'], [{ id: 'ln_l3', kind: 'speech', speakerId: 'c_baby', text: 'Bye-bye, friends!' }])
    ],
    render: emptyRender(),
    balloons: []
  };
  doc.pages = [page];
  doc.planStatus = 'draft';
  return doc;
}

/** The one-page book with page 1 drawn and current (cover not drawn) — "generate all pages" must cost $0. */
export function lakeDrawnDoc(): ComicDoc {
  const doc = lakePlannedDoc();
  doc.planStatus = 'approved';
  const page = doc.pages[0];
  page.render = {
    ...emptyRender(),
    status: 'ready',
    asset: { path: 'u/golden/p/golden_lake/img/page1.webp', source: 'generated', at: T0 + 60_000, w: 1856, h: 2304 },
    aspect: '4:5',
    origin: 'render',
    updatedAt: T0 + 60_000
  };
  page.render.specHash = pageSpecHash(doc, page);
  page.balloons = [{ lineId: 'ln_l3', x: 0.62, y: 0.7, w: 0.3, pinned: true }];
  doc.spend = { totalUsd: 0.17, byKind: { page: 0.06, sheet: 0.11 }, entries: [] };
  return doc;
}

/** A six-page action comic, every page drawn and current, cover drawn. */
export function sixPageDrawnDoc(): ComicDoc {
  const doc = createEmptyDoc('golden_six', 'Rooftop Run', T0);
  doc.brief = { ...doc.brief, logline: 'Two couriers race across monsoon rooftops.', premise: 'Maya and Arjun must deliver a stolen recipe before dawn.', genre: 'action', tone: 'breathless', audience: 'teens' };
  doc.style = { ...doc.style, status: 'locked', name: 'Ligne claire', spec: 'Clean even outlines, flat bright colors, detailed backgrounds.' };
  doc.cast = [
    character('c_maya', 'Maya', { tier: 'lead', look: { summary: 'Young courier with a red scarf', hair: 'black bob' } }),
    character('c_arjun', 'Arjun', { look: { summary: 'Bearded spice vendor in a green kurta' } }),
    character('c_kite', 'Red Kite', { kind: 'object', tier: 'extra', look: { summary: 'A patched red paper kite' } })
  ];
  doc.places = [{ id: 'pl_roofs', name: 'Rooftops', look: 'Tin roofs, water tanks, monsoon clouds', refs: [], sheet: emptyRender() }];
  doc.pages = Array.from({ length: 6 }, (_, i): Page => {
    const n = i + 1;
    const page: Page = {
      id: `pg_six_${n}`,
      n,
      summary: `Chase beat ${n}.`,
      layout: 'Row 1: one wide panel. Row 2: two equal panels.',
      panels: [1, 2, 3].map((k) => panel(`pn_six_${n}_${k}`, k, `Maya leaps gap ${n}.${k}.`, k === 3 ? ['c_maya', 'c_arjun'] : ['c_maya'], k === 2 ? [{ id: `ln_six_${n}`, kind: 'shout', speakerId: 'c_maya', text: 'Jump!' }] : [])),
      render: emptyRender(),
      balloons: []
    };
    page.render = { ...emptyRender(), status: 'ready', asset: { path: `u/golden/p/golden_six/img/p${n}.webp`, source: 'generated', at: T0, w: 1664, h: 2496 }, aspect: '2:3', updatedAt: T0 };
    return page;
  });
  for (const p of doc.pages) p.render.specHash = pageSpecHash(doc, p);
  doc.cover = { ...doc.cover, title: 'Rooftop Run', render: { ...emptyRender(), status: 'ready', asset: { path: 'u/golden/p/golden_six/img/cover.webp', source: 'generated', at: T0 }, updatedAt: T0 } };
  doc.planStatus = 'approved';
  doc.settings = { ...doc.settings, confirm: 'big' };
  return doc;
}

export const GOLDEN_DOCS: Record<string, () => ComicDoc> = {
  empty: () => createEmptyDoc('golden_empty', 'Untitled comic', T0),
  'lake-brief': lakeBriefDoc,
  'lake-planned': lakePlannedDoc,
  'lake-drawn': lakeDrawnDoc,
  'six-drawn': sixPageDrawnDoc
};
