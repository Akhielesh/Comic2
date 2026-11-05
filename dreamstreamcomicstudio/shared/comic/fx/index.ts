// Pro Edit effects (master plan §2.3, §2.6). PE-0 contract: the stored shape (types.ts), the registry seam
// (registry.ts, filled by PE-FX) and the parameter check every reader shares. Pure; no imports from doc.ts.

export * from './types.js';
export * from './registry.js';
import { FX_LIMITS } from '../limits.js';
import { fxGeneratorOf } from './registry.js';
import type { FxGenerator, FxParamValue, LayerFx } from './types.js';

const HEX6 = /^#[0-9a-fA-F]{6}$/;

/**
 * An effect's parameters checked against its generator's schema: numbers clamped to their range (rounded when the
 * spec is an integer), enums and colours ('#RRGGBB') kept only when valid, booleans only when boolean, unknown keys
 * dropped, and every missing parameter filled with its default. The server sanitizer refuses what this would change;
 * generators read the result, so a stored value out of range still draws inside the schema.
 */
export const fxParamsOf = (generator: Pick<FxGenerator, 'params'>, raw: unknown): Record<string, FxParamValue> => {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, FxParamValue> = {};
  for (const [key, spec] of Object.entries(generator.params)) {
    const v = Object.prototype.hasOwnProperty.call(given, key) ? given[key] : undefined;
    switch (spec.kind) {
      case 'number': {
        if (typeof v === 'number' && Number.isFinite(v)) {
          const clamped = Math.min(spec.max, Math.max(spec.min, v));
          out[key] = spec.int ? Math.round(clamped) : Math.round(clamped * 10000) / 10000;
        } else out[key] = spec.default;
        break;
      }
      case 'enum':
        out[key] = typeof v === 'string' && spec.values.includes(v) ? v : spec.default;
        break;
      case 'color':
        out[key] = typeof v === 'string' && HEX6.test(v) ? v : spec.default;
        break;
      case 'bool':
        out[key] = typeof v === 'boolean' ? v : spec.default;
        break;
    }
  }
  return out;
};

/** The effect's generator, when this build has `gen@v` (undefined: kept, never drawn). */
export const fxGeneratorFor = (fx: Pick<LayerFx, 'gen' | 'v'> | undefined): FxGenerator | undefined =>
  fx && typeof fx.gen === 'string' && typeof fx.v === 'number' ? fxGeneratorOf(fx.gen, fx.v) : undefined;

/** "Speed lines": the generator's name, else the id in words ('speed-lines' → "Speed lines"), else "Effect". */
export const fxName = (fx: Pick<LayerFx, 'gen' | 'v'> | undefined): string => {
  const known = fxGeneratorFor(fx)?.name;
  if (known) return known;
  const words = typeof fx?.gen === 'string' ? fx.gen.replace(/-/g, ' ').trim() : '';
  return words ? words[0].toUpperCase() + words.slice(1) : 'Effect';
};

/** The stored effect is within its byte budget (FX_LIMITS.fxBytes). */
export const fxWithinBudget = (fx: unknown): boolean => {
  try {
    return JSON.stringify(fx ?? null).length <= FX_LIMITS.fxBytes;
  } catch {
    return false;
  }
};
