import { describe, expect, it } from 'vitest';
import { asset, harbourComic, lakeStory, readyRender } from './__fixtures__/consistencyBooks';
import {
  ANCHOR_CAPS,
  ANCHOR_KINDS_OFF,
  ANCHOR_PLAN_KINDS,
  CONTINUITY_STALE_TEXT,
  anchorEligible,
  anchorKindsFromFlag,
  appearances,
  isRecurring,
  partsStale,
  planAnchors,
  plansWithAnchors,
  staleReasons,
  type AnchorKinds
} from './anchors';
import type { ComicDoc, ImageModelLock, Page, RefAsset } from './doc';
import { CONSISTENCY_LIMITS } from './limits';
import { getImageModel, type ImageModelSpec } from './models';
import { partsOf } from './parts';

const ALL: AnchorKinds = { places: true, props: true, styleKey: true, sheetV2: true };
const spec = (id: string): ImageModelSpec => getImageModel(id)!;
const NB21 = spec('nano-banana-2.1');
const lock = (modelId: string): ImageModelLock => ({ modelId, lockedAt: 1, origin: 'first_render' });
const page = (doc: ComicDoc, n: number): Page => doc.pages.find((p) => p.n === n)!;
const photo = (path: string, extra: Partial<RefAsset> = {}): RefAsset => ({ ...asset(path), source: 'upload', ...extra });

describe('appearances, isRecurring, anchorEligible', () => {
  it("b4b5774f-shaped: the book's three places all recur (≥ 2 pages, ≥ 3 panels)", () => {
    const doc = harbourComic();
    const apps = appearances(doc);
    for (const id of ['pl_gate', 'pl_market', 'pl_temple']) {
      expect(apps.places.get(id)!.pages).toHaveLength(2);
      expect(apps.places.get(id)!.panels).toBe(6);
      expect(isRecurring(apps.places.get(id))).toBe(true);
      expect(anchorEligible(doc, `place:${id}`)).toBe(true);
    }
    expect(apps.cast.get('c_guard')).toEqual({ pages: ['pg_1', 'pg_2'], panels: 3 });
    expect(isRecurring({ pages: ['a', 'b'], panels: CONSISTENCY_LIMITS.recurringPanels - 1 })).toBe(false);
    expect(isRecurring({ pages: ['a'], panels: 9 })).toBe(false);
  });

  it('eligible: lead/support (as today), recurring extras, recurring props, recurring places; not one-off walk-ons', () => {
    const doc = harbourComic((d) => {
      d.cast.push({ ...d.cast[2], id: 'c_walkon', name: 'Fisherman' });
      d.pages[5].panels[0].castIds = [...d.pages[5].panels[0].castIds, 'c_walkon'];
      d.places.push({ id: 'pl_dock', name: 'Dock', look: 'Boards', refs: [], sheet: readyRender('u/o/h/dock.webp') });
      d.pages[5].panels[2].placeId = 'pl_dock';
    });
    expect(anchorEligible(doc, 'char:c_meera')).toBe(true);
    expect(anchorEligible(doc, 'char:c_guard')).toBe(true);
    expect(anchorEligible(doc, 'prop:c_lantern')).toBe(true);
    expect(anchorEligible(doc, 'char:c_lantern')).toBe(false); // a prop's key is prop:
    expect(anchorEligible(doc, 'char:c_walkon')).toBe(false);
    expect(anchorEligible(doc, 'place:pl_dock')).toBe(false);
    for (const k of ['place:nope', 'style', 'char:', ':c_meera', 'charc_meera']) expect(anchorEligible(doc, k)).toBe(false);
  });
});

