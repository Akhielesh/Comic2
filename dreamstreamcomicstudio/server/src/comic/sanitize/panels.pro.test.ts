// @vitest-environment node
// PE-SERVER (master plan §2.3 "Sanitizers", §5 Security; carry notes PE-0 4; collisions C-9, C-10): the Pro Edit fields
// that ride the Ship 2 ops — an effect overlay (`layer` kind 'effect' + `fx`), a library sticker (`src.lib`), `blend`,
// a frame border's look (`style`, `seed`) and a new line's named style (`styleId`). PRO_EDIT_OPS_PATCHABLE is flipped
// locally (vi.mock, read live) and every acceptance is pinned against the refusal with the switch off. A fake effect
// generator is registered in the fx registry (PE-FX fills the real ones on its own branch). Everything goes through
// jobs.ts sanitizePatchOps.
import { afterEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../shared/comic/ops.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/comic/ops.js')>();
  const withPro: ReadonlySet<string> = new Set<string>([...real.CLIENT_PATCHABLE_OPS, ...real.PRO_EDIT_OPS]);
  return {
    ...real,
    get PRO_EDIT_OPS_PATCHABLE() {
      return sw.on;
    },
    get CLIENT_PATCHABLE_OPS() {
      return sw.on ? withPro : real.CLIENT_PATCHABLE_OPS;
    }
  };
});

const FAKE = vi.hoisted(() => ({
  gen: 'test-rays',
  v: 1,
  name: 'Test rays',
  group: 'lines' as const,
  params: {
    count: { kind: 'number' as const, min: 4, max: 40, default: 12, int: true as const, label: 'Rays' },
    spread: { kind: 'number' as const, min: 0, max: 1, default: 0.5 },
    mode: { kind: 'enum' as const, values: ['linear', 'radial'], default: 'linear' },
    color: { kind: 'color' as const, default: '#111111', label: 'Colour' },
    taper: { kind: 'bool' as const, default: true }
  }
}));
vi.mock('../../../../shared/comic/fx/registry.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/comic/fx/registry.js')>();
  return {
    ...real,
    FX_GENERATORS: [...real.FX_GENERATORS, FAKE],
    fxGeneratorOf: (gen: string, v: number) => (gen === FAKE.gen && v === FAKE.v ? FAKE : real.fxGeneratorOf(gen, v))
  };
});

import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { normalizeDoc, type ComicDoc, type PageLayer, type PanelFrame } from '../../../../shared/comic/doc.js';
import { FX_LIMITS } from '../../../../shared/comic/limits.js';
import { applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { inverseOps } from '../../../../shared/comic/undo.js';
import type { SanitizeCtx } from '../extensions.js';
import { sanitizePatchOps } from '../jobs.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { StudioError } from '../types.js';
import { STICKER_NOT_YET_MESSAGE } from './panels.js';

afterEach(() => {
  sw.on = true;
});

const sctx = (): SanitizeCtx => ({ userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: 1_800_000_000_000 });
const sanitize = (doc: ComicDoc, ops: unknown[]) => sanitizePatchOps(doc, ops, sctx()) as DocOp[];
const rejects = (fn: () => unknown, status: number, message?: RegExp | string): StudioError => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StudioError);
    expect((err as StudioError).status).toBe(status);
    if (message) expect((err as StudioError).message).toMatch(message);
    return err as StudioError;
  }
  throw new Error('expected the batch to be rejected');
};

