// PE-LETTER (master plan §2.3, §2.4, §2.12; agent-editor plan §3 C7): 24 looks, the opt-in client acceptance of every
// Pro key and id (S2b lead decision, collisions B-3 / C-8 / C-9), the load keep of a look this build does not know,
// stored Pro ids that draw, the named-style cascade and the fold-back of a deleted style.
//
// Each test fails on the engine before PE-LETTER (756b5a70): there was no PRO_LETTERING_PRESET_IDS, no allowPro option,
// sanitizeLetteringStyle reset an unknown look to classic (dropping base, kinds, speakers and named), resolveLetterStyle
// skipped every Pro key, shape and effect, and ignored `named[styleId]`.

import { describe, expect, it } from 'vitest';
import { makeQaDoc } from '../../../components/comicstudio/testing/qaFixtures';
import { createEmptyDoc, normalizeDoc, type ComicDoc, type Line } from '../doc';
import { PRO_LETTER_LIMITS } from '../limits';
import { FONT_REGISTRY } from './fonts';
import {
  BUBBLE_SHAPES,
  DRAWN_PRO_SFX_EFFECTS,
  FONT_IDS,
  LETTERING_PRESETS,
  LETTERING_PRESET_IDS,
  PRO_BUBBLE_SHAPES,
  PRO_LETTERING_PRESETS,
  PRO_LETTERING_PRESET_IDS,
  PRO_SFX_EFFECTS,
  SFX_EFFECTS,
  foldNamedStyle,
  foldedLineStyle,
  isDrawnShape,
  isDrawnSfxEffect,
  letteringPresetOf,
  mergeNamedStyles,
  namedStyleOf,
  resolveLetterStyle,
  sanitizeLetterStylePatch,
  sanitizeLetteringStyle,
  sanitizeLetteringStyleOpPatch,
  type LetterStylePatch,
  type LetteringStyle,
  type NamedLetterStyle
} from './style';

const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const line = (kind: Line['kind'], extra: Partial<Line> = {}): Line => ({ id: 'l', kind, text: 'Hi', ...extra });
const PRO = { allowPro: true } as const;

/** Every Pro key and id a client could send, within the write bounds. */
const PRO_PATCH = {
  fillGradient: { from: '#ff0000', to: '#ffff00', angle: 45 },
  strokes: [{ color: '#000000', w: 0.1 }, { color: '#ffffff', w: 0.05 }],
  glow: { color: '#ffcc00', size: 0.2 },
  warp: 'wave',
  warpAmount: 0.4,
  shape: 'heart',
  sfxEffect: 'shatter'
};

describe('24 looks (8 base + 16 Pro), each a complete style drawn with shipped faces', () => {
  it('the Pro looks are a separate list that names the §2.4 looks, with no id shared with the base ones', () => {
    expect(LETTERING_PRESET_IDS).toHaveLength(8);
    expect(PRO_LETTERING_PRESET_IDS).toHaveLength(16);
    expect(new Set([...LETTERING_PRESET_IDS, ...PRO_LETTERING_PRESET_IDS]).size).toBe(24);
    for (const id of ['shonen', 'horror', 'romance', 'kids', 'sci_fi', 'western', 'villain', 'robot', 'narrator_box', 'newspaper', 'retro_caption', 'flashback'])
      expect(PRO_LETTERING_PRESET_IDS).toContain(id);
    expect(Object.keys(PRO_LETTERING_PRESETS).sort()).toEqual([...PRO_LETTERING_PRESET_IDS].sort());
  });

  it('every Pro look: complete base, registry fonts, drawn shapes and effects, valid as a Pro patch, unique names', () => {
    const keys = Object.keys(LETTERING_PRESETS.classic.base).sort();
    const names = new Set(Object.values(LETTERING_PRESETS).map((p) => p.name));
    for (const id of PRO_LETTERING_PRESET_IDS) {
      const p = PRO_LETTERING_PRESETS[id];
      expect(p.id).toBe(id);
      expect(Object.keys(p.base).sort(), id).toEqual(keys);
      expect(FONT_IDS).toContain(p.base.font);
      expect(sanitizeLetterStylePatch(p.base, PRO), id).toEqual(p.base);
      for (const k of Object.values(p.kinds)) {
        if (k.font) expect(FONT_IDS, id).toContain(k.font);
        if (k.shape) expect(isDrawnShape(k.shape), `${id} ${k.shape}`).toBe(true);
        if (k.sfxEffect) expect(isDrawnSfxEffect(k.sfxEffect), `${id} ${k.sfxEffect}`).toBe(true);
        expect(sanitizeLetterStylePatch(k, PRO), id).toEqual(k);
      }
      expect(p.name.length).toBeLessThanOrEqual(24);
      expect(p.blurb.length).toBeGreaterThan(20);
      expect(p.promptHint).toMatch(/^Letter it|^Letter the/);
      expect(names.has(p.name), p.name).toBe(false);
      names.add(p.name);
      // Every face it letters with is in the registry (no Pro face before PE-FONTS).
      expect(FONT_REGISTRY[p.base.font]).toBeTruthy();
    }
  });

  it('letteringPresetOf: base look, Pro look, and classic for anything else (prototype keys included)', () => {
    expect(letteringPresetOf('noir')).toBe(LETTERING_PRESETS.noir);
    expect(letteringPresetOf('horror')).toBe(PRO_LETTERING_PRESETS.horror);
    for (const bad of ['constructor', '__proto__', 'toString', 'some_future_look', 7, undefined]) expect(letteringPresetOf(bad)).toBe(LETTERING_PRESETS.classic);
  });

  it('a doc on a Pro look letters with it', () => {
    const doc = { ...createEmptyDoc('d', 'D', 1), letterStyle: { presetId: 'robot' as never } };
    expect(resolveLetterStyle(doc, line('speech'))).toMatchObject({ shape: 'radio', tail: 'lightning', font: 'atkinson' });
    expect(resolveLetterStyle(doc, line('sfx'))).toMatchObject({ sfxEffect: 'outline_stack', shape: 'none' });
    const villain = { ...doc, letterStyle: { presetId: 'villain' as never } };
    expect(resolveLetterStyle(villain, line('sfx')).glow).toEqual({ color: '#ff1a1a', size: 0.1 });
  });
});

