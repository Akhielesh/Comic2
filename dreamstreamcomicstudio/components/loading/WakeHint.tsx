/**
 * WakeHint — one calm line inside a loader while the studio server is starting (backendWake.ts): the
 * boot status probe has been pending for a few seconds, which is what a cold container looks like.
 * Muted ink, no hue and no icon: it explains a wait, it does not report a fault. Renders nothing at any
 * other time. Its loader is the live region (role="status"), so the line is announced when it appears.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { useBackendWake } from './backendWake';

export const WAKE_HINT_TEXT = 'Waking up the studio…';
export const WAKE_HINT_DETAIL = 'The first visit after a quiet spell takes a few seconds.';

export function WakeHint({ className }: { className?: string }) {
  const wake = useBackendWake();
  if (wake !== 'slow') return null;
  return (
    <p data-slot="wake-hint" className={cn('ds-fade-in m-0 text-balance text-[length:var(--ds-text-sm)] leading-5 text-ds-muted', className)}>
      <span className="font-medium text-ds-ink">{WAKE_HINT_TEXT}</span> {WAKE_HINT_DETAIL}
    </p>
  );
}
