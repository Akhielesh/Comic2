// @vitest-environment node
// The S2 effect generators (master plan §2.3 "Effect", §2.6 "Effects", §2.8 "Effect geometry", §2.12 PE-FX):
// determinism, a frozen golden per gen@v (and per named preset), ≤ FX_LIMITS.segmentsMax segments, path / circle / rect
// only and fill-only, every mark inside its box, schema clamps at draw time, isotropy on any aspect, memoization,
// ≤ 4 ms per generator, and the dispatch through renderFx once fx/generators.ts is loaded.

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { FX_LIMITS } from '../limits';
import { FX_GEN_RE, fxParamsOf, fxWithinBudget } from './index';
import * as generatorsModule from './generators';
import { FX_DRAW_FNS, FX_GENERATORS_LOADED, FX_PRESETS, fxDrawFor, fxDrawUncheckedForTests, fxFromPreset, fxPresetOf, registerFxGenerators } from './generators';
import { FX_BORDER_STYLES, FX_EMANATA_ARRANGEMENTS, FX_EMANATA_SYMBOLS, FX_GENERATORS, fxCanDraw, fxDefaultsOf, fxGeneratorOf, fxSegmentsOf, registerFxDraw, renderFx } from './registry';
import { ASPECTS, SEEDS, atBound, commandsOf, curvePoints, fxOf, lcg, paramSets } from './fixtures.test-helpers';
import type { FxGenerator, FxNode, FxParamValue } from './types';

const h = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const keyOf = (g: Pick<FxGenerator, 'gen' | 'v'>) => `${g.gen}@${g.v}`;
/** The raw drawing after the schema check, as registered (no cap, no memo): the sweeps measure the drawing itself. */
const draw = (g: FxGenerator, raw: Record<string, FxParamValue>, seed: number, aspect: number): FxNode[] => fxDrawUncheckedForTests(keyOf(g))!(fxParamsOf(g, raw), seed, aspect);
/** Every enum value of a generator, each at the defaults (speed-line modes, emanata marks and arrangements, border styles). */
const enumSets = (g: FxGenerator): Record<string, FxParamValue>[] =>
  Object.entries(g.params).flatMap(([key, spec]) => (spec.kind === 'enum' ? spec.values.map((v) => ({ ...fxDefaultsOf(g), [key]: v })) : []));
/** Every (generator, parameter set, seed, aspect) the sweep tests run over. */
const sweep = function* () {
  for (const g of FX_GENERATORS) for (const raw of paramSets(g)) for (const seed of SEEDS) for (const aspect of ASPECTS) yield { g, raw, seed, aspect };
};

/**
 * Frozen per gen@v: [defaults, seed 1, aspect 1], [defaults, seed 1, aspect 1.6], [every number at its max, seed −7,
 * aspect 0.6], then every enum value at the defaults (seed 3, aspect 1.6). A registered version's drawing never changes
 * once shipped: a new look is a new version with a new golden here.
 */