describe('client acceptance of Pro lettering: only with {allowPro: true} (behind PRO_EDIT_OPS_PATCHABLE)', () => {
  it('sanitizeLetterStylePatch: refused without the option (exactly as before), accepted with it', () => {
    expect(sanitizeLetterStylePatch({ ...PRO_PATCH, italic: true })).toEqual({ italic: true });
    expect(sanitizeLetterStylePatch(PRO_PATCH)).toBeUndefined();
    expect(sanitizeLetterStylePatch(PRO_PATCH, PRO)).toEqual(PRO_PATCH);
    for (const shape of PRO_BUBBLE_SHAPES) {
      expect(sanitizeLetterStylePatch({ shape }), shape).toBeUndefined();
      expect(sanitizeLetterStylePatch({ shape }, PRO), shape).toEqual({ shape });
    }
    for (const sfxEffect of PRO_SFX_EFFECTS) {
      expect(sanitizeLetterStylePatch({ sfxEffect }), sfxEffect).toBeUndefined();
      // halftone_fill does not draw until S3, so no client may store it even with the switch on.
      expect(sanitizeLetterStylePatch({ sfxEffect }, PRO), sfxEffect).toEqual(DRAWN_PRO_SFX_EFFECTS.includes(sfxEffect) ? { sfxEffect } : undefined);
    }
  });

  it('the write bounds: strokes ≤ 3 and ≤ strokeWMax, glow ≤ glowSizeMax, warp ±warpAmountMax, hex colours only', () => {
    const out = sanitizeLetterStylePatch(
      {
        strokes: Array.from({ length: 5 }, (_v, i) => ({ color: i ? '#111' : 'auto', w: 2 })),
        glow: { color: 'gold', size: 9 },
        warpAmount: -7,
        fillGradient: { from: 'none', to: '#fff', angle: 10 }
      },
      PRO
    );
    expect(out).toEqual({ strokes: [{ color: '#111111', w: PRO_LETTER_LIMITS.strokeWMax }, { color: '#111111', w: PRO_LETTER_LIMITS.strokeWMax }], glow: { color: '#ffc400', size: PRO_LETTER_LIMITS.glowSizeMax }, warpAmount: -PRO_LETTER_LIMITS.warpAmountMax });
    expect(sanitizeLetterStylePatch({ warp: 'twist', strokes: 'x', glow: { color: '#fff', size: 0 } }, PRO)).toBeUndefined();
    expect(sanitizeLetterStylePatch({ strokes: [], glow: null, fillGradient: null }, PRO)).toEqual({ fillGradient: null, strokes: [], glow: null });
    // A gradient without an angle runs top to bottom.
    expect(sanitizeLetterStylePatch({ fillGradient: { from: '#000', to: '#fff' } }, PRO)).toEqual({ fillGradient: { from: '#000000', to: '#ffffff', angle: 90 } });
  });

  it('sanitizeLetteringStyleOpPatch: Pro looks, Pro keys in base / kinds / speakers and named styles need the option', () => {
    const cast = new Set(['c1']);
    const raw = { presetId: 'horror', base: { glow: { color: '#fff', size: 0.1 }, italic: true }, kinds: { sfx: { sfxEffect: 'wobble' } }, speakers: { c1: { shape: 'radio' } }, named: { st_a: { name: ' Radio ', patch: { shape: 'radio' } }, st_b: null } };
    // Without it: the Pro look is refused outright, exactly as before.
    expect(sanitizeLetteringStyleOpPatch(raw, cast)).toBeNull();
    expect(sanitizeLetteringStyleOpPatch({ ...raw, presetId: 'noir' }, cast)).toEqual({ presetId: 'noir', base: { italic: true } });
    // With it: everything, the named style's name trimmed.
    expect(sanitizeLetteringStyleOpPatch(raw, cast, PRO)).toEqual({
      presetId: 'horror',
      base: { italic: true, glow: { color: '#ffffff', size: 0.1 } },
      kinds: { sfx: { sfxEffect: 'wobble' } },
      speakers: { c1: { shape: 'radio' } },
      named: { st_a: { name: 'Radio', patch: { shape: 'radio' } }, st_b: null }
    });
    // A bad named entry rejects the whole patch (the server refuses the batch).
    for (const named of [{ __proto__x: null, 'bad key': null }, { st: { name: '', patch: {} } }, { st: { name: 'x'.repeat(41), patch: {} } }, 'nope'])
      expect(sanitizeLetteringStyleOpPatch({ named }, cast, PRO), JSON.stringify(named)).toBeNull();
    const many = Object.fromEntries(Array.from({ length: PRO_LETTER_LIMITS.namedStyles + 1 }, (_v, i) => [`st_${i}`, null]));
    expect(sanitizeLetteringStyleOpPatch({ named: many }, cast, PRO)).toBeNull();
  });
});

