// Effect names: metadata only (master plan §2.3, §2.6, §2.12). PE-0 contract; dependency-free (types only).
//
// The editor scene and History (server and client) name an effect ("Speed lines", "Added speed lines") through THIS
// file, never through fx/index.ts or fx/registry.ts. When PE-FX fills the registry and renderFx, no generator code
// (lines, bursts, emanata, …) follows into the editor scene or History: generators stay in the lazy Pro chunk (§2.6).
// PE-FX adds one entry per generator id here, and each FxGenerator.name equals FX_NAMES[gen] (a contract test holds it).

import type { LayerFx } from './types.js';

/** gen → plain words ("speed-lines" → "Speed lines"). Empty until PE-FX; a gen without an entry reads as its id. */
export const FX_NAMES: Readonly<Record<string, string>> = Object.freeze({});

/** "Speed lines": the generator's name, else the id in words ('speed-lines' → "Speed lines"), else "Effect". */
export const fxName = (fx: Pick<LayerFx, 'gen' | 'v'> | undefined): string => {
  const gen = typeof fx?.gen === 'string' ? fx.gen : '';
  const known = gen && Object.prototype.hasOwnProperty.call(FX_NAMES, gen) ? FX_NAMES[gen] : undefined;
  if (known) return known;
  const words = gen.replace(/-/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Effect';
};
