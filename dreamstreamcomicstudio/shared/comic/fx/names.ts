// Effect names: metadata only (master plan §2.3, §2.6, §2.12). PE-0 contract; dependency-free (types only).
//
// The editor scene and History (server and client) name an effect ("Speed lines", "Added speed lines") through THIS
// file, never through fx/index.ts or fx/registry.ts. When PE-FX fills the registry and renderFx, no generator code
// (lines, bursts, emanata, …) follows into the editor scene or History: generators stay in the lazy Pro chunk (§2.6).
// One entry per generator id (PE-FX), and each FxGenerator.name equals FX_NAMES[gen] (the contract tests hold it).

import type { LayerFx } from './types.js';

/** gen → plain words ("speed-lines" → "Speed lines"), one entry per registered generator (PE-FX); a gen without an
 *  entry (a newer build's) reads as its id. History lower-cases the first letter: "Added speed lines". */
export const FX_NAMES: Readonly<Record<string, string>> = Object.freeze({
  // lines
  'speed-lines': 'Speed lines',
  'focus-lines': 'Focus lines',
  // bursts
  burst: 'Burst',
  sunburst: 'Sunburst',
  explosion: 'Explosion',
  'shock-rings': 'Shock rings',
  // emanata
  emanata: 'Expression marks',
  // atmosphere
  rain: 'Rain',
  snow: 'Snow',
  petals: 'Falling petals',
  bokeh: 'Bokeh lights',
  sparkle: 'Sparkles',
  smoke: 'Smoke',
  // borders
  'frame-border': 'Frame border'
});

/** "Speed lines": the generator's name, else the id in words ('speed-lines' → "Speed lines"), else "Effect". */
export const fxName = (fx: Pick<LayerFx, 'gen' | 'v'> | undefined): string => {
  const gen = typeof fx?.gen === 'string' ? fx.gen : '';
  const known = gen && Object.prototype.hasOwnProperty.call(FX_NAMES, gen) ? FX_NAMES[gen] : undefined;
  if (known) return known;
  const words = gen.replace(/-/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Effect';
};
