// The side panel's row recipes (SH-C1): one hover tint and one "current" tint for every row in the panel and its rail
// (the board tabs, the comics, the destinations), ink only, token radii, the FOCUS_RING, 44 px targets. The frame's
// own controls (comicCreationWorkspace.css) read the same hover tint (tests/config/creationWorkspaceTokens.test.ts).

import { ACCENT_FILL, ACCENT_FILL_HOVER, FOCUS_RING, ON_ACCENT_TEXT } from '../../chat/studioDesign';

/** The tint under a row the pointer is on. */
export const PANEL_HOVER_TINT = 'var(--ds-hover)';
/** The tint of the current row (the open tab, the comic you are in): the hover tint, in heavier ink. */
export const PANEL_CURRENT_TINT = 'var(--ds-hover)';

/** A full-width row: icon, words, an optional count. */
export const PANEL_ROW = `flex min-h-11 w-full min-w-0 shrink-0 items-center gap-3 rounded-[var(--ds-radius-control)] px-3 text-sm ${FOCUS_RING} disabled:cursor-default disabled:opacity-50`;
/** A Go to row: 36 px under a mouse, 44 px for touch, so the pinned group leaves the list its room on a laptop. */
export const PANEL_ROW_SHORT = 'min-h-9 coarse:min-h-11';
/** A slim-rail item: one 44 px icon target. */
export const RAIL_ITEM = `flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-sm ${FOCUS_RING} disabled:cursor-default disabled:opacity-50`;
export const PANEL_ROW_IDLE = 'text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]';
export const PANEL_ROW_INK = 'text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]';
export const PANEL_ROW_CURRENT = 'bg-[var(--ds-hover)] font-semibold text-[var(--ds-ink)]';

/**
 * New comic on All comics: the view's one fill (ink under the skin, never the public chrome's cobalt). On its own view
 * it is an outline (the idea form's Start is that view's fill); anywhere else a plain row.
 */
export const PANEL_FILL = `${ACCENT_FILL} ${ON_ACCENT_TEXT} ${ACCENT_FILL_HOVER} font-semibold`;
export const PANEL_OUTLINE = 'bg-[var(--ds-raised)] font-semibold text-[var(--ds-ink)] shadow-[inset_0_0_0_1px_var(--ds-hairline)] hover:bg-[var(--ds-hover)]';