const GOLDEN: Record<string, string> = {
  'speed-lines@1': '37a4a408cb77e6f3',
  'focus-lines@1': 'd01ec22e36f33b17',
  'burst@1': 'c3bb1d914601ecf7',
  'sunburst@1': 'a3a78dec302f3e83',
  'explosion@1': 'a7aecd9ee0aad4b0',
  'shock-rings@1': '9507d31dd2293bf4',
  'emanata@1': 'c11fa9aae3ad3591',
  'rain@1': 'f62792616cff5bc6',
  'snow@1': '77e3ce07228ef508',
  'petals@1': 'c2b4b8f69b46ea1f',
  'bokeh@1': '00737eef7d39459f',
  'sparkle@1': '0dfbe39a31ff2b16',
  'smoke@1': '79819fca9278edcb',
  'frame-border@1': '36e6a1c07d9ca45e'
};
/** Frozen per named preset, at aspect 1 with its own seed. */
const PRESET_GOLDEN: Record<string, string> = {
  'speed-lines': 'e339c67a5a177672',
  'falling-lines': '99ae930b1b21f069',
  'radial-speed-lines': '8b781f80e57ee621',
  'curved-speed-lines': '254f96e7bdb8a414',
  'focus-lines': '00ebc60df758adab',
  'impact-focus': '1c3f9d34703f1c50',
  'star-burst': '2ccd5cb1402502a5',
  'shout-burst': 'c02242abba266d00',
  'puff-burst': '832dfb10752cbdcf',
  'spiky-burst': 'e1cc0bbd881f91eb',
  'sunburst': 'a3c07d1f8a380b2c',
  'ray-flash': 'ef65f8b2ad046f4b',
  'explosion': '07e51abbe1c78cf4',
  'shock-rings': 'bb46bb6224efcbc0',
  'sweat-drops': 'c936bcf8b4cbc48b',
  'shake-marks': 'a31d71f1f11fa91b',
  'surprise-lines': 'bf75ccbc6a6dd87b',
  'anger-mark': '53d6c9f57be08de4',
  'love-hearts': '2e84ed38b4a7031f',
  'dizzy-stars': 'f764c54693c51ce5',
  'steam-puffs': 'fb304615da2d81aa',
  'sleep-z': '4fa5fe771aba992e',
  'music-notes': '5af8c3ee36ca504f',
  'gloom-lines': 'e9e8b1df12de77df',
  'exclamation': '11482862d40cb251',
  'dizzy-swirl': '194e9f7663d58cf9',
  'rain': '817c8f2e7d7ba0d5',
  'snow': '2e4167731bf90363',
  'falling-petals': 'c978f7185f7ab29c',
  'bokeh-lights': 'b2ba21e793cece21',
  'sparkles': '660708e8f970901e',
  'smoke': '1cebbf7be6a5946a',
  'rough-border': '7ad51e9002116130',
  'brush-border': 'ef557091e2697c03',
  'double-rule': 'ff239bfd9ac6ece0',
  'dashed-border': '4ec02f72d69aa1a3',
  'dotted-border': '91975613fb88016a',
  'wavy-border': 'ba2f573fc76b2163',
  'jagged-border': '0461579c150aadf1',
  'film-strip': '56524b13b778d0fd',
  'torn-paper': '7349fbdfe2219451',
  'scalloped-border': 'b5b81b2f141000f0'
};

