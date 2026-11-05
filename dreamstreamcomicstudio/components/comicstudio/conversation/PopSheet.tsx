// Anchored glass sheet (composer option panels, header popovers) and the right-side
// slide-over (Settings). Both are focus-trapped, close on Esc (topmost first) and on a
// click outside, and hand focus back to whatever opened them.
//
// PopSheet has two strategies:
//   - 'absolute' (default): pops above/below its positioned parent, as before;
//   - 'fixed': portalled to <body> and placed from the anchor's rect, CLAMPED to the viewport
//     (12 px gutters) and flipped above/below when there is no room — header popovers on a phone
//     can never start at x = −160 again (visualqa P0-4).
// The adaptive version (bottom sheet on phones, side sheet on tablets) is
// mobile/sheets/AdaptiveSheet.tsx, which composes these primitives.

import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { HAIRLINE, SHADOW_SOFT, TRANSITION } from '../../chat/studioDesign';
import { useBackLayer } from '../mobile/backStack';
import { cx } from './ui';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Open sheets, innermost last — Esc closes only the top one.
const openStack: string[] = [];

/** Is this sheet the topmost open one? */
export const isTopSheet = (id: string): boolean => openStack[openStack.length - 1] === id;

const focusables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('data-focus-skip'));

export interface SheetBehaviourOptions {
  /** Close on a pointer down outside the sheet and its anchor (default true). */
  closeOnOutside?: boolean;
  /** Trap Tab inside the sheet (default true). Non-modal sheets turn it off. */
  trapFocus?: boolean;
  /** Move focus into the sheet on open (default true). */
  autoFocus?: boolean;
}

/** Shared behaviour: stack-aware Esc, outside click, focus trap + restore. */
export const useSheetBehaviour = (
  open: boolean,
  onClose: () => void,
  sheetRef: React.RefObject<HTMLElement | null>,
  anchorRef?: React.RefObject<HTMLElement | null>,
  closeOnOutsideOrOptions: boolean | SheetBehaviourOptions = true
): void => {
  const opts: SheetBehaviourOptions = typeof closeOnOutsideOrOptions === 'boolean' ? { closeOnOutside: closeOnOutsideOrOptions } : closeOnOutsideOrOptions;
  const closeOnOutside = opts.closeOnOutside !== false;
  const trapFocus = opts.trapFocus !== false;
  const autoFocus = opts.autoFocus !== false;
  const id = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    openStack.push(id);

    // Focus the selected/first control once mounted.
    const raf = autoFocus
      ? requestAnimationFrame(() => {
          const root = sheetRef.current;
          if (!root || root.contains(document.activeElement)) return;
          const preferred = root.querySelector<HTMLElement>('[data-autofocus],[aria-checked="true"],[aria-pressed="true"]');
          (preferred && !preferred.hasAttribute('disabled') ? preferred : focusables(root)[0] || root).focus({ preventScroll: true });
        })
      : 0;

    const onKey = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== id) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !trapFocus) return;
      const root = sheetRef.current;
      if (!root) return;
      const items = focusables(root);
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    const onPointer = (e: PointerEvent) => {
      if (!closeOnOutside || openStack[openStack.length - 1] !== id) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (sheetRef.current?.contains(target) || anchorRef?.current?.contains(target)) return;
      onCloseRef.current();
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
      const idx = openStack.lastIndexOf(id);
      if (idx !== -1) openStack.splice(idx, 1);
      // Hand focus back to the opener unless the user already moved it elsewhere.
      const active = document.activeElement;
      if (!active || active === document.body || sheetRef.current?.contains(active)) {
        try {
          previouslyFocused?.focus?.({ preventScroll: true });
        } catch {
          /* element gone */
        }
      }
    };
  }, [open, id, sheetRef, anchorRef, closeOnOutside, trapFocus, autoFocus]);
};

// ── Viewport-safe placement (pure, tested) ──────────────────────────────────

/** Gutter kept between a fixed popover and the viewport edge. */
export const SHEET_GUTTER = 12;

/** Left edge for a popover of `width` aligned to an anchor's right edge, clamped inside the viewport. */
export const clampSheetX = (anchorRight: number, width: number, vw: number, gutter = SHEET_GUTTER): number =>
  Math.round(Math.max(gutter, Math.min(anchorRight - width, vw - width - gutter)));

