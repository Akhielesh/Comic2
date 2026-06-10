/** Appearance: theme / accent / density / corners — persisted, applied to <html>. */

export type Theme = 'light' | 'dark';
export type Density = 'calm' | 'pro';
export type Corners = 'soft' | 'sharp';
export type StudioLayout = 'chat-right' | 'chat-left' | 'cinema';

export interface Appearance {
  theme: Theme;
  accent: string;
  density: Density;
  corners: Corners;
  studioLayout: StudioLayout;
}

interface AccentDef {
  label: string;
  sw: string;
  l: { a: string; a2: string; ink: string; wash: string };
  d: { a: string; a2: string; ink: string; wash: string };
}

export const ACCENTS: Record<string, AccentDef> = {
  clay:  { label: 'Clay',  sw: '#c2603f', l: { a: '#c2603f', a2: '#d8795a', ink: '#a64e30', wash: '#f3e3d8' }, d: { a: '#d8795a', a2: '#e08a6d', ink: '#e89c80', wash: '#3a2c25' } },
  sage:  { label: 'Sage',  sw: '#5f7d4f', l: { a: '#5f7d4f', a2: '#6f9159', ink: '#4d6740', wash: '#e6ecdc' }, d: { a: '#86a86f', a2: '#95b87d', ink: '#9cc081', wash: '#2d3526' } },
  slate: { label: 'Slate', sw: '#4f6f96', l: { a: '#4f6f96', a2: '#5f80a8', ink: '#3f5c80', wash: '#e0e7f0' }, d: { a: '#7d9dc2', a2: '#8eaecf', ink: '#9bb6d4', wash: '#283440' } },
  plum:  { label: 'Plum',  sw: '#7d5577', l: { a: '#7d5577', a2: '#916589', ink: '#684463', wash: '#efe4ed' }, d: { a: '#b288a8', a2: '#c098b6', ink: '#c7a3bd', wash: '#352a33' } },
};

/** Cover-theme gradients shared by the create form, invite page and join gate. */
export const COVER_THEMES: [string, string][] = [
  ['#c2603f', '#8a4a2f'], ['#4f7396', '#37536f'], ['#5f8a5a', '#3f6b3c'],
  ['#7d5577', '#553a52'], ['#b5832c', '#7d5a1c'], ['#3d3a35', '#1f1c19'],
];

export const coverGradient = (i: number): string => {
  const c = COVER_THEMES[Math.min(COVER_THEMES.length - 1, Math.max(0, i))] || COVER_THEMES[0];
  return `linear-gradient(135deg, ${c[0]}, ${c[1]})`;
};

const KEY = 'ds-live-appearance';

const DEFAULTS: Appearance = { theme: 'light', accent: 'clay', density: 'calm', corners: 'soft', studioLayout: 'chat-right' };

export function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    // Migrate the old single-key theme setting if present.
    const legacy = localStorage.getItem('ds-live-theme');
    const parsed = raw ? (JSON.parse(raw) as Partial<Appearance>) : {};
    return { ...DEFAULTS, ...(legacy && !raw ? { theme: legacy === 'light' ? 'light' : 'dark' } : {}), ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppearance(a: Appearance): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* storage unavailable (private mode) */
  }
}

/** Writes theme/accent/density/corners onto <html> as data-attrs + CSS vars. */
export function applyAppearance(a: Appearance): void {
  const el = document.documentElement;
  el.setAttribute('data-theme', a.theme);
  el.setAttribute('data-density', a.density);
  el.setAttribute('data-corners', a.corners);
  const ac = ACCENTS[a.accent] || ACCENTS.clay;
  const v = a.theme === 'dark' ? ac.d : ac.l;
  el.style.setProperty('--accent', v.a);
  el.style.setProperty('--accent-2', v.a2);
  el.style.setProperty('--accent-ink', v.ink);
  el.style.setProperty('--accent-wash', v.wash);
}
