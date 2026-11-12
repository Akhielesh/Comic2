/**
 * Lightbox — one picture at a time, big, with its neighbours a key or a swipe away (redesign plan §4; it replaces
 * timeline/MediaPreview's frame, styles.md §7.3 M8). It is the CONTENT of a viewer, not an overlay: the screen puts
 * it in its dialog or sheet (DS-1c) and keeps the actions (Use for page, Star, Restore) beside it.
 *
 *   - ← / → (and Home / End) move when the viewer has focus; a horizontal swipe of 48 px moves on touch; Left and
 *     Right follow the reading direction (mirrored right-to-left);
 *   - the counter ("3 of 12") is a polite live region; the buttons say where they go and stop at the ends;
 *   - the picture is revealed on decode (RevealImage), letterboxed (object-contain) on the stage colour;
 *   - `compare` puts a second view beside the picture (an earlier version), side by side from 640 px and stacked
 *     below on phones;
 *   - it opens with `ds-scale-in` and cross-fades between pictures on --ds-motion-exit; under reduced motion it
 *     simply swaps (styles/ds-motion.css and a reduced-motion check before any animation).
 */
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { RevealImage } from './CoverImage';
import { IconButton } from './IconButton';
import { FOCUS_RING, RADIUS_PANEL } from './recipes';
import { isRtl } from './roving';
import { motionMs, playEntrance } from './useImageReveal';
import { useReducedMotion } from './useReducedMotion';

export interface LightboxItem {
  /** Stable identity (the stored path). */
  key: string;
  src?: string | null;
  alt: string;
  /** Under the picture ("Page 3 · Version 2"). */
  caption?: React.ReactNode;
  /** Replaces the default picture (a procedural tile, the blocked tile). */
  content?: React.ReactNode;
}

export interface LightboxProps {
  items: readonly LightboxItem[];
  index: number;
  onIndexChange: (index: number) => void;
  /** The viewer's accessible name ("Assets viewer"). */
  label: string;
  /** A second view beside the picture (compare with an earlier version). */
  compare?: React.ReactNode;
  className?: string;
}

/** A swipe moves when it travels this far sideways (and more sideways than up or down). */
export const SWIPE_MIN_PX = 48;

export function Lightbox({ items, index, onIndexChange, label, compare, className }: LightboxProps) {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const reduced = useReducedMotion();
  const count = items.length;
  const at = count ? Math.min(Math.max(0, index), count - 1) : 0;
  const item = count ? items[at] : null;
  const first = useRef(true);

  const go = (to: number) => {
    if (!count) return;
    const next = Math.min(Math.max(0, to), count - 1);
    if (next !== at) onIndexChange(next);
  };

  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced) return;
    const el = stage.current;
    const animation = playEntrance(el, [{ opacity: 0 }, { opacity: 1 }], {
      duration: motionMs(el, '--ds-motion-exit', 160),
      easing: 'ease-out'
    });
    return () => animation?.cancel();
  }, [item?.key]);

  useEffect(() => {
    // Keep a swipe that ends outside the viewer from leaking into the next one.
    const reset = () => (start.current = null);
    window.addEventListener('pointercancel', reset);
    return () => window.removeEventListener('pointercancel', reset);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const rtl = isRtl(root.current);
    if (e.key === 'ArrowRight') go(at + (rtl ? -1 : 1));
    else if (e.key === 'ArrowLeft') go(at + (rtl ? 1 : -1));
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(count - 1);
    else return;
    e.preventDefault();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (!s || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return;
    const rtl = isRtl(root.current);
    // Swiping left brings the next picture (the content follows the finger).
    go(at + ((dx < 0) !== rtl ? 1 : -1));
  };

  if (!item) {
    return (
      <div role="group" aria-roledescription="viewer" aria-label={label} className={cn('flex min-h-40 items-center justify-center p-6 text-[var(--ds-muted)]', className)}>
        Nothing to show yet
      </div>
    );
  }

  return (
    <div
      ref={root}
      role="group"
      aria-roledescription="viewer"
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      data-slot="lightbox"
      className={`${cn('ds-scale-in flex min-h-0 min-w-0 flex-col gap-3', className)} ${FOCUS_RING}`}
    >
      <div className={cn('grid min-h-0 min-w-0 flex-1 gap-3', compare ? 'grid-rows-2 sm:grid-cols-2 sm:grid-rows-1' : 'grid-cols-1')}>
        <figure className="relative m-0 flex min-h-0 min-w-0 flex-col gap-2">
          <div ref={stage} className={cn('relative min-h-48 w-full flex-1 overflow-hidden bg-[var(--ds-well)] touch-pan-y', RADIUS_PANEL)}>
            {item.content ??
              (item.src ? (
                <RevealImage key={item.key} src={item.src} alt={item.alt} revealKey={item.key} priority fit="contain" fallback={<span className="absolute inset-0 flex items-center justify-center text-[13px] text-[var(--ds-muted)]">Couldn't load this picture</span>} />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center text-[13px] text-[var(--ds-muted)]">{item.alt}</span>
              ))}
          </div>
          {item.caption ? <figcaption className="min-w-0 truncate text-[13px] leading-5 text-[var(--ds-muted)]">{item.caption}</figcaption> : null}
        </figure>
        {compare ? <div className="relative min-h-0 min-w-0">{compare}</div> : null}
      </div>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <IconButton label="Previous picture" variant="outline" disabled={at <= 0} onClick={() => go(at - 1)} data-lightbox="prev">
          <ChevronLeft />
        </IconButton>
        <span role="status" aria-live="polite" aria-atomic="true" data-slot="lightbox-counter" className="text-[13px] tabular-nums text-[var(--ds-muted)]">
          {`${at + 1} of ${count}`}
        </span>
        <IconButton label="Next picture" variant="outline" disabled={at >= count - 1} onClick={() => go(at + 1)} data-lightbox="next">
          <ChevronRight />
        </IconButton>
      </div>
    </div>
  );
}
