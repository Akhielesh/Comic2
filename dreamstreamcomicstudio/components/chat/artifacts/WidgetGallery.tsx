import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

// Horizontal "scrolling gallery" for an assistant turn that produced MORE THAN ONE
// rich card. Instead of a tall vertical stack (a "scroll wall"), the cards live on a
// snap-scroll track with calm chrome: edge-fade overlays that appear only when there
// is more to scroll, hover/focus arrow buttons, and a row of progress dots (or a
// "n / N" counter for long sets). Each card keeps its own WidgetFrame chrome —
// this only owns the *layout* of multiple cards, never the cards themselves.
//
// House style: macOS "calm studio" glass, theme tokens (--ds-*), reduced-motion safe.

export interface GalleryItem {
  /** Stable React key for the card. */
  key: number;
  /** The fully-wrapped card node (WidgetFrame + boundary already applied upstream). */
  node: React.ReactNode;
  /** Wide/interactive cards (maps, itineraries, code) get a roomier column. */
  wide?: boolean;
}

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ARROW =
  'absolute top-1/2 z-20 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-full ' +
  'border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] text-[var(--ds-ink)] ' +
  'shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_var(--ds-hairline)] backdrop-blur-md ' +
  'opacity-0 transition-opacity duration-200 hover:bg-[var(--ds-hover)] ' +
  'group-hover/gallery:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-80';

export const WidgetGallery: React.FC<{ items: GalleryItem[] }> = ({ items }) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [overflow, setOverflow] = useState(false);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const [active, setActive] = useState(0);

  const measure = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    setOverflow(max > 4);
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft >= max - 2);
    // Active card = the one whose left edge sits nearest the track's left edge.
    const probe = el.scrollLeft + 24;
    let best = 0;
    let bestDist = Infinity;
    itemRefs.current.forEach((it, i) => {
      if (!it) return;
      const dist = Math.abs(it.offsetLeft - probe);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    });
    setActive(best);
  }, []);

  useLayoutEffect(measure, [measure, items.length]);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      ro?.disconnect();
    };
  }, [measure]);

  const scrollToItem = useCallback((i: number) => {
    const el = trackRef.current;
    const target = itemRefs.current[i];
    if (!el || !target) return;
    el.scrollTo({ left: Math.max(0, target.offsetLeft - 8), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const page = useCallback((dir: -1 | 1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.85, 280), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      page(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      page(-1);
    }
  };

  const showDots = items.length <= 10;

  return (
    <div className="group/gallery relative">
      <div
        ref={trackRef}
        role="group"
        aria-roledescription="carousel"
        aria-label={`${items.length} result cards`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="ds-gallery-track flex snap-x snap-proximity gap-3 overflow-x-auto rounded-2xl px-1 py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40"
      >
        {items.map((item, i) => (
          <div
            key={item.key}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            className={`ds-gallery-item min-w-0 shrink-0 snap-start ${
              item.wide ? 'w-[92%] sm:w-[34rem] lg:w-[38rem]' : 'w-[86%] sm:w-80'
            }`}
            style={prefersReducedMotion() ? undefined : { animationDelay: `${Math.min(i, 6) * 55}ms` }}
            role="group"
            aria-roledescription="slide"
            aria-label={`Card ${i + 1} of ${items.length}`}
          >
            {item.node}
          </div>
        ))}
      </div>

      {/* Edge fades — only when there is more to scroll in that direction. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-[var(--ds-canvas)] to-transparent transition-opacity duration-300 ${
          overflow && !atStart ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-[var(--ds-canvas)] to-transparent transition-opacity duration-300 ${
          overflow && !atEnd ? 'opacity-100' : 'opacity-0'
        }`}
      />

      {/* Arrow controls — revealed on hover/focus, hidden at the respective edge. */}
      {overflow && !atStart && (
        <button type="button" aria-label="Scroll to previous cards" onClick={() => page(-1)} className={`${ARROW} left-1`}>
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      {overflow && !atEnd && (
        <button type="button" aria-label="Scroll to more cards" onClick={() => page(1)} className={`${ARROW} right-1`}>
          <ChevronRight className="h-4 w-4" />
        </button>
      )}

      {/* Progress — dots for short sets, a compact counter for long ones. */}
      {overflow && (
        <div className="mt-1.5 flex items-center justify-center gap-1.5">
          {showDots ? (
            items.map((_, i) => (
              <button
                key={i}
                type="button"
                aria-label={`Go to card ${i + 1}`}
                aria-current={i === active}
                onClick={() => scrollToItem(i)}
                className={`h-1.5 rounded-full transition-all duration-200 ${
                  i === active ? 'w-4 bg-[var(--ds-accent)]' : 'w-1.5 bg-[var(--ds-faint)] hover:bg-[var(--ds-muted)]'
                }`}
              />
            ))
          ) : (
            <span className="text-[11px] tabular-nums text-[var(--ds-muted)]">
              {active + 1} / {items.length}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
