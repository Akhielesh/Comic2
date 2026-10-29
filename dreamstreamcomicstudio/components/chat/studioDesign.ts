/**
 * Chat Studio "calm studio" design language — inspired by Claude.ai + macOS glass.
 *
 * Chat Studio deliberately does NOT use the comic kit (`border-2 border-black`,
 * `shadow-comic`, brand-yellow, `font-display`). Inside the chat shell, always
 * compose from these constants instead. Tailwind scans this file (it's under
 * components/**), so arbitrary values here are safe to use.
 *
 * Every constant is token-driven (`--ds-*` in index.css): the defaults of those tokens
 * reproduce exactly the classes these constants used to spell out (rounded-2xl,
 * duration-200, backdrop-blur-md, …), and a skin (`[data-ds-skin="atlas"]`, see
 * docs/design/atlas-skin.md) restyles everything built from them by overriding the
 * tokens — Comic Studio imports this file too, so its look follows the skin while chat,
 * settings and home stay as they are.
 */

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** Warm paper canvas behind the whole chat shell. */
export const CANVAS_BG = 'bg-[var(--ds-canvas)]';

/** Slightly deeper paper for the sidebar column. */
export const SIDEBAR_BG = 'bg-[var(--ds-sidebar)]';

/** Floating glass surface (panels, toolbars, menus). The blur amount is a token (12 px = blur-md). */
export const GLASS = 'bg-[var(--ds-surface-soft)] backdrop-blur-[var(--ds-surface-blur)]';

/** Stronger glass for the composer bar and modals that sit over content. */
export const GLASS_STRONG = 'bg-[var(--ds-surface)] backdrop-blur-[var(--ds-surface-blur)]';

// ---------------------------------------------------------------------------
// Lines, depth, shape
// ---------------------------------------------------------------------------

/** Hairline border — the ONLY border weight used inside Chat Studio. */
export const HAIRLINE = 'border border-[var(--ds-hairline)]';

/** Soft ambient shadow — never the comic offset shadow. */
export const SHADOW_SOFT = 'shadow-[shadow:var(--ds-shadow-soft)]';

/** Panel radius (1rem = rounded-2xl by default). */
export const RADIUS_PANEL = 'rounded-[var(--ds-radius-panel)]';

/** Control radius (buttons, inputs; 0.75rem = rounded-xl by default). */
export const RADIUS_CONTROL = 'rounded-[var(--ds-radius-control)]';

/** Pill radius (chips, toggles; rounded-full by default). */
export const RADIUS_PILL = 'rounded-[var(--ds-radius-chip)]';

// ---------------------------------------------------------------------------
// Color & type
// ---------------------------------------------------------------------------

/** Primary ink text. */
export const INK = 'text-[var(--ds-ink)]';

/** Muted/secondary text. */
export const MUTED = 'text-[var(--ds-muted)]';

/**
 * Terracotta accent hex values (for the rare inline-style need). The brand accent is DECORATIVE
 * (~3:1 on paper): never use it for text or under text — ACCENT_TEXT_HEX / ACCENT_FILL_HEX are the
 * readable values (= the light-theme --ds-accent-text / --ds-accent-fill in index.css).
 */
export const ACCENT_HEX = '#D97757';
export const ACCENT_HOVER_HEX = '#c2643f';
export const ACCENT_TEXT_HEX = '#A0472A';
export const ACCENT_FILL_HEX = '#AE5132';

/**
 * Accent utilities (terracotta by default; ink under the Atlas skin). ACCENT_BG is the brand fill
 * for marks that carry no text (dots, bars, toggle tracks); a fill that carries a label or a glyph
 * uses ACCENT_FILL (+ ACCENT_FILL_HOVER) with ON_ACCENT_TEXT, which is ≥ 4.5:1 in both themes
 * (index.css routes the older `bg-[var(--ds-accent)] text-white` pairing there too).
 */
export const ACCENT_BG = 'bg-[var(--ds-accent)]';
export const ACCENT_BG_HOVER = 'hover:bg-[var(--ds-accent-hover)]';
/** Accent-coloured text and the icons beside it: the readable accent (≥ 4.5:1 on every studio surface). */
export const ACCENT_TEXT = 'text-[var(--ds-accent-text)]';
/** Solid accent fill that carries text (primary buttons, badges, chips). */
export const ACCENT_FILL = 'bg-[var(--ds-accent-fill)]';
export const ACCENT_FILL_HOVER = 'hover:bg-[var(--ds-accent-fill-hover)]';
/** Text on a solid accent fill (white by default; paper on ink in the dark Atlas skin). */
export const ON_ACCENT_TEXT = 'text-[var(--ds-on-accent)]';
/** Soft accent tint for active/selected rows (= the old bg-[#D97757]/10 by default). */
export const ACCENT_SOFT_BG = 'bg-[var(--ds-accent-soft)]';

/** Display face for headings (index.css: inherits the body face by default, Space Grotesk under Atlas). */
export const FONT_DISPLAY = 'ds-font-display';

/** Headings inside chat: quiet semibold, never comic display lettering. */
export const HEADING = `font-semibold tracking-tight text-[var(--ds-ink)] ${FONT_DISPLAY}`;

/** Quiet small-caps label (section/group headers). */
export const LABEL = 'text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]';

