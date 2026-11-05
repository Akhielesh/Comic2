// B4: plan.ts with consistency anchors — missing anchors, the quote counting anchors plus the reference allowance, and
// the breakdown's per-page anchors / text-only cast / detail / lint. Without the new options plan.ts is byte for byte
// what it was (plan.compat.test.ts); the client quote equals the server estimate in server/src/comic/plan.anchors.parity.test.ts.
import { describe, expect, it } from 'vitest';
import { asset, harbourComic, lakeStory, readyRender } from './__fixtures__/consistencyBooks';
import type { ComicDoc, ImageModelLock, RefAsset } from './doc';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, getImageModel } from './models';
import { partsOf } from './parts';
import { REF_ALLOWANCE_USD, extraRefsUsd, missingAnchorsFor, quoteRenderPages, summarizeBook, type AnchorRunOptions } from './plan';

const r4 = (n: number) => Math.round(n * 10000) / 10000;
const NB21 = getImageModel('nano-banana-2.1')!;
const PRO = getImageModel('nano-banana-pro')!;
const PLACES: AnchorRunOptions = { mode: 'auto', kinds: { places: true } };
const ALL: AnchorRunOptions = { mode: 'auto', kinds: { places: true, props: true, styleKey: true, sheetV2: true } };
const LEGACY: ImageModelLock = { modelId: 'nano-banana-legacy', lockedAt: 1, origin: 'first_render' };

describe('missingAnchorsFor', () => {
  it('recurring extras always; recurring places and props only with their kind; leads and one-offs never', () => {
    const doc = harbourComic((d) => {
      d.cast.push({ ...d.cast[2], id: 'c_walkon', name: 'Fisherman' });
      d.pages[5].panels[0].castIds = [...d.pages[5].panels[0].castIds, 'c_walkon'];
    });
    expect(missingAnchorsFor(doc, doc.pages).map((m) => [m.key, m.kind, m.pageIds])).toEqual([['char:c_guard', 'character', ['pg_1', 'pg_2']]]);
    expect(missingAnchorsFor(doc, doc.pages, { kinds: { places: true, props: true } }).map((m) => [m.key, m.name, m.pageIds])).toEqual([
      ['char:c_guard', 'GATE GUARD', ['pg_1', 'pg_2']],
      ['place:pl_gate', 'CHITRAKULAM GATE', ['pg_1', 'pg_2']],
      ['place:pl_market', 'NIGHT MARKET', ['pg_3', 'pg_4']],
      ['place:pl_temple', 'SEA TEMPLE', ['pg_5', 'pg_6']],
      ['prop:c_lantern', 'BRASS LANTERN', ['pg_2', 'pg_3', 'pg_4']]
    ]);
    // Only the anchors the given pages use.
    expect(missingAnchorsFor(doc, doc.pages.slice(4), { kinds: { places: true } }).map((m) => m.key)).toEqual(['place:pl_temple']);
  });

  it('a drawn or busy sheet is not missing; an unticked anchor is listed as skipped', () => {
    const doc = harbourComic((d) => {
      d.places[0].sheet = readyRender('u/o/h/gate.webp');
      d.places[1].sheet = { status: 'rendering', history: [] };
      d.consistency = { skip: ['place:pl_temple'] };
    });
    expect(missingAnchorsFor(doc, doc.pages, { kinds: { places: true } }).map((m) => [m.key, m.skipped])).toEqual([
      ['char:c_guard', false],
      ['place:pl_temple', true]
    ]);
  });
});

