/**
 * SpotlightGroup — Atlas components/effects/Spotlight.tsx: a plain element that lights every `.ds-spotlight`
 * card (and `.ds-spotlight-grid` layer) inside it with one shared pointer (useSpotlight). Decoration only.
 */
import React, { useRef } from 'react';
import { useSpotlight } from './useSpotlight';
import './landing.css';

export type SpotlightGroupProps = React.HTMLAttributes<HTMLElement> & {
  as?: 'div' | 'section' | 'ul';
  children?: React.ReactNode;
};

export function SpotlightGroup({ as = 'div', children, ...rest }: SpotlightGroupProps) {
  const ref = useRef<HTMLElement>(null);
  useSpotlight(ref);
  return React.createElement(as, { ...rest, ref }, children);
}
