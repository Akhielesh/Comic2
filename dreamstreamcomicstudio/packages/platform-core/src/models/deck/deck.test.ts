// @vitest-environment node
//
// DeckSpec v1 (plan §5.2, W1.2): the schema and its refinements (rects stay on the slide, one chart value per
// category); applyDeckOps with exact inverses; and overlapCheck, which flags the SmartArt-over-chart fixture (export is
// refused while content elements overlap) and nothing on the contract deck.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DeckElement, DeckOp, DeckRect, DeckSpec, OverlapPair, Slide } from './index.js';
import {
  DECK_LIMITS,
  applyDeckOps,
  checkDeckOp,
  checkDeckSpec,
  checkSlide,
  deckOverlaps,
  invertDeckOp,
  invertDeckOps,
  migrateDeckSpec,
  overlapCheck,
} from './index.js';

const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(new URL(`../../../fixtures/${name}`, import.meta.url), 'utf8')) as T;

const minimal = (): DeckSpec => fixture<DeckSpec>('contract/deck/minimal.json');
const full = (): DeckSpec => fixture<DeckSpec>('contract/deck/full.json');
const contractOps = (): DeckOp[] => fixture<DeckOp[]>('contract/deck/ops.json');
const smartArt = () => fixture<{ slide: Slide; expected: OverlapPair[]; fixedChartRect: DeckRect }>('models/deck/smartart-over-chart.json');

const content = (deck: DeckSpec): Omit<DeckSpec, 'rev'> => {
  const out = { ...deck };
  delete out.rev;
  return out;
};

const undoIds = (op: DeckOp, i: number) => `undo-${i}-${op.id}`.slice(0, 64);

const roundTrip = (deck: DeckSpec, ops: DeckOp[]) => {
  const forward = applyDeckOps(deck, ops);
  const undo = invertDeckOps(deck, forward.applied, { baseRev: forward.doc.rev ?? 0, id: undoIds });
  expect(undo).not.toBeNull();
  const back = applyDeckOps(forward.doc, undo!);
  expect(back.rejected).toEqual([]);
  expect(content(back.doc)).toEqual(content(deck));
  return forward;
};

const box = (id: string, rect: DeckRect, layer: 'content' | 'background' = 'content'): DeckElement => ({ kind: 'shape', id, rect, layer, shape: 'rect' });
const line = (id: string, rect: DeckRect): DeckElement => ({ kind: 'shape', id, rect, layer: 'content', shape: 'line' });
const text = (id: string, rect: DeckRect): DeckElement => ({ kind: 'text', id, rect, layer: 'content', paragraphs: [{ runs: [{ text: id }] }] });
const slideOf = (elements: DeckElement[]): Slide => ({ id: 'sl', layout: 'content', elements });

describe('DeckSpec schema', () => {
  it('accepts every contract fixture as it is, and migrate() reads v1 into the same deck', () => {
    for (const deck of [minimal(), full()]) {
      expect(checkDeckSpec(deck)).toEqual({ ok: true, value: deck });
      expect(migrateDeckSpec(deck)).toEqual({ ok: true, value: deck });
    }
    for (const op of contractOps()) expect(checkDeckOp(op)).toEqual({ ok: true, value: op });
    expect(migrateDeckSpec({ ...minimal(), v: 3 })).toMatchObject({ ok: false, errors: [{ path: 'v', code: 'literal' }] });
  });

  it('refines what the DSL cannot say: a rect stays on the slide, a series holds one value per category', () => {
    const offRight = slideOf([box('a', [0.6, 0, 0.5, 0.2])]);
    expect(checkSlide(offRight)).toMatchObject({ ok: false, errors: [{ path: 'elements[0].rect[2]', code: 'above-max' }] });
    const offBottom = slideOf([box('a', [0, 0.9, 0.2, 0.2])]);
    expect(checkSlide(offBottom)).toMatchObject({ ok: false, errors: [{ path: 'elements[0].rect[3]', code: 'above-max' }] });
    // Binary rounding (0.1 + 0.9 is a hair over 1) is not a violation; the right and bottom edges themselves are allowed.
    expect(checkSlide(slideOf([box('a', [0.1, 0.7, 0.9, 0.3]), box('b', [0, 0, 1, 1], 'background')])).ok).toBe(true);
    const chart: DeckElement = { kind: 'chart', id: 'c', rect: [0, 0, 1, 1], layer: 'content', chart: 'line', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] };
    expect(checkSlide(slideOf([chart]))).toMatchObject({ ok: false, errors: [{ path: 'elements[0].series[0].values', code: 'too-few' }] });
    // Ops carry the same rules: an add_slide with an element off the slide is refused, at the op's own path.
    const op = { op: 'add_slide', id: 'op-x', baseRev: 0, slide: offRight };
    expect(checkDeckOp(op)).toMatchObject({ ok: false, errors: [{ path: 'slide.elements[0].rect[2]', code: 'above-max' }] });
    const r = applyDeckOps(minimal(), [op as DeckOp]);
    expect(r.rejected).toMatchObject([{ code: 'invalid', message: expect.stringContaining('slide.elements[0].rect[2]') }]);
    const rename = { op: 'update_slide', id: 'op-y', baseRev: 0, slideId: 'sl1', slide: { id: 'sl9', layout: 'end', elements: [] } };
    expect(checkDeckOp(rename)).toMatchObject({ ok: false, errors: [{ path: 'slide.id', code: 'literal' }] });
  });
});