export interface SheetPlacement {
  left: number;
  top: number;
  width?: number;
  maxHeight: number;
  placement: 'above' | 'below';
  /** Set when the sheet is confined to one screen of a dual-screen device: the most it may grow to. */
  maxWidth?: number;
}

/** A horizontal span the sheet must stay inside (one screen of a dual-screen device). */
export interface SheetBounds {
  left: number;
  right: number;
}

/**
 * Dual-screen devices (side-by-side viewport segments): the screen that holds the anchor — a popover
 * never straddles the fold (mobile.md §3.6; P1-QA sheets-span-the-fold). Null on a single screen.
 */
export const segmentBoundsFor = (anchor: { left: number; right: number }, segments: readonly { left: number; right: number }[] | null | undefined): SheetBounds | null => {
  if (!segments || segments.length !== 2) return null;
  const cx = (anchor.left + anchor.right) / 2;
  const hit = segments.find((r) => cx >= r.left && cx < r.right) ?? (cx < segments[0].right ? segments[0] : segments[1]);
  return { left: hit.left, right: hit.right };
};

/**
 * Where a fixed popover goes: aligned to the anchor (start/end/stretch), clamped horizontally,
 * placed on the requested side and flipped when the other side has clearly more room.
 */
export const placeSheet = (
  anchor: { left: number; right: number; top: number; bottom: number },
  sheet: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: 'above' | 'below' = 'below',
  align: 'start' | 'end' | 'stretch' = 'end',
  gap = 8,
  gutter = SHEET_GUTTER,
  bounds: SheetBounds | null = null
): SheetPlacement => {
  const vw = Math.max(0, viewport.width);
  const vh = Math.max(0, viewport.height);
  // The span the sheet lives in: the viewport, or one screen of a dual-screen device.
  const lo = bounds ? Math.max(0, bounds.left) : 0;
  const hi = bounds ? Math.min(vw, bounds.right) : vw;
  const span = Math.max(0, hi - lo - gutter * 2);
  const width = align === 'stretch' ? Math.min(anchor.right - anchor.left, span) : Math.min(sheet.width, span);
  let left: number;
  if (align === 'end') left = Math.round(Math.max(lo + gutter, Math.min(anchor.right - width, hi - width - gutter)));
  else left = Math.round(Math.max(lo + gutter, Math.min(anchor.left, hi - width - gutter)));
  const roomBelow = vh - anchor.bottom - gap - gutter;
  const roomAbove = anchor.top - gap - gutter;
  let side = placement;
  if (side === 'below' && sheet.height > roomBelow && roomAbove > roomBelow) side = 'above';
  else if (side === 'above' && sheet.height > roomAbove && roomBelow > roomAbove) side = 'below';
  const room = Math.max(120, side === 'below' ? roomBelow : roomAbove);
  const height = Math.min(sheet.height, room);
  const top = side === 'below' ? anchor.bottom + gap : Math.max(gutter, anchor.top - gap - height);
  return {
    left,
    top: Math.round(top),
    ...(align === 'stretch' || (bounds && sheet.width > width) ? { width: Math.round(width) } : {}),
    maxHeight: Math.round(room),
    placement: side,
    ...(bounds ? { maxWidth: Math.round(span) } : {})
  };
};

// ── PopSheet ─────────────────────────────────────────────────────────────────

export interface PopSheetProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the sheet. */
  label: string;
  /** Element that toggles the sheet (clicks on it are not "outside"). */
  anchorRef?: React.RefObject<HTMLElement | null>;
  placement?: 'above' | 'below';
  align?: 'start' | 'end' | 'stretch';
  className?: string;
  children: React.ReactNode;
  /** 'absolute' (default): relative to the positioned parent. 'fixed': portalled, viewport-clamped (needs anchorRef). */
  strategy?: 'absolute' | 'fixed';
  /**
   * 'fixed' only: the viewport's side-by-side segments (a dual-screen device). The sheet stays on the
   * screen that holds its anchor instead of straddling the fold.
   */
  segments?: readonly { left: number; right: number }[] | null;
}

const SHEET_SURFACE = `max-h-[min(70vh,560px)] overflow-y-auto overscroll-contain rounded-2xl ${HAIRLINE} ${SHADOW_SOFT} bg-[var(--ds-surface-strong)] backdrop-blur-xl animate-scale-in focus:outline-none`;