// ---------------------------------------------------------------------------
// Status tones (mirrors Atlas's tone.ts). Hue only ever carries meaning and is always
// paired with a word or an icon — never colour alone.
// ---------------------------------------------------------------------------

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Readable status text (and the icon next to it): the `-text` tokens stay ≥ 4.5:1 on the page. */
export const TONE_TEXT: Record<StatusTone, string> = {
  success: 'text-[var(--ds-success-text)]',
  warning: 'text-[var(--ds-warning-text)]',
  danger: 'text-[var(--ds-danger-text)]',
  info: 'text-[var(--ds-info-text)]',
  neutral: 'text-[var(--ds-muted)]'
};

/** A tinted panel, chip or banner background with a matching border. */
export const TONE_SURFACE: Record<StatusTone, string> = {
  success: 'border-[color:color-mix(in_srgb,var(--ds-success)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-success)_10%,transparent)]',
  warning: 'border-[color:color-mix(in_srgb,var(--ds-warning)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-warning)_10%,transparent)]',
  danger: 'border-[color:color-mix(in_srgb,var(--ds-danger)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-danger)_10%,transparent)]',
  info: 'border-[color:color-mix(in_srgb,var(--ds-info)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-info)_10%,transparent)]',
  neutral: 'border-[var(--ds-hairline)] bg-[var(--ds-well-strong)]'
};

/** Small solid marks: status dots, bar fills, progress segments. */
export const TONE_FILL: Record<StatusTone, string> = {
  success: 'bg-[var(--ds-success)]',
  warning: 'bg-[var(--ds-warning)]',
  danger: 'bg-[var(--ds-danger)]',
  info: 'bg-[var(--ds-info)]',
  neutral: 'bg-[var(--ds-muted)]'
};

/** Text + surface together, for chips and inline banners. */
export const TONE_CHIP: Record<StatusTone, string> = {
  success: `${TONE_SURFACE.success} ${TONE_TEXT.success}`,
  warning: `${TONE_SURFACE.warning} ${TONE_TEXT.warning}`,
  danger: `${TONE_SURFACE.danger} ${TONE_TEXT.danger}`,
  info: `${TONE_SURFACE.info} ${TONE_TEXT.info}`,
  neutral: `${TONE_SURFACE.neutral} ${TONE_TEXT.neutral}`
};

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/**
 * Standard motion — slight tint or lift on hover, no comic translate-jump (200 ms by default).
 * Deliberately `transition-all`, as before the tokens: consumers outside the skin animate
 * positional properties with it (the provider switch knob in components/ApiConfiguration.tsx
 * slides `left-*`), and the skin must not change motion outside its scope. Narrowing the
 * property list to colour/shadow/opacity/transform is Phase D2 work, with the restyle.
 */
export const TRANSITION = 'transition-all duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]';

/** Subtle hover lift for floating elements. */
export const HOVER_LIFT = 'hover:-translate-y-px';

/** Press feedback: dips while pressed and springs back (index.css; motion-safe, skin only). */
export const PRESS = 'ds-press';

// ---------------------------------------------------------------------------
// Composites (the everyday building blocks)
// ---------------------------------------------------------------------------

/** Floating glass panel: glass + hairline + soft shadow + panel radius. */
export const PANEL = `${GLASS} ${HAIRLINE} ${SHADOW_SOFT} ${RADIUS_PANEL}`;

/** Primary action (send, new chat): the text-bearing accent fill with on-accent text (≥ 4.5:1). */
export const PRIMARY_BTN = `${ACCENT_FILL} ${ACCENT_FILL_HOVER} ${ON_ACCENT_TEXT} ${TRANSITION}`;

/** Quiet glass pill for toggles/chips. */
export const PILL = `${HAIRLINE} ${RADIUS_PILL} bg-[var(--ds-surface-soft)] backdrop-blur-sm ${TRANSITION}`;

/** Quiet icon/control button on glass. */
export const CONTROL_BTN = `${HAIRLINE} ${RADIUS_CONTROL} bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)] ${TRANSITION}`;

/** Soft hover row (sidebar sessions, menu items). */
export const HOVER_ROW = `${RADIUS_CONTROL} hover:bg-[var(--ds-hover)] ${TRANSITION}`;

/** Active sidebar row: soft accent tint with ink text. */
export const ACTIVE_ROW = `${RADIUS_CONTROL} ${ACCENT_SOFT_BG} text-[var(--ds-ink)]`;

/** Floating dropdown/context menu. */
export const MENU = `bg-[var(--ds-surface-strong)] backdrop-blur-[var(--ds-surface-blur)] ${HAIRLINE} ${SHADOW_SOFT} ${RADIUS_CONTROL}`;

/** Row inside a floating menu (icon + label, quiet hover). */
export const MENU_ITEM = `w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-left hover:bg-[var(--ds-hover)] ${TRANSITION}`;

// ---------------------------------------------------------------------------
// Sidebar rail (Claude-style compact navigation)
// ---------------------------------------------------------------------------

/** Quiet top-level nav row in the sidebar rail (icon + label). */
export const NAV_ROW = `w-full flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${TRANSITION}`;

/** Active nav row — soft accent tint, same geometry as NAV_ROW. */
export const NAV_ROW_ACTIVE = `w-full flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-[var(--ds-ink)] ${ACCENT_SOFT_BG} ${TRANSITION}`;

/** Compact session row in the rail (single-line truncated title). */
export const RAIL_ROW = `rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-[var(--ds-hover)] ${TRANSITION}`;

/** Active session row — soft accent tint. */
export const RAIL_ROW_ACTIVE = `rounded-lg px-2.5 py-1.5 text-[13px] ${ACCENT_SOFT_BG} text-[var(--ds-ink)] ${TRANSITION}`;
