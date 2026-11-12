/**
 * Shelf — a titled row of cards that scrolls sideways (redesign plan §4; Discover's home, the studio Home): an `<h2>`,
 * "See all", a snap scroller and, on fine pointers only, ← → buttons that move it by a page. On touch the row is
 * swiped (no arrows to miss with a thumb). The scroller fades its content at an edge only while there is more to
 * scroll that way (`ds-fade-edge-x`, styles/ds-motion.css).
 *
 *   empty    renders NOTHING: Discover hides empty rails, never shows one with a "no results" line;
 *   loading  one row of skeleton cards at the shelf's card width;
 *   error    an inline row "Couldn't load {title} · Retry" (the rest of the page keeps working).
 *
 * The arrows say where they go ("Scroll Trending left"), are disabled at the ends, and jump instead of gliding
 * under reduced motion. Below the fold a shelf can skip rendering work until it is near (`deferRender`:
 * content-visibility:auto with its intrinsic height). Cards are list items; the shelf's heading is h2 so a
 * card's h3 follows it (§9 headings: h1 page → h2 shelf → h3 card).
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Skeleton } from './Skeleton';
import { useReducedMotion } from './useReducedMotion';

/** Whether the primary pointer is fine (a mouse or trackpad): the shelf arrows only show there. Live. */
export function useFinePointer(): boolean {
  const query = '(pointer: fine)';
  const read = () => {
    try {
      return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [fine, setFine] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const sync = () => setFine(mq.matches);
    sync();
    mq.addEventListener?.('change', sync);
    return () => mq.removeEventListener?.('change', sync);
  }, []);
  return fine;
}

export interface ShelfProps<T> {
  title: string;
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  /** The card width in px (layout.ts `discover.shelfCardPx`). */
  cardPx: number;
  /** "See all" (a link with href, or a button). */
  seeAll?: { href?: string; onClick?: () => void; label?: string };
  loading?: boolean;
  /** The shelf failed to load: an inline row with Retry instead of the cards. */
  error?: boolean;
  onRetry?: () => void;
  /** Below the fold: skip layout and paint until it is near (content-visibility:auto). */
  deferRender?: boolean;
  /** How many skeleton cards to show while loading. */
  skeletonCount?: number;
  className?: string;
}

export function Shelf<T>({ title, items, getKey, renderItem, cardPx, seeAll, loading = false, error = false, onRetry, deferRender = false, skeletonCount = 4, className }: ShelfProps<T>) {
  const headingId = useId();
  const fine = useFinePointer();
  const reduced = useReducedMotion();
  const scroller = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const at = Math.abs(el.scrollLeft);
    setEdges((prev) => {
      const next = { start: at <= 1, end: at >= max - 1 };
      return prev.start === next.start && prev.end === next.end ? prev : next;
    });
  }, []);

  useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, items.length]);

  if (!loading && !error && items.length === 0) return null;

  const page = (dir: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    const rtl = typeof window !== 'undefined' && window.getComputedStyle(el).direction === 'rtl';
    const by = Math.max(cardPx, el.clientWidth - cardPx) * dir * (rtl ? -1 : 1);
    if (typeof el.scrollBy === 'function') el.scrollBy({ left: by, behavior: reduced ? 'auto' : 'smooth' });
    else el.scrollLeft += by;
  };

  const seeAllControl = seeAll && (seeAll.href || seeAll.onClick) && !error && items.length > 0 ? (
    seeAll.href ? (
      <a href={seeAll.href} className="text-[13px] font-medium text-[var(--ds-ink)] underline-offset-4 hover:underline">
        {seeAll.label ?? 'See all'}
      </a>
    ) : (
      <Button variant="link" size="sm" onClick={seeAll.onClick}>
        {seeAll.label ?? 'See all'}
      </Button>
    )
  ) : null;

  return (
    <section
      aria-labelledby={headingId}
      data-slot="shelf"
      className={cn('flex min-w-0 flex-col gap-2', className)}
      style={deferRender ? { contentVisibility: 'auto', containIntrinsicSize: `auto ${Math.round(cardPx * 1.5 + 96)}px` } : undefined}
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <h2 id={headingId} className="m-0 min-w-0 truncate text-[length:var(--ds-text-lg)] font-semibold leading-6 text-[var(--ds-ink)]">
          {title}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {seeAllControl}
          {fine && !error && items.length > 0 ? (
            <>
              <IconButton label={`Scroll ${title} left`} size="sm" disabled={edges.start} onClick={() => page(-1)} data-shelf-arrow="prev">
                <ChevronLeft />
              </IconButton>
              <IconButton label={`Scroll ${title} right`} size="sm" disabled={edges.end} onClick={() => page(1)} data-shelf-arrow="next">
                <ChevronRight />
              </IconButton>
            </>
          ) : null}
        </div>
      </div>
      {error ? (
        <div role="alert" data-slot="shelf-error" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-[var(--ds-muted)]">
          <span>Couldn't load {title}</span>
          {onRetry ? (
            <>
              <span aria-hidden="true">·</span>
              <Button variant="link" size="sm" onClick={onRetry} className="h-auto p-0">
                Retry
              </Button>
            </>
          ) : null}
        </div>
      ) : (
        <ul
          ref={scroller}
          role="list"
          aria-labelledby={headingId}
          aria-busy={loading || undefined}
          onScroll={measure}
          className="ds-fade-edge-x m-0 flex min-w-0 list-none snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth p-0 pb-1 motion-reduce:scroll-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {loading
            ? Array.from({ length: Math.max(1, skeletonCount) }, (_, i) => (
                <li key={`skeleton-${i}`} className="shrink-0 snap-start" style={{ width: cardPx }} aria-hidden="true">
                  <Skeleton className="w-full" style={{ aspectRatio: '2 / 3' }} />
                  <Skeleton className="mt-2 h-4 w-3/4" />
                </li>
              ))
            : items.map((item, i) => (
                <li key={getKey(item, i)} className="shrink-0 snap-start" style={{ width: cardPx }}>
                  {renderItem(item, i)}
                </li>
              ))}
        </ul>
      )}
    </section>
  );
}
