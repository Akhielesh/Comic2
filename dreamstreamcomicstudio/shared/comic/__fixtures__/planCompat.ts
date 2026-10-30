// Back-compat cases for shared/comic/plan.ts (B4): every existing export, called the way today's callers call it, on
// books with and without Ship 2 data. plan.compat.test.ts compares their JSON with plan.golden.json, which was written
// from plan.ts BEFORE B4 changed it — so the existing callers and the quotes stay byte for byte what they were.
// Synthetic data only.

import { createEmptyDoc, emptyRender, pageSpecHash, normalizeDoc, type ComicDoc, type Page, type QualityTier } from '../doc.js';
import { partsOf } from '../parts.js';
import {
  coverNeedsDraw,
  estimateDocJobs,
  missingRefCastIdsFor,
  missingSheetsFor,
  pageTargets,
  quoteLockOf,
  quoteRenderPages,
  recurringCastIds,
  sheetTargets,
  spendByTarget,
  summarizeBook,
  unitPrice
} from '../plan.js';
import { harbourComic, lakeStory, readyRender } from './consistencyBooks.js';
import { makeLakeComic } from './lakeComic.js';

const plannedDoc = (): ComicDoc => {
  const doc = createEmptyDoc('proj-compat', 'Spice Run', 1_700_000_000_000);
  doc.brief = { ...doc.brief, logline: 'A courier races through a spice market.', genre: 'adventure', tone: 'fun' };
  doc.style = { ...doc.style, status: 'drafted', name: 'Ligne claire', spec: 'Clean even outlines, flat bright colors.' };
  doc.cast = [
    { id: 'c_maya', name: 'Maya', tier: 'lead', look: { summary: 'Young courier with a red scarf' }, refs: [], sheet: emptyRender() },
    { id: 'c_arjun', name: 'Arjun', tier: 'support', look: { summary: 'Bearded spice vendor' }, refs: [], sheet: emptyRender() },
    { id: 'c_cat', name: 'Market Cat', tier: 'extra', kind: 'animal', look: { summary: 'Ginger cat' }, refs: [], sheet: emptyRender() }
  ];
  doc.places = [{ id: 'pl_market', name: 'Spice Market', look: 'Narrow lanes', refs: [], sheet: emptyRender() }];
  const page = (n: number, castIds: string[]): Page => ({
    id: `pg_${n}`,
    n,
    summary: `Page ${n} beat`,
    layout: 'Row 1: one wide panel. Row 2: two equal panels.',
    panels: [1, 2, 3].map((k) => ({
      id: `pn_${n}_${k}`,
      n: k,
      size: k === 1 ? 'wide' : 'medium',
      shot: k === 1 ? 'establishing' : 'medium',
      action: `Action ${n}.${k}`,
      castIds: k === 3 ? [...castIds, 'c_cat'] : castIds,
      placeId: 'pl_market',
      lines: k === 2 ? [{ id: `ln_${n}_${k}`, kind: 'speech', speakerId: castIds[0], text: `Line on page ${n}` }] : []
    })),
    render: emptyRender(),
    balloons: []
  });
  doc.pages = [page(1, ['c_maya']), page(2, ['c_maya', 'c_arjun']), page(3, ['c_arjun'])];
  doc.planStatus = 'draft';
  return doc;
};

const OVERFULL = 'listen the carrier behind those flower stalls has no plates and nobody has unloaded anything since morning which means someone wants us watching it closely tonight so stay here and keep your eyes on the gate until I come back with the others';