describe('effect generators: registration and determinism', () => {
  it('registers a drawing for exactly the registered generators', () => {
    expect(FX_GENERATORS_LOADED).toBe(true);
    expect(Object.keys(FX_DRAW_FNS).sort()).toEqual(FX_GENERATORS.map(keyOf).sort());
    for (const g of FX_GENERATORS) expect(fxCanDraw(g), keyOf(g)).toBe(true);
    expect(() => fxDrawFor('nope@1')).toThrow(/no generator/);
  });

  it('exports no raw drawing: FX_DRAW_FNS clamps, caps and memoizes a stored parameter set like renderFx', () => {
    // The raw map stays module-private; only the accessor whose name says it is unchecked (and for tests) reaches it.
    expect('DRAW_FNS' in generatorsModule).toBe(false);
    const speed = fxGeneratorOf('speed-lines', 1)!;
    const stored = { count: 100000, weight: 9, length: 'long' } as unknown as Record<string, FxParamValue>;
    const nodes = FX_DRAW_FNS['speed-lines@1'](stored, 1, 1);
    expect(nodes).toEqual(draw(speed, { ...fxDefaultsOf(speed), count: 96, weight: 0.06 }, 1, 1));
    expect(nodes).toBe(renderFx({ gen: 'speed-lines', v: 1, seed: 1, params: stored }, { aspect: 1 }));
    expect(Object.isFrozen(nodes)).toBe(true);
    for (const g of FX_GENERATORS) {
      const wild = Object.fromEntries(Object.entries(g.params).map(([k, spec]) => [k, spec.kind === 'number' ? spec.max * 1000 + 1e6 : 'x']));
      expect(fxSegmentsOf(FX_DRAW_FNS[keyOf(g)](wild, 5, 1.6)), keyOf(g)).toBeLessThanOrEqual(FX_LIMITS.segmentsMax);
    }
  });

  it('is deterministic: the same fx gives byte-identical nodes (fresh objects, any key order, through renderFx too)', () => {
    for (const g of FX_GENERATORS) {
      for (const raw of [fxDefaultsOf(g), atBound(g, 'max'), atBound(g, 'min')]) {
        for (const aspect of [0.6, 1, 1.6]) {
          const a = JSON.stringify(draw(g, raw, 42, aspect));
          const reversed = Object.fromEntries(Object.entries(raw).reverse());
          expect(JSON.stringify(draw(g, { ...reversed }, 42, aspect)), keyOf(g)).toBe(a);
          expect(JSON.stringify(renderFx(fxOf(g, reversed, 42), { aspect })), keyOf(g)).toBe(a);
        }
      }
    }
  });

  it('a different seed draws differently (every generator is seeded at its defaults)', () => {
    for (const g of FX_GENERATORS) {
      const a = JSON.stringify(draw(g, fxDefaultsOf(g), 1, 1));
      expect(JSON.stringify(draw(g, fxDefaultsOf(g), 2, 1)), keyOf(g)).not.toBe(a);
    }
  });

  it('matches the frozen golden of every gen@v; every registered version has one (old versions stay registered)', () => {
    const got: Record<string, string> = {};
    for (const g of FX_GENERATORS) {
      got[keyOf(g)] = h([
        renderFx(fxOf(g, fxDefaultsOf(g), 1), { aspect: 1 }),
        renderFx(fxOf(g, fxDefaultsOf(g), 1), { aspect: 1.6 }),
        renderFx(fxOf(g, atBound(g, 'max'), -7), { aspect: 0.6 }),
        ...enumSets(g).map((raw) => renderFx(fxOf(g, raw, 3), { aspect: 1.6 }))
      ]);
    }
    expect(got).toEqual(GOLDEN);
    for (const key of Object.keys(GOLDEN)) expect(FX_GENERATORS.some((g) => keyOf(g) === key), `${key} is still registered`).toBe(true);
  });

  it('matches the frozen golden of every named preset', () => {
    const got: Record<string, string> = {};
    for (const p of FX_PRESETS) got[p.id] = h(renderFx(fxFromPreset(p.id)!, { aspect: 1 }));
    expect(got).toEqual(PRESET_GOLDEN);
  });
});

describe('effect generators: named presets (with the drawings, in the Pro chunk)', () => {
  it('names 42 presets: lines 6, bursts 8, emanata 12, atmosphere 6, borders 10', () => {
    const count: Record<string, number> = {};
    for (const p of FX_PRESETS) count[p.group] = (count[p.group] ?? 0) + 1;
    expect(count).toEqual({ lines: 6, bursts: 8, emanata: 12, atmosphere: 6, borders: 10 });
    expect(FX_PRESETS).toHaveLength(42);
    expect(new Set(FX_PRESETS.map((p) => p.id)).size).toBe(42);
    expect(new Set(FX_PRESETS.map((p) => p.name)).size).toBe(42);
    // One preset per emanata mark and per border style.
    expect(new Set(FX_PRESETS.filter((p) => p.gen === 'emanata').map((p) => p.params.symbol))).toEqual(new Set(FX_EMANATA_SYMBOLS));
    expect(new Set(FX_PRESETS.filter((p) => p.gen === 'frame-border').map((p) => p.params.style))).toEqual(new Set(FX_BORDER_STYLES));
  });

  it('every preset is a registered generator with every parameter inside its schema, a seed and search words', () => {
    for (const p of FX_PRESETS) {
      const g = fxGeneratorOf(p.gen, p.v);
      expect(g, p.id).toBeDefined();
      expect(p.group).toBe(g!.group);
      expect(FX_GEN_RE.test(p.id), p.id).toBe(true);
      expect(Object.keys(p.params).sort(), p.id).toEqual(Object.keys(g!.params).sort());
      expect(fxParamsOf(g!, p.params), p.id).toEqual(p.params);
      expect(Number.isInteger(p.seed) && p.seed >= -2147483648 && p.seed <= 2147483647, p.id).toBe(true);
      expect(p.keywords.length, p.id).toBeGreaterThanOrEqual(3);
      expect(fxWithinBudget(fxFromPreset(p.id)), p.id).toBe(true);
      expect(Object.isFrozen(p) && Object.isFrozen(p.params), p.id).toBe(true);
    }
  });

  it('fxFromPreset gives a fresh effect (its own parameters; an int32 seed override), undefined for an unknown id', () => {
    const a = fxFromPreset('radial-speed-lines')!;
    expect(a).toEqual({ gen: 'speed-lines', v: 1, seed: 103, params: { ...fxPresetOf('radial-speed-lines')!.params } });
    a.params.count = 4;
    expect(fxPresetOf('radial-speed-lines')!.params.count).toBe(56);
    expect(fxFromPreset('rain', -12)!.seed).toBe(-12);
    expect(fxFromPreset('rain', 2 ** 31)!.seed).toBe(401);
    expect(fxFromPreset('rain', 1.5)!.seed).toBe(401);
    expect(fxFromPreset('nope')).toBeUndefined();
  });
});

