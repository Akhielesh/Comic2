import React from 'react';
import type { CostText } from './costView';

/**
 * One cost figure or phrase from costView. While the viewer's allowance is still loading (at most
 * ALLOWANCE_WAIT_MS) it is a quiet skeleton the size of a short phrase, so a table never waits on it.
 * A dollar figure always says what it is: its note is the tooltip, and `withNote` also prints the short
 * form after a short figure ("$15.00/M out · list price", "$15.00/M out · your key"), for places where
 * nothing else on screen labels it.
 */
export const CostValue: React.FC<{ cost: CostText; form?: 'short' | 'sentence'; withNote?: boolean; className?: string }> = ({
  cost,
  form = 'short',
  withNote = false,
  className = ''
}) => {
  if (cost.mode === 'loading') {
    return (
      <span className={`inline-flex align-middle ${className}`} data-cost-loading>
        <span aria-hidden className={`inline-block h-3 ${form === 'sentence' ? 'w-40' : 'w-16'} animate-pulse rounded bg-[var(--ds-well)]`} />
        <span className="sr-only">Loading usage</span>
      </span>
    );
  }
  if (form === 'sentence') return <span className={className}>{cost.sentence}</span>;
  const note = cost.mode === 'dollars' && cost.note ? cost.note : '';
  return (
    <span className={className} title={note ? note[0].toUpperCase() + note.slice(1) : undefined}>
      {cost.short}
      {withNote && note && cost.noteShort && <span className="font-normal text-[var(--ds-muted)]"> · {cost.noteShort}</span>}
    </span>
  );
};