describe('quoteRenderPages — counting anchors plus the reference allowance', () => {
  it('adds the anchor sheets (places and props at 1K) and the allowance per extra reference', () => {
    const doc = harbourComic();
    const plain = quoteRenderPages(doc, { byok: false, tier: 'standard' });
    const q = quoteRenderPages(doc, { byok: false, tier: 'standard', anchors: PLACES });
    const page = (NB21.priceUsd['2K']! + QC_USD_PER_PAGE) * PLATFORM_MARKUP;
    // Extra references (the anchors' additions over today's plan, sheets drawn first counted as attached):
    // p1 +2 (the guard's sheet, the gate), p2 +2 (the guard, the gate), p3–p6 +1 each (their place) = 8.
    expect(q.anchors).toMatchObject({ keys: ['char:c_guard', 'place:pl_gate', 'place:pl_market', 'place:pl_temple'], skipped: [], unused: [], extraRefs: 8 });
    expect(q.anchors!.missing.map((m) => m.key)).toEqual(q.anchors!.keys);
    expect(q.anchors!.missing.some((m) => m.unused)).toBe(false);
    expect(q.anchors!.lines).toEqual([
      { label: 'recurring character sheets', count: 1, usd: r4(NB21.priceUsd['2K']! * PLATFORM_MARKUP), kind: 'sheet' },
      { label: 'place sheets', count: 3, usd: r4(NB21.priceUsd['1K']! * 3 * PLATFORM_MARKUP), kind: 'place' },
      { label: 'extra references', count: 8, usd: r4(8 * REF_ALLOWANCE_USD * PLATFORM_MARKUP), kind: 'refs' }
    ]);
    // One base line here ('pages': no missing lead/support sheet, no cover): the anchor lines follow it, never at a fixed index.
    expect(q.lines).toEqual([{ label: 'pages', count: 6, usd: r4(page * 6) }, ...q.anchors!.lines.map(({ kind: _k, ...l }) => l)]);
    expect(q.usd).toBe(r4(q.lines.reduce((s, l) => s + l.usd, 0)));
    expect(q.imageCount).toBe(plain.imageCount + 4);
    expect(q.pageIds).toEqual(plain.pageIds);
    // The page and sheet lines are exactly today's.
    expect(q.lines.slice(0, plain.lines.length)).toEqual(plain.lines);
  });

  it('props take their own line; BYOK pays no markup; an unticked anchor is neither drawn nor quoted', () => {
    const doc = harbourComic((d) => {
      d.consistency = { skip: ['place:pl_temple', 'char:c_guard'] };
    });
    const q = quoteRenderPages(doc, { byok: true, tier: 'standard', anchors: ALL });
    expect(q.anchors!.keys).toEqual(['place:pl_gate', 'place:pl_market', 'prop:c_lantern']);
    expect(q.anchors!.skipped).toEqual(['char:c_guard', 'place:pl_temple']);
    const label = (l: string) => q.lines.find((x) => x.label === l);
    expect(label('place sheets')).toEqual({ label: 'place sheets', count: 2, usd: r4(NB21.priceUsd['1K']! * 2) });
    expect(label('prop sheets')).toEqual({ label: 'prop sheets', count: 1, usd: r4(NB21.priceUsd['1K']!) });
    expect(label('recurring character sheets')).toBeUndefined();
    expect(label('extra references')!.usd).toBe(r4(label('extra references')!.count * REF_ALLOWANCE_USD));
  });

  it('a model with a published per-reference price is quoted at that price, not the allowance', () => {
    expect(extraRefsUsd(PRO, 10, true)).toBe(r4(10 * PRO.perRefUsd!));
    expect(extraRefsUsd(NB21, 10, true)).toBe(r4(10 * REF_ALLOWANCE_USD));
    expect(extraRefsUsd(NB21, 0, false)).toBe(0);
    const doc = harbourComic((d) => {
      d.imageModel = { modelId: 'nano-banana-pro', lockedAt: 1, origin: 'user_change' };
    });
    const q = quoteRenderPages(doc, { byok: true, tier: 'standard', anchors: PLACES });
    const refs = q.lines.find((l) => l.label === 'extra references')!;
    expect(refs.usd).toBe(r4(refs.count * PRO.perRefUsd!));
    // Pro draws place sheets on the locked model.
    expect(q.lines.find((l) => l.label === 'place sheets')!.usd).toBe(r4(PRO.priceUsd['1K']! * 3));
  });

  it('a legacy-locked comic quotes no place or prop sheet it can never attach; those anchors stay in words and say why', () => {
    // nano-banana-legacy takes 3 references (2 characters, 1 object): every page attaches its two beings and the style
    // board, so the places and the lantern are never attached (plan §8: places, props and style go as text).
    const doc = harbourComic((d) => {
      d.imageModel = LEGACY;
    });
    const run: AnchorRunOptions = { mode: 'auto', kinds: { places: true, props: true } };
    const plain = quoteRenderPages(doc, { byok: false, tier: 'standard' });
    const q = quoteRenderPages(doc, { byok: false, tier: 'standard', anchors: run });
    expect(q.lines.map((l) => l.label)).toEqual(['pages', 'recurring character sheets', 'extra references']);
    expect(q.anchors!.keys).toEqual(['char:c_guard']);
    expect(q.anchors!.unused).toEqual(['place:pl_gate', 'place:pl_market', 'place:pl_temple', 'prop:c_lantern']);
    expect(q.imageCount).toBe(plain.imageCount + 1);
    const lake = q.anchors!.missing.find((m) => m.key === 'place:pl_gate')!;
    expect(lake).toMatchObject({ unused: true, skipped: false });
    expect(lake.text).toBe('No sheet is made for CHITRAKULAM GATE: no page in this run has a reference slot left for it, so it is described in words.');
    expect(q.anchors!.missing.find((m) => m.key === 'char:c_guard')!.unused).toBeUndefined();
    // The breakdown says the same: the book's list flags them, and each page names the cap that leaves them in words.
    const s = summarizeBook(doc, { byok: false, tier: 'standard', consistency: run });
    expect(s.anchors!.missing.filter((m) => m.unused).map((m) => m.key)).toEqual(q.anchors!.unused);
    expect(s.anchors!.usd).toBe(r4(q.usd - plain.usd));
    expect(s.pages[0].anchors!.map((a) => a.key)).toEqual(['char:c_meera', 'char:c_guard', 'style']);
    expect(s.pages[0].textOnly).toEqual([
      { id: 'pl_gate', name: 'CHITRAKULAM GATE', why: 'cap', text: 'This model takes at most 3 reference images per page. CHITRAKULAM GATE is described in words on this page.' }
    ]);
    expect(s.pages[2].textOnly!.map((t) => [t.id, t.why])).toEqual([
      ['pl_market', 'cap'],
      ['c_lantern', 'cap']
    ]);
    // An unticked anchor that ticking would not help is flagged too (the card offers nothing for it).
    const skipped = harbourComic((d) => {
      d.imageModel = LEGACY;
      d.consistency = { skip: ['place:pl_gate'] };
    });
    const qs = quoteRenderPages(skipped, { byok: false, tier: 'standard', anchors: run });
    expect(qs.anchors!.skipped).toEqual(['place:pl_gate']);
    expect(qs.anchors!.missing.find((m) => m.key === 'place:pl_gate')).toMatchObject({ skipped: true, unused: true });
    expect(qs.usd).toBe(q.usd);
  });

  it('an unticked anchor that ticking would attach is offered, not flagged unused', () => {
    const doc = harbourComic((d) => {
      d.consistency = { skip: ['place:pl_gate'] };
    });
    const q = quoteRenderPages(doc, { byok: false, tier: 'standard', anchors: PLACES });
    expect(q.anchors!.missing.find((m) => m.key === 'place:pl_gate')).toEqual({
      key: 'place:pl_gate',
      kind: 'place',
      id: 'pl_gate',
      name: 'CHITRAKULAM GATE',
      pageIds: ['pg_1', 'pg_2'],
      skipped: true
    });
  });

  it('a page that attaches fewer references with anchors never lowers the quote (each page counts from 0)', () => {
    // Page 1 uses six places with sheets: today attaches all of them, the places kind only 2 (−2 references); page 2
    // adds the guard's and the gate's sheets (+2). The allowance prices +2, never the net 0.
    const doc = harbourComic((d) => {
      for (const k of [1, 2, 3, 4, 5]) d.places.push({ id: `pl_x${k}`, name: `Alley ${k}`, look: 'Narrow', refs: [], sheet: readyRender(`u/o/h/x${k}.webp`) });
      const base = d.pages[0].panels[2];
      d.pages[0].panels = [
        ...d.pages[0].panels.map((pn, i) => ({ ...pn, placeId: ['pl_gate', 'pl_x1', 'pl_x2'][i] })),
        ...[3, 4, 5].map((k, i) => ({ ...base, id: `pg_1_p${4 + i}`, n: 4 + i, placeId: `pl_x${k}` }))
      ];
    });
    const q = quoteRenderPages(doc, { byok: false, tier: 'standard', pageIds: ['pg_1', 'pg_2'], anchors: PLACES });
    expect(q.anchors!.extraRefs).toBe(2);
    expect(q.anchors!.lines.find((l) => l.kind === 'refs')).toEqual({ label: 'extra references', count: 2, usd: r4(2 * REF_ALLOWANCE_USD * PLATFORM_MARKUP), kind: 'refs' });
    const p1Only = quoteRenderPages(doc, { byok: false, tier: 'standard', pageIds: ['pg_1'], anchors: PLACES });
    expect(p1Only.anchors!.extraRefs).toBe(0);
    expect(p1Only.usd).toBeGreaterThanOrEqual(quoteRenderPages(doc, { byok: false, tier: 'standard', pageIds: ['pg_1'] }).usd);
  });

  it("mode 'none' and kinds off with nothing recurring are today's quote", () => {
    const doc = harbourComic();
    const plain = quoteRenderPages(doc, { byok: false, tier: 'standard', includeCover: true });
    expect(quoteRenderPages(doc, { byok: false, tier: 'standard', includeCover: true, anchors: { mode: 'none', kinds: { places: true } } })).toEqual(plain);
    const lake = lakeStory((d) => {
      d.pages = d.pages.map((p) => ({ ...p, render: { status: 'none', history: [] } }));
    });
    const auto = quoteRenderPages(lake, { byok: false, tier: 'draft', anchors: { mode: 'auto' } });
    const { anchors, ...rest } = auto;
    expect(anchors).toEqual({ keys: [], skipped: [], unused: [], extraRefs: 0, lines: [], missing: [] });
    expect(rest).toEqual(quoteRenderPages(lake, { byok: false, tier: 'draft' }));
  });
});

