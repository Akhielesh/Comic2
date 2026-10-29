/**
 * Chat Studio "calm studio" design language — inspired by Claude.ai + macOS glass.
 *
 * Chat Studio deliberately does NOT use the comic kit (`border-2 border-black`,
 * `shadow-comic`, brand-yellow, `font-display`). Inside the chat shell, always
 * compose from these constants instead. Tailwind scans this file (it's under
 * components/**), so arbitrary values here are safe to use.
 *
 * Every constant is token-driven (`--ds-*` in index.css). The defaults of those tokens
 * reproduce the classes these constants used to spell out (rounded-2xl, duration-200,
 * backdrop-blur-md, …) except where a text pairing fell below 4.5:1
 * (tests/config/tokenContrast.test.ts): ACCENT_TEXT reads the deeper readable accent, the
 * label on an accent fill (ON_ACCENT_TEXT, so PRIMARY_BTN) is ink instead of white, and the
 * muted ink and the status text move a shade toward more contrast. A skin
 * (`[data-ds-skin="atlas"]`, see docs/design/atlas-skin.md) restyles everything built from
 * them by overriding the tokens — Comic Studio imports this file too, so its look follows the
 * skin while chat, settings and home keep the default tokens.
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
 * Terracotta accent hex values for the rare inline-style need. LIGHT THEME ONLY, and they never
 * follow the dark theme or a skin — prefer the var() utilities below (ACCENT_TEXT, ACCENT_FILL, …)
 * whenever a class can do it. The brand accent measures ~3:1 on the paper: it is never text.
 * ACCENT_TEXT_HEX is the light --ds-accent-text (readable accent text; 2.5:1 on the DARK canvas, so
 * not for dark surfaces); ACCENT_FILL_HEX is the light --ds-accent-fill (= the brand), which carries
 * an ink label (--ds-on-accent), never white.
 */
export const ACCENT_HEX = '#D97757';
export const ACCENT_HOVER_HEX = '#c2643f';
export const ACCENT_TEXT_HEX = '#A0472A';
export const ACCENT_FILL_HEX = '#D97757';

/**
 * Accent utilities (terracotta by default; ink under the Atlas skin). ACCENT_BG is the brand fill
 * for marks that carry no text (dots, bars, toggle tracks); a fill that carries a label or a glyph
 * uses ACCENT_FILL (+ ACCENT_FILL_HOVER) with ON_ACCENT_TEXT — by default the same brand terracotta
 * under an ink label, ≥ 4.5:1 in both themes (index.css routes the older
 * `bg-[var(--ds-accent)] text-white` pairing there too).
 */
export const ACCENT_BG = 'bg-[var(--ds-accent)]';
export const ACCENT_BG_HOVER = 'hover:bg-[var(--ds-accent-hover)]';
/** Accent-coloured text and the icons beside it: the readable accent (≥ 4.5:1 on every studio surface). */
export const ACCENT_TEXT = 'text-[var(--ds-accent-text)]';
/** Solid accent fill that carries text (primary buttons, badges, chips). */
export const ACCENT_FILL = 'bg-[var(--ds-accent-fill)]';
export const ACCENT_FILL_HOVER = 'hover:bg-[var(--ds-accent-fill-hover)]';
/** Text on a solid accent fill (ink on the terracotta by default; white on ink in Atlas light, ink on paper in Atlas dark). */
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

/** A tinted panel, chip or banner background with a matching border (danger tints read the danger mark, as TONE_FILL). */
export const TONE_SURFACE: Record<StatusTone, string> = {
  success: 'border-[color:color-mix(in_srgb,var(--ds-success)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-success)_10%,transparent)]',
  warning: 'border-[color:color-mix(in_srgb,var(--ds-warning)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-warning)_10%,transparent)]',
  danger: 'border-[color:color-mix(in_srgb,var(--ds-danger-mark)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-danger-mark)_10%,transparent)]',
  info: 'border-[color:color-mix(in_srgb,var(--ds-info)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-info)_10%,transparent)]',
  neutral: 'border-[var(--ds-hairline)] bg-[var(--ds-well-strong)]'
};

/**
 * Small solid marks: status dots, bar fills, progress segments. Danger reads the danger MARK: the
 * same red outside the skin and in Atlas light, the brighter Atlas red in Atlas dark, where the deep
 * red (kept for fills under white text) is under 3:1 as a dot on the page.
 */
