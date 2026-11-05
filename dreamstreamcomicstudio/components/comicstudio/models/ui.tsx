// Shared look for the model picker, its confirms and the lock line: Atlas-skinned through the studioDesign.ts
// constants and --ds-* tokens only (no literal hue, no spelled-out radius or duration). Every control is a real
// 44 px target (`min-h-11`), on fine pointers too: these are deliberate, money-and-consistency decisions.

import React from 'react';
import {
  ACCENT_SOFT_BG,
  CONTROL_BTN,
  HAIRLINE,
  PRESS,
  PRIMARY_BTN,
  RADIUS_CONTROL,
  RADIUS_PILL,
  TONE_CHIP,
  TRANSITION
} from '../../chat/studioDesign';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]';

/** A secondary / cancel button. */
export const BTN_SECONDARY = `${CONTROL_BTN} ${FOCUS} ${PRESS} inline-flex min-h-11 min-w-0 max-w-full items-center justify-center gap-1.5 px-4 py-2 text-center text-[13px] font-medium leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere] disabled:cursor-not-allowed disabled:opacity-50`;

/** The one primary action. */
export const BTN_PRIMARY = `${PRIMARY_BTN} ${RADIUS_CONTROL} ${FOCUS} ${PRESS} inline-flex min-h-11 min-w-0 max-w-full items-center justify-center gap-1.5 px-4 py-2 text-center text-[13px] font-semibold leading-snug [overflow-wrap:anywhere] disabled:cursor-not-allowed disabled:opacity-50`;

/** A quiet text link-button ("Change…", "Compare all models"). */
export const BTN_LINK = `${RADIUS_CONTROL} ${FOCUS} ${TRANSITION} inline-flex min-h-11 min-w-0 max-w-full items-center gap-1 px-1.5 text-left text-[12.5px] font-semibold text-[var(--ds-ink)] underline decoration-[var(--ds-hairline)] underline-offset-2 hover:decoration-[var(--ds-ink)] [overflow-wrap:anywhere]`;

/** A square icon button (row details, back). */
export const BTN_ICON = `${RADIUS_CONTROL} ${FOCUS} ${TRANSITION} grid min-h-11 min-w-11 shrink-0 place-items-center text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)]`;

export type BadgeTone = 'current' | 'default' | 'experimental' | 'suggested';

const BADGE_TONE: Record<BadgeTone, string> = {
  current: `border ${TONE_CHIP.info}`,
  default: `${HAIRLINE} text-[var(--ds-muted)]`,
  experimental: `border ${TONE_CHIP.warning}`,
  suggested: `${HAIRLINE} ${ACCENT_SOFT_BG} text-[var(--ds-ink)]`
};

export const Badge: React.FC<{ tone: BadgeTone; children: React.ReactNode }> = ({ tone, children }) => (
  <span data-badge={tone} className={cx(RADIUS_PILL, 'inline-flex shrink-0 items-center whitespace-nowrap px-1.5 py-px text-[10.5px] font-semibold leading-4', BADGE_TONE[tone])}>
    {children}
  </span>
);
