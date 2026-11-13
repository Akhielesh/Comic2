/**
 * The parts EmptyState, LoadingState and ErrorState share (Atlas WorkspacePrimitives' state panels): the
 * icon tile with its halo, the title and description type, and the panel / inline frames. Each state
 * says what happened in words and offers the next step; none relies on colour.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import type { ButtonVariant } from './Button';
import { RADIUS_CONTROL, RADIUS_PANEL, SHADOW_SOFT, STATUS_EDGE, STATUS_INK, WRAP_TEXT } from './recipes';

export type StateVariant = 'panel' | 'bare' | 'inline';

export interface StateAction {
  label: string;
  onClick: () => void;
  variant?: ButtonVariant;
}

const TILE_FACE = `relative flex size-14 items-center justify-center ${RADIUS_PANEL} border bg-gradient-to-b from-[var(--ds-canvas)] to-[var(--ds-well)] ${SHADOW_SOFT} dark:from-[var(--ds-hover)] dark:to-[var(--ds-raised)] [&_svg]:size-5`;
export const STATE_TILE: Record<'neutral' | 'error', string> = {
  neutral: `${TILE_FACE} border-[color:color-mix(in_srgb,var(--ds-hairline)_80%,transparent)] text-[var(--ds-muted)]`,
  error: `${TILE_FACE} ${STATUS_EDGE.error} ${STATUS_INK.error}`
};
const HALO: Record<'neutral' | 'error', string> = {
  neutral: 'bg-[color:color-mix(in_srgb,var(--ds-ink)_3.5%,transparent)]',
  error: 'bg-[var(--ds-status-error-tint)]'
};
export const SMALL_TILE = `flex size-9 shrink-0 items-center justify-center ${RADIUS_CONTROL} border border-[color:color-mix(in_srgb,var(--ds-hairline)_80%,transparent)] bg-[var(--ds-raised)] text-[var(--ds-muted)] ${SHADOW_SOFT} [&_svg]:size-4`;

/** The rounded tile that holds a state's icon: a soft raised square with a faint halo. */
export function StateIconTile({ tone = 'neutral', children }: { tone?: 'neutral' | 'error'; children: React.ReactNode }) {
  return (
    <div aria-hidden="true" className="relative mb-5">
      <span className={cn('absolute -inset-3 rounded-[1.4rem] opacity-70', HALO[tone])} />
      <div className={STATE_TILE[tone]}>{children}</div>
    </div>
  );
}

/**
 * Atlas's state panels set the 24 px title on a 28 px line (`text-2xl/7`), tighter than the TEXT_2XL
 * heading step (32 px): spelled here, not appended to TEXT_2XL, because this string is used without `cn`
 * and the step's leading-8 would win by CSS order.
 */
export const STATE_TITLE = `m-0 text-balance font-semibold tracking-[-0.03em] text-[var(--ds-ink)] text-[length:var(--ds-text-2xl)] leading-7 ${WRAP_TEXT}`;
export const STATE_DESCRIPTION = `m-0 text-pretty text-[length:var(--ds-text-base)] leading-6 text-[var(--ds-muted)] ${WRAP_TEXT}`;
export const INLINE_TITLE = `m-0 text-balance text-[0.9375rem] font-semibold leading-6 tracking-[-0.01em] text-[var(--ds-ink)] ${WRAP_TEXT}`;
export const PANEL_FRAME = `flex min-w-0 flex-col items-center justify-center ${RADIUS_PANEL} px-6 py-12 text-center`;
export const INLINE_FRAME = `flex min-w-0 items-start gap-3.5 ${RADIUS_PANEL} border border-dashed border-[var(--ds-hairline)] bg-[color:color-mix(in_srgb,var(--ds-well)_60%,transparent)] p-4 text-start sm:p-5`;

export type StateHeading = 'h2' | 'h3' | 'h4';

/** Spinner motion: it turns, and holds still under reduced motion. */
export const SPINNER = 'animate-spin motion-reduce:animate-none';