describe('overlapCheck', () => {
  it('flags every content pair of the SmartArt-over-chart fixture, and nothing else', () => {
    const { slide, expected } = smartArt();
    expect(checkSlide(slide).ok).toBe(true);
    const pairs = overlapCheck(slide);
    expect(pairs.map(({ a, b }) => ({ a, b }))).toEqual(expected.map(({ a, b }) => ({ a, b })));
    pairs.forEach((p, i) => expect(p.area).toBeCloseTo(expected[i].area, 9));
  });

  it('the fixed layout (chart moved below the diagram) is exportable', () => {
    const { slide, fixedChartRect } = smartArt();
    const deck: DeckSpec = { v: 1, title: 'Pitch', size: '16:9', theme: { preset: 'dark' }, slides: [slide] };
    expect(deckOverlaps(deck)).toEqual([{ slideId: 'sl-smartart', pairs: overlapCheck(slide) }]);
    const chart = slide.elements.find((e) => e.id === 'chart')!;
    const fixed: Slide = { ...slide, elements: slide.elements.map((e) => (e === chart ? { ...chart, rect: fixedChartRect } : e)) };
    const r = applyDeckOps(deck, [{ op: 'update_slide', id: 'fix', baseRev: 0, slideId: 'sl-smartart', slide: fixed }]);
    expect(r.rejected).toEqual([]);
    expect(overlapCheck(r.doc.slides[0])).toEqual([]);
    expect(deckOverlaps(r.doc)).toEqual([]);
  });

  it('finds no overlap anywhere on the contract deck', () => {
    for (const slide of full().slides) expect(overlapCheck(slide)).toEqual([]);
    expect(deckOverlaps(full())).toEqual([]);
  });

  it('touching edges never overlap, even after binary rounding; a hair of real overlap does', () => {
    const third = 0.1 + 0.2; // 0.30000000000000004
    expect(overlapCheck(slideOf([box('a', [0.1, 0, 0.2, 1]), box('b', [third, 0, 0.3, 1])]))).toEqual([]);
    expect(overlapCheck(slideOf([box('a', [0, 0, 0.5, 0.5]), box('b', [0.5, 0.5, 0.5, 0.5])]))).toEqual([]);
    const tiny = overlapCheck(slideOf([box('a', [0, 0, 0.5, 1]), box('b', [0.499, 0, 0.5, 1])]));
    expect(tiny).toHaveLength(1);
    expect(tiny[0].area).toBeCloseTo(0.001, 9);
    // Containment is overlap: a box fully inside another.
    expect(overlapCheck(slideOf([box('big', [0, 0, 1, 1]), box('in', [0.4, 0.4, 0.1, 0.1])]))).toEqual([{ a: 'big', b: 'in', area: expect.closeTo(0.01, 9) }]);
  });

  it('a line shape through a box overlaps it (area 0); a line along an edge, or two crossing lines, do not', () => {
    const t = box('t', [0.1, 0.1, 0.5, 0.5]);
    expect(overlapCheck(slideOf([t, line('h', [0, 0.3, 1, 0])]))).toEqual([{ a: 't', b: 'h', area: 0 }]);
    expect(overlapCheck(slideOf([line('v', [0.3, 0, 0, 1]), t]))).toEqual([{ a: 'v', b: 't', area: 0 }]);
    expect(overlapCheck(slideOf([t, line('edge', [0, 0.6, 1, 0])]))).toEqual([]);
    expect(overlapCheck(slideOf([t, line('beside', [0.7, 0.3, 0.2, 0])]))).toEqual([]);
    expect(overlapCheck(slideOf([line('h', [0, 0.5, 1, 0]), line('v', [0.5, 0, 0, 1])]))).toEqual([]);
    // A diagonal line counts as its bounding box.
    expect(overlapCheck(slideOf([t, line('diag', [0.5, 0.5, 0.3, 0.3])]))).toEqual([{ a: 't', b: 'diag', area: expect.closeTo(0.01, 9) }]);
  });

  it('only a line shape may be flat: a flat text box or table is refused, and overlapCheck still flags it', () => {
    // A zero-height text box on the chart's top edge: renderers draw the text down from that edge, across the chart.
    const chart: DeckElement = { kind: 'chart', id: 'chart', rect: [0.1, 0.2, 0.8, 0.7], layer: 'content', chart: 'bar', categories: ['a'], series: [{ name: 's', values: [1] }] };
    const onEdge = slideOf([chart, text('label', [0.1, 0.2, 0.8, 0])]);
    expect(checkSlide(onEdge)).toMatchObject({ ok: false, errors: [{ path: 'elements[1].rect[3]', code: 'below-min' }] });
    expect(overlapCheck(onEdge)).toEqual([{ a: 'chart', b: 'label', area: 0 }]);
    // Two zero-height text boxes stacked at the same y.
    const stacked = slideOf([text('one', [0.1, 0.5, 0.8, 0]), text('two', [0.1, 0.5, 0.8, 0])]);
    expect(checkSlide(stacked)).toMatchObject({
      ok: false,
      errors: [
        { path: 'elements[0].rect[3]', code: 'below-min' },
        { path: 'elements[1].rect[3]', code: 'below-min' },
      ],
    });
    expect(overlapCheck(stacked)).toEqual([{ a: 'one', b: 'two', area: 0 }]);
    // A table with no width, a rect shape squashed flat: refused too. A line shape may be flat either way.
    const table: DeckElement = { kind: 'table', id: 'tbl', rect: [0.1, 0.9, 0, 0.05], layer: 'content', rows: [] };
    expect(checkSlide(slideOf([table]))).toMatchObject({ ok: false, errors: [{ path: 'elements[0].rect[2]', code: 'below-min' }] });
    expect(checkSlide(slideOf([box('r', [0.1, 0.1, 0.5, 1e-7])]))).toMatchObject({ ok: false, errors: [{ path: 'elements[0].rect[3]', code: 'below-min' }] });
    expect(checkSlide(slideOf([line('h', [0, 0.5, 1, 0]), line('v', [0.5, 0, 0, 1])])).ok).toBe(true);
    // An op cannot bring one in either.
    const r = applyDeckOps(minimal(), [{ op: 'add_slide', id: 'flat', baseRev: 0, slide: onEdge }]);
    expect(r.rejected).toMatchObject([{ code: 'invalid', message: expect.stringContaining('slide.elements[1].rect[3]') }]);
    // A flat box that touches nothing is no overlap.
    expect(overlapCheck(slideOf([chart, text('far', [0.1, 0.95, 0.8, 0])]))).toEqual([]);
  });

  it('slide ids are unique in a deck and element ids within a slide (the same element id on two slides is fine)', () => {
    const deck = full();
    const twoSlides: DeckSpec = { ...deck, slides: [deck.slides[0], { ...deck.slides[1], id: deck.slides[0].id }] };
    expect(checkDeckSpec(twoSlides)).toMatchObject({ ok: false, errors: [{ path: 'slides[1].id', code: 'too-many' }] });
    const sameOnTwo: DeckSpec = { ...minimal(), slides: [slideOf([box('e', [0, 0, 0.1, 0.1])]), { ...slideOf([box('e', [0, 0, 0.1, 0.1])]), id: 'sl2' }] };
    expect(checkDeckSpec(sameOnTwo).ok).toBe(true);
    expect(checkSlide(slideOf([box('e', [0, 0, 0.1, 0.1]), box('e', [0.5, 0.5, 0.1, 0.1])]))).toMatchObject({ ok: false, errors: [{ path: 'elements[1].id', code: 'too-many' }] });
  });

  it('background elements never count, and it never throws on anything', () => {
    expect(overlapCheck(slideOf([box('bg', [0, 0, 1, 1], 'background'), box('a', [0.2, 0.2, 0.2, 0.2]), box('b', [0.5, 0.5, 0.2, 0.2])]))).toEqual([]);
    for (const junk of [null, undefined, 1, 'slide', [], {}, { elements: null }, { elements: [null, 1, { layer: 'content' }, { id: 'x', layer: 'content', rect: [0, 0, 'a', 1] }] }]) {
      expect(overlapCheck(junk as unknown as Slide)).toEqual([]);
      expect(deckOverlaps(junk as unknown as DeckSpec)).toEqual([]);
    }
  });
});

