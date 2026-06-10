/**
 * Chat Studio "calm studio" design language — inspired by Claude.ai + macOS glass.
 *
 * Chat Studio deliberately does NOT use the comic kit (`border-2 border-black`,
 * `shadow-comic`, brand-yellow, `font-display`). Inside the chat shell, always
 * compose from these constants instead. Tailwind scans this file (it's under
 * components/**), so arbitrary values here are safe to use.
 */

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** Warm paper canvas behind the whole chat shell. */
export const CANVAS_BG = 'bg-[var(--ds-canvas)]';

/** Slightly deeper paper for the sidebar column. */
export const SIDEBAR_BG = 'bg-[var(--ds-sidebar)]';

/** Floating glass surface (panels, toolbars, menus). */
export const GLASS = 'bg-[var(--ds-surface-soft)] backdrop-blur-md';

/** Stronger glass for the composer bar and modals that sit over content. */
export const GLASS_STRONG = 'bg-[var(--ds-surface)] backdrop-blur-md';

// ---------------------------------------------------------------------------
// Lines, depth, shape
// ---------------------------------------------------------------------------

/** Hairline border — the ONLY border weight used inside Chat Studio. */
export const HAIRLINE = 'border border-[var(--ds-hairline)]';

/** Soft ambient shadow — never the comic offset shadow. */
export const SHADOW_SOFT = 'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_var(--ds-hairline)]';

/** Panel radius. */
export const RADIUS_PANEL = 'rounded-2xl';

/** Control radius (buttons, inputs). */
export const RADIUS_CONTROL = 'rounded-xl';

/** Pill radius (chips, toggles). */
export const RADIUS_PILL = 'rounded-full';

// ---------------------------------------------------------------------------
// Color & type
// ---------------------------------------------------------------------------

/** Primary ink text. */
export const INK = 'text-[var(--ds-ink)]';

/** Muted/secondary text. */
export const MUTED = 'text-[var(--ds-muted)]';

/** Terracotta accent hex values (for the rare inline-style need). */
export const ACCENT_HEX = '#D97757';
export const ACCENT_HOVER_HEX = '#c2643f';

/** Terracotta accent utilities. */
export const ACCENT_BG = 'bg-[var(--ds-accent)]';
export const ACCENT_BG_HOVER = 'hover:bg-[var(--ds-accent-hover)]';
export const ACCENT_TEXT = 'text-[var(--ds-accent)]';
/** Soft accent tint for active/selected rows. */
export const ACCENT_SOFT_BG = 'bg-[#D97757]/10';

/** Headings inside chat: quiet semibold, never comic display lettering. */
export const HEADING = 'font-semibold tracking-tight text-[var(--ds-ink)]';

/** Quiet small-caps label (section/group headers). */
export const LABEL = 'text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]';

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** Standard motion — slight tint or lift on hover, no comic translate-jump. */
export const TRANSITION = 'transition-all duration-200';

/** Subtle hover lift for floating elements. */
export const HOVER_LIFT = 'hover:-translate-y-px';

// ---------------------------------------------------------------------------
// Composites (the everyday building blocks)
// ---------------------------------------------------------------------------

/** Floating glass panel: glass + hairline + soft shadow + panel radius. */
export const PANEL = `${GLASS} ${HAIRLINE} ${SHADOW_SOFT} ${RADIUS_PANEL}`;

/** Primary action (send, new chat): terracotta with white text. */
export const PRIMARY_BTN = `${ACCENT_BG} ${ACCENT_BG_HOVER} text-white ${TRANSITION}`;

/** Quiet glass pill for toggles/chips. */
export const PILL = `${HAIRLINE} ${RADIUS_PILL} bg-[var(--ds-surface-soft)] backdrop-blur-sm ${TRANSITION}`;

/** Quiet icon/control button on glass. */
export const CONTROL_BTN = `${HAIRLINE} ${RADIUS_CONTROL} bg-[var(--ds-surface-soft)] hover:bg-[var(--ds-hover)] ${TRANSITION}`;

/** Soft hover row (sidebar sessions, menu items). */
export const HOVER_ROW = `${RADIUS_CONTROL} hover:bg-[var(--ds-hover)] ${TRANSITION}`;

/** Active sidebar row: soft terracotta tint with ink text. */
export const ACTIVE_ROW = `${RADIUS_CONTROL} ${ACCENT_SOFT_BG} text-[var(--ds-ink)]`;

/** Floating dropdown/context menu. */
export const MENU = `bg-[var(--ds-surface-strong)] backdrop-blur-md ${HAIRLINE} ${SHADOW_SOFT} ${RADIUS_CONTROL}`;