describe('effect generators: geometry budget and shape (§2.8)', () => {
  it(`draws at most FX_LIMITS.segmentsMax (${FX_LIMITS.segmentsMax}) segments for every parameter set, seed and aspect`, () => {
    const worst: Record<string, number> = {};
    for (const { g, raw, seed, aspect } of sweep()) {
      const n = fxSegmentsOf(draw(g, raw, seed, aspect));
      worst[keyOf(g)] = Math.max(worst[keyOf(g)] ?? 0, n);
      if (n > FX_LIMITS.segmentsMax) expect.fail(`${keyOf(g)} drew ${n} segments for ${JSON.stringify(raw)}, seed ${seed}, aspect ${aspect}`);
    }
    for (const g of FX_GENERATORS) expect(worst[keyOf(g)], keyOf(g)).toBeGreaterThan(0);
  });

  it('uses only path, circle and rect nodes, fill-only, with plain #RRGGBB fills, opacities in (0, 1) and M L Q C Z paths', () => {
    const KEYS: Record<string, string[]> = { path: ['tag', 'd', 'fill', 'opacity'], rect: ['tag', 'x', 'y', 'w', 'h', 'fill', 'opacity'], circle: ['tag', 'cx', 'cy', 'r', 'fill', 'opacity'] };
    const NUM = '-?\\d+(?:\\.\\d+)?';
    const D = new RegExp(`^(?:M${NUM} ${NUM}(?:L${NUM} ${NUM}|Q${NUM} ${NUM} ${NUM} ${NUM}|C${NUM} ${NUM} ${NUM} ${NUM} ${NUM} ${NUM}|Z)*)+$`);
    for (const { g, raw, seed, aspect } of sweep()) {
      for (const node of draw(g, raw, seed, aspect)) {
        const at = `${keyOf(g)} ${JSON.stringify(raw)} ${seed} ${aspect}`;
        expect(['path', 'circle', 'rect'], at).toContain(node.tag);
        for (const k of Object.keys(node)) if (!KEYS[node.tag].includes(k)) expect.fail(`${at}: key ${k} on ${node.tag}`);
        expect(node.fill, at).toMatch(/^#[0-9a-fA-F]{6}$/);
        if (node.opacity !== undefined) expect(node.opacity > 0 && node.opacity < 1, at).toBe(true);
        if (node.tag === 'path' && !D.test(node.d)) expect.fail(`${at}: path grammar ${node.d.slice(0, 80)}`);
      }
    }
  });

  it('keeps every mark inside its box: end points within 0..1, curves within a hair of it', () => {
    let worstEnd = 0;
    let worstCurve = 0;
    let at = '';
    for (const { g, raw, seed, aspect } of sweep()) {
      for (const node of draw(g, raw, seed, aspect)) {
        const { ends, samples } = curvePoints(node);
        for (const [x, y] of ends) {
          const out = Math.max(-x, -y, x - 1, y - 1);
          if (out > worstEnd) [worstEnd, at] = [out, `${keyOf(g)} ${JSON.stringify(raw)} ${seed} ${aspect}`];
        }
        for (const [x, y] of samples) worstCurve = Math.max(worstCurve, -x, -y, x - 1, y - 1);
      }
    }
    expect(worstEnd, at).toBeLessThanOrEqual(0.0001);
    expect(worstCurve).toBeLessThanOrEqual(0.01);
  });

  it('curved speed lines never bend past the box, on any aspect (a seeded sweep of 200 random sets, aspects up to 5)', () => {
    const g = fxGeneratorOf('speed-lines', 1)!;
    /** How far a node reaches past the box, in units of the box height (x is scaled by the aspect). */
    const overflow = (nodes: readonly FxNode[], aspect: number): number => {
      let worst = 0;
      for (const node of nodes) {
        const { ends, samples } = curvePoints(node);
        for (const [x, y] of [...ends, ...samples]) worst = Math.max(worst, -x * aspect, (x - 1) * aspect, -y, y - 1);
      }
      return worst;
    };
    const rand = lcg(0x5eed);
    const cases: { raw: Record<string, FxParamValue>; seed: number; aspect: number }[] = [
      // Found by a 4,000-set probe: near the ends of a long chord almost parallel to an edge, the ribbon crossed the box.
      { raw: { mode: 'curved', count: 10, angle: -172.24, length: 0.831, weight: 0.01, taper: false, bend: 0.837, jitter: 0.7515 }, seed: -1598422169, aspect: 4 }
    ];
    for (const raw of paramSets(g, 200).slice(-200)) {
      cases.push({ raw: { ...raw, mode: 'curved' }, seed: (Math.floor(rand() * 2 ** 32) | 0), aspect: Math.round((0.2 + rand() * 4.8) * 1000) / 1000 });
    }
    for (const aspect of [4, 5]) for (const raw of paramSets(g, 0)) cases.push({ raw: { ...raw, mode: 'curved' }, seed: 11, aspect });
    let worst = 0;
    let at = '';
    for (const { raw, seed, aspect } of cases) {
      const out = overflow(draw(g, raw, seed, aspect), aspect);
      if (out > worst) [worst, at] = [out, `${JSON.stringify(raw)} seed ${seed} aspect ${aspect}`];
    }
    expect(worst, at).toBeLessThanOrEqual(0.002);
  });

  it('keeps marks round on any aspect: a disc drawn in a 2.5:1 box is as wide as it is tall once the box is mapped', () => {
    const g = fxGeneratorOf('bokeh', 1)!;
    for (const aspect of [0.4, 2.5]) {
      const [halo] = draw(g, { ...fxDefaultsOf(g), soft: true }, 3, aspect);
      for (const sub of (halo as Extract<FxNode, { tag: 'path' }>).d.split('M').filter(Boolean)) {
        const pts = commandsOf(`M${sub}`).flatMap(([, v]) => {
          const out: [number, number][] = [];
          for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]]);
          return out;
        });
        const xs = pts.map((p) => p[0] * aspect);
        const ys = pts.map((p) => p[1]);
        expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 3);
      }
    }
  });

  it('one emanata mark sits in the middle of its box, whatever the arrangement', () => {
    const g = fxGeneratorOf('emanata', 1)!;
    /** The middle of everything drawn, in the isotropic frame (box heights). */
    const middleOf = (nodes: readonly FxNode[], aspect: number): [number, number] => {
      const pts = nodes.flatMap((n) => {
        const { ends, samples } = curvePoints(n);
        return [...ends, ...samples];
      });
      const xs = pts.map(([x]) => x * aspect);
      const ys = pts.map(([, y]) => y);
      return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    };
    let worst = 0;
    let at = '';
    for (const symbol of FX_EMANATA_SYMBOLS) {
      for (const arrange of FX_EMANATA_ARRANGEMENTS) {
        for (const aspect of [0.5, 1, 2.4]) {
          for (const seed of [1, -9, 4242]) {
            const [x, y] = middleOf(draw(g, { ...fxDefaultsOf(g), symbol, arrange, count: 1, jitter: 0, size: 0.3 }, seed, aspect), aspect);
            // A mark's own outline is not quite centred in its cell (the swirl, the drop): at most 0.1 of its size.
            const off = Math.max(Math.abs(x - aspect / 2), Math.abs(y - 0.5));
            if (off > worst) [worst, at] = [off, `${symbol} ${arrange} ${aspect} ${seed}`];
          }
        }
      }
    }
    expect(worst, at).toBeLessThanOrEqual(0.03);
    // The single-mark presets (anger mark, exclamation, dizzy swirl) at the contact-sheet aspects, with any seed.
    for (const id of ['anger-mark', 'exclamation', 'dizzy-swirl']) {
      for (const aspect of [1, 2.4]) {
        for (const seed of [undefined, 77, -5]) {
          const [x, y] = middleOf(renderFx(fxFromPreset(id, seed)!, { aspect }), aspect);
          expect(Math.abs(x / aspect - 0.5), `${id} ${aspect} ${seed} across`).toBeLessThanOrEqual(0.04);
          expect(Math.abs(y - 0.5), `${id} ${aspect} ${seed} down`).toBeLessThanOrEqual(0.04);
        }
      }
    }
  });

  it('every emanata mark and every border style draws, and each looks different', () => {
    for (const [gen, key] of [
      ['emanata', 'symbol'],
      ['frame-border', 'style']
    ] as const) {
      const g = fxGeneratorOf(gen, 1)!;
      const spec = g.params[key];
      if (spec.kind !== 'enum') throw new Error('enum expected');
      const seen = new Set<string>();
      for (const v of spec.values) {
        const nodes = draw(g, { ...fxDefaultsOf(g), [key]: v }, 1, 1);
        expect(fxSegmentsOf(nodes), `${gen} ${v}`).toBeGreaterThan(0);
        seen.add(JSON.stringify(nodes));
      }
      expect(seen.size, gen).toBe(spec.values.length);
    }
  });
});

