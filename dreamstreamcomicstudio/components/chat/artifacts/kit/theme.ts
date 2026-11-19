// Shared colour system for rich-output components. One palette/accent prop drives
// every card so the AI (and the gallery) can recolour a component without touching
// its markup. Every colour here is a design token (docs/design/design-system.md,
// "Colour layer"), so the cards follow light and dark and the skin:
// - series take the seven hues in CHART_HUE_ORDER (ultramarine, magenta, leaf, sky first,
//   the order that stays apart for colour-blind readers); the mono palette takes the ink steps;
// - the accent is the ink, or one hue by slot for a named palette;
// - up / down / neutral are the readable status inks (cards use them for words as much as
//   for lines, so they read at 4.5:1 on every surface).
// A colour the model supplies on one series (`s.color`) is content and is kept as given.

import { CHART_HUE_ORDER } from '../../studioDesign';

export type PaletteName =
  | 'brand'
  | 'bull'
  | 'bear'
  | 'ocean'
  | 'sunset'
  | 'violet'
  | 'mono';

export interface Palette {
  /** Primary accent (lines, fills, active controls). */
  accent: string;
  /** Multi-series ramp for charts with more than one line/bar. */
  series: string[];
}

/** Up / down / flat: the readable status inks (words, icons and marks alike). */
export const BULL = 'var(--ds-success-text)';
export const BEAR = 'var(--ds-danger-text)';
export const NEUTRAL = 'var(--ds-muted)';

/** The hue token for a 1-based slot. */
const hue = (slot: number) => `var(--ds-hue-${slot})`;
/** The categorical series, in the colour-blind-safe chart order. */
const CATEGORICAL: string[] = CHART_HUE_ORDER.map(hue);
/** The same order, starting at a given slot (a named palette leads with its own hue). */
const leadingWith = (slot: number): string[] => [hue(slot), ...CATEGORICAL.filter((c) => c !== hue(slot))];
/** The monochrome ink steps (tiers, ordinal data, a calm card). */
const INK_STEPS = [1, 2, 3, 4, 5].map((n) => `var(--ds-chart-${n})`);

export const PALETTES: Record<PaletteName, Palette> = {
  brand: { accent: 'var(--ds-ink)', series: CATEGORICAL },
  bull: { accent: BULL, series: CATEGORICAL },
  bear: { accent: BEAR, series: CATEGORICAL },
  ocean: { accent: hue(7), series: leadingWith(7) },
  sunset: { accent: hue(2), series: leadingWith(2) },
  violet: { accent: hue(5), series: leadingWith(5) },
  mono: { accent: 'var(--ds-ink)', series: INK_STEPS }
};

export interface ThemeInput {
  /** A named palette. Defaults to brand. */
  palette?: PaletteName;
  /** Explicit accent hex, overrides the palette accent. */
  accent?: string;
  /** When given, picks bull/bear automatically from the sign (used by finance). */
  trend?: number;
}

export interface ResolvedTheme {
  accent: string;
  series: string[];
  up: string;
  down: string;
  neutral: string;
}

/** Resolve a {palette, accent, trend} into concrete colors. */
export const resolveTheme = (input: ThemeInput = {}): ResolvedTheme => {
  // The model supplies `palette` as a free string, so an out-of-set name (or a typo)
  // must NOT crash the card — fall back to brand instead of throwing on `base.accent`.
  const base = PALETTES[input.palette as PaletteName] ?? PALETTES.brand;
  let accent = input.accent ?? base.accent;
  if (typeof input.trend === 'number') {
    accent = input.trend > 0 ? BULL : input.trend < 0 ? BEAR : NEUTRAL;
  }
  return { accent, series: base.series, up: BULL, down: BEAR, neutral: NEUTRAL };
};

/**
 * A translucent version of a colour, for chart area fills and soft tints. A hex is mixed
 * to rgba as before; a token or any other CSS colour (`var(--ds-hue-2)`) is mixed with
 * color-mix, so a tint never needs a hex.
 */
export const withAlpha = (color: string, alpha: number): string => {
  const a = Math.max(0, Math.min(1, alpha));
  const m = color.trim().replace(/^#/, '');
  if (color.trim().startsWith('#') && /^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(m)) {
    const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(a * 1000) / 10}%, transparent)`;
};