const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
const moved = { x: 0.3, y: 0.3, w: 0.2, h: 0.2 };
const FX = { gen: 'test-rays', v: 1, seed: 7, params: { count: 12, spread: 0.25 } };
const LIB = { pack: 'fluent', id: 'star', v: '1' };
const STYLED: PanelFrame = { box: { x: 0.02, y: 0.02, w: 0.96, h: 0.46 }, border: { w: 0.006, color: '#111111', style: 'rough', seed: 42 } };
/** Page 1 as a newer build stored it: an effect overlay, a library sticker, a blended shape, a styled frame on panel 1. */
const fixture = (): ComicDoc => {
  const raw = JSON.parse(JSON.stringify(plannedDoc())) as ComicDoc;
  raw.pages[0].layers = [
    { id: 'ly_fx', kind: 'effect', box, fx: FX } as PageLayer,
    { id: 'ly_star', kind: 'image', box, src: { lib: LIB } } as PageLayer,
    { id: 'ly_box', kind: 'shape', box, shape: { type: 'rect' }, blend: 'multiply' } as PageLayer,
    { id: 'ly_future', kind: 'hologram', box } as unknown as PageLayer
  ];
  raw.pages[0].panels[0].frame = JSON.parse(JSON.stringify(STYLED));
  raw.letterStyle = { presetId: 'classic', named: { st_villain: { name: 'Villain', patch: { italic: true } } } };
  return normalizeDoc(raw);
};
const layerOp = (id: string, patch: Record<string, unknown> | null) => ({ op: 'layer', pageId: 'pg_1', id, patch });
const layerOf = (doc: ComicDoc, id: string) => doc.pages[0].layers!.find((l) => l.id === id);
/** Sanitize a batch, apply it, then sanitize and apply its inverse: the page must come back exactly. */
const roundTrip = (doc: ComicDoc, batch: unknown[]): ComicDoc => {
  const ops = sanitize(doc, batch);
  const after = applyOps(doc, ops);
  const undo = sanitize(after, inverseOps(doc, ops));
  expect(applyOps(after, undo).pages[0], JSON.stringify(batch)).toEqual(doc.pages[0]);
  return after;
};

describe('the stored fixture survives the load (PE-0 keep)', () => {
  it('effect, sticker, blend, border look and the opaque layer are all on the page', () => {
    const page = fixture().pages[0];
    expect(page.layers!.map((l) => [l.id, l.kind])).toEqual([['ly_fx', 'effect'], ['ly_star', 'image'], ['ly_box', 'shape'], ['ly_future', 'hologram']]);
    expect(page.panels[0].frame).toEqual(STYLED);
  });
});

