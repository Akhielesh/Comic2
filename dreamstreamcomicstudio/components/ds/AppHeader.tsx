/**
 * AppHeader — the app's sticky header (Atlas AuthenticatedAppHeader; redesign plan §4, §11.3 M1c). It is
 * plain at rest and frosts once the page scrolls under it: STICKY_HEADER on the <header>, HEADER_GLASS on an
 * aria-hidden first layer that follows `data-scrolled` (the blur lives on that layer, never on the header
 * itself, so a position: fixed descendant such as a dropdown is never trapped by it).
 *
 * One grid, shared with AppHeaderSkeleton (Atlas components/shell/header-layout.ts): brand · nav · actions.
 * The skeleton paints the same grid with placeholders, so the real header replaces it without anything
 * moving. The row is the chrome height token (`--header-h`: 56 px, 48 px under 600 px wide, 44 px on a
 * phone in landscape or the studio's phone chrome) and the gutter follows the redesign plan's §5.1 steps
 * (16 / 24 / 32 px).
 *
 * `useScrolledPast` is Atlas's reading of the window scroll: at most once per animation frame, re-rendering
 * only when the answer flips, never read while mounting.
 */
import React, { useEffect, useState } from 'react';
import { cn } from '../../lib/utils';
import { HEADER_GLASS, STICKY_HEADER } from './recipes';
import { Skeleton } from './Skeleton';

/** The header row's grid: brand, a flexible middle for the nav, actions. */
export const HEADER_GRID = 'grid min-h-[var(--header-h,56px)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2 sm:gap-x-3';

/** Where each part sits in HEADER_GRID (the skeleton puts its placeholders in the same cells). */
export const HEADER_REGION = {
  brand: 'col-start-1 row-start-1 flex min-w-0 items-center gap-2',
  nav: 'col-start-2 row-start-1 flex min-w-0 items-center justify-center',
  actions: 'col-start-3 row-start-1 flex min-w-0 items-center justify-end gap-1 sm:gap-2'
} as const;
export type HeaderRegion = keyof typeof HEADER_REGION;

/** The header's centred column: the page width and the §5.1 gutters. */
export const HEADER_INNER = 'mx-auto w-full max-w-7xl px-4 medium:px-6 xl:px-8';

/** Whether the window has scrolled more than `threshold` px (Atlas useScrolledPast). Off when `enabled` is false. */
export function useScrolledPast(threshold = 4, enabled = true): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    let frame = 0;
    const read = () => {
      frame = 0;
      setScrolled(window.scrollY > threshold);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(read);
    };
    schedule();
    window.addEventListener('scroll', schedule, { passive: true });
    return () => {
      window.removeEventListener('scroll', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [threshold, enabled]);
  return enabled && scrolled;
}

export interface AppHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'children'> {
  /** The brand lockup (home link). */
  brand: React.ReactNode;
  /** The middle: the product nav on wide screens (hide it below the width it fits at). */
  nav?: React.ReactNode;
  /** The right side: account, notifications, the phone menu toggle. */
  actions?: React.ReactNode;
  /** A line above the row (an announcement); it scrolls away with the page. */
  banner?: React.ReactNode;
  /** Below the row, inside the header (the phone menu panel). */
  children?: React.ReactNode;
  /**
   * The frosted state. By default the window scroll decides (useScrolledPast); pass it when the page
   * scrolls another element.
   */
  scrolled?: boolean;
  /** Extra classes for the centred column (a wider or narrower page). */
  innerClassName?: string;
}

export const AppHeader = React.forwardRef<HTMLElement, AppHeaderProps>(function AppHeader(
  { brand, nav, actions, banner, children, scrolled, innerClassName, className, ...rest },
  ref
) {
  const pastTop = useScrolledPast(4, scrolled === undefined);
  const frosted = scrolled ?? pastTop;
  return (
    <header {...rest} ref={ref} data-slot="app-header" data-scrolled={frosted ? 'true' : 'false'} className={cn(STICKY_HEADER, className)}>
      <div aria-hidden="true" data-slot="app-header-glass" className={HEADER_GLASS} />
      {banner}
      <div className={cn(HEADER_INNER, innerClassName)}>
        <div data-slot="app-header-grid" className={HEADER_GRID}>
          <div data-region="brand" className={HEADER_REGION.brand}>
            {brand}
          </div>
          <div data-region="nav" className={HEADER_REGION.nav}>
            {nav}
          </div>
          <div data-region="actions" className={HEADER_REGION.actions}>
            {actions}
          </div>
        </div>
      </div>
      {children}
    </header>
  );
});

export interface AppHeaderSkeletonProps {
  /** Spoken while the page loads (the placeholders themselves are hidden from assistive tech). */
  label?: string;
  /** How many nav placeholders the middle shows from `lg` up (the real nav's count; 0 for none). */
  navItems?: number;
  /** How many action placeholders sit on the right (the real header's count). */
  actionItems?: number;
  className?: string;
  innerClassName?: string;
}

/**
 * The header in its resting shape while the page loads (Atlas WorkspaceBootSkeleton's header): the same
 * <header>, glass layer, column and grid as AppHeader, with placeholder blocks where the brand, the nav and
 * the actions will land. Static (no entrance), so it shows from the first frame.
 */
export function AppHeaderSkeleton({ label = 'Loading…', navItems = 4, actionItems = 2, className, innerClassName }: AppHeaderSkeletonProps) {
  return (
    <header data-slot="app-header-skeleton" data-scrolled="false" aria-busy="true" className={cn(STICKY_HEADER, className)}>
      <div aria-hidden="true" data-slot="app-header-glass" className={HEADER_GLASS} />
      <span className="sr-only">{label}</span>
      <div className={cn(HEADER_INNER, innerClassName)}>
        <div data-slot="app-header-grid" className={HEADER_GRID}>
          <div data-region="brand" aria-hidden="true" className={HEADER_REGION.brand}>
            <Skeleton className="size-7 shrink-0" />
            <Skeleton shape="text" className="hidden w-28 sm:block" />
          </div>
          <div data-region="nav" aria-hidden="true" className={HEADER_REGION.nav}>
            {navItems > 0 ? (
              <span className="hidden items-center gap-1 lg:flex">
                {Array.from({ length: navItems }, (_, i) => (
                  <Skeleton key={i} shape="text" className="h-7 w-20" />
                ))}
              </span>
            ) : null}
          </div>
          <div data-region="actions" aria-hidden="true" className={HEADER_REGION.actions}>
            {Array.from({ length: actionItems }, (_, i) => (
              <Skeleton key={i} shape="circle" className="size-8 coarse:size-11" />
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}
