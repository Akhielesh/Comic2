/**
 * Collapse — Atlas components/effects/Collapse.tsx: a height-animated disclosure body. It grows from 0 to its
 * natural height with a `grid-template-rows` transition (0fr → 1fr), so nothing is measured in JavaScript and
 * the content may keep changing height while open. On close it stays mounted for the exit (--ds-motion-exit,
 * 160 ms) and then unmounts, so a closed panel costs nothing and never leaves stale content behind. No
 * transform is involved, so position: fixed descendants (popovers, action bars) are safe. Under reduced motion
 * it opens and closes at once: no transition, no exit wait.
 */
import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { PRESENCE_EXIT_MS, usePresence } from './usePresence';
import { useReducedMotion } from './useReducedMotion';

export const COLLAPSE_BASE = 'grid transition-[grid-template-rows,opacity] ease-[var(--ds-ease)] motion-reduce:transition-none';
export const COLLAPSE_OPEN = 'grid-rows-[1fr] opacity-100 duration-[var(--ds-motion-slow)]';
export const COLLAPSE_CLOSED = 'grid-rows-[0fr] opacity-0 duration-[var(--ds-motion-exit)]';
/** After this the open body stops clipping, so shadows and focus rings at its edges show (the open time, 300 ms at most, plus a frame). */
export const COLLAPSE_SETTLE_MS = 320;

export interface CollapseProps {
  open: boolean;
  /** For aria-controls on the toggle. */
  id?: string;
  className?: string;
  innerClassName?: string;
  children: React.ReactNode;
  exitMs?: number;
}

export function Collapse({ open, id, className, innerClassName, children, exitMs = PRESENCE_EXIT_MS }: CollapseProps) {
  const reduced = useReducedMotion();
  const { mounted, shown } = usePresence(open, exitMs, reduced);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!shown) {
      setSettled(false);
      return;
    }
    if (reduced) {
      setSettled(true);
      return;
    }
    const timer = setTimeout(() => setSettled(true), COLLAPSE_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [shown, reduced]);

  if (!mounted) return null;
  return (
    <div
      id={id}
      data-slot="collapse"
      data-state={shown ? 'open' : 'closed'}
      // While closing, the body is still in the DOM for its exit; keep it out of the accessibility tree.
      aria-hidden={open ? undefined : true}
      className={cn(COLLAPSE_BASE, shown ? COLLAPSE_OPEN : COLLAPSE_CLOSED, className)}
    >
      <div className={cn('min-h-0', settled ? 'overflow-visible' : 'overflow-hidden', innerClassName)}>{children}</div>
    </div>
  );
}
