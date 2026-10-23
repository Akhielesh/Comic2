// BottomSheet (mobile.md §4.2): the phone presentation of every studio sheet.
//
//  - Portalled and `position: fixed`, sitting ON the keyboard (`bottom: var(--kb)`), never taller
//    than the visible app (`--app-h` − top safe area − 12 px); content pads the bottom safe area.
//  - A 36×4 grabber in a 52 px header that is also the drag zone (title + 44 px Close).
//  - Detents (peek / half / full / content / px / fraction). A release snaps by velocity: a flick
//    (> 600 px/s) moves one detent in its direction, otherwise the nearest; dragging well below the
//    lowest detent dismisses (when dismissible).
//  - The content scroller and the sheet drag are arbitrated like iOS: the sheet only follows a
//    finger moving DOWN while the content is scrolled to the top.
//  - Modal: scrim, aria-modal, focus trap + restore, Esc, and the back gesture closes it.
//    Non-modal: a labelled region with no scrim (the canvas behind stays interactive).
//  - Reduced motion: detents jump (no spring); the entrance is a plain fade.

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { HAIRLINE } from '../../../chat/studioDesign';
import { useSheetBehaviour } from '../../conversation/PopSheet';
import { useBackLayer } from '../backStack';
import { useFormFactor } from '../useFormFactor';
import { detentHeights, rubber, snapDetent, type SheetDetent } from './snap';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name. */
  label: string;
  /** Visible heading (optional; the label names the dialog either way). */
  title?: string;
  /** Default ['content']. */
  detents?: SheetDetent[];
  /** Index into `detents` to open at (default 0). */
  initialDetent?: number;
  /** Default true. */
  modal?: boolean;
  /** Drag-down / scrim / Esc may close it (default true). */
  dismissible?: boolean;
  /** Element that opened it (focus returns there). */
  anchorRef?: React.RefObject<HTMLElement | null>;
  onDetentChange?: (index: number) => void;
  className?: string;
  children: React.ReactNode;
}

const HEADER_PX = 52;
const DRAG_SLOP = 6;

type Pair = { detent: SheetDetent; h: number; index: number };

const availableHeight = (el: HTMLElement | null): number => {
  if (typeof window === 'undefined') return 600;
  if (el) {
    const mh = parseFloat(getComputedStyle(el).maxHeight);
    if (Number.isFinite(mh) && mh > 0) return mh;
  }
  const vv = window.visualViewport;
  return Math.max(200, (vv?.height || window.innerHeight || 600) - 12);
};