export const TONE_FILL: Record<StatusTone, string> = {
  success: 'bg-[var(--ds-success)]',
  warning: 'bg-[var(--ds-warning)]',
  danger: 'bg-[var(--ds-danger-mark)]',
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
// Wave 5 recipes (Atlas acd9fdfc; docs/design/atlas-skin.md "Wave 5 port"). New constants, read by
// nothing outside the skin yet: Phase D2 moves components onto them. Every one is token-driven, so
// under the skin it is the Atlas primitive and outside it reads the default tokens.
// ---------------------------------------------------------------------------

/**
 * Keyboard focus (Atlas `.atlas-focus-ring`, and every primitive since wave 5): a solid 2 px outline
 * in the focus colour set 2 px off the element — the ink under the skin, so it clears 3:1 in both
 * themes (a 50 %-alpha ring did not); 3 px under the OS "increase contrast" setting. Pair with
 * PRIMARY_BTN, CONTROL_BTN, PILL, chips, switches and checkboxes.
 */
export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--ds-focus)] contrast-more:focus-visible:outline-[3px]';
/** The same, flush with the element (tab and segment triggers inside a track). */
export const FOCUS_RING_FLUSH = FOCUS_RING.replace('outline-offset-2', 'outline-offset-0');
/** Rows inside a menu, list or listbox: an inset ring in the ring colour (Atlas menu items). */
export const FOCUS_ITEM = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-ring)]';

/**
 * A text field or select trigger (Atlas Input / Textarea / SelectTrigger): an edge that clears 3:1
 * against the page (--ds-control-border, darker on hover) and keyboard focus drawn as a RING — 2 px
 * of the focus colour set 2 px off the field — so a field set borderless inside a group that shows
 * focus itself can drop it with FIELD_EMBEDDED.
 */
export const FIELD = `${RADIUS_CONTROL} border border-[var(--ds-control-border)] bg-[var(--ds-canvas)] text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] hover:border-[var(--ds-control-border-hover)] focus-visible:border-[var(--ds-focus)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--ds-canvas)] transition-[border-color,box-shadow,background-color] duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] disabled:cursor-not-allowed disabled:opacity-50`;
/**
 * A borderless field inside FIELD_GROUP. Drops the ring AND its offset: ring-0 on its own leaves the
 * page-coloured offset painted over a 0 px ring, so the field would show no focus at all. Only ever
 * inside a wrapper that shows focus itself.
 */
export const FIELD_EMBEDDED = 'min-w-0 flex-1 border-0 bg-transparent focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0';
/** The pill around an embedded field (a search box with an icon): the field edge, and focus shown by the group. */
export const FIELD_GROUP = `flex items-center gap-2 ${RADIUS_CONTROL} border border-[var(--ds-control-border)] bg-[var(--ds-canvas)] hover:border-[var(--ds-control-border-hover)] focus-within:border-[color:color-mix(in_srgb,var(--ds-ink)_70%,transparent)] focus-within:ring-[3px] focus-within:ring-[color:color-mix(in_srgb,var(--ds-ring)_20%,transparent)] transition-[border-color,box-shadow] duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)]`;

/**
 * Menus, popovers, dialogs and sheets (Atlas overlays): a step above the cards they cover (#1a1a1a
 * over #111111 in dark), a lighter edge, and in dark a 1 px light catch along the top with a deeper
 * shadow. Opaque: no frosted glass.
 */
export const OVERLAY = `bg-[var(--ds-raised)] text-[var(--ds-ink)] border border-[var(--ds-overlay-edge)] shadow-[shadow:var(--ds-shadow-overlay)] ${RADIUS_PANEL}`;
/** The dim behind a modal: 40 % black, 60 % in dark, and no backdrop blur (Atlas wave 5 dropped it). */
export const SCRIM = 'bg-[var(--ds-scrim)]';

/** The small uppercase label above a heading or a group of controls (Atlas `.atlas-overline`). */
export const OVERLINE = 'text-[11px] font-semibold leading-4 tracking-[0.12em] uppercase text-[var(--ds-muted)]';

