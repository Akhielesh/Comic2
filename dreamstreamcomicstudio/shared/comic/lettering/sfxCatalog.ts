import { scriptOf } from '../languages.js';
import { DRAWN_PRO_SFX_EFFECTS, SFX_EFFECTS, type AnySfxEffect, type LetterStylePatch, type SfxEffect } from './style.js';

export type DrawnSfxEffect = Exclude<AnySfxEffect, 'halftone_fill'>;

interface SfxStyle {
  label: string;
  description: string;
  needsGlyphs?: true;
}

const STYLES: Record<DrawnSfxEffect, SfxStyle> = {
  filled_stroke: { label: 'Filled', description: 'Solid letters with an outline for impacts.' },
  outlined: { label: 'Outlined', description: 'White letters with a heavier dark outline for a manga look.' },
  shadow: { label: 'Shadow', description: 'An offset shadow adds depth to heavy sounds.' },
  skewed: { label: 'Skewed', description: 'Slanted lettering suggests fast movement.' },
  arched: { label: 'Arched', description: 'A curved baseline follows a sweeping sound.', needsGlyphs: true },
  pop: { label: 'Pop', description: 'Letters grow across the word for a playful accent.', needsGlyphs: true },
  extrude3d: { label: '3D extrude', description: 'Layered depth for a heavy impact.' },
  outline_stack: { label: 'Stacked outline', description: 'Three outlines help separate lettering from busy artwork.' },
  wobble: { label: 'Wobble', description: 'Uneven letters suggest a tremor or a shiver.', needsGlyphs: true },
  shatter: { label: 'Shatter', description: 'Split lettering for a crack or break.' },
  gradient: { label: 'Gradient', description: 'A two-tone fill gives lettering depth.' }
};

export const sfxStyleOf = (id: DrawnSfxEffect): SfxStyle => STYLES[id];

/** Use the renderer's shipped IDs; storage may also contain effects a client cannot write or draw. */
export const sfxStyleIds = (allowPro = false): readonly DrawnSfxEffect[] =>
  allowPro ? [...SFX_EFFECTS, ...DRAWN_PRO_SFX_EFFECTS] : SFX_EFFECTS;

export const sfxStyleSupports = (id: DrawnSfxEffect, lang?: string): boolean =>
  !sfxStyleOf(id).needsGlyphs || scriptOf(lang).allowLetterSpacing;

/** An explicit choice supplies enough styling to show the effect. Existing documents keep their stored fields. */
export function sfxStylePatch(id: DrawnSfxEffect, current: Pick<LetterStylePatch, 'arc' | 'shadow' | 'textStroke'>): LetterStylePatch {
  // The write sanitizer handles Pro IDs. Stored LetterStyle keeps the base union for older clients.
  const sfxEffect = id as SfxEffect;
  switch (id) {
    case 'filled_stroke':
      return { sfxEffect, textColor: 'auto', textStroke: current.textStroke ?? { color: '#111111', width: 0.12 } };
    case 'outlined':
      return { sfxEffect, textColor: '#ffffff', textStroke: { color: '#111111', width: 0.14 } };
    case 'shadow':
      return { sfxEffect, shadow: current.shadow ?? { color: '#111111', dx: 0.08, dy: 0.08 } };
    case 'arched':
      return { sfxEffect, ...(Math.abs(current.arc ?? 0) < 0.05 ? { arc: 0.4 } : {}) };
    default:
      return { sfxEffect };
  }
}