describe('load keep: a stored Pro id or look survives load and draws', () => {
  const stored = (): ComicDoc => {
    const d = json(makeQaDoc('lake-1p'));
    const l = d.pages[0].panels[0].lines[0];
    d.pages[0].panels[0].lines[0] = { ...l, kind: 'speech', style: json(PRO_PATCH) as never };
    d.letterStyle = { presetId: 'horror' as never, base: { textColor: '#222222', strokes: [{ color: '#000000', w: 0.08 }] } as never, kinds: { sfx: { sfxEffect: 'extrude3d' } as never } };
    return d;
  };

  it('a Pro look and its patches survive normalizeDoc and draw (shape, gradient, strokes, glow, warp, effect)', () => {
    const loaded = normalizeDoc(json(stored()));
    expect(loaded.letterStyle).toEqual(stored().letterStyle);
    const l = loaded.pages[0].panels[0].lines[0];
    expect(l.style).toEqual(PRO_PATCH);
    const r = resolveLetterStyle(loaded, l);
    expect(r).toMatchObject({ ...PRO_PATCH, textColor: '#222222', font: PRO_LETTERING_PRESETS.horror.base.font });
    expect(resolveLetterStyle(loaded, { ...l, kind: 'sfx', style: undefined }).sfxEffect).toBe('extrude3d');
  });

  it('a well-formed look this build does not know keeps its patches and draws as classic (was: wiped to classic)', () => {
    const raw = { presetId: 'future_look', auto: true, base: { textColor: '#00ff00', warp: 'arc' }, kinds: { shout: { fill: '#000001' } }, speakers: { c1: { italic: true } }, named: { st_x: { name: 'X', patch: { glow: { color: '#fff', size: 0.3 } } } } };
    const kept = sanitizeLetteringStyle(raw, { keepStoredPro: true });
    expect(kept).toEqual({ presetId: 'future_look', auto: true, base: { textColor: '#00ff00', warp: 'arc' }, kinds: { shout: { fill: '#000001' } }, speakers: { c1: { italic: true } }, named: { st_x: { name: 'X', patch: { glow: { color: '#ffffff', size: 0.3 } } } } });
    const doc = { format: createEmptyDoc('d', 'D', 1).format, letterStyle: kept };
    const asClassic = { format: doc.format, letterStyle: { ...kept, presetId: 'classic' as const } };
    expect(resolveLetterStyle(doc, line('shout'))).toEqual(resolveLetterStyle(asClassic, line('shout')));
    // Without the keep (a client) and for a malformed id, exactly as before.
    expect(sanitizeLetteringStyle(raw)).toEqual({ presetId: 'classic' });
    for (const presetId of ['Future', 'x', 'constructor', '__proto__', 'a'.repeat(40), 'bad-dash'])
      expect(sanitizeLetteringStyle({ presetId, base: { italic: true } }, { keepStoredPro: true }), presetId).toEqual({ presetId: 'classic' });
  });

  it('what this build cannot draw stays kept and is skipped: halftone_fill (S3) and a face PE-FONTS has not shipped', () => {
    const style = sanitizeLetterStylePatch({ sfxEffect: 'halftone_fill', font: 'bungee-shade' }, { keepStoredPro: true });
    expect(style).toEqual({ sfxEffect: 'halftone_fill', font: 'bungee-shade' });
    const doc = { format: createEmptyDoc('d', 'D', 1).format, letterStyle: { presetId: 'classic' as const } };
    const r = resolveLetterStyle(doc, line('sfx', { style }));
    expect(SFX_EFFECTS).toContain(r.sfxEffect);
    expect(FONT_IDS).toContain(r.font);
    // Every drawn shape is a base or Pro one (the exhaustive records see no other id).
    for (const s of [...BUBBLE_SHAPES, ...PRO_BUBBLE_SHAPES]) expect(isDrawnShape(s)).toBe(true);
    expect(isDrawnShape('blob')).toBe(false);
  });
});