describe('summarizeBook — the consistency view', () => {
  it('lists what each page attaches, who is described in words and why (the 5th being)', () => {
    const doc = lakeStory();
    const s = summarizeBook(doc, { byok: false, consistency: { mode: 'none' } });
    const p5 = s.pages.find((p) => p.n === 5)!;
    expect(p5.anchors!.map((a) => a.key)).toEqual(['char:c_baby', 'char:c_ducks', 'char:c_frog', 'char:c_bunny', 'place:pl_lake', 'style', 'prev:pg_4']);
    expect(p5.anchors![0]).toEqual({ key: 'char:c_baby', role: 'character', name: 'THE BABY', source: 'sheet', path: 'u/o/l/baby.webp' });
    expect(p5.textOnly).toEqual([{ id: 'c_heron', name: 'HERON', why: 'cap', text: 'This model keeps 4 characters on model per page. HERON is described in words on this page.' }]);
    expect(p5.detail).toEqual({ panels: 4, directions: 0, continuity: false, scene: { name: 'The Lake', from: 'derived' } });
    expect(p5.lint).toBeUndefined();
    expect(s.anchors).toEqual({ mode: 'none', kinds: { places: false, props: false, styleKey: false, sheetV2: false }, missing: [], usd: 0, extraRefs: 0 });
  });

  it("with mode 'auto' the quotes count the anchors: totals, the page quote and the book's anchor line", () => {
    const doc = harbourComic();
    const plain = summarizeBook(doc, { byok: false });
    const s = summarizeBook(doc, { byok: false, consistency: PLACES });
    const q = quoteRenderPages(doc, { byok: false, tier: doc.settings.quality, holdBack: {}, anchors: PLACES });
    expect(s.totals.toDrawUsd).toBe(q.usd);
    expect(s.anchors!.usd).toBe(r4(q.usd - plain.totals.toDrawUsd));
    expect(s.anchors!.extraRefs).toBe(8);
    expect(s.anchors!.missing.map((m) => m.key)).toEqual(q.anchors!.keys);
    const p1 = s.pages[0];
    expect(p1.quoteUsd).toBe(r4(plain.pages[0].quoteUsd! + extraRefsUsd(NB21, 2, false)));
    expect(p1.anchors!.find((a) => a.key === 'place:pl_gate')).toEqual({ key: 'place:pl_gate', role: 'place', name: 'CHITRAKULAM GATE', source: 'sheet', pending: true });
  });

  it('puts continuity and direction lint on their page, and names what changed since a drawing with parts', () => {
    const doc = harbourComic((d) => {
      d.pages[1].continuity = { sceneId: 'sc_missing' };
      d.pages[2].panels[0].direction = { lens: 'macro', by: 'writer' };
      d.pages[2].panels[0].shot = 'establishing';
      d.pages[3].render = { ...readyRender('u/o/h/p4.webp'), parts: partsOf(d, d.pages[3]) };
    });
    doc.pages[3].panels[1].castIds = ['c_meera'];
    const s = summarizeBook(doc, { byok: false, consistency: { mode: 'none' } });
    expect(s.pages[1].lint).toEqual([{ kind: 'unknown_scene', severity: 'major', text: "Page 2 is set in a scene the book doesn't have." }]);
    expect(s.pages[2].lint).toEqual([{ kind: 'lens_shot', severity: 'minor', text: 'Panel 1 on page 3 is an establishing shot but asks for a macro lens.', panel: 1 }]);
    expect(s.pages[2].detail).toMatchObject({ directions: 1, continuity: false });
    expect(s.pages[1].detail).toMatchObject({ continuity: true });
    expect(s.pages[3].detail!.changed).toEqual(["Panel 2: who's in it"]);
    expect(s.pages[0].lint).toBeUndefined();
  });

  it("ranks photos with summarizeBook's own rating unless the view names one", () => {
    const photo = (path: string, assessed: 'G' | 'PG-13'): RefAsset => ({ ...asset(path), source: 'upload', safety: { assessed, at: 1 } });
    const doc = harbourComic((d) => {
      d.settings = { ...d.settings, rating: 'PG-13' };
      d.cast = d.cast.map((c) => (c.id === 'c_guard' ? { ...c, refs: [photo('u/o/h/guard-teen.jpg', 'PG-13'), photo('u/o/h/guard-kid.jpg', 'G')] } : c));
    });
    const guard = (s: ReturnType<typeof summarizeBook>) => s.pages[0].anchors!.find((a) => a.key === 'char:c_guard')!.path;
    expect(guard(summarizeBook(doc, { byok: false, consistency: { mode: 'none' } }))).toBe('u/o/h/guard-teen.jpg');
    expect(guard(summarizeBook(doc, { byok: false, rating: 'G', consistency: { mode: 'none' } }))).toBe('u/o/h/guard-kid.jpg');
    expect(summarizeBook(doc, { byok: false, rating: 'G', consistency: { mode: 'none' } }).pages).toEqual(
      summarizeBook(doc, { byok: false, rating: 'G', consistency: { mode: 'none', rating: 'G' } }).pages
    );
    // The view's own rating wins.
    expect(guard(summarizeBook(doc, { byok: false, rating: 'G', consistency: { mode: 'none', rating: 'PG-13' } }))).toBe('u/o/h/guard-teen.jpg');
  });

  it('without the option no Ship 2 field appears (the byte-for-byte proof is plan.compat.test.ts)', () => {
    const books: ComicDoc[] = [harbourComic(), lakeStory()];
    for (const doc of books) {
      const s = summarizeBook(doc, { byok: false });
      expect(s.anchors).toBeUndefined();
      for (const p of s.pages) for (const k of ['anchors', 'textOnly', 'detail', 'lint']) expect(p).not.toHaveProperty(k);
    }
  });
});