describe('effect overlays (layer kind effect + fx)', () => {
  it('on: a registered gen@v with parameters inside its schema is accepted, stored as sent (numbers to 4 places)', () => {
    const doc = fixture();
    const fx = { gen: 'test-rays', v: 1, seed: -12345, params: { count: 20, spread: 0.333333333, mode: 'radial', color: '#ff0000', taper: false } };
    const ops = sanitize(doc, [layerOp('ly_new', { kind: 'effect', box, fx })]);
    expect(ops).toEqual([{ op: 'layer', pageId: 'pg_1', id: 'ly_new', patch: { kind: 'effect', box, fx: { ...fx, params: { ...fx.params, spread: 0.3333 } } } }]);
    expect(layerOf(applyOps(doc, ops), 'ly_new')).toEqual({ id: 'ly_new', kind: 'effect', box, fx: { ...fx, params: { ...fx.params, spread: 0.3333 } } });
    roundTrip(doc, [layerOp('ly_new', { kind: 'effect', box, fx })]);
    roundTrip(doc, [layerOp('ly_fx', { fx: { ...FX, params: { count: 30 } } })]);
  });

  it('off: a new effect overlay is "an unknown kind" and an fx patch is dropped, exactly as before PE-SERVER', () => {
    const doc = fixture();
    sw.on = false;
    rejects(() => sanitize(doc, [layerOp('ly_new', { kind: 'effect', box, fx: FX })]), 400, /overlay kind/);
    // The key is dropped (a no-op patch), as any key the sanitizer does not know.
    expect(sanitize(doc, [layerOp('ly_fx', { fx: { ...FX, params: { count: 30 } } })])).toEqual([{ op: 'layer', pageId: 'pg_1', id: 'ly_fx', patch: {} }]);
  });

  it('refuses an unknown generator, an unregistered version, a parameter out of range, an unknown setting and the wrong kinds', () => {
    const doc = fixture();
    const effect = (fx: Record<string, unknown>) => [layerOp('ly_new', { kind: 'effect', box, fx: { ...FX, ...fx } })];
    rejects(() => sanitize(doc, effect({ gen: 'no-such-effect' })), 400, /isn't available/);
    rejects(() => sanitize(doc, effect({ v: 2 })), 400, /isn't available/);
    rejects(() => sanitize(doc, effect({ params: { count: 99 } })), 400, /Test rays setting, rays \(count\), is out of range/);
    rejects(() => sanitize(doc, effect({ params: { count: 12.5 } })), 400, /out of range/);
    rejects(() => sanitize(doc, effect({ params: { glitter: 1 } })), 400, /no setting called “glitter”/);
    rejects(() => sanitize(doc, effect({ params: { mode: 'spiral' } })), 400, /isn't one of its choices/);
    rejects(() => sanitize(doc, effect({ params: { color: 'red' } })), 400, /#RRGGBB/);
    rejects(() => sanitize(doc, effect({ params: { taper: 'yes' } })), 400, /wrong kind/);
    rejects(() => sanitize(doc, effect({ seed: 2 ** 40 })), 400, /effect seed/);
    rejects(() => sanitize(doc, [layerOp('ly_new', { kind: 'effect', box })]), 400, /picture, shape or effect/);
  });

  it(`refuses an oversize effect (over ${FX_LIMITS.fxBytes} bytes) before reading it`, () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [layerOp('ly_new', { kind: 'effect', box, fx: { ...FX, params: { mode: 'x'.repeat(FX_LIMITS.fxBytes) } } })]), 400, /too many settings/);
    const many = Object.fromEntries(Array.from({ length: FX_LIMITS.paramsPerFx + 1 }, (_, i) => [`p${i}`, 1]));
    rejects(() => sanitize(doc, [layerOp('ly_new', { kind: 'effect', box, fx: { ...FX, params: many } })]), 400, /too many settings/);
  });

  it('effect settings belong to an effect overlay', () => {
    rejects(() => sanitize(fixture(), [layerOp('ly_box', { fx: FX })]), 400, /Only an effect overlay/);
  });

  it("off: a stored effect still moves, and its undo (which re-sends kind and fx as stored) is accepted, even when this build can't draw it", () => {
    sw.on = false;
    const doc = fixture();
    const after = roundTrip(doc, [layerOp('ly_fx', { box: moved })]);
    expect(layerOf(after, 'ly_fx')).toEqual({ id: 'ly_fx', kind: 'effect', box: moved, fx: FX });
    // The inverse carries kind 'effect' and the stored fx: re-asserted, not written.
    const inverse = inverseOps(doc, sanitize(doc, [layerOp('ly_fx', { box: moved })]));
    expect(inverse[0]).toMatchObject({ op: 'layer', patch: { kind: 'effect', fx: FX, box } });
    // A different fx is still dropped, never written.
    expect(sanitize(doc, [layerOp('ly_fx', { box: moved, fx: { ...FX, seed: 8 } })])).toEqual([{ op: 'layer', pageId: 'pg_1', id: 'ly_fx', patch: { box: moved } }]);
  });

  it('on: re-sending a stored effect of a generator this build does not have is kept (an undo after a rollback)', () => {
    const raw = JSON.parse(JSON.stringify(fixture())) as ComicDoc;
    raw.pages[0].layers![0] = { id: 'ly_fx', kind: 'effect', box, fx: { gen: 'tone-dots', v: 3, seed: 1, params: { size: 4 } } } as PageLayer;
    const doc = normalizeDoc(raw);
    roundTrip(doc, [layerOp('ly_fx', { box: moved })]);
    rejects(() => sanitize(doc, [layerOp('ly_fx', { fx: { gen: 'tone-dots', v: 3, seed: 2, params: { size: 4 } } })]), 400, /isn't available/);
  });
});

describe('library stickers (src.lib)', () => {
  it('on: every new triple is refused with a calm reason (no catalogue until PE-ASSETS)', () => {
    const doc = fixture();
    rejects(() => sanitize(doc, [layerOp('ly_new', { kind: 'image', box, src: { lib: LIB } })]), 400, STICKER_NOT_YET_MESSAGE);
    rejects(() => sanitize(doc, [layerOp('ly_new', { kind: 'image', box, src: { lib: { pack: 'fluent', id: 'moon', v: '1' } } })]), 400, STICKER_NOT_YET_MESSAGE);
    rejects(() => sanitize(doc, [layerOp('ly_star', { src: { lib: { ...LIB, v: '2' } } })]), 400, STICKER_NOT_YET_MESSAGE);
  });

  it('off: a triple is refused as before (an overlay picture needs a path)', () => {
    sw.on = false;
    rejects(() => sanitize(fixture(), [layerOp('ly_new', { kind: 'image', box, src: { lib: LIB } })]), 400, /Pick a picture/);
  });

  it('either way, a stored sticker moves and re-crops, and its undo (re-sending its triple) is accepted', () => {
    for (const on of [true, false]) {
      sw.on = on;
      const doc = fixture();
      roundTrip(doc, [layerOp('ly_star', { box: moved })]);
      const after = roundTrip(doc, [layerOp('ly_star', { src: { lib: LIB, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } } })]);
      expect(layerOf(after, 'ly_star')!.src).toEqual({ lib: LIB, crop: { x: 0, y: 0, w: 0.5, h: 0.5 } });
    }
  });
});

describe('blend', () => {
  it('on: one of multiply, screen, overlay; null clears; anything else is refused', () => {
    const doc = fixture();
    expect(sanitize(doc, [layerOp('ly_box', { blend: 'screen' })])).toEqual([{ op: 'layer', pageId: 'pg_1', id: 'ly_box', patch: { blend: 'screen' } }]);
    roundTrip(doc, [layerOp('ly_box', { blend: 'overlay' })]);
    roundTrip(doc, [layerOp('ly_box', { blend: null })]);
    rejects(() => sanitize(doc, [layerOp('ly_box', { blend: 'difference' })]), 400, /blend/);
  });

  it('off: a new blend is dropped as before; the stored one is re-asserted (an undo of a move keeps it)', () => {
    sw.on = false;
    const doc = fixture();
    expect(sanitize(doc, [layerOp('ly_box', { opacity: 0.5, blend: 'screen' })])).toEqual([{ op: 'layer', pageId: 'pg_1', id: 'ly_box', patch: { opacity: 0.5 } }]);
    expect(sanitize(doc, [layerOp('ly_box', { blend: null })])).toEqual([{ op: 'layer', pageId: 'pg_1', id: 'ly_box', patch: {} }]);
    const after = roundTrip(doc, [layerOp('ly_box', { box: moved })]);
    expect(layerOf(after, 'ly_box')!.blend).toBe('multiply');
  });
});

describe('kinds a client may never write', () => {
  it('an unknown kind is refused and a newer build’s overlay (opaque) is never patched, with the switch on or off', () => {
    for (const on of [true, false]) {
      sw.on = on;
      const doc = fixture();
      rejects(() => sanitize(doc, [layerOp('ly_new', { kind: 'hologram', box })]), 400, /overlay kind/);
      rejects(() => sanitize(doc, [layerOp('ly_future', { box: moved })]), 400, /newer version of the studio/);
      rejects(() => sanitize(doc, [layerOp('ly_future', { kind: 'shape', shape: { type: 'rect' } })]), 400, /newer version of the studio/);
    }
  });
});

describe('frame border look (page_frames border.style / seed)', () => {
  const framesOp = (frame: Record<string, unknown>, panelId = 'pn_1_1') => ({ op: 'page_frames', pageId: 'pg_1', frames: [{ panelId, frame }] });
  const nextBox = { x: 0.02, y: 0.02, w: 0.9, h: 0.46 };

  it('off: a frame edit never drops the stored look, even when the client leaves it out; a client can neither add nor change one', () => {
    sw.on = false;
    const doc = fixture();
    const [op] = sanitize(doc, [framesOp({ box: nextBox, border: { w: 0.006, color: '#111111' } })]) as Extract<DocOp, { op: 'page_frames' }>[];
    expect(op.frames![0].frame).toEqual({ box: nextBox, border: { w: 0.006, color: '#111111', style: 'rough', seed: 42 } });
    const [changed] = sanitize(doc, [framesOp({ box: nextBox, border: { w: 0.006, style: 'wavy', seed: 1 } })]) as Extract<DocOp, { op: 'page_frames' }>[];
    expect(changed.frames![0].frame!.border).toEqual({ w: 0.006, style: 'rough', seed: 42 });
    const [none] = sanitize(doc, [framesOp({ box: nextBox })]) as Extract<DocOp, { op: 'page_frames' }>[];
    expect(none.frames![0].frame!.border).toEqual({ style: 'rough', seed: 42 });
    // A new look on a plain panel is dropped.
    const [plain] = sanitize(doc, [framesOp({ box: { x: 0.02, y: 0.52, w: 0.46, h: 0.46 }, border: { w: 0.004, style: 'brush', seed: 3 } }, 'pn_1_2')]) as Extract<DocOp, { op: 'page_frames' }>[];
    expect(plain.frames![0].frame!.border).toEqual({ w: 0.004 });
    // The editor's own edit (it spreads the stored frame) and its undo come back exactly.
    roundTrip(doc, [framesOp({ ...STYLED, box: nextBox })]);
  });

  it('on: the client frame is the truth: a valid look is accepted, an invalid one refused, its undo exact', () => {
    const doc = fixture();
    const [op] = sanitize(doc, [framesOp({ box: { x: 0.02, y: 0.52, w: 0.46, h: 0.46 }, border: { w: 0.004, style: 'brush', seed: 3 } }, 'pn_1_2')]) as Extract<DocOp, { op: 'page_frames' }>[];
    expect(op.frames![0].frame!.border).toEqual({ w: 0.004, style: 'brush', seed: 3 });
    roundTrip(doc, [framesOp({ box: { x: 0.02, y: 0.52, w: 0.46, h: 0.46 }, border: { style: 'film', seed: -9 } }, 'pn_1_2')]);
    roundTrip(doc, [framesOp({ ...STYLED, border: { ...STYLED.border, style: 'wavy' } })]);
    rejects(() => sanitize(doc, [framesOp({ box: nextBox, border: { style: 'sparkly' } })]), 400, /border look/);
    rejects(() => sanitize(doc, [framesOp({ box: nextBox, border: { style: 'rough', seed: 1.5 } })]), 400, /border look/);
  });
});

describe('named style on a new line (panel_add lines[].styleId)', () => {
  const addOp = (styleId: string) => ({ op: 'panel_add', pageId: 'pg_1', panel: { id: 'pn_new', lines: [{ id: 'ln_new', kind: 'speech', text: 'Hi', styleId }] } });
  const lineOf = (ops: DocOp[]) => (ops[0] as Extract<DocOp, { op: 'panel_add' }>).panel.lines[0];

  it('on: a styleId naming a saved style is kept; an unknown one is dropped', () => {
    const doc = fixture();
    expect(lineOf(sanitize(doc, [addOp('st_villain')])).styleId).toBe('st_villain');
    expect(lineOf(sanitize(doc, [addOp('st_ghost')]))).not.toHaveProperty('styleId');
  });

  it('off: dropped even when it names a saved style', () => {
    sw.on = false;
    expect(lineOf(sanitize(fixture(), [addOp('st_villain')]))).not.toHaveProperty('styleId');
  });
});