describe('planAnchors — the f8312c86-shaped protagonist', () => {
  it('attaches the extra protagonist sheet on every page, in both modes', () => {
    const doc = lakeStory();
    for (const kinds of [ANCHOR_KINDS_OFF, ALL]) {
      for (const p of doc.pages) {
        const plan = planAnchors(doc, p, NB21, undefined, { kinds });
        const first = plan.attached[0];
        expect(first).toMatchObject({ key: 'char:c_baby', role: 'character', slot: 'character', source: 'sheet', path: 'u/o/l/baby.webp', name: 'THE BABY' });
        expect(plan.keys).toContain('char:c_baby');
        expect(plan.textOnly).not.toContain('c_baby');
      }
    }
  });

  it('the 5th being overflows with why "cap" and the exact words', () => {
    const doc = lakeStory();
    const plan = planAnchors(doc, page(doc, 5), NB21, undefined);
    expect(plan.attached.filter((a) => a.role === 'character').map((a) => a.id)).toEqual(['c_baby', 'c_ducks', 'c_frog', 'c_bunny']);
    expect(plan.overflow).toEqual([
      {
        key: 'char:c_heron',
        role: 'character',
        id: 'c_heron',
        name: 'HERON',
        why: 'cap',
        slot: 'character',
        text: 'This model keeps 4 characters on model per page. HERON is described in words on this page.'
      }
    ]);
    expect(plan.textOnly).toEqual(['c_heron']);
  });
});

describe('planAnchors — caps from the locked model', () => {
  const doc = lakeStory();
  const p5 = page(doc, 5);

  it('Nano Banana 2.1: 4 character slots, the board and the lake as objects, the previous page', () => {
    const plan = planAnchors(doc, p5, NB21, lock('nano-banana-2.1'));
    expect(plan.caps).toEqual({ total: 14, characters: 4, objects: 10, style: 0 });
    expect(plan.attached.map((a) => a.key)).toEqual(['char:c_baby', 'char:c_ducks', 'char:c_frog', 'char:c_bunny', 'place:pl_lake', 'style', 'prev:pg_4']);
  });

  it('Nano Banana Pro: 5 character slots and a style class', () => {
    const plan = planAnchors(doc, p5, NB21, lock('nano-banana-pro'));
    expect(plan.modelId).toBe('nano-banana-pro');
    expect(plan.caps).toEqual({ total: 14, characters: 5, objects: 6, style: 3 });
    expect(plan.attached.filter((a) => a.role === 'character')).toHaveLength(5);
    expect(plan.attached.find((a) => a.key === 'style')).toMatchObject({ slot: 'style', source: 'board' });
    expect(plan.overflow).toEqual([]);
  });

  it('legacy (3 references, 2 characters, 1 object): two beings and the board; the rest in words', () => {
    const plan = planAnchors(doc, p5, NB21, lock('nano-banana-legacy'));
    expect(plan.caps).toEqual({ total: 3, characters: 2, objects: 1, style: 0 });
    expect(plan.attached.map((a) => a.key)).toEqual(['char:c_baby', 'char:c_ducks', 'style']);
    expect(plan.overflow.map((o) => [o.id, o.why, o.slot])).toEqual([
      ['c_frog', 'cap', 'character'],
      ['c_bunny', 'cap', 'character'],
      ['c_heron', 'cap', 'character'],
      ['pl_lake', 'cap', 'total'],
      ['pg_4', 'cap', 'total']
    ]);
    expect(plan.overflow[0].text).toBe('This model keeps 2 characters on model per page. FROG is described in words on this page.');
    expect(plan.overflow[3].text).toBe('This model takes at most 3 reference images per page. THE LAKE is described in words on this page.');
  });

  it('the lock wins over the spec the caller passed (a job never draws on another model)', () => {
    expect(planAnchors(doc, p5, spec('nano-banana-pro'), lock('nano-banana-legacy')).modelId).toBe('nano-banana-legacy');
    expect(planAnchors(doc, p5, spec('nano-banana-pro'), null).modelId).toBe('nano-banana-pro');
  });

  it("an undefined lock means the comic's own lock (a card passing the tier's spec shows the locked model's caps); null means unlocked", () => {
    const pro = lakeStory((d) => {
      d.imageModel = lock('nano-banana-pro');
    });
    const card = planAnchors(pro, page(pro, 5), NB21, undefined);
    expect(card.modelId).toBe('nano-banana-pro');
    expect(card.caps).toEqual({ total: 14, characters: 5, objects: 6, style: 3 });
    expect(card.attached).toEqual(planAnchors(pro, page(pro, 5), NB21, pro.imageModel).attached);
    expect(planAnchors(pro, page(pro, 5), NB21, null).modelId).toBe('nano-banana-2.1');
    // No lock at all: the spec passed in.
    expect(planAnchors(doc, p5, NB21, undefined).modelId).toBe('nano-banana-2.1');
  });

  it('anchors mode caps the total at doc.consistency.maxRefs (default 9) and says so', () => {
    expect(planAnchors(doc, p5, NB21, undefined, { kinds: ALL }).caps.total).toBe(CONSISTENCY_LIMITS.maxRefsDefault);
    const tight = lakeStory((d) => {
      d.consistency = { maxRefs: 4 };
    });
    const plan = planAnchors(tight, page(tight, 5), NB21, undefined, { kinds: ALL });
    expect(plan.caps.total).toBe(4);
    expect(plan.attached.map((a) => a.key)).toEqual(['char:c_baby', 'char:c_ducks', 'char:c_frog', 'char:c_bunny']);
    const lake = plan.overflow.find((o) => o.id === 'pl_lake')!;
    expect(lake).toMatchObject({ why: 'cap', slot: 'total' });
    expect(lake.text).toBe('This comic attaches at most 4 reference images per page. THE LAKE is described in words on this page.');
  });
});