describe('effect generators: schema clamps at draw time (PE-0 risk 2)', () => {
  it('a stored out-of-range, wrong-kind or unknown parameter draws exactly as its clamped value or default', () => {
    for (const g of FX_GENERATORS) {
      const wild = Object.fromEntries(
        Object.entries(g.params).map(([k, s]) => [k, s.kind === 'number' ? s.max * 1000 + 1e6 : s.kind === 'enum' ? 'not-a-choice' : s.kind === 'color' ? 'red' : 'yes'])
      );
      const low = Object.fromEntries(Object.entries(g.params).map(([k, s]) => [k, s.kind === 'number' ? s.min - 1e6 : (fxDefaultsOf(g)[k] as FxParamValue)]));
      for (const aspect of [0.6, 1.6]) {
        const clampedHigh = { ...fxDefaultsOf(g), ...Object.fromEntries(Object.entries(g.params).filter(([, s]) => s.kind === 'number').map(([k, s]) => [k, s.kind === 'number' ? s.max : 0])) };
        expect(JSON.stringify(renderFx(fxOf(g, { ...wild, extra: 5 }, 9), { aspect })), keyOf(g)).toBe(JSON.stringify(draw(g, clampedHigh, 9, aspect)));
        expect(JSON.stringify(renderFx(fxOf(g, low, 9), { aspect })), keyOf(g)).toBe(JSON.stringify(draw(g, atBound(g, 'min'), 9, aspect)));
        expect(fxSegmentsOf(renderFx(fxOf(g, wild, 9), { aspect })), keyOf(g)).toBeLessThanOrEqual(FX_LIMITS.segmentsMax);
      }
      // Missing parameters (and junk instead of an object) draw the defaults.
      expect(JSON.stringify(renderFx({ gen: g.gen, v: g.v, seed: 4, params: null as unknown as Record<string, FxParamValue> }, { aspect: 1 }))).toBe(JSON.stringify(draw(g, fxDefaultsOf(g), 4, 1)));
    }
    // The plain example: 100 000 speed lines draw as the schema's 96.
    const speed = fxGeneratorOf('speed-lines', 1)!;
    expect(renderFx({ gen: 'speed-lines', v: 1, seed: 1, params: { count: 100000 } }, { aspect: 1 })).toEqual(draw(speed, { ...fxDefaultsOf(speed), count: 96 }, 1, 1));
  });
});

