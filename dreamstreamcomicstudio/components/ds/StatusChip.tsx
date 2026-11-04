/**
 * StatusChip — the one status vocabulary (Atlas connectors/status, studioDesign STATUS_*): healthy
 * (done, connected), active (working right now), waiting (queued, paused), attention (worth a look),
 * error (the person has to act). The words are required — hue only ever confirms them — and lead with
 * the state's dot (or an icon you pass). Ink, tint and edge come from STATUS_CHIP_TONE, which
 * tokenContrast.test.ts holds to ≥ 4.5:1 on its own surface in every theme.
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { STATUS_CHIP, STATUS_CHIP_TONE, STATUS_DOT, type StatusState } from './recipes';

export const STATUS_STATES: readonly StatusState[] = ['healthy', 'active', 'waiting', 'attention', 'error'];

export interface StatusChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  state: StatusState;
  /** Replaces the dot (decoration; the words say the state). */
  icon?: React.ReactNode;
  /** The state in words. */
  children: React.ReactNode;
}

export function StatusChip({ state, icon, className, children, ...rest }: StatusChipProps) {
  return (
    <span {...rest} data-slot="status-chip" data-state={state} className={cn(STATUS_CHIP, STATUS_CHIP_TONE[state], className)}>
      {icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0 [&_svg]:size-3">
          {icon}
        </span>
      ) : (
        <span aria-hidden="true" data-slot="status-dot" className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[state])} />
      )}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
