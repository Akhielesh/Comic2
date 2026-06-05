// Shimmer / Skeleton — loading placeholders with a sweeping shimmer. The shimmer is CSS
// (`.studio-shimmer` in index.css) so it runs continuously and cheaply, and is disabled
// under `prefers-reduced-motion` via the stylesheet's media query.

import React from 'react';

export interface SkeletonProps {
  className?: string;
  /** Render as a rounded pill instead of a rounded rectangle. */
  pill?: boolean;
}

/** A single shimmering placeholder block. Size it with className (w-/h-). */
export const Skeleton: React.FC<SkeletonProps> = ({ className, pill }) => (
  <div
    aria-hidden
    className={`studio-shimmer ${pill ? 'rounded-full' : 'rounded-md'} ${className ?? ''}`}
  />
);

export interface ShimmerProps {
  /** Number of placeholder lines. */
  lines?: number;
  className?: string;
}

/** A small stack of shimmering lines — a quick "content loading" affordance. */
export const Shimmer: React.FC<ShimmerProps> = ({ lines = 3, className }) => (
  <div className={`space-y-2 ${className ?? ''}`}>
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
    ))}
  </div>
);