describe('planAnchors — props take object slots', () => {
  const withLantern = (tier: 'extra' | 'support') =>
    harbourComic((d) => {
      d.cast = d.cast.map((c) => (c.id === 'c_lantern' ? { ...c, tier, sheet: readyRender('u/o/h/lantern.webp') } : c));
    });

  it('ship1 (today): an extra prop stays in words; a support prop uses a character slot', () => {
    const extra = planAnchors(withLantern('extra'), page(withLantern('extra'), 3), NB21, undefined);
    expect(extra.attached.some((a) => a.id === 'c_lantern')).toBe(false);
    expect(extra.overflow.find((o) => o.id === 'c_lantern')).toMatchObject({ role: 'prop', why: 'off', text: 'BRASS LANTERN is described in words on this page.' });
    const doc = withLantern('support');
    const support = planAnchors(doc, page(doc, 3), NB21, undefined);
    expect(support.attached.find((a) => a.id === 'c_lantern')).toMatchObject({ key: 'prop:c_lantern', role: 'character', slot: 'character' });
  });

  it('props kind on: the prop is a PROP in an object slot and frees the character slot', () => {
    for (const tier of ['extra', 'support'] as const) {
      const doc = withLantern(tier);
      const plan = planAnchors(doc, page(doc, 3), NB21, undefined, { kinds: { props: true } });
      expect(plan.attached.find((a) => a.id === 'c_lantern')).toMatchObject({ key: 'prop:c_lantern', role: 'prop', slot: 'object', source: 'sheet' });
      expect(plan.attached.filter((a) => a.slot === 'character').map((a) => a.id)).toEqual(['c_meera', 'c_ravi']);
    }
  });

  it('≤ ANCHOR_CAPS.propsPerPage props per page; the next one overflows on the kind cap', () => {
    const doc = withLantern('extra');
    doc.cast.push(
      { ...doc.cast[3], id: 'c_kite', name: 'Red Kite', sheet: readyRender('u/o/h/kite.webp') },
      { ...doc.cast[3], id: 'c_oar', name: 'Broken Oar', sheet: readyRender('u/o/h/oar.webp') }
    );
    doc.pages[2].panels[1].castIds = ['c_ravi', 'c_kite', 'c_oar'];
    const plan = planAnchors(doc, page(doc, 3), NB21, undefined, { kinds: { props: true } });
    expect(plan.attached.filter((a) => a.role === 'prop')).toHaveLength(ANCHOR_CAPS.propsPerPage);
    const over = plan.overflow.filter((o) => o.role === 'prop');
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ why: 'cap', slot: 'kind' });
    expect(over[0].text).toMatch(/^Only 2 props are attached per page\. [A-Z ]+ is described in words on this page\.$/);
  });
});

