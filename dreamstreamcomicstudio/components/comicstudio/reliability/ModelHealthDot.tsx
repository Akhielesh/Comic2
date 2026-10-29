// ModelHealthDot (reliability.md §3): a small status dot with a word and a tooltip naming the source and the
// time ("Paused · OpenRouter status, 2 min ago"). Used by the banner, the outage card, the admin section, and
// exported for the model picker / insights rows (models.md). Never colour alone: the state word is always in
// the accessible name, and visible unless `hideLabel`.

import React from 'react';
import type { HealthState, ModelHealth } from '../../../shared/comic/modelHealth';
import { TONE_FILL, TONE_TEXT } from '../../chat/studioDesign';
import { cx } from '../conversation/ui';
import { STATE_TONE, STATE_WORD, sourceLine } from './copy';

export interface ModelHealthDotProps {
  /** The model's health (state + source/time for the tooltip). */
  health?: ModelHealth | null;
  /** A bare state (when there is no ModelHealth, e.g. one route). Ignored when `health` is given. */
  state?: HealthState;
  /** Hide the visible word (it stays in the accessible name and the tooltip). */
  hideLabel?: boolean;
  /** Prefix for the accessible name, e.g. the model's nickname. */
  label?: string;
  className?: string;
  now?: number;
}

export const ModelHealthDot: React.FC<ModelHealthDotProps> = ({ health, state, hideLabel, label, className, now }) => {
  const s: HealthState = health?.state ?? state ?? 'unknown';
  const tone = STATE_TONE[s];
  const word = STATE_WORD[s];
  const source = health ? sourceLine(health, now ?? Date.now()) : undefined;
  const tip = source ? `${word} · ${source}` : word;
  return (
    <span
      className={cx('inline-flex min-w-0 items-center gap-1.5', className)}
      title={tip}
      data-health={s}
      role="img"
      aria-label={`${label ? `${label}: ` : ''}${tip}`}
    >
      <span className={cx('h-2 w-2 shrink-0 rounded-full', TONE_FILL[tone], s === 'degraded' && 'motion-safe:animate-pulse')} aria-hidden />
      {!hideLabel && (
        <span aria-hidden className={cx('min-w-0 truncate text-[12px] font-medium', s === 'ok' || s === 'unknown' ? 'text-[var(--ds-muted)]' : TONE_TEXT.warning)}>
          {word}
        </span>
      )}
    </span>
  );
};

export default ModelHealthDot;
