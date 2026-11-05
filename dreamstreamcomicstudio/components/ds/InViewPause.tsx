/**
 * InViewPause — Atlas components/public/InViewPause.tsx: a plain element that holds the CSS loops inside it
 * (live dot, caret, marquee, loading shimmers) still while it is off screen (useInViewPause). Wrap a group of
 * loops with it when the loops themselves are not components (a `.ds-marquee` row, a hero's caret).
 */
import React, { useRef } from 'react';
import { useInViewPause } from './useInViewPause';

export type InViewPauseProps = React.HTMLAttributes<HTMLElement> & {
  /** The element to render; it hosts the loops (or contains them). */
  as?: 'div' | 'span' | 'section' | 'ul';
  children?: React.ReactNode;
};

export function InViewPause({ as = 'div', children, ...rest }: InViewPauseProps) {
  const ref = useRef<HTMLElement>(null);
  useInViewPause(ref);
  return React.createElement(as, { ...rest, ref }, children);
}