/** A glass sheet that pops above (or below) its anchor. */
export const PopSheet: React.FC<PopSheetProps> = ({
  open,
  onClose,
  label,
  anchorRef,
  placement = 'above',
  align = 'stretch',
  className,
  children,
  strategy = 'absolute',
  segments
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const fixed = strategy === 'fixed' && !!anchorRef;
  const [pos, setPos] = useState<SheetPlacement | null>(null);
  // Read at placement time (a new array each render must not re-run the placement effect).
  const segRef = useRef(segments);
  segRef.current = segments;
  const segKey = segments && segments.length === 2 ? segments.map((r) => `${Math.round(r.left)}-${Math.round(r.right)}`).join('|') : '';
  useSheetBehaviour(open, onClose, ref, anchorRef);

  useLayoutEffect(() => {
    if (!open || !fixed || typeof window === 'undefined') return;
    const place = () => {
      const anchor = anchorRef?.current;
      const el = ref.current;
      if (!anchor || !el) return;
      const r = anchor.getBoundingClientRect();
      const vv = window.visualViewport;
      const viewport = { width: vv?.width || window.innerWidth, height: vv?.height || window.innerHeight };
      const bounds = segmentBoundsFor(r, segRef.current);
      const next = placeSheet(r, { width: el.offsetWidth || 320, height: el.scrollHeight || el.offsetHeight || 240 }, viewport, placement, align, 8, SHEET_GUTTER, bounds);
      setPos((cur) =>
        cur && cur.left === next.left && cur.top === next.top && cur.maxHeight === next.maxHeight && cur.width === next.width && cur.maxWidth === next.maxWidth ? cur : next
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place);
    };
  }, [open, fixed, anchorRef, placement, align, segKey]);

  if (!open) return null;

  if (fixed) {
    const node = (
      <div
        ref={ref}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        data-sheet="popover"
        className={cx(`fixed z-[86] ${SHEET_SURFACE}`, className)}
        style={
          pos
            ? {
                left: pos.left,
                top: pos.top,
                maxHeight: `min(${pos.maxHeight}px, 560px)`,
                ...(pos.width ? { width: pos.width } : {}),
                maxWidth: pos.maxWidth !== undefined ? pos.maxWidth : `calc(100vw - ${SHEET_GUTTER * 2}px)`
              }
            : { left: SHEET_GUTTER, top: -9999, visibility: 'hidden', maxWidth: `calc(100vw - ${SHEET_GUTTER * 2}px)` }
        }
      >
        {children}
      </div>
    );
    return typeof document !== 'undefined' ? createPortal(node, document.body) : node;
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-sheet="popover"
      className={cx(
        `absolute z-40 ${SHEET_SURFACE}`,
        placement === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
        align === 'stretch' ? 'left-0 right-0' : align === 'start' ? 'left-0' : 'right-0',
        className
      )}
    >
      {children}
    </div>
  );
};

// ── SlideOver ────────────────────────────────────────────────────────────────

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  /** Panel width in px (default 420; never wider than the viewport minus a 12 px gutter). */
  width?: number;
  side?: 'right' | 'left';
}

/** Side sheet over a dimmed backdrop (Settings). Safe-area aware; the back gesture closes it. */
export const SlideOver: React.FC<SlideOverProps> = ({ open, onClose, title, children, width = 420, side = 'right' }) => {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useSheetBehaviour(open, onClose, ref, undefined, false);
  useBackLayer(open, onClose, `slideover:${title}`);
  if (!open) return null;
  return (
    <div className={cx('fixed inset-0 z-[85] flex', side === 'right' ? 'justify-end' : 'justify-start')}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px] animate-fade-in" aria-hidden onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-sheet="side"
        className={cx(
          `relative flex h-full w-full flex-col ${HAIRLINE} border-y-0 bg-[var(--ds-canvas)] shadow-[0_0_48px_rgba(0,0,0,0.18)] studio-reveal focus:outline-none`,
          side === 'right' ? 'border-r-0' : 'border-l-0'
        )}
        style={{
          maxWidth: `min(${width}px, 100vw)`,
          paddingTop: 'var(--sa-top, 0px)',
          paddingBottom: 'var(--sa-bottom-eff, 0px)',
          ...(side === 'right' ? { paddingRight: 'var(--sa-right, 0px)' } : { paddingLeft: 'var(--sa-left, 0px)' })
        }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-[var(--ds-hairline-soft)] py-2 pl-5 pr-2">
          <h2 id={titleId} className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] coarse:h-11 coarse:w-11 ${TRANSITION}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">{children}</div>
      </div>
    </div>
  );
};