describe('planAnchors — places, previous page, style key, reserved slot', () => {
  const threePlaces = () =>
    harbourComic((d) => {
      d.places = d.places.map((p) => ({ ...p, sheet: readyRender(`u/o/h/${p.id}.webp`) }));
      d.pages[0].panels = d.pages[0].panels.map((pn, i) => ({ ...pn, placeId: ['pl_gate', 'pl_market', 'pl_temple'][i] }));
    });

  it('ship1 attaches every place (today); anchors attach ≤ 2 and name the third', () => {
    const doc = threePlaces();
    expect(planAnchors(doc, page(doc, 1), NB21, undefined).attached.filter((a) => a.role === 'place')).toHaveLength(3);
    const plan = planAnchors(doc, page(doc, 1), NB21, undefined, { kinds: { places: true } });
    expect(plan.attached.filter((a) => a.role === 'place').map((a) => a.id)).toEqual(['pl_gate', 'pl_market']);
    expect(plan.overflow.filter((o) => o.role === 'place')).toEqual([
      { key: 'place:pl_temple', role: 'place', id: 'pl_temple', name: 'SEA TEMPLE', why: 'cap', slot: 'kind', text: 'Only 2 places are attached per page. SEA TEMPLE is described in words on this page.' }
    ]);
  });

  it('sheetV2 alone plans every page exactly as today; each plan kind gates only its own behaviour', () => {
    expect(ANCHOR_PLAN_KINDS).toEqual(['places', 'props', 'styleKey']);
    expect(plansWithAnchors({ sheetV2: true })).toBe(false);
    for (const doc of [threePlaces(), lakeStory(), harbourComic()]) {
      for (const p of doc.pages) {
        const v2 = planAnchors(doc, p, NB21, undefined, { kinds: { sheetV2: true } });
        expect(v2.mode).toBe('ship1');
        expect(v2).toEqual(planAnchors(doc, p, NB21, undefined, { kinds: ANCHOR_KINDS_OFF }));
      }
    }
    // styleKey alone: the anchors order and the maxRefs default, but the place cap belongs to the places kind.
    const doc = threePlaces();
    const styleOnly = planAnchors(doc, page(doc, 1), NB21, undefined, { kinds: { styleKey: true } });
    expect(styleOnly.mode).toBe('anchors');
    expect(styleOnly.caps.total).toBe(CONSISTENCY_LIMITS.maxRefsDefault);
    expect(styleOnly.attached.filter((a) => a.role === 'place').map((a) => a.id)).toEqual(['pl_gate', 'pl_market', 'pl_temple']);
    expect(styleOnly.overflow.some((o) => o.slot === 'kind')).toBe(false);
  });

  it('anchors priority: the same-scene previous page before place sheets when slots run short (ship1 keeps places first)', () => {
    const doc = harbourComic((d) => {
      d.scenes = [{ id: 'sc_a', name: 'Gate' }];
      d.pages[0].continuity = { sceneId: 'sc_a' };
      d.pages[0].render = readyRender('u/o/h/p1.webp');
      d.places[0].sheet = readyRender('u/o/h/gate.webp');
      // Meera + Ravi + the style board leave one reference.
      d.consistency = { maxRefs: 4 };
    });
    const plan = planAnchors(doc, page(doc, 2), NB21, undefined, { kinds: { places: true } });
    expect(plan.attached.map((a) => a.key)).toEqual(['char:c_meera', 'char:c_ravi', 'style', 'prev:pg_1']);
    expect(plan.overflow.find((o) => o.id === 'pl_gate')).toMatchObject({ role: 'place', why: 'cap', slot: 'total' });
    const today = planAnchors(doc, page(doc, 2), NB21, undefined);
    expect(today.attached.map((a) => a.key)).toEqual(['char:c_meera', 'char:c_ravi', 'place:pl_gate', 'style']);
    expect(today.overflow.find((o) => o.role === 'previous')).toMatchObject({ id: 'pg_1', why: 'cap', slot: 'total' });
  });

  it('anchors: the same-scene previous page is attached (pending when the run draws it first)', () => {
    const doc = harbourComic((d) => {
      d.scenes = [{ id: 'sc_a', name: 'Gate' }];
      d.pages[0].continuity = { sceneId: 'sc_a' };
      d.pages[0].render = readyRender('u/o/h/p1.webp');
    });
    const plan = planAnchors(doc, page(doc, 2), NB21, undefined, { kinds: { places: true } });
    expect(plan.attached.at(-1)).toMatchObject({ key: 'prev:pg_1', role: 'previous', path: 'u/o/h/p1.webp' });
    const p3 = planAnchors(doc, page(doc, 3), NB21, undefined, { kinds: { places: true }, assumeDrawn: new Set(['pg_2']) });
    expect(p3.attached.at(-1)).toMatchObject({ key: 'prev:pg_2', pending: true });
    expect(p3.attached.at(-1)!.path).toBeUndefined();
  });

  it('styleKey: with no board the style key page is the style anchor; a board always wins', () => {
    const doc = harbourComic((d) => {
      d.style = { ...d.style, board: undefined };
      d.pages[0].render = readyRender('u/o/h/p1.webp');
    });
    const plan = planAnchors(doc, page(doc, 4), NB21, undefined, { kinds: { styleKey: true } });
    expect(plan.attached.find((a) => a.role === 'style_key')).toMatchObject({ key: 'stylekey:pg_1', slot: 'object', source: 'page', name: 'PAGE 1' });
    expect(planAnchors(doc, page(doc, 4), NB21, undefined).attached.some((a) => a.role === 'style_key')).toBe(false);
    const boarded = harbourComic((d) => {
      d.pages[0].render = readyRender('u/o/h/p1.webp');
    });
    expect(planAnchors(boarded, page(boarded, 4), NB21, undefined, { kinds: { styleKey: true } }).attached.find((a) => a.slot === 'object' && a.role !== 'previous')).toMatchObject({
      key: 'style',
      source: 'board'
    });
  });

  it('the layout guide takes one reserved object slot, first — never a model’s only object slot', () => {
    const doc = lakeStory();
    const plan = planAnchors(doc, page(doc, 2), NB21, undefined, { layoutGuide: true, kinds: ALL });
    expect(plan.reserved).toBe(true);
    expect(plan.attached[0]).toEqual({ key: 'layout', role: 'layout', slot: 'object', source: 'guide', name: 'PAGE LAYOUT GUIDE' });
    const legacy = planAnchors(doc, page(doc, 2), NB21, lock('nano-banana-legacy'), { layoutGuide: true });
    expect(legacy.reserved).toBe(false);
  });

  it('a run that draws a sheet first plans it as pending; an unticked anchor says so; a blocked sheet says so', () => {
    const doc = harbourComic((d) => {
      d.consistency = { skip: ['char:c_guard'] };
      d.cast = d.cast.map((c) =>
        c.id === 'c_ravi'
          ? { ...c, sheet: { ...readyRender('u/o/h/ravi.webp'), asset: { ...asset('u/o/h/ravi.webp'), safety: { assessed: 'X', at: 1 } } } }
          : c.id === 'c_meera'
            ? { ...c, sheet: { status: 'none', history: [] } }
            : c
      );
    });
    const plan = planAnchors(doc, page(doc, 2), NB21, undefined, { assumeReady: new Set(['char:c_meera']) });
    expect(plan.attached[0]).toMatchObject({ key: 'char:c_meera', source: 'sheet', pending: true });
    expect(plan.overflow.map((o) => [o.id, o.why])).toEqual([
      ['c_ravi', 'blocked'],
      ['c_guard', 'skipped'],
      ['c_lantern', 'off'],
      ['pl_gate', 'no_ref']
    ]);
    expect(plan.overflow[0].text).toBe("RAVI's picture can't be sent to the model, so it is described in words on this page.");
  });

  it('a photo stands in for a missing sheet; spare character slots add a likeness photo', () => {
    const doc = harbourComic((d) => {
      d.cast = d.cast.map((c) =>
        c.id === 'c_guard' ? { ...c, refs: [photo('u/o/h/guard.jpg', { subject: 'person' })] } : c.id === 'c_meera' ? { ...c, likeness: 'sheet_and_photo', refs: [photo('u/o/h/meera.jpg')] } : c
      );
    });
    for (const kinds of [ANCHOR_KINDS_OFF, ALL]) {
      const plan = planAnchors(doc, page(doc, 1), NB21, undefined, { kinds });
      expect(plan.attached.filter((a) => a.slot === 'character').map((a) => [a.key, a.source, a.path])).toEqual([
        ['char:c_meera', 'sheet', 'u/o/h/meera.webp'],
        ['photo:c_meera', 'photo', 'u/o/h/meera.jpg'],
        ['char:c_guard', 'photo', 'u/o/h/guard.jpg']
      ]);
    }
  });
});

