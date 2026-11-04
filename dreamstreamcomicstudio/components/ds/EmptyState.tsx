/**
 * EmptyState — nothing here yet, or nothing matches (Atlas EmptyStatePanel): a title, why, and the
 * action that fills it. role="status", so a list that empties out is announced. `panel` (a centred dashed
 * card for an empty page or section), `bare` (the same inside a card), `inline` (a compact row for an
 * empty list inside a section).
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { INLINE_FRAME, INLINE_TITLE, PANEL_FRAME, SMALL_TILE, STATE_DESCRIPTION, STATE_TITLE, StateIconTile, type StateAction, type StateHeading, type StateVariant } from './stateParts';

export interface EmptyStateProps {
  title: string;
  description: React.ReactNode;
  icon?: React.ReactNode;
  action?: StateAction;
  secondaryAction?: StateAction;
  variant?: StateVariant;
  /** The title's heading level (h3 by default). */
  as?: StateHeading;
  className?: string;
}

export const EMPTY_FRAME: Record<StateVariant, string> = {
  panel: `${PANEL_FRAME} min-h-[320px] border border-dashed border-[var(--ds-hairline)] bg-[color:color-mix(in_srgb,var(--ds-well)_60%,transparent)]`,
  bare: `${PANEL_FRAME} min-h-[240px]`,
  inline: INLINE_FRAME
};

export function EmptyState({ title, description, icon, action, secondaryAction, variant = 'panel', as: H = 'h3', className }: EmptyStateProps) {
  if (variant === 'inline') {
    return (
      <div role="status" data-slot="empty-state" data-variant="inline" className={cn(EMPTY_FRAME.inline, className)}>
        {icon ? (
          <span aria-hidden="true" className={SMALL_TILE}>
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <H className={INLINE_TITLE}>{title}</H>
          <p className={cn(STATE_DESCRIPTION, 'mt-0.5')}>{description}</p>
          {action || secondaryAction ? (
            <div className="mt-3.5 flex flex-wrap items-center gap-2">
              {action ? (
                <Button size="sm" variant={action.variant ?? 'outline'} onClick={action.onClick}>
                  {action.label}
                </Button>
              ) : null}
              {secondaryAction ? (
                <Button size="sm" variant="ghost" onClick={secondaryAction.onClick}>
                  {secondaryAction.label}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div role="status" data-slot="empty-state" data-variant={variant} className={cn(EMPTY_FRAME[variant], className)}>
      {icon ? <StateIconTile>{icon}</StateIconTile> : null}
      <div className="max-w-xl space-y-2">
        <H className={STATE_TITLE}>{title}</H>
        <p className={STATE_DESCRIPTION}>{description}</p>
      </div>
      {action || secondaryAction ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {action ? (
            <Button variant={action.variant ?? 'default'} onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button variant="ghost" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