describe('applyDeckOps', () => {
  it('applies each contract op, and undoes each one exactly', () => {
    for (const op of contractOps()) {
      const r = roundTrip(minimal(), [op]);
      expect(r.rejected).toEqual([]);
      expect(r.doc.rev).toBe(1);
    }
    const r = applyDeckOps(minimal(), contractOps().slice(0, 3));
    expect(r.doc.slides.map((s) => [s.id, s.layout])).toEqual([
      ['sl1', 'section'],
      ['sl2', 'content'],
      ['sl3', 'end'],
    ]);
  });

  it('a malformed op returns the SAME deck object; stale, duplicate, not-found, reused ids, bad positions and the cap are refused', () => {
    const deck = full(); // rev 2
    const b = { baseRev: 2 };
    const ops: unknown[] = [
      { op: 'add_slide', id: 'o1', ...b, slide: { id: 'x', layout: 'keynote', elements: [] } },
      { op: 'set_theme', id: 'o2', ...b, theme: { preset: 'light', background: 'red' } },
      { op: 'set_theme', id: 'o3', baseRev: 1, theme: { preset: 'light' } },
      { op: 'remove_slide', id: 'o4', ...b, slideId: 'nope' },
      { op: 'add_slide', id: 'o5', ...b, slide: { id: 'sl-end', layout: 'end', elements: [] } },
      { op: 'add_slide', id: 'o6', ...b, slide: { id: 'n', layout: 'end', elements: [box('e', [0, 0, 0.1, 0.1]), box('e', [0.5, 0.5, 0.1, 0.1])] } },
      { op: 'add_slide', id: 'o7', ...b, index: 8, slide: { id: 'n2', layout: 'end', elements: [] } },
      { op: 'move_slide', id: 'o8', ...b, slideId: 'sl-end', index: 7 },
      { op: 'update_slide', id: 'o9', ...b, slideId: 'sl-end', slide: { id: 'sl-end', layout: 'end', elements: [box('e', [0, 0, 0.1, 0.1]), box('e', [0.5, 0.5, 0.1, 0.1])] } },
    ];
    const r = applyDeckOps(deck, ops as DeckOp[]);
    expect(r.doc).toBe(deck);
    expect(r.rejected.map((x) => x.code)).toEqual(['invalid', 'invalid', 'stale', 'not-found', 'invalid', 'invalid', 'invalid', 'invalid', 'invalid']);

    const dup = applyDeckOps(deck, [
      { op: 'set_theme', id: 'same', ...b, theme: { preset: 'light' } },
      { op: 'set_theme', id: 'same', ...b, theme: { preset: 'dark' } },
    ]);
    expect(dup.doc.theme).toEqual({ preset: 'light' });
    expect(dup.rejected).toMatchObject([{ index: 1, code: 'duplicate' }]);
    expect(applyDeckOps(dup.doc, dup.applied).rejected).toMatchObject([{ code: 'stale' }]);

    const slides: Slide[] = [];
    for (let i = 0; i < DECK_LIMITS.slides; i++) slides.push({ id: `s${i}`, layout: 'content', elements: [] });
    const big: DeckSpec = { v: 1, title: 'Big', size: '4:3', theme: { preset: 'light' }, slides };
    expect(applyDeckOps(big, [{ op: 'add_slide', id: 'more', baseRev: 0, slide: { id: 'more', layout: 'end', elements: [] } }]).rejected).toMatchObject([{ code: 'limit' }]);
  });

  it('move_slide moves to the position AFTER the move, and inverts to the old position', () => {
    const deck = full();
    const op: DeckOp = { op: 'move_slide', id: 'mv', baseRev: 2, slideId: 'sl-title', index: 6 };
    const r = applyDeckOps(deck, [op]);
    expect(r.doc.slides.map((s) => s.id)).toEqual(['sl-section', 'sl-content', 'sl-image', 'sl-two', 'sl-charts', 'sl-end', 'sl-title']);
    expect(invertDeckOp(deck, op, { id: 'u', baseRev: 3 })).toEqual({ op: 'move_slide', id: 'u', baseRev: 3, slideId: 'sl-title', index: 0 });
    expect(invertDeckOp(deck, { op: 'remove_slide', id: 'rm', baseRev: 2, slideId: 'sl-two' }, { id: 'u', baseRev: 3 })).toEqual({
      op: 'add_slide',
      id: 'u',
      baseRev: 3,
      index: 4,
      slide: deck.slides[4],
    });
    roundTrip(deck, [op, { op: 'remove_slide', id: 'rm', baseRev: 2, slideId: 'sl-two' }, { op: 'set_theme', id: 'th', baseRev: 2, theme: { preset: 'light' } }]);
  });

  it('random batches (seeded) always apply in full and always come back exactly', () => {
    let seed = 0x51a7e;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)];
    let n = 0;
    const fresh = () => `y${++n}`;
    const slide = (id: string): Slide => ({
      id,
      layout: pick(['title', 'section', 'content', 'image-full', 'two-col', 'end'] as const),
      elements: rnd() < 0.5 ? [] : [box(fresh(), [rnd() * 0.5, rnd() * 0.5, 0.25, 0.25]), { kind: 'text', id: fresh(), rect: [0, 0.8, 1, 0.2], layer: 'content', paragraphs: [{ runs: [{ text: id }] }] }],
      ...(rnd() < 0.3 ? { notes: `notes ${id}` } : {}),
    });
    const nextOp = (deck: DeckSpec): DeckOp => {
      const base = { id: fresh(), baseRev: deck.rev ?? 0 };
      const kinds = ['set_theme'];
      if (deck.slides.length < DECK_LIMITS.slides) kinds.push('add_slide', 'add_slide');
      if (deck.slides.length) kinds.push('update_slide', 'remove_slide', 'move_slide');
      switch (pick(kinds)) {
        case 'add_slide':
          return { op: 'add_slide', ...base, ...(rnd() < 0.7 ? { index: Math.floor(rnd() * (deck.slides.length + 1)) } : {}), slide: slide(fresh()) };
        case 'update_slide': {
          const id = pick(deck.slides).id;
          return { op: 'update_slide', ...base, slideId: id, slide: slide(id) };
        }
        case 'remove_slide':
          return { op: 'remove_slide', ...base, slideId: pick(deck.slides).id };
        case 'move_slide':
          return { op: 'move_slide', ...base, slideId: pick(deck.slides).id, index: Math.floor(rnd() * deck.slides.length) };
        default:
          return { op: 'set_theme', ...base, theme: pick([{ preset: 'light' }, { preset: 'dark', accent: '#22C55E' }, { preset: 'brand', background: '#0F172A', text: '#F8FAFC' }] as const) };
      }
    };
    let deck = full();
    for (let round = 0; round < 150; round++) {
      const batch: DeckOp[] = [];
      let scratch = deck;
      for (let k = 0, size = 1 + Math.floor(rnd() * 5); k < size; k++) {
        const op = nextOp(scratch);
        scratch = applyDeckOps(scratch, [op]).doc;
        batch.push({ ...op, baseRev: deck.rev ?? 0 });
      }
      const r = roundTrip(deck, batch);
      expect(r.rejected).toEqual([]);
      expect(content(r.doc)).toEqual(content(scratch));
      expect(checkDeckSpec(r.doc).ok).toBe(true);
      deck = r.doc;
    }
  });
});
