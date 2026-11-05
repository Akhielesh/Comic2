// Model Lab chrome, composed from the studioDesign constants and the --ds-* semantic tokens (Atlas skin rules:
// never a literal hue, never rounded-2xl / duration-*). Every interactive target is at least 44 px tall (min-h-11).

import { ACCENT_BG, ACCENT_BG_HOVER, HAIRLINE, ON_ACCENT_TEXT, PRESS, RADIUS_CONTROL, RADIUS_PANEL, SHADOW_SOFT, TRANSITION } from '../../../chat/studioDesign';

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]';
export const LAB_PANEL = `${HAIRLINE} ${RADIUS_PANEL} ${SHADOW_SOFT} bg-[var(--ds-surface)]`;
export const LAB_WELL = `border border-[var(--ds-hairline-soft)] ${RADIUS_CONTROL} bg-[var(--ds-surface-soft)]`;
const BTN_BASE = `inline-flex min-h-11 min-w-11 max-w-full items-center justify-center gap-1.5 px-3.5 text-[13px] font-medium ${RADIUS_CONTROL} ${TRANSITION} ${PRESS} ${FOCUS} disabled:cursor-not-allowed disabled:opacity-50`;
export const LAB_PRIMARY_BTN = `${BTN_BASE} ${ACCENT_BG} ${ACCENT_BG_HOVER} ${ON_ACCENT_TEXT}`;
export const LAB_SECONDARY_BTN = `${BTN_BASE} ${HAIRLINE} bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]`;
/** Long ids, model versions and provider words must wrap at 360 px instead of overflowing. */
export const WRAP = '[overflow-wrap:anywhere]';
