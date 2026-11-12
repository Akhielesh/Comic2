// @vitest-environment node
// PE-SERVER (master plan §2.3 "Sanitizers"; lead addendum "PE-0 note 9, approved"; collisions B-3, C-9): with
// PRO_EDIT_OPS_PATCHABLE off the lettering sanitizers keep refusing the Pro text keys, ids and looks from a client; on,
// PE-LETTER's opt-in (`allowPro`, wired at the S2b integration) accepts them. Either way a client may RE-ASSERT a Pro
// value the doc stores — a single-line line_style, the letter_style base / kinds / speakers and the stored look — so an
// undo after a rollback keeps a stored Pro style; with the switch off a new or different Pro value is still stripped.
// Named styles are Pro fields: a line's styleId is kept only when it names a saved style (switch on) or re-asserts the
// line's own; a letter_style `named` patch keeps the count and name rules. PRO_EDIT_OPS_PATCHABLE is flipped locally.
import { afterEach, describe, expect, it, vi } from 'vitest';

const sw = vi.hoisted(() => ({ on: true }));
vi.mock('../../../../shared/comic/ops.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../shared/comic/ops.js')>();
  return {
    ...real,
    get PRO_EDIT_OPS_PATCHABLE() {
      return sw.on;
    }
  };
});

import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { normalizeDoc, type ComicDoc, type Line } from '../../../../shared/comic/doc.js';
import { PRO_LETTER_LIMITS } from '../../../../shared/comic/limits.js';
import { applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { inverseOps } from '../../../../shared/comic/undo.js';
import type { SanitizeCtx } from '../extensions.js';
import { sanitizePatchOps } from '../jobs.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { StudioError } from '../types.js';
import { lineStyleIdOf, reassertedStylePatch } from './lettering.js';

afterEach(() => {
  sw.on = true;
});

const sctx = (): SanitizeCtx => ({ userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: 1_800_000_000_000 });
const sanitize = (doc: ComicDoc, ops: unknown[]) => sanitizePatchOps(doc, ops, sctx()) as DocOp[];
const rejects = (fn: () => unknown, status: number, message?: RegExp): StudioError => {
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

/** What a newer build stores: Pro lettering on ln_1_2 and in the comic's base, kinds and a speaker; saved named styles. */
const PRO = { shape: 'heart', sfxEffect: 'wobble', font: 'bungee', fillGradient: { from: '#ff0000', to: '#ffff00', angle: 90 }, strokes: [{ color: '#000000', w: 0.1 }], warp: 'arc', warpAmount: 0.5 };
const NAMED = { st_villain: { name: 'Villain', patch: { italic: true } }, st_radio: { name: 'Radio', patch: { shape: 'radio' } } };
const stored = (): ComicDoc => {
  const raw = JSON.parse(JSON.stringify(plannedDoc())) as ComicDoc;
  const p1 = raw.pages[0];
  p1.panels[1].lines[0] = { ...p1.panels[1].lines[0], style: { italic: true, ...JSON.parse(JSON.stringify(PRO)) }, styleId: 'st_villain' };
  p1.panels[0].lines = [{ id: 'ln_1_1', kind: 'caption', text: 'Meanwhile', style: { italic: true, warp: 'arc' } } as Line];
  // A newer build's ids (a Pro shape, a Pro font) are not in this build's types: stored as JSON, as the server loads them.
  raw.letterStyle = JSON.parse(
    JSON.stringify({
      presetId: 'classic',
      base: { weight: 700, warp: 'wave', glow: { color: '#00ff00', size: 0.1 } },
      kinds: { shout: { shape: 'monster', sizeScale: 1.2 } },
      speakers: { c_maya: { font: 'bungee', textColor: '#aa0000' } },
      named: NAMED
    })
  );
  return normalizeDoc(raw);
};
const line = (doc: ComicDoc, id = 'ln_1_2') => doc.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === id)!;
/** Sanitize a batch and apply it, then sanitize and apply its inverse: the doc's lettering must come back exactly. */
const undoRoundTrip = (doc: ComicDoc, batch: unknown[]) => {
  const ops = sanitize(doc, batch);
  const after = applyOps(doc, ops);
  const undo = sanitize(after, inverseOps(doc, ops));
  const back = applyOps(after, undo);
  return { ops, after, undo, back };
};

describe('stored Pro lettering survives an undo (re-assert, PE-0 wave note 9)', () => {
  it('line_style: undoing a restyle of a Pro-styled line keeps every stored Pro key, with the switch on or off', () => {
    for (const on of [true, false]) {
      sw.on = on;
      const doc = stored();
      expect(line(doc).style).toEqual({ italic: true, ...PRO });
      const { after, undo, back } = undoRoundTrip(doc, [{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { textColor: '#123456' } }]);
      expect(line(after).style).toEqual({ italic: true, ...PRO, textColor: '#123456' });
      // The inverse is a replace with the old style: its Pro keys equal what the line stores, so they come back.
      expect(undo).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], mode: 'replace', patch: { italic: true, ...PRO } }]);
      expect(line(back).style).toEqual(line(doc).style);
    }
  });

  it('line_style, switch off: a new or different Pro value is still stripped, and a multi-line op never re-asserts', () => {
    sw.on = false;
    const doc = stored();
    rejects(() => sanitize(doc, [{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { shape: 'radio' } }]), 400, /nothing valid/);
    rejects(() => sanitize(doc, [{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { warp: 'wave', warpAmount: 0.9 } }]), 400, /nothing valid/);
    expect(sanitize(doc, [{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { warp: 'arc', glow: { color: '#ffffff', size: 0.2 } } }])).toEqual([
      { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { warp: 'arc' } }
    ]);
    // ln_1_1 stores warp 'arc' too, but a two-line op cannot be checked line by line: stripped.
    rejects(() => sanitize(doc, [{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_1', 'ln_1_2'], patch: { warp: 'arc' } }]), 400, /nothing valid/);
    // A line with no stored Pro style: the Pro keys are refused as before (the switch on is the next describe's).
    const plain = normalizeDoc(JSON.parse(JSON.stringify(plannedDoc())));
    rejects(() => sanitize(plain, [{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { warp: 'arc', fillGradient: { from: '#000000', to: '#ffffff', angle: 0 } } }]), 400, /nothing valid/);
  });

  it('letter_style: undoing a base, kind or speaker edit keeps the stored Pro keys (the reset in the inverse does not lose them)', () => {
    for (const on of [true, false]) {
      sw.on = on;
      const doc = stored();
      for (const patch of [{ base: { textColor: '#222222' } }, { kinds: { shout: { padding: 1 } } }, { speakers: { c_maya: { italic: true } } }, { presetId: 'manga', keepOverrides: true }]) {
        const { undo, back } = undoRoundTrip(doc, [{ op: 'letter_style', patch }]);
        expect(undo[0]).toEqual({ op: 'letter_style', patch: null });
        expect(back.letterStyle, JSON.stringify(patch)).toEqual(doc.letterStyle);
      }
    }
  });

  it('letter_style, switch off: a Pro key that differs from the stored one is stripped; equal ones are re-asserted', () => {
    sw.on = false;
    const doc = stored();
    expect(sanitize(doc, [{ op: 'letter_style', patch: { base: { warp: 'wave', weight: 800 }, kinds: { shout: { shape: 'monster' } }, speakers: { c_maya: { font: 'bungee' } } } }])).toEqual([
      { op: 'letter_style', patch: { base: { weight: 800, warp: 'wave' }, kinds: { shout: { shape: 'monster' } }, speakers: { c_maya: { font: 'bungee' } } } }
    ]);
    rejects(() => sanitize(doc, [{ op: 'letter_style', patch: { base: { warp: 'flag' }, kinds: { shout: { shape: 'icicle' } } } }]), 400, /nothing valid/);
    rejects(() => sanitize(doc, [{ op: 'letter_style', patch: { speakers: { c_arjun: { font: 'bungee' } } } }]), 400, /nothing valid/);
    // Invalid parts are still refused even when a Pro key would re-assert.
    rejects(() => sanitize(doc, [{ op: 'letter_style', patch: { base: { warp: 'wave' }, safeMargin: 'wide' } }]), 400, /nothing valid/);
  });

  it('reassertedStylePatch keeps the load order, so the stored style is rebuilt exactly', () => {
    const storedStyle = { italic: true, ...PRO } as never;
    const raw = JSON.parse(JSON.stringify({ warp: 'arc', shape: 'heart', textColor: '#111111' }));
    expect(Object.keys(reassertedStylePatch(raw, { textColor: '#111111' }, storedStyle)!)).toEqual(['textColor', 'shape', 'warp']);
    expect(reassertedStylePatch({ warp: 'arc' }, undefined, undefined)).toBeUndefined();
  });
});

describe('named styles (Pro fields, lead decision C-9)', () => {
  it('lineStyleIdOf: a saved style is kept and an unknown one dropped with the switch on; off, every styleId is dropped as before', () => {
    const doc = stored();
    expect(lineStyleIdOf(doc, 'st_radio')).toBe('st_radio');
    expect(lineStyleIdOf(doc, 'st_ghost')).toBeUndefined();
    expect(lineStyleIdOf(doc, '__proto__')).toBeUndefined();
    expect(lineStyleIdOf(doc, 42)).toBeUndefined();
    expect(lineStyleIdOf(doc, null, 'st_villain')).toBeNull();
    expect(lineStyleIdOf(doc, null)).toBeUndefined();
    // The line's own, even once its saved style is gone (an undo after the style was deleted).
    expect(lineStyleIdOf(doc, 'st_old', 'st_old')).toBe('st_old');
    expect(lineStyleIdOf(doc, 'st_old', 'st_villain')).toBeUndefined();
    sw.on = false;
    expect(lineStyleIdOf(doc, 'st_radio')).toBeUndefined();
    expect(lineStyleIdOf(doc, 'st_villain', 'st_villain')).toBeUndefined();
    expect(lineStyleIdOf(doc, null, 'st_villain')).toBeUndefined();
    expect(lineStyleIdOf(doc, 'st_radio', 'st_villain')).toBeUndefined();
  });

  it(`on: a named patch past ${PRO_LETTER_LIMITS.namedStyles} saved styles or with a name over ${PRO_LETTER_LIMITS.namedNameChars} characters is refused calmly`, () => {
    const doc = stored();
    const more = Object.fromEntries(Array.from({ length: PRO_LETTER_LIMITS.namedStyles - 1 }, (_, i) => [`st_${i}`, { name: `Style ${i}`, patch: {} }]));
    rejects(() => sanitize(doc, [{ op: 'letter_style', patch: { named: more } }]), 409, /up to 32 saved lettering styles/);
    rejects(() => sanitize(doc, [{ op: 'letter_style', patch: { named: { st_long: { name: 'x'.repeat(PRO_LETTER_LIMITS.namedNameChars + 1), patch: {} } } } }]), 400, /40 characters/);
    rejects(() => sanitize(doc, [{ op: 'letter_style', patch: { named: { st_blank: { name: '  ', patch: {} } } } }]), 400, /needs a name/);
    // Deleting one makes room.
    const swap = { ...Object.fromEntries(Object.entries(more).slice(0, 30)), st_villain: null };
    expect(() => sanitize(doc, [{ op: 'letter_style', patch: { named: swap, base: { weight: 400 } } }])).not.toThrow();
  });

  it('off: a named patch is dropped as before (nothing else in it: nothing valid)', () => {
    sw.on = false;
    const doc = stored();
    const more = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`st_${i}`, { name: 'x'.repeat(60), patch: {} }]));
    rejects(() => sanitize(doc, [{ op: 'letter_style', patch: { named: more } }]), 400, /nothing valid/);
    expect(sanitize(doc, [{ op: 'letter_style', patch: { named: more, base: { weight: 400 } } }])).toEqual([{ op: 'letter_style', patch: { base: { weight: 400 } } }]);
  });
});

