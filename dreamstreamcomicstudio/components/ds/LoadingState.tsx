/**
 * LoadingState — a surface is loading (Atlas LoadingStatePanel): a spinner that holds still under
 * reduced motion, and words, so a screen reader hears it too (role="status"). `panel` or `inline`. Set
 * aria-busy on the region being loaded, not on this.
 */
import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { PANEL_FRAME, SPINNER, STATE_DESCRIPTION, STATE_TITLE, StateIconTile, type StateHeading } from './stateParts';

export interface LoadingStateProps {
  /** What is loading, in words ("Loading your comics…"). */
  title?: string;
  description?: React.ReactNode;
  variant?: 'panel' | 'inline';
  as?: StateHeading;
  className?: string;
}

export function LoadingState({ title = 'Loading…', description, variant = 'panel', as: H = 'h3', className }: LoadingStateProps) {
  if (variant === 'inline') {
    return (
      <div role="status" data-slot="loading-state" data-variant="inline" className={cn('flex min-w-0 items-center gap-2 py-2 text-[length:var(--ds-text-base)] text-[var(--ds-muted)]', className)}>
        <Loader2 aria-hidden="true" className={cn('size-4 shrink-0', SPINNER)} />
        <span className="min-w-0">{title}</span>
      </div>
    );
  }
  return (
    <div
      role="status"
      data-slot="loading-state"
      data-variant="panel"
      className={cn(PANEL_FRAME, `min-h-[240px] border border-[color:color-mix(in_srgb,var(--ds-hairline)_80%,transparent)] bg-[var(--ds-surface)]`, className)}
    >
      <StateIconTile>
        <Loader2 className={SPINNER} />
      </StateIconTile>
      <div className="max-w-xl space-y-2">
        <H className={STATE_TITLE}>{title}</H>
        {description ? <p className={STATE_DESCRIPTION}>{description}</p> : null}
      </div>
    </div>
  );
}
