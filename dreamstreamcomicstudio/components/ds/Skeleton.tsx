/**
 * Skeleton — a placeholder block while content loads (Atlas `ui-generated/skeleton.tsx`). It is the
 * `.studio-shimmer` block (index.css): the skeleton tokens with a page-colour glint under the skin, its
 * sweep off under reduced motion. Always hidden from assistive tech — pair a loading region with a
 * LoadingState or aria-busy that says what is coming. Size it with classes (h-4 w-32, size-10 …).
 */
import React from 'react';
import { cn } from '../../lib/utils';
import { RADIUS_CONTROL } from './recipes';

export type SkeletonShape = 'block' | 'text' | 'circle';

export const SKELETON_SHAPE: Record<SkeletonShape, string> = {
  block: RADIUS_CONTROL,
  text: 'h-4 rounded-[var(--ds-radius-sm)]',
  circle: 'rounded-full'
};

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  shape?: SkeletonShape;
}

export function Skeleton({ shape = 'block', className, ...rest }: SkeletonProps) {
  return <div {...rest} aria-hidden="true" data-slot="skeleton" className={cn('studio-shimmer', SKELETON_SHAPE[shape], className)} />;
}