describe('named styles: the cascade, the fold-back on delete, the merge', () => {
  const docWith = (ls: LetteringStyle) => ({ format: createEmptyDoc('d', 'D', 1).format, letterStyle: ls });

  it('cascade order: preset.base → preset.kinds → doc.base → doc.kinds → named[styleId] → doc.speakers → line.style', () => {
    // Each layer sets the key it should win and the keys a later layer must beat.
    const ls: LetteringStyle = {
      presetId: 'classic',
      base: { fill: '#000001', textColor: '#000001', border: '#000001', borderWidth: 2 },
      kinds: { speech: { textColor: '#000002', border: '#000002', borderWidth: 2.5 } },
      named: { st_1: { name: 'One', patch: { border: '#000003', borderWidth: 3, padding: 2, glow: { color: '#000003', size: 0.1 } } } },
      speakers: { c1: { borderWidth: 3.5, padding: 2.5 } }
    };
    const doc = docWith(ls);
    const r = resolveLetterStyle(doc, line('speech', { styleId: 'st_1', speakerId: 'c1', style: { padding: 3 } }));
    expect(r).toMatchObject({ fill: '#000001', textColor: '#000002', border: '#000003', borderWidth: 3.5, padding: 3, glow: { color: '#000003', size: 0.1 } });
    // Thought keeps its preset kind (cloud), whatever the named style says about anything else.
    expect(resolveLetterStyle(doc, line('thought', { styleId: 'st_1' })).shape).toBe('cloud');
    // A line linking to nothing, or to a prototype key, draws without a named layer.
    for (const styleId of ['st_missing', 'constructor', '__proto__']) expect(resolveLetterStyle(doc, line('speech', { styleId }))).toEqual(resolveLetterStyle(doc, line('speech')));
    expect(namedStyleOf(ls, 'toString')).toBeUndefined();
  });

  it('linked: editing the named style restyles every line that uses it', () => {
    const ls: LetteringStyle = { presetId: 'classic', named: { st_v: { name: 'Villain', patch: { textColor: '#aa0000' } } } };
    const a = line('speech', { id: 'a', styleId: 'st_v' });
    const b = line('shout', { id: 'b', styleId: 'st_v' });
    const edited = { ...ls, named: mergeNamedStyles(ls.named, { st_v: { name: 'Villain', patch: { textColor: '#00aa00' } } }) };
    for (const l of [a, b]) {
      expect(resolveLetterStyle(docWith(ls), l).textColor).toBe('#aa0000');
      expect(resolveLetterStyle(docWith(edited), l).textColor).toBe('#00aa00');
    }
  });

  it('deleting a named style folds its patch back into each line with no visual change (every QA fixture line)', () => {
    const NAMED: Record<string, NamedLetterStyle> = {
      st_bold: { name: 'Bold', patch: { weight: 900, border: '#123456', glow: null, shadow: null, strokes: [{ color: '#ff0000', w: 0.1 }] } },
      st_cool: { name: 'Cool', patch: { textColor: '#0000ff', shape: 'telepathic' as never, italic: true, sfxEffect: 'halftone_fill' as never } }
    };
    for (const name of ['heist-12p', 'webtoon-20p'] as const) {
      const doc = json(makeQaDoc(name));
      const castIds = (doc.cast || []).map((c) => c.id);
      doc.letterStyle = {
        presetId: 'classic',
        base: { glow: { color: '#00ff00', size: 0.2 }, shadow: { color: '#000000', dx: 0.05, dy: 0.05 } },
        named: NAMED,
        // A speaker decides some of the keys a named style also sets (and one with a value this build cannot draw).
        speakers: Object.fromEntries(castIds.slice(0, 2).map((id, i) => [id, i ? { border: '#654321' } : ({ italic: false, shape: 'blob' } as unknown as LetterStylePatch)]))
      };
      let n = 0;
      for (const page of doc.pages)
        for (const panel of page.panels)
          panel.lines.forEach((l, i) => {
            l.styleId = i % 3 === 0 ? 'st_bold' : i % 3 === 1 ? 'st_cool' : undefined;
            if (i % 2) l.style = { ...(l.style || {}), weight: 400, textColor: '#111111' };
            n += 1;
          });
      expect(n).toBeGreaterThan(10);
      for (const id of Object.keys(NAMED)) {
        const before = doc;
        const folded = foldNamedStyle(before, id);
        expect(folded.length).toBeGreaterThan(0);
        const after = json(before);
        after.letterStyle = { ...after.letterStyle!, named: mergeNamedStyles(after.letterStyle!.named, { [id]: null }) };
        for (const f of folded) {
          const l = after.pages.find((p) => p.id === f.pageId)!.panels.flatMap((p) => p.lines).find((x) => x.id === f.lineId)!;
          delete l.styleId;
          if (f.style) l.style = f.style;
          else delete l.style;
        }
        for (const page of before.pages)
          for (const panel of page.panels)
            for (const l of panel.lines) {
              const l2 = after.pages.find((p) => p.id === page.id)!.panels.flatMap((p) => p.lines).find((x) => x.id === l.id)!;
              expect(resolveLetterStyle(after, l2), `${name} ${id} ${l.id}`).toEqual(resolveLetterStyle(before, l));
            }
        expect(after.letterStyle!.named?.[id]).toBeUndefined();
      }
    }
  });

  it('foldedLineStyle keeps a named null (a decided "no glow") and leaves a line without a saved style alone', () => {
    const ls: LetteringStyle = { presetId: 'classic', base: { glow: { color: '#00ff00', size: 0.2 } }, named: { st: { name: 'S', patch: { glow: null, italic: true } } } };
    expect(foldedLineStyle(ls, { styleId: 'st', style: { weight: 400 } })).toEqual({ weight: 400, glow: null, italic: true });
    expect(foldedLineStyle(ls, { style: { weight: 400 } })).toEqual({ weight: 400 });
    expect(foldedLineStyle(ls, { styleId: 'gone' })).toBeUndefined();
    expect(foldNamedStyle({ letterStyle: ls, pages: [] }, 'gone')).toEqual([]);
  });

  it('mergeNamedStyles: upsert replaces a style whole, null deletes, a new one past the cap is not added', () => {
    const cur = { a: { name: 'A', patch: { italic: true } }, b: { name: 'B', patch: {} } };
    expect(mergeNamedStyles(cur, { a: { name: 'A2', patch: { weight: 900 } }, b: null })).toEqual({ a: { name: 'A2', patch: { weight: 900 } } });
    expect(mergeNamedStyles(cur, { a: null, b: null })).toBeUndefined();
    const full = Object.fromEntries(Array.from({ length: PRO_LETTER_LIMITS.namedStyles }, (_v, i) => [`s${i}`, { name: `S${i}`, patch: {} }]));
    expect(Object.keys(mergeNamedStyles(full, { extra: { name: 'X', patch: {} } })!)).toHaveLength(PRO_LETTER_LIMITS.namedStyles);
    expect(mergeNamedStyles(full, { s0: { name: 'Renamed', patch: {} } })!.s0.name).toBe('Renamed');
    expect(mergeNamedStyles(undefined, { 'bad key': { name: 'X', patch: {} }, __proto__: null } as never)).toBeUndefined();
  });
});
