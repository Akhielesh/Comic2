// Parity: shared/comic/anchors.ts planAnchors in 'ship1' mode (every COMIC_CONSISTENCY_ANCHORS kind off) attaches
// exactly what the server's page compile attaches today (prompts.ts planPageReferences): the same images, in the same
// order, in the same slots — for every registered model, with and without the layout guide. This is what lets B5
// build planPageReferences from planAnchors with a doc without new data compiling byte for byte (I8), and lets the
// client show exactly what the server sends. (Server-side file so the client typecheck never pulls server code.)
import { describe, expect, it } from 'vitest';
import { asset, harbourComic, lakeStory, readyRender } from '../../../shared/comic/__fixtures__/consistencyBooks.js';
import { planAnchors, type PlannedAnchor } from '../../../shared/comic/anchors.js';
import type { ComicDoc, RefAsset } from '../../../shared/comic/doc.js';
import { IMAGE_MODELS } from '../../../shared/comic/models.js';
import { nearestReadyBefore } from '../../../shared/comic/sendable.js';
import { LAYOUT_REFERENCE_PATH, planPageReferences, type PlannedReference } from './prompts.js';

const photo = (path: string, extra: Partial<RefAsset> = {}): RefAsset => ({ ...asset(path), source: 'upload', ...extra });

/** The server's reference kind for a planned anchor. */
const kindOf = (a: PlannedAnchor): PlannedReference['kind'] => {
  switch (a.role) {
    case 'layout':
      return 'layout';
    case 'character':
      return a.source === 'sheet' ? 'character' : 'author';
    case 'likeness':
    case 'photo2':
      return 'author';
    case 'place':
      return 'place';
    case 'previous':
      return 'previous_page';
    default:
      return 'style';
  }
};

const fixtures = (): Record<string, ComicDoc> => ({
  harbour: harbourComic(),
  lake: lakeStory(),
  // Everything at once: drawn pages, place sheets and photos, style refs, cast photos, a likeness, a blocked sheet, a
  // support prop with a sheet, an extra prop with a sheet, a blocked page drawing.
  rich: harbourComic((d) => {
    d.style = { ...d.style, refs: [photo('u/o/h/style1.jpg', { label: 'linework' }), photo('u/o/h/style2.jpg', { label: 'color' }), photo('u/o/h/style3.jpg')] };
    d.places = d.places.map((p, i) =>
      i === 0 ? { ...p, sheet: readyRender('u/o/h/gate.webp') } : i === 1 ? { ...p, refs: [photo('u/o/h/market.jpg', { label: 'wide' })] } : p
    );
    d.cast = d.cast.map((c) => {
      if (c.id === 'c_meera') return { ...c, likeness: 'sheet_and_photo' as const, refs: [photo('u/o/h/meera1.jpg', { subject: 'person' }), photo('u/o/h/meera2.jpg', { label: 'face' })] };
      if (c.id === 'c_ravi') return { ...c, sheet: { ...readyRender('u/o/h/ravi.webp'), asset: { ...asset('u/o/h/ravi.webp'), safety: { assessed: 'X' as const, at: 1 } } }, refs: [photo('u/o/h/ravi1.jpg'), photo('u/o/h/ravi2.jpg', { label: 'side' })] };
      if (c.id === 'c_guard') return { ...c, refs: [photo('u/o/h/guard.jpg', { subject: 'person' })] };
      if (c.id === 'c_lantern') return { ...c, sheet: readyRender('u/o/h/lantern.webp') };
      return c;
    });
    d.cast.push({ id: 'c_kite', name: 'Red Kite', tier: 'support', kind: 'object', look: { summary: 'A red kite' }, refs: [], sheet: readyRender('u/o/h/kite.webp') });
    d.pages[3].panels[0].castIds = [...d.pages[3].panels[0].castIds, 'c_kite'];
    d.pages[2].panels[1].placeId = 'pl_gate';
    d.pages = d.pages.map((p) => (p.n === 5 ? p : { ...p, render: readyRender(`u/o/h/p${p.n}.webp`) }));
    d.pages[3].render = { ...d.pages[3].render, asset: { ...d.pages[3].render.asset!, safety: { assessed: 'X', at: 1 } } };
  }),
  noBoard: lakeStory((d) => {
    d.style = { ...d.style, board: undefined, refs: [photo('u/o/l/style.jpg', { label: 'color' })] };
  })
});

describe('planAnchors (ship1) === prompts.ts planPageReferences', () => {
  for (const [name, doc] of Object.entries(fixtures())) {
    it(`attaches the same references on the ${name} fixture for every model, with and without the layout guide`, () => {
      let compared = 0;
      const seen = new Set<string>();
      for (const spec of IMAGE_MODELS) {
        for (const layoutGuide of [false, true]) {
          for (const page of doc.pages) {
            const prev = nearestReadyBefore(doc, page);
            const server = planPageReferences(doc, page, spec, prev, layoutGuide ? { layoutGuide: true } : {});
            const shared = planAnchors(doc, page, spec, null, { layoutGuide, previousPage: prev ?? null });
            const byDefault = planAnchors(doc, page, spec, null, { layoutGuide });
            expect(shared.mode).toBe('ship1');
            expect(byDefault.attached).toEqual(shared.attached);
            expect(shared.attached.map((a) => ({ path: a.path ?? LAYOUT_REFERENCE_PATH, kind: kindOf(a), slot: a.slot }))).toEqual(
              server.map((r) => ({ path: r.path, kind: r.kind, slot: r.slot }))
            );
            for (const [i, a] of shared.attached.entries()) {
              if (a.role === 'place') expect(server[i].placeId).toBe(a.id);
              if (a.role === 'character' || a.role === 'likeness' || a.role === 'photo2') expect(server[i].characterId).toBe(a.id);
            }
            compared += server.length;
            for (const a of shared.attached) seen.add(`${a.role}/${a.source}`);
          }
        }
      }
      expect(compared).toBeGreaterThan(0);
      if (name === 'rich') {
        // The rich fixture really exercises every path of the planner.
        for (const k of ['layout/guide', 'character/sheet', 'character/photo', 'likeness/photo', 'photo2/photo', 'place/sheet', 'place/photo', 'style/board', 'style/style_ref', 'previous/page']) {
          expect(seen, k).toContain(k);
        }
      }
    });
  }
});
