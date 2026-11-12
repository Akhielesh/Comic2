// The S2 effect generators (master plan §2.6, §2.12 PE-FX; collisions B-7): importing this module registers the
// drawing of every generator in FX_GENERATORS, so renderFx (fx/registry.ts) draws them. Only the Pro editor and the
// compose path import it (one import each); the shared barrel never does, so generator code stays out of the server,
// the editor scene, History and every bundle that does not draw effects. Until it is imported, renderFx returns [].
//
// Every registered drawing reads its parameters through fxParamsOf (fx/index.ts): a stored value out of the schema's
// range, of the wrong kind or missing draws as the clamped value or the default (PE-0 risk 2: players clamp at draw time).

import { fxParamsOf } from './index.js';
import { fxGeneratorOf, registerFxDraw, type FxDraw } from './registry.js';
import type { FxDrawFn } from './seed.js';
import { drawFocusLines, drawSpeedLines } from './lines.js';
import { drawBurst, drawExplosion, drawShockRings, drawSunburst } from './bursts.js';
import { drawEmanata } from './emanata.js';
import { drawBokeh, drawPetals, drawRain, drawSmoke, drawSnow, drawSparkle } from './atmosphere.js';
import { drawFrameBorder } from './borders.js';

/** The pure drawings by `gen@v`, before the schema check (tests and tools call them with checked parameters). */
export const FX_DRAW_FNS: Readonly<Record<string, FxDrawFn>> = Object.freeze({
  'speed-lines@1': drawSpeedLines,
  'focus-lines@1': drawFocusLines,
  'burst@1': drawBurst,
  'sunburst@1': drawSunburst,
  'explosion@1': drawExplosion,
  'shock-rings@1': drawShockRings,
  'emanata@1': drawEmanata,
  'rain@1': drawRain,
  'snow@1': drawSnow,
  'petals@1': drawPetals,
  'bokeh@1': drawBokeh,
  'sparkle@1': drawSparkle,
  'smoke@1': drawSmoke,
  'frame-border@1': drawFrameBorder
});

/** The registered drawing of `gen@v`: the schema check, then the pure drawing. */
export const fxDrawFor = (key: string): FxDraw => {
  const [gen, v] = [key.slice(0, key.lastIndexOf('@')), Number(key.slice(key.lastIndexOf('@') + 1))];
  const generator = fxGeneratorOf(gen, v);
  const fn = FX_DRAW_FNS[key];
  if (!generator || !fn) throw new Error(`fx: no generator ${key}`);
  return (fx, ctx) => fn(fxParamsOf(generator, fx.params), fx.seed | 0, ctx.aspect);
};

/** Registers every S2 drawing (idempotent). Called once when this module loads. */
export const registerFxGenerators = (): void => {
  for (const key of Object.keys(FX_DRAW_FNS)) {
    const at = key.lastIndexOf('@');
    registerFxDraw(key.slice(0, at), Number(key.slice(at + 1)), fxDrawFor(key));
  }
};

registerFxGenerators();

/** True once this module has run (a value to import where a bare side-effect import would read oddly). */
export const FX_GENERATORS_LOADED = true;