/** Every book the cases run on: plain, drawn, mixed, locked, an overfull page, and books carrying Ship 2 data. */
export const compatBooks = (): Record<string, ComicDoc> => {
  const planned = normalizeDoc(plannedDoc());
  const drawn = normalizeDoc(plannedDoc());
  drawn.cast = drawn.cast.map((c) => ({ ...c, sheet: readyRender(`u/x/${c.id}.webp`) }));
  drawn.pages = drawn.pages.map((p) => ({ ...p, render: { ...readyRender(`u/x/${p.id}.webp`), specHash: pageSpecHash(drawn, p) } }));
  const mixed = normalizeDoc(plannedDoc());
  mixed.pages[0].render = { ...readyRender('u/x/p1.webp'), specHash: 'old-hash' };
  mixed.pages[1].render = { status: 'failed', history: [], error: 'boom' };
  mixed.pages[2].render = { status: 'rendering', history: [] };
  mixed.pages.push({ ...mixed.pages[0], id: 'pg_empty', n: 4, panels: [], render: emptyRender() });
  mixed.settings = { ...mixed.settings, imageModelOverride: 'nano-banana-pro' };
  const overfull = normalizeDoc(plannedDoc());
  overfull.pages[1].panels[2].lines = [{ id: 'ln_over', kind: 'speech', speakerId: 'c_maya', text: OVERFULL }];
  const lake = makeLakeComic();
  const lakePro = makeLakeComic((d) => {
    d.imageModel = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'user_change' };
  });
  const harbour = harbourComic();
  // A book that already carries every Ship 2 field: scenes, a ledger, directions, consistency settings, stamped parts.
  const ship2 = harbourComic((d) => {
    d.scenes = [
      { id: 'sc_gate', name: 'At the gate', placeId: 'pl_gate', time: 'night' },
      { id: 'sc_market', name: 'Market', placeId: 'pl_market' }
    ];
    d.consistency = { maxRefs: 5, skip: ['place:pl_temple'], styleKeyPageId: 'pg_1' };
    d.places = d.places.map((p, i) => (i === 0 ? { ...p, sheet: readyRender('u/o/h/gate.webp') } : p));
    d.pages[0].continuity = { sceneId: 'sc_gate', cast: { c_meera: { outfit: 'blue sari', holding: ['lantern'] } }, props: { lantern: 'lit' }, by: 'writer' };
    d.pages[2].continuity = { sceneId: 'sc_market', notes: ['Rain starts.'] };
    d.pages[0].panels[0].direction = { lens: 'wide', light: 'cold dusk', cast: { c_meera: { expression: 'wary', pos: 'left', depth: 'fg' } }, by: 'writer' };
    d.pages[1].panels[1].direction = { lens: 'normal', background: ['wet steps'], offPanel: ['c_guard'], by: 'derived' };
    d.pages = d.pages.map((p) => (p.n <= 2 ? { ...p, render: { ...readyRender(`u/o/h/p${p.n}.webp`), specHash: pageSpecHash(d, p), parts: partsOf(d, p), anchorKeys: ['char:c_meera'] } } : p));
  });
  const lakeStoryDoc = lakeStory();
  return { planned, drawn, mixed, overfull, lake, lakePro, harbour, ship2, lakeStory: lakeStoryDoc };
};

const TIERS: QualityTier[] = ['draft', 'standard', 'pro'];

/** Every existing plan.ts export called on every book (results JSON-safe: Maps and Sets as arrays). */
export const planCompatCases = (): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [name, doc] of Object.entries(compatBooks())) {
    const first = [...doc.pages].sort((a, b) => a.n - b.n)[0]?.id;
    const ids = (pages: { id: string }[]) => pages.map((p) => p.id);
    out[`${name}.pageTargets`] = [ids(pageTargets(doc)), ids(pageTargets(doc, { force: true })), ids(pageTargets(doc, { pageIds: first ? [first] : [] }))];
    out[`${name}.sheetTargets`] = [ids(sheetTargets(doc)), ids(sheetTargets(doc, { force: true }))];
    out[`${name}.missingSheetsFor`] = ids(missingSheetsFor(doc, doc.pages));
    out[`${name}.coverNeedsDraw`] = coverNeedsDraw(doc);
    out[`${name}.quoteLockOf`] = quoteLockOf(doc) ?? null;
    out[`${name}.recurringCastIds`] = [...recurringCastIds(doc)].sort();
    out[`${name}.missingRefCastIdsFor`] = missingRefCastIdsFor(doc, doc.cast.map((c) => c.id));
    out[`${name}.spendByTarget`] = [...spendByTarget(doc).entries()];
    out[`${name}.estimateDocJobs`] = [
      estimateDocJobs(doc, [{ kind: 'page', count: 2 }, { kind: 'sheet', count: 1 }, { kind: 'cover', count: 1 }], { byok: false }),
      estimateDocJobs(doc, [{ kind: 'page', count: 1, label: 'page' }], { byok: true, tier: 'pro', lock: null })
    ];
    for (const byok of [false, true]) {
      out[`${name}.unitPrice.${byok}`] = (['page', 'cover', 'sheet', 'edit'] as const).map((k) => unitPrice(doc, k, { byok }));
      for (const tier of TIERS) {
        const cases = [{}, { force: true }, { includeCover: true }, { holdBack: {} }, { holdBack: { drawOverfull: first ? [first, 'pg_2'] : [] } }, { pageIds: first ? [first] : [], force: true }, { lock: null }];
        out[`${name}.quoteRenderPages.${tier}.${byok}`] = cases.map((c) => quoteRenderPages(doc, { ...c, byok, tier, modelOverride: doc.settings.imageModelOverride }));
      }
      out[`${name}.summarizeBook.${byok}`] = [
        summarizeBook(doc, { byok }),
        summarizeBook(doc, { byok, tier: 'pro', rating: 'PG' }),
        summarizeBook(doc, { byok, pageIds: first ? [first] : undefined, drawOverfull: ['pg_2'] })
      ];
    }
  }
  return out;
};