describe('effect generators: memo, budget guard and speed', () => {
  it('memoizes by (gen, v, seed, aspect, params): the same effect is computed once and shared, frozen', () => {
    const spy = vi.fn(fxDrawFor('burst@1'));
    registerFxDraw('burst', 1, spy);
    try {
      const fx = fxFromPreset('star-burst')!;
      const first = renderFx(fx, { aspect: 1.25 });
      const again = renderFx({ ...fx, params: Object.fromEntries(Object.entries(fx.params).reverse()) }, { aspect: 1.25 });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(again).toBe(first);
      expect(Object.isFrozen(first) && first.every((n) => Object.isFrozen(n))).toBe(true);
      renderFx({ ...fx, seed: fx.seed + 1 }, { aspect: 1.25 });
      renderFx({ ...fx, params: { ...fx.params, points: 9 } }, { aspect: 1.25 });
      renderFx(fx, { aspect: 2 });
      expect(spy).toHaveBeenCalledTimes(4);
      // The memo is bounded: a long run of distinct effects evicts the oldest.
      for (let s = 0; s < 300; s += 1) renderFx({ ...fx, seed: 1000 + s }, { aspect: 1.25 });
      renderFx(fx, { aspect: 1.25 });
      expect(spy).toHaveBeenCalledTimes(305);
    } finally {
      registerFxGenerators();
    }
  });

  it('renderFx never returns more than the budget, and a drawing that throws draws nothing', () => {
    const many: FxNode[] = Array.from({ length: 150 }, (_, i) => ({ tag: 'rect', x: 0, y: i / 150, w: 1, h: 0.001, fill: '#000000' }));
    try {
      registerFxDraw('rain', 1, () => many);
      const out = renderFx({ gen: 'rain', v: 1, seed: 1, params: {} }, { aspect: 1 });
      expect(fxSegmentsOf(out)).toBe(FX_LIMITS.segmentsMax);
      expect(out).toEqual(many.slice(0, FX_LIMITS.segmentsMax / 4));
      registerFxDraw('rain', 1, () => {
        throw new Error('boom');
      });
      expect(renderFx({ gen: 'rain', v: 1, seed: 1, params: {} }, { aspect: 1 })).toEqual([]);
    } finally {
      registerFxGenerators();
    }
    expect(renderFx({ gen: 'rain', v: 1, seed: 1, params: {} }, { aspect: 1 }).length).toBeGreaterThan(0);
  });

  it('draws each generator in at most 4 ms on its fixtures (median of warm runs, heaviest parameter set)', () => {
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const report: Record<string, number> = {};
    for (const g of FX_GENERATORS) {
      let worst = 0;
      for (const raw of paramSets(g, 4)) {
        const p = fxParamsOf(g, raw);
        const fn = fxDrawUncheckedForTests(keyOf(g))!;
        for (let i = 0; i < 3; i += 1) fn(p, i, 1.6);
        const times: number[] = [];
        for (let i = 0; i < 9; i += 1) {
          const t0 = performance.now();
          fn(p, 100 + i, 1.6);
          times.push(performance.now() - t0);
        }
        worst = Math.max(worst, median(times));
      }
      report[keyOf(g)] = Math.round(worst * 1000) / 1000;
    }
    for (const [key, ms] of Object.entries(report)) expect(ms, `${key} took ${ms} ms`).toBeLessThanOrEqual(4);
  });
});
