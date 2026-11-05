// The effect generator registry (master plan §2.3, §2.6). STUB with fixed export names (PE-0): PE-FX fills
// FX_GENERATORS (36 S2 entries: lines, bursts, emanata, atmosphere, borders) and renderFx; PE-TONES adds tones and
// paper. Registered versions are never removed or changed (a stored effect must draw the same forever).
//
// Rules for PE-FX:
// - every module this file imports: types only from doc.ts (a value import back into doc.ts would be a cycle);
// - each FxGenerator.name is FX_NAMES[gen] (fx/names.ts, metadata only), which the editor scene and History read;
// - keep generator implementations out of this file's static imports: the shared barrel (`comic.fx`) re-exports it, so
//   renderFx dispatches through a lazily imported module (§2.6 "Generators … go in a lazy pro-editor chunk").

import type { FxDrawContext, FxGenerator, FxNode, LayerFx } from './types.js';

/** Every registered generator version. Empty until PE-FX: no effect is drawn and the server accepts none. */
export const FX_GENERATORS: readonly FxGenerator[] = [];

/** The registered generator for `gen@v`, or undefined (unknown: the effect is kept but draws nothing). */
export const fxGeneratorOf = (gen: string, v: number): FxGenerator | undefined => FX_GENERATORS.find((g) => g.gen === gen && g.v === v);

/** The newest registered version of `gen` (what a new effect is created with), or undefined. */
export const latestFxGenerator = (gen: string): FxGenerator | undefined =>
  FX_GENERATORS.filter((g) => g.gen === gen).reduce<FxGenerator | undefined>((best, g) => (!best || g.v > best.v ? g : best), undefined);

/**
 * What an effect draws, in its layer's 0..1 box: deterministic (same fx gives byte-identical nodes), paths, circles and
 * rects only, ≤ FX_LIMITS.segmentsMax segments. Stub: draws nothing for every effect.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const renderFx = (fx: LayerFx, ctx: FxDrawContext): FxNode[] => [];
