// Code Studio theme system (Code-Studio-only — does NOT change the main app).
//
// Three switchable workspace themes:
//   • black — absolute-black OLED dark
//   • light — clean white/light
//   • brand — the DreamStream main-app look (comic borders, brand yellow/blue)
//
// Each theme is the SAME set of Tailwind class fragments, so every studio surface composes
// `t.bg`, `t.panel`, … from the active theme via the `useStudioTheme()` hook (themeStore.ts).
// Keep these literal strings (Tailwind scans this file to keep the classes).

export type StudioThemeId = 'black' | 'light' | 'brand';

export interface StudioThemeTokens {
  id: StudioThemeId;
  label: string;
  /** True for dark surfaces (drives status-text shades etc.). */
  isDark: boolean;
  /** Monaco editor theme name (defined in MonacoEditor.tsx). */
  monaco: string;

  /** App/workspace background. */
  bg: string;
  /** Raised panel surface (pane bodies). */
  panel: string;
  /** Secondary surface (pane headers, file tree, gutters). */
  panelAlt: string;
  /** Code editor surface — matches the Monaco theme background. */
  editorBg: string;
  /** Hairline divider/border. */
  edge: string;
  /** Stronger border for focused/active edges. */
  edgeStrong: string;
  /** Hover background for interactive rows/buttons (theme-correct). */
  hover: string;

  /** Primary body text. */
  text: string;
  /** Dimmed/secondary text. */
  textDim: string;
  /** Faint/tertiary text. */
  textFaint: string;

  /** Accent foreground (links, active labels). */
  accent: string;
  /** Soft accent background (active rows/tabs). */
  accentSoft: string;
  /** Accent background (primary actions). */
  accentBg: string;
  /** Accent background hover. */
  accentBgHover: string;
  /** Text colour that sits on `accentBg`. */
  accentText: string;
  /** Focus ring. */
  focusRing: string;
}

export const STUDIO_THEMES: Record<StudioThemeId, StudioThemeTokens> = {
  // ---- Absolute black (OLED dark) ----
  black: {
    id: 'black',
    label: 'Black',
    isDark: true,
    monaco: 'studio-black',
    bg: 'bg-black',
    panel: 'bg-[#0a0a0a]',
    panelAlt: 'bg-[#060606]',
    editorBg: 'bg-black',
    edge: 'border-white/10',
    edgeStrong: 'border-white/25',
    hover: 'hover:bg-white/5',
    text: 'text-slate-100',
    textDim: 'text-slate-400',
    textFaint: 'text-slate-500',
    accent: 'text-sky-400',
    accentSoft: 'bg-sky-500/15',
    accentBg: 'bg-sky-500',
    accentBgHover: 'hover:bg-sky-400',
    accentText: 'text-black',
    focusRing: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
  },
  // ---- White (light) ----
  light: {
    id: 'light',
    label: 'White',
    isDark: false,
    monaco: 'studio-light',
    bg: 'bg-slate-50',
    panel: 'bg-white',
    panelAlt: 'bg-slate-100',
    editorBg: 'bg-white',
    edge: 'border-slate-200',
    edgeStrong: 'border-slate-300',
    hover: 'hover:bg-slate-100',
    text: 'text-slate-800',
    textDim: 'text-slate-500',
    textFaint: 'text-slate-400',
    accent: 'text-sky-600',
    accentSoft: 'bg-sky-500/10',
    accentBg: 'bg-sky-500',
    accentBgHover: 'hover:bg-sky-400',
    accentText: 'text-white',
    focusRing: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50',
  },
  // ---- DreamStream brand (comic look) ----
  brand: {
    id: 'brand',
    label: 'DreamStream',
    isDark: false,
    monaco: 'studio-light',
    bg: 'bg-slate-50',
    panel: 'bg-white',
    panelAlt: 'bg-amber-50',
    editorBg: 'bg-white',
    edge: 'border-black',
    edgeStrong: 'border-black',
    hover: 'hover:bg-black/5',
    text: 'text-black',
    textDim: 'text-slate-600',
    textFaint: 'text-slate-400',
    accent: 'text-brand-blue',
    accentSoft: 'bg-brand-blue/10',
    accentBg: 'bg-brand-yellow',
    accentBgHover: 'hover:bg-yellow-300',
    accentText: 'text-black',
    focusRing: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50',
  },
};

export const STUDIO_THEME_ORDER: StudioThemeId[] = ['black', 'light', 'brand'];
export const DEFAULT_STUDIO_THEME: StudioThemeId = 'black';

/** Non-reactive default tokens (for any static context). Components use `useStudioTheme()`. */
export const studioTheme = STUDIO_THEMES[DEFAULT_STUDIO_THEME];
