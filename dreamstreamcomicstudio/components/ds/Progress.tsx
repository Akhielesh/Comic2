/**
 * Progress — Atlas `ui-generated/progress.tsx`: an 8 px track tinted with the accent and the accent bar
 * (or a status dot colour when a `tone` says what the progress means). role progressbar with its range;
 * without a `value` it is indeterminate (no aria-valuenow, a third-width bar that pulses; it holds still
 * under reduced motion). The bar grows by width, so it fills from the reading start in either direction, on
 * the slow entrance time (instant under reduced motion). Forced colours (Atlas): the track is outlined in
 * the text colour and the bar drawn in the system highlight, since both fills are painted over there.
 * Name it with `label` (or aria-labelledby).
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { STATUS_DOT, type StatusState } from './recipes';

export type ProgressSize = 'sm' | 'default';

export const PROGRESS_TRACK =
  'relative w-full overflow-hidden rounded-full bg-[color:color-mix(in_srgb,var(--ds-accent)_15%,transparent)] forced-colors:border forced-colors:border-[CanvasText]';
export const PROGRESS_SIZE: Record<ProgressSize, string> = { sm: 'h-1', default: 'h-2' };
export const PROGRESS_BAR =
  'h-full rounded-full transition-[width] duration-[var(--ds-motion-enter-slow)] ease-[var(--ds-ease)] motion-reduce:transition-none forced-colors:[forced-color-adjust:none] forced-colors:bg-[Highlight]';

export interface ProgressProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 0…max; omit (or null) while the amount is unknown. */
  value?: number | null;
  max?: number;
  /** The accessible name. */
  label?: string;
  /** The spoken value (aria-valuetext), e.g. "3 of 12 pages". */
  valueText?: string;
  /** Colour the bar by what it means (a status dot colour); the accent by default. */
  tone?: StatusState;
  size?: ProgressSize;
}

export function Progress({ value, max = 100, label, valueText, tone, size = 'default', className, ...rest }: ProgressProps) {
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const clamped = determinate ? Math.min(max, Math.max(0, value as number)) : 0;
  const pct = max > 0 ? (clamped / max) * 100 : 0;
  return (
    <div
      {...rest}
      role="progressbar"
      aria-label={label ?? rest['aria-label']}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={determinate ? clamped : undefined}
      aria-valuetext={valueText}
      data-slot="progress"
      data-state={!determinate ? 'indeterminate' : clamped >= max ? 'complete' : 'loading'}
      className={cn(PROGRESS_TRACK, PROGRESS_SIZE[size], className)}
    >
      <div
        data-slot="progress-bar"
        className={cn(PROGRESS_BAR, tone ? STATUS_DOT[tone] : 'bg-[var(--ds-accent)]', !determinate && 'w-1/3 motion-safe:animate-pulse')}
        style={determinate ? { width: `${pct}%` } : undefined}
      />
    </div>
  );
}