describe('anchorKindsFromFlag', () => {
  it('reads the env value', () => {
    expect(anchorKindsFromFlag(undefined)).toEqual(ANCHOR_KINDS_OFF);
    expect(anchorKindsFromFlag('')).toEqual(ANCHOR_KINDS_OFF);
    expect(anchorKindsFromFlag('1')).toEqual(ALL);
    expect(anchorKindsFromFlag('places, props')).toEqual({ places: true, props: true, styleKey: false, sheetV2: false });
  });
});

describe('partsStale / staleReasons', () => {
  const drawnWithParts = (mutate?: (doc: ComicDoc) => void) =>
    harbourComic((d) => {
      d.pages[0].continuity = { props: { lantern: 'lit' } };
      d.pages[0].render = { ...readyRender('u/o/h/p1.webp'), parts: partsOf(d, d.pages[0]) };
      mutate?.(d);
    });

  it('renders without parts are never stale from consistency changes (I8)', () => {
    const doc = harbourComic((d) => {
      d.pages[0].render = readyRender('u/o/h/p1.webp');
      d.pages[0].panels[0].castIds = ['c_ravi'];
      d.pages[0].panels[0].direction = { lens: 'wide' };
      d.pages[0].continuity = { notes: ['Rain.'] };
    });
    expect(partsStale(doc, doc.pages[0])).toBe(false);
    expect(staleReasons(doc, doc.pages[0])).toEqual([]);
  });

  it('a version drawn from the current parts is fresh', () => {
    const doc = drawnWithParts();
    expect(partsStale(doc, doc.pages[0])).toBe(false);
  });

  it('names the part that changed', () => {
    const at = (mutate: (d: ComicDoc) => void) => {
      const doc = drawnWithParts();
      mutate(doc);
      return staleReasons(doc, doc.pages[0]).map((r) => r.text);
    };
    expect(at((d) => (d.pages[0].panels[1].castIds = ['c_meera']))).toEqual(["Panel 2: who's in it"]);
    expect(at((d) => (d.pages[0].panels[0].action = 'Meera runs.'))).toEqual(['Panel 1: what happens']);
    expect(at((d) => (d.pages[0].panels[2].shot = 'close_up'))).toEqual(['Panel 3: the shot']);
    expect(at((d) => (d.pages[0].panels[0].mood = 'tense'))).toEqual(['Panel 1: the mood']);
    expect(at((d) => (d.pages[0].panels[0].direction = { lens: 'wide', by: 'user' }))).toEqual(['Panel 1: the direction']);
    expect(at((d) => (d.pages[0].continuity = { props: { lantern: 'lit' }, notes: ['Rain.'] }))).toEqual(["This page's continuity (outfits, props, notes or scene)"]);
    expect(at((d) => (d.pages[0].continuity = { props: { lantern: 'broken' } }))).toEqual([CONTINUITY_STALE_TEXT, 'The state of “lantern”']);
    expect(at((d) => (d.places[0].look = 'Gate in fog'))).toEqual(['Panel 1: the place', 'Panel 2: the place', 'Panel 3: the place', 'How CHITRAKULAM GATE looks']);
    expect(at((d) => d.pages[0].panels.push({ ...d.pages[0].panels[2], id: 'pg_1_p4', n: 4 }))).toEqual(['Panel 4 is new']);
    expect(at((d) => d.pages[0].panels.pop())).toEqual(['A panel was removed']);
    // The direction's provenance marker alone is not a change.
    const doc = drawnWithParts((d) => {
      d.pages[0].panels[0].direction = { lens: 'wide', by: 'writer' };
      d.pages[0].render = { ...d.pages[0].render, parts: partsOf(d, d.pages[0]) };
    });
    doc.pages[0].panels[0].direction = { lens: 'wide', by: 'user' };
    expect(partsStale(doc, doc.pages[0])).toBe(false);
  });

  it('a place newly used on the page is a panel change, not "How X looks" (no look was drawn before)', () => {
    const doc = drawnWithParts();
    doc.pages[0].panels[0].placeId = 'pl_market';
    expect(staleReasons(doc, doc.pages[0]).map((r) => r.text)).toEqual(['Panel 1: the place']);
  });

  it('an older version can be checked too', () => {
    const doc = drawnWithParts();
    const old = { parts: { ...doc.pages[0].render.parts!, cont: '000000' } };
    expect(staleReasons(doc, doc.pages[0], old).map((r) => r.part)).toEqual(['continuity']);
  });
});