export const BottomSheet: React.FC<BottomSheetProps> = ({
  open,
  onClose,
  label,
  title,
  detents,
  initialDetent = 0,
  modal = true,
  dismissible = true,
  anchorRef,
  onDetentChange,
  className,
  children
}) => {
  const ff = useFormFactor();
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const list = useMemo<SheetDetent[]>(() => (detents && detents.length ? detents : ['content']), [detents]);
  const [index, setIndex] = useState(() => Math.min(Math.max(0, initialDetent), list.length - 1));
  const [dragH, setDragH] = useState<number | null>(null);
  const [avail, setAvail] = useState(600);
  const drag = useRef<{ y: number; h: number; samples: { y: number; t: number }[]; active: boolean; pointerId?: number } | null>(null);
  const suppressClick = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (open) setIndex(Math.min(Math.max(0, initialDetent), list.length - 1));
  }, [open, initialDetent, list.length]);

  const close = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  useSheetBehaviour(open, close, sheetRef, anchorRef, { closeOnOutside: false, trapFocus: modal, autoFocus: modal });
  useBackLayer(open && modal, onClose, `sheet:${label}`);

  // Available height follows the visible viewport (keyboard, rotation).
  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const measure = () => setAvail(availableHeight(sheetRef.current));
    measure();
    window.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('resize', measure);
    };
  }, [open]);

  const contentHeight = (): number => {
    const scroller = scrollerRef.current;
    const header = sheetRef.current?.querySelector<HTMLElement>('[data-sheet-header]');
    return (header?.offsetHeight || HEADER_PX) + (scroller?.scrollHeight || 0);
  };

  /** Detents as px, sorted, de-duplicated (a 'content' detent wins a tie: it stays auto-sized). */
  const pairs = (): Pair[] => {
    const content = contentHeight();
    const out: Pair[] = [];
    list.forEach((d, i) => {
      const [h] = detentHeights([d], avail, content);
      if (!h) return;
      const same = out.find((p) => Math.abs(p.h - h) < 1);
      if (same) {
        if (d === 'content') Object.assign(same, { detent: d, index: i });
        return;
      }
      out.push({ detent: d, h, index: i });
    });
    return out.sort((a, b) => a.h - b.h);
  };

  const current = list[index];
  const restingHeight = current === 'content' ? undefined : detentHeights([current], avail, 0)[0];

  const go = (i: number) => {
    setIndex(i);
    onDetentChange?.(i);
  };

  const startDrag = (y: number) => {
    const h = sheetRef.current?.getBoundingClientRect().height || restingHeight || 0;
    drag.current = { y, h, samples: [{ y, t: performance.now() }], active: false };
  };

  const moveDrag = (y: number): boolean => {
    const d = drag.current;
    if (!d) return false;
    const dy = y - d.y;
    if (!d.active && Math.abs(dy) < DRAG_SLOP) return false;
    d.active = true;
    const now = performance.now();
    d.samples.push({ y, t: now });
    while (d.samples.length > 2 && now - d.samples[0].t > 100) d.samples.shift();
    setDragH(Math.max(0, rubber(d.h - dy, 0, avail)));
    return true;
  };

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.active) {
      setDragH(null);
      return;
    }
    suppressClick.current = true;
    window.setTimeout(() => (suppressClick.current = false), 0);
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    const dt = Math.max(1, last.t - first.t);
    const velocity = ((last.y - first.y) / dt) * 1000;
    const h = sheetRef.current?.getBoundingClientRect().height || d.h;
    const ps = pairs();
    const target = snapDetent(h, velocity, ps.map((p) => p.h), { dismissible });
    setDragH(null);
    if (target < 0) onCloseRef.current();
    else go(ps[target].index);
  };

  // Header / grabber: pointer events (touch-action: none on the zone).
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startDrag(e.clientY);
    if (drag.current) drag.current.pointerId = e.pointerId;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current || drag.current.pointerId !== e.pointerId) return;
    if (moveDrag(e.clientY) && !(e.currentTarget as HTMLElement).hasPointerCapture?.(e.pointerId)) {
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / released pointer */
      }
    }
  };
  const onPointerUp = () => endDrag();

  // Content: follow a finger moving down only while the scroller is at the top (iOS behaviour).
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!open || !scroller) return;
    let startY = 0;
    let tracking = false;
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      tracking = scroller.scrollTop <= 0;
    };
    const onMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      if (!drag.current) {
        if (y - startY > DRAG_SLOP && scroller.scrollTop <= 0) startDrag(startY);
        else {
          if (y < startY) tracking = false; // scrolling the content up: not ours
          return;
        }
      }
      if (moveDrag(y) && e.cancelable) e.preventDefault();
    };
    const onEnd = () => {
      tracking = false;
      if (drag.current) endDrag();
    };
    scroller.addEventListener('touchstart', onStart, { passive: true });
    scroller.addEventListener('touchmove', onMove, { passive: false });
    scroller.addEventListener('touchend', onEnd);
    scroller.addEventListener('touchcancel', onEnd);
    return () => {
      scroller.removeEventListener('touchstart', onStart);
      scroller.removeEventListener('touchmove', onMove);
      scroller.removeEventListener('touchend', onEnd);
      scroller.removeEventListener('touchcancel', onEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, avail, list, dismissible]);

  // A focused field scrolls into view inside the sheet, never the document.
  const onFocusCapture = (e: React.FocusEvent) => {
    const scroller = scrollerRef.current;
    const target = e.target as HTMLElement;
    if (!scroller || !scroller.contains(target) || !target.getBoundingClientRect) return;
    const s = scroller.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    if (r.top < s.top) scroller.scrollTop -= s.top - r.top + 8;
    else if (r.bottom > s.bottom) scroller.scrollTop += r.bottom - s.bottom + 8;
  };

  const cycle = () => {
    if (suppressClick.current || list.length < 2) return;
    go((index + 1) % list.length);
  };

  if (!open || typeof document === 'undefined') return null;

  const dragging = dragH !== null;
  const height = dragging ? dragH : restingHeight;
  const motion = ff.reducedMotion || dragging ? '' : 'transition-[height] duration-200 ease-out';

  const sheet = (
    <div
      ref={sheetRef}
      role={modal ? 'dialog' : 'region'}
      aria-modal={modal || undefined}
      aria-label={label}
      tabIndex={-1}
      data-sheet="bottom"
      data-detent={typeof current === 'number' ? String(current) : current}
      onFocusCapture={onFocusCapture}
      className={cx(
        `fixed inset-x-0 z-[76] mx-auto flex w-full max-w-[640px] flex-col overflow-hidden rounded-t-[var(--sheet-radius,20px)] ${HAIRLINE} border-b-0 bg-[var(--ds-surface-strong)] shadow-[0_-8px_40px_rgba(0,0,0,0.18)] backdrop-blur-xl focus:outline-none`,
        ff.reducedMotion ? 'animate-fade-in' : 'studio-reveal',
        motion,
        className
      )}
      style={{
        bottom: 'var(--kb, 0px)',
        maxHeight: 'calc(var(--app-h, 100dvh) - var(--sa-top, 0px) - 12px)',
        ...(height !== undefined ? { height } : {}),
        paddingLeft: 'var(--sa-left, 0px)',
        paddingRight: 'var(--sa-right, 0px)'
      }}
    >
      <div
        data-sheet-header
        className="relative flex h-[52px] shrink-0 touch-none select-none items-center gap-2 pl-4 pr-1.5"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {list.length > 1 ? (
          // Several detents: the grabber is also a keyboard/screen-reader way to resize.
          <button
            type="button"
            onClick={cycle}
            aria-label="Resize sheet"
            data-hit-exempt="grabber: the whole 52 px header is its drag zone"
            className="absolute left-1/2 top-0 flex h-5 w-16 -translate-x-1/2 cursor-grab items-start justify-center pt-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
          >
            <span aria-hidden className="block h-1 w-9 rounded-full bg-[var(--ds-hairline)]" />
          </button>
        ) : (
          // One detent: a visual affordance only (drag the header down; Close and Esc are the accessible way out).
          <span aria-hidden data-sheet-grabber className="pointer-events-none absolute left-1/2 top-0 flex h-5 w-16 -translate-x-1/2 items-start justify-center pt-1.5">
            <span className="block h-1 w-9 rounded-full bg-[var(--ds-hairline)]" />
          </span>
        )}
        {title ? (
          <h2 id={titleId} className="min-w-0 flex-1 truncate pt-1.5 text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">
            {title}
          </h2>
        ) : (
          <span className="flex-1" />
        )}
        {(dismissible || !modal) && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="mt-1.5 grid h-11 w-11 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" style={{ paddingBottom: 'var(--sa-bottom-eff, 0px)' }}>
        {children}
      </div>
    </div>
  );

  return createPortal(
    modal ? (
      <>
        <div className="fixed inset-0 z-[75] bg-black/30 animate-fade-in" aria-hidden onClick={close} data-sheet-scrim />
        {sheet}
      </>
    ) : (
      sheet
    ),
    document.body
  );
};

export default BottomSheet;