describe("PE-LETTER's opt-in, wired (collisions B-3): accepted with the switch on, refused as before with it off", () => {
  const plain = () => normalizeDoc(JSON.parse(JSON.stringify(plannedDoc())));
  const PRO_TEXT = { warp: 'arc', warpAmount: 0.5, fillGradient: { from: '#000000', to: '#ffffff', angle: 0 }, shape: 'radio' };
  /** A doc whose comic look is `presetId` as stored (a Pro look written while the switch was on). */
  const withLook = (presetId: string): ComicDoc => {
    const raw = JSON.parse(JSON.stringify(plannedDoc())) as ComicDoc;
    raw.letterStyle = JSON.parse(JSON.stringify({ presetId, base: { weight: 700 } }));
    return normalizeDoc(raw);
  };

  it('line_style: the Pro text keys and a Pro shape on a plain line', () => {
    const op = { op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { textColor: '#123456', ...PRO_TEXT } };
    const [out] = sanitize(plain(), [op]) as Extract<DocOp, { op: 'line_style' }>[];
    expect(out.patch).toMatchObject({ textColor: '#123456', ...PRO_TEXT });
    expect(line(applyOps(plain(), [out])).style).toMatchObject(PRO_TEXT);
    sw.on = false;
    expect(sanitize(plain(), [op])).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['ln_1_2'], patch: { textColor: '#123456' } }]);
  });

  it('a new line (panel_add) and a `line` create or update carry Pro text keys only with the switch on', () => {
    const add = { op: 'panel_add', pageId: 'pg_1', panel: { id: 'pn_new', lines: [{ id: 'ln_new', kind: 'speech', text: 'Hi', style: { italic: true, ...PRO_TEXT } }] } };
    const upd = { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: { style: { italic: true, ...PRO_TEXT } } };
    const addedStyle = (ops: DocOp[]) => (ops[0] as Extract<DocOp, { op: 'panel_add' }>).panel.lines[0].style;
    const lineStyle = (ops: DocOp[]) => ((ops[0] as Extract<DocOp, { op: 'line' }>).patch as { style?: unknown }).style;
    expect(addedStyle(sanitize(plain(), [add]))).toMatchObject({ italic: true, ...PRO_TEXT });
    expect(lineStyle(sanitize(plain(), [upd]))).toMatchObject({ italic: true, ...PRO_TEXT });
    sw.on = false;
    expect(addedStyle(sanitize(plain(), [add]))).toEqual({ italic: true });
    expect(lineStyle(sanitize(plain(), [upd]))).toEqual({ italic: true });
  });

  it('letter_style: a Pro look is picked only with the switch on, and the refusal lists the looks a client may pick', () => {
    const [op] = sanitize(plain(), [{ op: 'letter_style', patch: { presetId: 'horror' } }]);
    expect(op).toEqual({ op: 'letter_style', patch: { presetId: 'horror' } });
    expect(applyOps(plain(), [op]).letterStyle?.presetId).toBe('horror');
    const on = rejects(() => sanitize(plain(), [{ op: 'letter_style', patch: { presetId: 'teleport' } }]), 400, /Unknown lettering preset/);
    expect(on.message).toMatch(/horror/);
    sw.on = false;
    const off = rejects(() => sanitize(plain(), [{ op: 'letter_style', patch: { presetId: 'horror' } }]), 400, /Unknown lettering preset/);
    expect(off.message).not.toMatch(/horror/);
  });

  it('letter_style: the stored look re-asserts with the switch off (C-8), so undoing an edit keeps it; another Pro look is refused', () => {
    sw.on = false;
    const doc = withLook('horror');
    expect(doc.letterStyle?.presetId).toBe('horror');
    expect(sanitize(doc, [{ op: 'letter_style', patch: { presetId: 'horror', keepOverrides: true, base: { weight: 800 } } }])).toEqual([
      { op: 'letter_style', patch: { presetId: 'horror', keepOverrides: true, base: { weight: 800 } } }
    ]);
    // The inverse of a base edit is a reset, then the old look: jobs.ts never applies letter_style to the batch's
    // working doc, so the restore still meets the stored look and re-asserts it.
    const { undo, back } = undoRoundTrip(doc, [{ op: 'letter_style', patch: { base: { weight: 400 } } }]);
    expect(undo[0]).toEqual({ op: 'letter_style', patch: null });
    expect(undo[1]).toMatchObject({ op: 'letter_style', patch: { presetId: 'horror', keepOverrides: true, base: { weight: 700 } } });
    expect(back.letterStyle).toEqual(doc.letterStyle);
    rejects(() => sanitize(doc, [{ op: 'letter_style', patch: { presetId: 'robot' } }]), 400, /Unknown lettering preset/);
  });

  it('letter_style `named`: a save and a delete apply, and their undo puts the saved styles back exactly', () => {
    const doc = stored();
    const save = undoRoundTrip(doc, [{ op: 'letter_style', patch: { named: { st_hero: { name: 'Hero', patch: { italic: true, textColor: '#0000ff' } } } } }]);
    expect(save.after.letterStyle?.named).toEqual({ ...NAMED, st_hero: { name: 'Hero', patch: { italic: true, textColor: '#0000ff' } } });
    expect(save.undo[save.undo.length - 1]).toEqual({ op: 'letter_style', patch: { named: { st_hero: null } } });
    expect(save.back.letterStyle).toEqual(doc.letterStyle);
    const drop = undoRoundTrip(doc, [{ op: 'letter_style', patch: { named: { st_villain: null } } }]);
    expect(Object.keys(drop.after.letterStyle?.named ?? {})).toEqual(['st_radio']);
    expect(drop.back.letterStyle).toEqual(doc.letterStyle);
  });
});
