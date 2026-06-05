// Studio dark theme tokens (Sprint 0, S0.5).
//
// The workspace uses a dark "studio" surface so code + previews pop (plan §5, D8). These
// are Tailwind class fragments so views compose them directly; the raw palette also lives
// in tailwind.config.cjs as `colors.studio.*` for arbitrary use. Keep the two in sync.

export const studioTheme = {
  /** App/workspace background. */
  bg: 'bg-[#0b0e14]',
  /** Raised panel surface (editor, preview, logs). */
  panel: 'bg-[#11151f]',
  /** Secondary surface (file tree, gutters). */
  panelAlt: 'bg-[#0e1219]',
  /** Hairline divider/border. */
  edge: 'border-white/10',
  /** Stronger border for focused/active edges. */
  edgeStrong: 'border-white/20',
  /** Primary body text. */
  text: 'text-slate-200',
  /** Dimmed/secondary text. */
  textDim: 'text-slate-400',
  /** Faint/tertiary text. */
  textFaint: 'text-slate-500',
  /** Accent foreground (links, active). */
  accent: 'text-sky-400',
  /** Accent background (primary actions). */
  accentBg: 'bg-sky-500',
  /** Accent background hover. */
  accentBgHover: 'hover:bg-sky-400',
  /** Focus ring. */
  focusRing: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60',
} as const;

export type StudioTheme = typeof studioTheme;
