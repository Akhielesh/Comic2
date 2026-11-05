/**
 * LiveDot — Atlas components/effects/LiveDot.tsx: the live-status dot (`.ds-live-dot`, styles/ds-motion.css)
 * in its own colour (`currentColor`: put a tone ink on it or its parent). Its soft ping holds still while the
 * dot is scrolled out of view or the tab is in the background (useInViewPause) and picks up again when it is
 * back; reduced motion stops the ping entirely. The dot is decoration: the text beside it says what is live.
 * `settle` pings three times on arrival, then rests (a decorative dot, not a live state).
 */
import React, { useRef } from 'react';
import { cn } from '../../lib/utils';
import { useInViewPause } from './useInViewPause';

export type LiveDotProps = Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> & { settle?: boolean };

export function LiveDot({ className, settle = false, ...rest }: LiveDotProps) {
  const ref = useRef<HTMLSpanElement>(null);
  useInViewPause(ref);
  return <span aria-hidden="true" data-slot="live-dot" {...rest} ref={ref} className={cn('ds-live-dot', settle && 'ds-live-dot-settle', className)} />;
}
