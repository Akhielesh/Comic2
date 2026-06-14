import { useEffect, useState } from 'react';
import { BULL, BEAR } from '../theme';

// Canvas can't read CSS variables, so a themed game has to resolve the `--ds-*`
// tokens to concrete color strings and re-read them whenever the user flips between
// the light and Claude-style dark themes (toggled by a `dark` class on <html> via
// services/theme.ts). This hook returns a ready-to-use palette for ctx.fillStyle,
// keeping every game faithful to the calm-glass house colors in both themes.

export interface GameColors {
  /** Opaque playfield background (the recessed board). */
  board: string;
  ink: string;
  muted: string;
  faint: string;
  hairline: string;
  well: string;
  raised: string;
  /** Terracotta brand accent — the player / active element. */
  accent: string;
  up: string;
  down: string;
  /** A calm multi-hue ramp (theme-invariant) for bricks, tiles and food. */
  ramp: string[];
}

const RAMP = ['#3B82F6', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4'];

const read = (el: HTMLElement | null): GameColors => {
  const root = el ?? (typeof document !== 'undefined' ? document.documentElement : null);
  const cs = root ? getComputedStyle(root) : null;
  const v = (name: string, fallback: string) => (cs?.getPropertyValue(name).trim() || fallback);
  return {
    board: v('--ds-canvas', '#FAF9F5'),
    ink: v('--ds-ink', '#1a1915'),
    muted: v('--ds-muted', '#6e6a60'),
    faint: v('--ds-faint', 'rgba(0,0,0,0.28)'),
    hairline: v('--ds-hairline', 'rgba(0,0,0,0.10)'),
    well: v('--ds-well', 'rgba(0,0,0,0.03)'),
    raised: v('--ds-raised', '#ffffff'),
    accent: v('--ds-accent', '#D97757'),
    up: BULL,
    down: BEAR,
    ramp: RAMP
  };
};

/** Live `--ds-*` palette for canvas drawing; re-reads on light/dark theme flips. */
export const useThemeColors = (el?: HTMLElement | null): GameColors => {
  const [colors, setColors] = useState<GameColors>(() => read(el ?? null));

  useEffect(() => {
    setColors(read(el ?? null));
    if (typeof document === 'undefined') return;
    // The theme toggle adds/removes `dark` on <html>; re-resolve when it changes.
    const obs = new MutationObserver(() => setColors(read(el ?? null)));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => obs.disconnect();
  }, [el]);

  return colors;
};