/** A neutral chip (Atlas MetaChip) — status meaning uses STATUS_CHIP. Add one CHIP_VARIANT. */
export const CHIP = `inline-flex max-w-full items-center gap-1 whitespace-nowrap ${RADIUS_PILL} border px-2 py-0.5 text-[11px] font-medium leading-4`;
export const CHIP_VARIANT = {
  /** The default: a quiet outline on the page. */
  outline: 'border-[var(--ds-hairline)] bg-[var(--ds-canvas)] text-[var(--ds-muted)]',
  /** A soft ink fill, for a label that names something (a comic, a series, a style). */
  filled: 'border-transparent bg-[color:color-mix(in_srgb,var(--ds-ink)_6%,transparent)] text-[var(--ds-ink)]',
  /** A dashed outline, for something provisional or not set. */
  dashed: 'border-dashed border-[var(--ds-hairline)] bg-transparent text-[var(--ds-muted)]'
} as const;

/**
 * One status vocabulary (Atlas wave 5, connectors/status): the page is monochrome and hue appears
 * only where a state means something, always next to its words. healthy = done / connected;
 * active = working right now (ink); waiting = queued / paused (muted); attention = the person may
 * want to look (amber); error = the person has to act (red).
 */
export type StatusState = 'healthy' | 'active' | 'waiting' | 'attention' | 'error';
/** Readable status text and the icon beside it (≥ 4.5:1 on its own surface, tokenContrast.test.ts). */
export const STATUS_INK: Record<StatusState, string> = {
  healthy: TONE_TEXT.success,
  active: 'text-[var(--ds-ink)]',
  waiting: 'text-[var(--ds-muted)]',
  attention: TONE_TEXT.warning,
  error: TONE_TEXT.danger
};
/** Border and tint for a status chip, callout or row. */
export const STATUS_SURFACE: Record<StatusState, string> = {
  healthy: 'border-[color:color-mix(in_srgb,var(--ds-success)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-success)_6%,transparent)]',
  active: 'border-[color:color-mix(in_srgb,var(--ds-ink)_15%,transparent)] bg-[var(--ds-well)]',
  waiting: 'border-[var(--ds-hairline)] bg-[var(--ds-canvas)]',
  attention: 'border-[color:color-mix(in_srgb,var(--ds-warning)_40%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-warning)_8%,transparent)]',
  error: 'border-[color:color-mix(in_srgb,var(--ds-danger-mark)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--ds-danger-mark)_6%,transparent)]'
};
/** The solid dot of a status (always beside its words), a toast's edge and time-left bar. */
export const STATUS_DOT: Record<StatusState, string> = {
  healthy: 'bg-[var(--ds-success)]',
  active: 'bg-[var(--ds-ink)]',
  waiting: 'bg-[var(--ds-muted)]',
  attention: 'bg-[var(--ds-warning)]',
  error: 'bg-[var(--ds-danger-mark)]'
};
/** The status chip's shape (dot or icon, then the words); add STATUS_CHIP_TONE[state]. */
export const STATUS_CHIP = `inline-flex max-w-full items-center gap-1.5 whitespace-nowrap ${RADIUS_PILL} border px-2.5 py-0.5 text-[11px] font-medium leading-4 transition-colors duration-[var(--ds-motion-slow)]`;
export const STATUS_CHIP_TONE: Record<StatusState, string> = {
  healthy: `${STATUS_SURFACE.healthy} ${STATUS_INK.healthy}`,
  active: `${STATUS_SURFACE.active} ${STATUS_INK.active}`,
  waiting: `${STATUS_SURFACE.waiting} ${STATUS_INK.waiting}`,
  attention: `${STATUS_SURFACE.attention} ${STATUS_INK.attention}`,
  error: `${STATUS_SURFACE.error} ${STATUS_INK.error}`
};

/**
 * Segmented tabs (Atlas PanelTabs): a soft track; the selected segment is a raised pill. Either paint
 * SEGMENTED_ACTIVE on the selected item, or place one SEGMENTED_PILL under the items and move it with
 * an inline translateX / width measured from the selected item — it glides on the panel time and the
 * spring, and jumps under reduced motion. Items take the flush focus outline.
 */
