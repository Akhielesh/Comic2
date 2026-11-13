/**
 * ErrorState — something failed (Atlas ErrorStatePanel): what failed in plain words, why if known, and a
 * retry. role="alert". The danger edge and tint (STATUS_SURFACE.error) with the readable danger icon;
 * the words carry the meaning. `panel` or `inline`.
 */
import React from 'react';
import { AlertCircle } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { RADIUS_PANEL, STATUS_INK, STATUS_SURFACE } from './recipes';
import { INLINE_TITLE, PANEL_FRAME, STATE_DESCRIPTION, STATE_TITLE, StateIconTile, type StateHeading } from './stateParts';

export interface ErrorStateProps {
  /** What failed, plainly ("Your comics didn't load"). */
  title?: string;
  /** Why, if known, and what the person can do. */
  description?: React.ReactNode;
  retryLabel?: string;
  onRetry?: () => void;
  variant?: 'panel' | 'inline';
  as?: StateHeading;
  className?: string;
}

/**
 * The description: a string (or number) in a `<p>` as always; any other node (a MessageText, a list) in a `<div>` with
 * the same class, so a block never lands inside a `<p>` (invalid nesting). Nothing renders without one.
 */
function Description({ className, children }: { className: string; children: React.ReactNode }) {
  if (children === null || children === undefined || children === false || children === '') return null;
  return typeof children === 'string' || typeof children === 'number' ? <p className={className}>{children}</p> : <div className={className}>{children}</div>;
}

export function ErrorState({ title = 'Something went wrong', description, retryLabel = 'Try again', onRetry, variant = 'panel', as: H = 'h3', className }: ErrorStateProps) {
  if (variant === 'inline') {
    return (
      <div role="alert" data-slot="error-state" data-variant="inline" className={cn(`flex min-w-0 items-start gap-3 ${RADIUS_PANEL} border p-4`, STATUS_SURFACE.error, className)}>
        <AlertCircle aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', STATUS_INK.error)} />
        <div className="min-w-0 flex-1">
          <H className={INLINE_TITLE}>{title}</H>
          <Description className={cn(STATE_DESCRIPTION, 'mt-0.5')}>{description}</Description>
          {onRetry ? (
            <Button size="sm" variant="outline" className="mt-3" onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div role="alert" data-slot="error-state" data-variant="panel" className={cn(PANEL_FRAME, 'min-h-[260px] border', STATUS_SURFACE.error, className)}>
      <StateIconTile tone="error">
        <AlertCircle />
      </StateIconTile>
      <div className="max-w-xl space-y-2">
        <H className={STATE_TITLE}>{title}</H>
        <Description className={STATE_DESCRIPTION}>{description}</Description>
      </div>
      {onRetry ? (
        <div className="mt-6">
          <Button variant="outline" onClick={onRetry}>
            {retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
