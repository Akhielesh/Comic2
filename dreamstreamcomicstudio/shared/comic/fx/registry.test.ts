// @vitest-environment node
// The effect registry (master plan §2.3, §2.6, §2.12 PE-FX): metadata, names, presets and the loading seam. This file
// never imports fx/generators.ts at the top, so it also pins that renderFx draws nothing until the generators module
// is loaded (collisions B-7), then loads it and sees the same effect draw.

import { readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { FX_LIMITS } from '../limits';
import * as fxBarrel from './index';
import { FX_GEN_RE, FX_GROUPS, FX_PARAM_KEY_RE, fxParamsOf, fxWithinBudget } from './index';
import { FX_NAMES, fxName } from './names';
import {
  FX_BORDER_STYLES,
  FX_EMANATA_SYMBOLS,
  FX_GENERATORS,
  fxAspectOf,
  fxCanDraw,
  fxDefaultsOf,
  fxGeneratorOf,
  fxSegmentsOf,
  latestFxGenerator,
  registerFxDraw,
  renderFx
} from './registry';
import type { LayerFx } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const defaultFx = (gen: string, v = 1, seed = 7): LayerFx => ({ gen, v, seed, params: fxDefaultsOf(fxGeneratorOf(gen, v)!) });

describe('fx registry: generators and their schemas', () => {
  it('registers the 14 S2 generators (lines 2, bursts 4, emanata 1, atmosphere 6, borders 1), each gen@v once', () => {
    const byGroup: Record<string, string[]> = {};
    for (const g of FX_GENERATORS) (byGroup[g.group] ??= []).push(g.gen);
    expect(byGroup).toEqual({
      lines: ['speed-lines', 'focus-lines'],
      bursts: ['burst', 'sunburst', 'explosion', 'shock-rings'],
      emanata: ['emanata'],
      atmosphere: ['rain', 'snow', 'petals', 'bokeh', 'sparkle', 'smoke'],
      borders: ['frame-border']
    });
    const keys = FX_GENERATORS.map((g) => `${g.gen}@${g.v}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const g of FX_GENERATORS) {
      expect(FX_GEN_RE.test(g.gen), g.gen).toBe(true);
      expect(Number.isInteger(g.v) && g.v >= 1, g.gen).toBe(true);
      expect(FX_GROUPS).toContain(g.group);
      expect(latestFxGenerator(g.gen)).toBe(g);
      expect(fxGeneratorOf(g.gen, g.v)).toBe(g);
    }
    expect(fxGeneratorOf('speed-lines', 2)).toBeUndefined();
    expect(fxGeneratorOf('nope', 1)).toBeUndefined();
    // Tones and paper are PE-TONES's (S3).
    expect(FX_GENERATORS.some((g) => g.group === 'tones' || g.group === 'paper')).toBe(false);
  });

  it('every generator name is its FX_NAMES entry, and FX_NAMES names exactly the registered generators', () => {
    for (const g of FX_GENERATORS) {
      expect(g.name, `${g.gen}@${g.v}`).toBe(FX_NAMES[g.gen]);
      expect(fxName(g)).toBe(g.name);
    }
    expect(Object.keys(FX_NAMES).sort()).toEqual([...new Set(FX_GENERATORS.map((g) => g.gen))].sort());
    // The PE-0 words still read the same.
    expect([fxName({ gen: 'speed-lines', v: 1 }), fxName({ gen: 'focus-lines', v: 9 }), fxName({ gen: 'future-gen', v: 1 })]).toEqual(['Speed lines', 'Focus lines', 'Future gen']);
  });

  it('schemas are well formed: keys, kinds, ranges, defaults inside them, at most FX_LIMITS.paramsPerFx parameters', () => {
    for (const g of FX_GENERATORS) {
      const entries = Object.entries(g.params);
      expect(entries.length, g.gen).toBeLessThanOrEqual(FX_LIMITS.paramsPerFx);
      for (const [key, spec] of entries) {
        const at = `${g.gen}.${key}`;
        expect(FX_PARAM_KEY_RE.test(key), at).toBe(true);
        expect(typeof spec.label === 'string' && spec.label.length > 0, at).toBe(true);
        if (spec.kind === 'number') {
          expect(spec.min < spec.max, at).toBe(true);
          expect(spec.default >= spec.min && spec.default <= spec.max, at).toBe(true);
          if (spec.int) expect([spec.min, spec.max, spec.default].every(Number.isInteger), at).toBe(true);
        } else if (spec.kind === 'enum') {
          expect(spec.values.length >= 2 && spec.values.includes(spec.default), at).toBe(true);
          expect(spec.values.every((v) => v.length <= FX_LIMITS.paramTextChars), at).toBe(true);
        } else if (spec.kind === 'color') expect(spec.default, at).toMatch(/^#[0-9a-f]{6}$/);
      }
      // The defaults are exactly what the schema check keeps.
      expect(fxParamsOf(g, fxDefaultsOf(g)), g.gen).toEqual(fxDefaultsOf(g));
    }
    expect(fxGeneratorOf('emanata', 1)!.params.symbol).toMatchObject({ values: FX_EMANATA_SYMBOLS });
    expect(FX_EMANATA_SYMBOLS).toHaveLength(12);
    expect(fxGeneratorOf('frame-border', 1)!.params.style).toMatchObject({ values: FX_BORDER_STYLES });
    expect(FX_BORDER_STYLES).toHaveLength(10);
  });

  it('the largest effect any schema allows stays within FX_LIMITS.fxBytes (1 KB)', () => {
    for (const g of FX_GENERATORS) {
      // Every number at its longest (negative, four decimals), the longest enum value, the most negative seed.
      const params = Object.fromEntries(
        Object.entries(g.params).map(([k, s]) => [
          k,
          s.kind === 'number' ? (s.int ? -Math.max(Math.abs(s.min), Math.abs(s.max)) : -(Math.max(Math.abs(s.min), Math.abs(s.max)) - 0.0001)) : s.kind === 'enum' ? [...s.values].sort((a, b) => b.length - a.length)[0] : s.kind === 'color' ? '#ffffff' : false
        ])
      );
      const fx = { gen: g.gen, v: 9999, seed: -2147483648, params };
      expect(JSON.stringify(fx).length, g.gen).toBeLessThanOrEqual(FX_LIMITS.fxBytes);
      expect(fxWithinBudget(fx), g.gen).toBe(true);
    }
  });
});

describe('fx registry: renderFx loading seam, budget helpers', () => {
  it('draws nothing until fx/generators.ts is loaded, then draws (renderFx stays synchronous)', async () => {
    const fxs = FX_GENERATORS.map((g) => defaultFx(g.gen, g.v));
    for (const fx of fxs) {
      expect(fxCanDraw(fx), fx.gen).toBe(false);
      expect(renderFx(fx, { aspect: 1 }), fx.gen).toEqual([]);
    }
    await import('./generators');
    for (const fx of fxs) {
      expect(fxCanDraw(fx), fx.gen).toBe(true);
      expect(renderFx(fx, { aspect: 1 }).length, fx.gen).toBeGreaterThan(0);
    }
    // Unknown generators and versions stay inert.
    expect(renderFx({ gen: 'future-gen', v: 1, seed: 1, params: {} }, { aspect: 1 })).toEqual([]);
    expect(renderFx({ gen: 'burst', v: 2, seed: 1, params: {} }, { aspect: 1 })).toEqual([]);
    expect(renderFx(undefined as unknown as LayerFx, { aspect: 1 })).toEqual([]);
  });

  it('refuses to register a drawing for a version the registry does not hold', () => {
    expect(() => registerFxDraw('future-gen', 1, () => [])).toThrow(/not a registered generator/);
    expect(() => registerFxDraw('burst', 2, () => [])).toThrow(/not a registered generator/);
  });

  it('counts segments (each path command but M; rect and circle 4) and normalizes the aspect', () => {
    expect(fxSegmentsOf([{ tag: 'path', d: 'M0 0L1 0Q0.5 0.5 1 1C0 0 0 0 0 1Z' }, { tag: 'rect', x: 0, y: 0, w: 1, h: 1 }, { tag: 'circle', cx: 0.5, cy: 0.5, r: 0.1 }])).toBe(12);
    expect([fxAspectOf({ aspect: 1.23456 }), fxAspectOf({ aspect: 0 }), fxAspectOf({ aspect: NaN }), fxAspectOf(undefined), fxAspectOf({ aspect: 1e9 }), fxAspectOf({ aspect: 1e-9 })]).toEqual([1.235, 1, 1, 1, 20, 0.05]);
  });
});

describe('fx registry: generator code never follows into the shared barrel', () => {
  /** Pro effect code: the drawings and their helpers. Only fx/generators.ts imports them (the lazy Pro chunk). */
  const PRO_MODULES = ['generators', 'draw', 'lines', 'bursts', 'emanata', 'atmosphere', 'borders'].map((m) => normalize(join(here, `${m}.ts`)));
  const GENERATOR_MODULES = [...PRO_MODULES, normalize(join(here, 'seed.ts'))];
  /** Every module specifier a file names: import / export … from (type-only included), side-effect and dynamic imports. */
  const importsOf = (file: string): string[] => {
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const out: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) out.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
  };
  const resolveRel = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith('.')) return undefined;
    const base = normalize(join(dirname(from), spec)).replace(/\.js$/, '');
    for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      try {
        readFileSync(cand);
        return cand;
      } catch {
        /* next */
      }
    }
    return undefined;
  };

  it('the barrel carries schemas, not presets or drawings (those load with fx/generators.ts, in the Pro chunk)', () => {
    for (const name of ['FX_PRESETS', 'fxFromPreset', 'fxPresetOf', 'FX_DRAW_FNS', 'registerFxGenerators']) expect(name in fxBarrel, name).toBe(false);
    for (const name of ['FX_GENERATORS', 'renderFx', 'fxParamsOf', 'fxGeneratorOf', 'FX_NAMES']) expect(name in fxBarrel, name).toBe(true);
  });

  it('registry.ts and names.ts import only types, names and limits (static or dynamic)', () => {
    expect(importsOf(join(here, 'registry.ts')).sort()).toEqual(['../limits.js', './names.js', './types.js']);
    expect(importsOf(join(here, 'names.ts'))).toEqual(['./types.js']);
    expect(importsOf(join(here, 'index.ts')).sort()).toEqual(['../limits.js', './names.js', './registry.js', './registry.js', './types.js', './types.js'].sort());
  });

  /** Every module reachable from `start` through relative imports (static, type-only, side-effect and dynamic). */
  const reachable = (start: string): Set<string> => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      const file = queue.pop()!;
      for (const spec of importsOf(file)) {
        const target = resolveRel(file, spec);
        if (target && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    return seen;
  };

  it('no module the shared barrel (shared/comic/index.ts) reaches imports a generator module', () => {
    const seen = reachable(normalize(join(here, '..', 'index.ts')));
    expect(seen.has(normalize(join(here, 'registry.ts')))).toBe(true);
    expect([...seen].filter((f) => GENERATOR_MODULES.includes(f)).map((f) => relative(here, f))).toEqual([]);
  });

  it('the library textures shim (the reader page mat, the library thumbnails) reaches fx/seed.ts only, never Pro effect code', () => {
    // Rollup splits by module, not by function: a Pro helper in a module the shim reaches ships to every reader.
    const library = normalize(join(here, '..', '..', '..', 'components', 'comicstudio', 'library', 'procedural'));
    const inFx = (files: Set<string>) => [...files].filter((f) => f.startsWith(here + sep)).map((f) => relative(here, f)).sort();
    expect(inFx(reachable(join(library, 'textures.ts')))).toEqual(['seed.ts']);
    expect(importsOf(join(here, 'seed.ts'))).toEqual([]);
    // PresetThumb (StyleTab, StylePanel, OptionsCard, LibraryImage) also reaches the schemas through stylePresets, never a drawing.
    const thumb = reachable(join(library, 'PresetThumb.tsx'));
    expect(thumb.has(normalize(join(library, 'textures.ts')))).toBe(true);
    expect([...thumb].filter((f) => PRO_MODULES.includes(f)).map((f) => relative(here, f))).toEqual([]);
  });
});