export const SEGMENTED_TRACK = `relative inline-flex min-w-0 max-w-full gap-0.5 ${RADIUS_CONTROL} border border-[var(--ds-hairline-soft)] bg-[var(--ds-well-strong)] p-0.5`;
export const SEGMENTED_ITEM = `relative inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[calc(var(--ds-radius-control)-2px)] px-3 text-[13px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] aria-checked:text-[var(--ds-ink)] aria-selected:text-[var(--ds-ink)] transition-colors duration-[var(--ds-motion-medium)] ease-[var(--ds-ease)] ${FOCUS_RING_FLUSH}`;
export const SEGMENTED_ACTIVE = 'bg-[var(--ds-segment-pill)] text-[var(--ds-ink)] shadow-[shadow:var(--ds-shadow-segment)]';
export const SEGMENTED_PILL = 'pointer-events-none absolute inset-y-0.5 left-0 rounded-[calc(var(--ds-radius-control)-2px)] bg-[var(--ds-segment-pill)] shadow-[shadow:var(--ds-shadow-segment)] transition-[transform,width] duration-[var(--ds-motion-panel)] ease-[var(--ds-ease-spring)] motion-reduce:transition-none';

/**
 * A section card (Atlas SectionCard with an icon): a labelled <section> whose header carries a 36 px
 * icon tile, a 16 px title and a muted description over a divider; an aside (a count, a status chip,
 * a field) sits beside the title while there is room and wraps under it when there is not.
 */
export const SECTION_CARD = `overflow-hidden ${RADIUS_PANEL} border border-[var(--ds-hairline)] bg-[var(--ds-surface)] text-[var(--ds-ink)] ${SHADOW_SOFT}`;
export const SECTION_HEADER = 'flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-[var(--ds-hairline)] px-5 py-5 sm:px-6';
export const SECTION_ICON_TILE = `flex h-9 w-9 shrink-0 items-center justify-center ${RADIUS_CONTROL} border border-[var(--ds-hairline)] bg-[var(--ds-well)] text-[var(--ds-ink)]`;
export const SECTION_TITLE = `m-0 text-[length:var(--ds-text-lg)] font-semibold leading-6 tracking-[-0.01em] text-[var(--ds-ink)] ${FONT_DISPLAY}`;
export const SECTION_DESCRIPTION = 'm-0 mt-0.5 text-pretty text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)]';
export const SECTION_BODY = 'px-5 py-5 sm:px-6';

/**
 * Toasts (Atlas GlobalNotificationBar): a monochrome card — the status hue appears only on the 4 px
 * edge (TOAST_EDGE + STATUS_DOT[state]), the time-left bar (TOAST_COUNTDOWN + STATUS_DOT[state], with
 * `--ds-toast-duration` set inline and `data-paused` on the toast while its dismiss clock is held) and
 * the icon (STATUS_INK[state]), next to a title that already says what happened. TOAST_ENTER /
 * TOAST_EXIT arrive on the enter curve and leave quicker; give the exit a removal timer (no
 * animationend fires under reduced motion). Each toast sits in a TOAST_SLOT that closes
 * (TOAST_SLOT_CLOSED) as it leaves, so the stack glides up instead of jumping.
 */
export const TOAST = `ds-toast pointer-events-auto relative flex items-start gap-3 overflow-hidden ${RADIUS_PANEL} border border-[var(--ds-overlay-edge)] bg-[var(--ds-raised)] py-3 pl-4 pr-3 text-[var(--ds-ink)] shadow-[shadow:var(--ds-shadow-panel)]`;
export const TOAST_EDGE = 'pointer-events-none absolute inset-y-0 left-0 w-1';
export const TOAST_COUNTDOWN = 'ds-toast-countdown pointer-events-none absolute bottom-0 left-0 h-0.5 w-full';
export const TOAST_ENTER = 'ds-toast-enter';
export const TOAST_EXIT = 'ds-toast-exit';
export const TOAST_TITLE = 'text-[length:var(--ds-text-base)] font-medium leading-5 text-[var(--ds-ink)] [overflow-wrap:anywhere]';
export const TOAST_MESSAGE = 'mt-0.5 text-[13px] leading-5 text-[var(--ds-muted)] [overflow-wrap:anywhere]';
export const TOAST_SLOT = 'grid transition-[grid-template-rows] duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] motion-reduce:transition-none';
export const TOAST_SLOT_OPEN = 'grid-rows-[1fr]';
export const TOAST_SLOT_CLOSED = 'grid-rows-[0fr]';

/**
 * The inverted ink panel (a black call-to-action or brand panel on white). Under the skin in dark it
 * stays a raised dark panel with a light rim instead of a white slab (index.css swaps the ink tokens
 * back inside it), and focus inside it draws in the page colour.
 */
export const INVERSE_SURFACE = 'ds-inverse-surface bg-[var(--ds-ink)] text-[var(--ds-canvas)]';

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
