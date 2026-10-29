// Small building blocks shared by the Insights tabs (models.md §4.7 layout rules): --ds-* tokens through the
// studioDesign constants, calm glass, tabular figures, rows that wrap instead of widening the card (no horizontal
// overflow from 320 px), 44 px targets on touch, and every figure next to its source.

import React from 'react';
import { LABEL, RADIUS_CONTROL, RADIUS_PILL, TRANSITION } from '../../chat/studioDesign';
import { cx } from '../conversation/ui';

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]';

/** Long words (model ids, provider names, notes) break instead of widening the card. */
export const WRAP = '[overflow-wrap:anywhere]';

/** A quiet section with a small-caps heading. */
export const Section: React.FC<{ title: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; className?: string; label?: string }> = ({
  title,
  aside,
  children,
  className,
  label
}) => (
  <section aria-label={label} className={cx('min-w-0', className)}>
    <div className="mb-1 flex min-w-0 flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
      <h4 className={cx(LABEL, 'min-w-0', WRAP)}>{title}</h4>
      {aside && <span className={cx('min-w-0 text-[11px] text-[var(--ds-muted)]', WRAP)}>{aside}</span>}
    </div>
    {children}
  </section>
);

/** Label on the left, figure on the right; wraps under the label when the row is narrow. */
export const Fact: React.FC<{ label: React.ReactNode; value: React.ReactNode; note?: React.ReactNode; title?: string; className?: string }> = ({
  label,
  value,
  note,
  title,
  className
}) => (
  <div className={cx('flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-1', className)}>
    <span className={cx('min-w-0 flex-1 basis-40 text-[12px] text-[var(--ds-ink)]', WRAP)}>{label}</span>
    <span className={cx('min-w-0 max-w-full text-right text-[12.5px] font-semibold tabular-nums text-[var(--ds-ink)]', WRAP)} title={title}>
      {value}
    </span>
    {note && <span className={cx('block w-full min-w-0 text-[11px] text-[var(--ds-muted)]', WRAP)}>{note}</span>}
  </div>
);

/** A quiet badge ("2K", "older model", "Current"). */
export const Badge: React.FC<{ children: React.ReactNode; className?: string; title?: string }> = ({ children, className, title }) => (
  <span
    title={title}
    className={cx(
      `inline-flex shrink-0 items-center ${RADIUS_PILL} border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-1.5 py-px text-[10.5px] font-medium leading-4 text-[var(--ds-muted)]`,
      className
    )}
  >
    {children}
  </span>
);

/** A muted line naming where figures come from and when ("OpenRouter · 14:05"). */
export const Source: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <p className={cx('mt-1 min-w-0 text-[10.5px] leading-snug text-[var(--ds-muted)]', WRAP, className)}>{children}</p>
);

/** A text button (links to the picker, retries) — a real 44 px target on touch. */
export const TextButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ className, children, ...rest }) => (
  <button
    type="button"
    {...rest}
    className={cx(
      `inline-flex items-center gap-1 ${RADIUS_CONTROL} px-1 text-[12px] font-medium text-[var(--ds-ink)] underline decoration-dotted underline-offset-2 hover:bg-[var(--ds-hover)] ${TRANSITION} ${FOCUS} disabled:opacity-50 coarse:min-h-11 coarse:px-2`,
      className
    )}
  >
    {children}
  </button>
);
