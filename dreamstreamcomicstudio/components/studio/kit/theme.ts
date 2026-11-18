// Code Studio theme system (Code-Studio-only — does NOT change the main app).
//
// Three switchable workspace themes:
//   • black — absolute-black OLED dark
//   • light — clean white/light
//   • brand — the DreamStream app look, on the app's own --ds-* tokens
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

  // ---- Next-gen surface kit (AI-studio aesthetic) ----
  /** Frosted-glass surface (translucent bg + blur) for floating headers/cards. */
  glass: string;
  /** Accent glow shadow for primary/active/“thinking” surfaces. */
  glow: string;
  /** Subtle top-down gradient wash for headers/hero strips. */
  gradient: string;
  /** Chip/pill surface (bg + border together). */
  chip: string;
  /** Multi-stop accent gradient (for progress bars, active rails, brand marks). */
  accentGrad: string;
}

export const STUDIO_THEMES: Record<StudioThemeId, StudioThemeTokens> = {
  // ---- Linear / AI-studio dark (the default hero theme) ----
  // Near-black charcoal base with frosted-glass panels that float over the aurora glow
  // (see StudioAurora). Electric violet accent. Premium, AI-centric — not flat OLED.
  black: {
    id: 'black',
    label: 'Dark',
    isDark: true,
    monaco: 'studio-black',
    bg: 'bg-[#0B0B0F]',
    panel: 'bg-[#101016]',
    panelAlt: 'bg-[#16161d]',
    editorBg: 'bg-[#0B0B0F]',
    edge: 'border-white/[0.08]',
    edgeStrong: 'border-white/25',
    hover: 'hover:bg-white/[0.06]',
    text: 'text-[#E8E8F0]',
    textDim: 'text-slate-400',
    textFaint: 'text-slate-500',
    accent: 'text-violet-300',
    accentSoft: 'bg-violet-500/15',
    accentBg: 'bg-violet-500',
    accentBgHover: 'hover:bg-violet-400',
    accentText: 'text-white',
    focusRing: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/60',
    glass: 'bg-white/[0.045] backdrop-blur-xl',
    glow: 'shadow-[0_0_50px_-14px_rgba(139,92,246,0.55)]',
    gradient: 'bg-gradient-to-b from-white/[0.05] to-transparent',
    chip: 'bg-white/[0.05] border-white/10',
    accentGrad: 'bg-gradient-to-r from-violet-500 via-fuchsia-500 to-cyan-400',
  },
  // ---- White (light) ----
  // ---- White (light) — refined, AI-centric (cohesive violet accent, soft depth) ----
  light: {
    id: 'light',
    label: 'Light',
    isDark: false,
    monaco: 'studio-light',
    bg: 'bg-[#F6F7FB]',
    panel: 'bg-white',
    panelAlt: 'bg-slate-50',
    editorBg: 'bg-white',
    edge: 'border-slate-200/80',
    edgeStrong: 'border-slate-300',
    hover: 'hover:bg-slate-100/80',
    text: 'text-slate-900',
    textDim: 'text-slate-500',
    textFaint: 'text-slate-400',
    accent: 'text-violet-600',
    accentSoft: 'bg-violet-500/10',
    accentBg: 'bg-violet-600',
    accentBgHover: 'hover:bg-violet-500',
    accentText: 'text-white',
    focusRing: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/50',
    glass: 'bg-white/75 backdrop-blur-xl',
    glow: 'shadow-[0_12px_44px_-16px_rgba(124,58,237,0.35)]',
    gradient: 'bg-gradient-to-b from-white to-slate-50',
    chip: 'bg-white border-slate-200',
    accentGrad: 'bg-gradient-to-r from-violet-600 via-fuchsia-500 to-sky-500',
  },
  // ---- DreamStream (the app's own tokens) ----
  // Token-only: the Atlas paper / ink surfaces, hairlines, the ink accent and the focus outline,
  // so it follows the app skin and its light / dark tokens. The editor stays on the light Monaco
  // theme's white page. The id stays 'brand' so stored preferences still load.
  brand: {
    id: 'brand',
    label: 'DreamStream',
    isDark: false,
    monaco: 'studio-light',
    bg: 'bg-[var(--ds-canvas)]',
    panel: 'bg-[var(--ds-surface)]',
    panelAlt: 'bg-[var(--ds-well)]',
    editorBg: 'bg-white',
    edge: 'border-[var(--ds-hairline)]',
    edgeStrong: 'border-[var(--ds-control-border-hover)]',
    hover: 'hover:bg-[var(--ds-hover)]',
    text: 'text-[var(--ds-ink)]',
    textDim: 'text-[var(--ds-muted)]',
    textFaint: 'text-[var(--ds-muted)]',
    accent: 'text-[var(--ds-accent-text)]',
    accentSoft: 'bg-[var(--ds-accent-soft)]',
    accentBg: 'bg-[var(--ds-accent-fill)]',
    accentBgHover: 'hover:bg-[var(--ds-accent-fill-hover)]',
    accentText: 'text-[var(--ds-on-accent)]',
    focusRing: 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ds-focus)]',
    glass: 'bg-[var(--ds-surface)]',
    glow: 'shadow-[shadow:var(--ds-shadow-soft)]',
    gradient: 'bg-[var(--ds-canvas)]',
    chip: 'bg-[var(--ds-surface)] border-[var(--ds-hairline)]',
    accentGrad: 'bg-[var(--ds-accent)]',
  },
};

export const STUDIO_THEME_ORDER: StudioThemeId[] = ['black', 'light', 'brand'];
export const DEFAULT_STUDIO_THEME: StudioThemeId = 'black';

/** Non-reactive default tokens (for any static context). Components use `useStudioTheme()`. */
export const studioTheme = STUDIO_THEMES[DEFAULT_STUDIO_THEME];
