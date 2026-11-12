// Test fixtures for the effect generators (PE-FX): parameter sets per generator (defaults, every bound, every enum
// value, seeded random sets), path parsing and curve sampling. Imported by tests only.

import type { FxGenerator, FxNode, FxParamValue, LayerFx } from './types';
import { fxDefaultsOf } from './registry';

/** A deterministic stream for random parameter sets (independent of the generators' own). */
const lcg = (seed: number) => {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

/** Every number at `which` bound (or the default), every enum, colour and flag at its default. */
export const atBound = (g: FxGenerator, which: 'min' | 'max'): Record<string, FxParamValue> =>
  Object.fromEntries(Object.entries(g.params).map(([k, s]) => [k, s.kind === 'number' ? s[which] : s.kind === 'bool' ? (which === 'max' ? !s.default : s.default) : s.default]));

/** Parameter sets covering a generator: defaults, both bounds, each enum value at each bound, `random` seeded sets. */
export const paramSets = (g: FxGenerator, random = 12): Record<string, FxParamValue>[] => {
  const sets: Record<string, FxParamValue>[] = [fxDefaultsOf(g), atBound(g, 'min'), atBound(g, 'max')];
  for (const [key, spec] of Object.entries(g.params)) {
    if (spec.kind !== 'enum') continue;
    for (const v of spec.values) sets.push({ ...fxDefaultsOf(g), [key]: v }, { ...atBound(g, 'min'), [key]: v }, { ...atBound(g, 'max'), [key]: v });
  }
  const rand = lcg(g.gen.length * 7919 + g.v);
  for (let i = 0; i < random; i += 1) {
    sets.push(
      Object.fromEntries(
        Object.entries(g.params).map(([k, s]) => {
          if (s.kind === 'number') {
            const v = s.min + rand() * (s.max - s.min);
            return [k, s.int ? Math.round(v) : Math.round(v * 10000) / 10000];
          }
          if (s.kind === 'enum') return [k, s.values[Math.floor(rand() * s.values.length)]];
          if (s.kind === 'bool') return [k, rand() < 0.5];
          return [k, `#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')}`];
        })
      )
    );
  }
  return sets;
};

export const ASPECTS = [0.25, 0.6, 1, 1.6, 4] as const;
export const SEEDS = [1, -7, 2147483647] as const;

export const fxOf = (g: Pick<FxGenerator, 'gen' | 'v'>, params: Record<string, FxParamValue>, seed = 1): LayerFx => ({ gen: g.gen, v: g.v, seed, params });

/** A path's commands as [letter, numbers]. */
export const commandsOf = (d: string): [string, number[]][] =>
  [...d.matchAll(/([A-Za-z])([^A-Za-z]*)/g)].map((m) => [m[1], m[2].trim() ? m[2].trim().split(/[\s,]+/).map(Number) : []]);

/** On-curve points of a path: every end point, and samples along each quadratic and cubic. */
export const curvePoints = (node: FxNode): { ends: [number, number][]; samples: [number, number][] } => {
  if (node.tag !== 'path') {
    if (node.tag === 'rect') return { ends: [[node.x, node.y], [node.x + node.w, node.y + node.h]], samples: [] };
    return { ends: [[node.cx - node.r, node.cy - node.r], [node.cx + node.r, node.cy + node.r]], samples: [] };
  }
  const ends: [number, number][] = [];
  const samples: [number, number][] = [];
  let cur: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];
  for (const [c, v] of commandsOf(node.d)) {
    if (c === 'M' || c === 'L') {
      cur = [v[0], v[1]];
      if (c === 'M') start = cur;
      ends.push(cur);
    } else if (c === 'Q') {
      for (const t of [0.25, 0.5, 0.75]) {
        const u = 1 - t;
        samples.push([u * u * cur[0] + 2 * u * t * v[0] + t * t * v[2], u * u * cur[1] + 2 * u * t * v[1] + t * t * v[3]]);
      }
      cur = [v[2], v[3]];
      ends.push(cur);
    } else if (c === 'C') {
      for (const t of [0.25, 0.5, 0.75]) {
        const u = 1 - t;
        samples.push([
          u * u * u * cur[0] + 3 * u * u * t * v[0] + 3 * u * t * t * v[2] + t * t * t * v[4],
          u * u * u * cur[1] + 3 * u * u * t * v[1] + 3 * u * t * t * v[3] + t * t * t * v[5]
        ]);
      }
      cur = [v[4], v[5]];
      ends.push(cur);
    } else if (c === 'Z') cur = start;
  }
  return { ends, samples };
};
