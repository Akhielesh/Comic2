// Shared color system for rich-output components. One palette/accent prop drives
// every card so the AI (and the gallery) can recolor a component without touching
// its markup. Palettes resolve to a single `accent` plus a multi-series ramp for
// charts. Keep these in sync with tailwind.config.cjs brand tokens.

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

/** Canonical up/down colors, matched to the existing StockCard. */
export const BULL = '#059669';
export const BEAR = '#dc2626';
export const NEUTRAL = '#64748b';

export const PALETTES: Record<PaletteName, Palette> = {
  brand: { accent: '#3B82F6', series: ['#3B82F6', '#EF4444', '#FACC15', '#10b981', '#8b5cf6'] },
  bull: { accent: BULL, series: [BULL, '#0ea5e9', '#84cc16', '#14b8a6'] },
  bear: { accent: BEAR, series: [BEAR, '#f97316', '#ec4899', '#f59e0b'] },
  ocean: { accent: '#0ea5e9', series: ['#0ea5e9', '#6366f1', '#06b6d4', '#3b82f6'] },
  sunset: { accent: '#f97316', series: ['#f97316', '#ef4444', '#f59e0b', '#ec4899'] },
  violet: { accent: '#8b5cf6', series: ['#8b5cf6', '#6366f1', '#a855f7', '#d946ef'] },
  mono: { accent: '#334155', series: ['#334155', '#64748b', '#94a3b8', '#cbd5e1'] }
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
  const base = PALETTES[input.palette ?? 'brand'];
  let accent = input.accent ?? base.accent;
  if (typeof input.trend === 'number') {
    accent = input.trend > 0 ? BULL : input.trend < 0 ? BEAR : NEUTRAL;
  }
  return { accent, series: base.series, up: BULL, down: BEAR, neutral: NEUTRAL };
};

/** A translucent version of a hex color, for chart area fills. */
export const withAlpha = (hex: string, alpha: number): string => {
  const m = hex.replace('#', '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};
