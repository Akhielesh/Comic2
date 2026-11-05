// TouchCanvas (contract §13.3; mobile.md §5.1): custom pinch-zoom and pan for the page editor and the
// readers — a CSS transform on our own stage, never browser zoom (which would also scale the chrome).
//
//  - Two fingers: pinch + pan around the midpoint (the content under your fingers stays under them).
//    The moment a second finger lands, the current owner (a balloon drag, a Mark-up box) is
//    PREEMPTED through the GestureArbiter: its draft reverts, nothing is committed.
//  - One finger on the art pans when zoomed (`oneFingerPan: 'whenZoomed'`), unless a child owns the
//    gesture (controls, text fields, `[data-no-canvas-gesture]`) or already claimed the arbiter.
//  - Double-tap toggles fit ↔ 2.5× at the tap point; ctrl+wheel (trackpad pinch) zooms; + / − / 0
//    while focused; optional 44 px zoom controls for one-handed use and accessibility.
//  - Panning clamps so the page never leaves a gap; past the edges it rubber-bands (0.35) and springs
//    back (instant under reduced motion). Pulling a zoomed page past its left/right edge asks the
//    host to turn the page (`onEdgeOverscroll`).
//  - `will-change: transform` only while a gesture is live (removed 150 ms after), so vector
//    lettering re-rasterises crisply at the zoomed scale.
//  - Palm rejection: while a pen is down (or just lifted), single touches are ignored.
// Children read `useZoom().scale` to keep handles a constant size on screen; pans do not re-render them.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useFormFactor } from '../useFormFactor';
import { GestureArbiterContext, createGestureArbiter } from './GestureArbiter';
import { IDENTITY, RUBBER, clampState, isDoubleTap, overscrollX, panBy, pinch, sameZoom, zoomAt, type Pt, type Size, type Tap, type ZoomXY } from './gestureMath';
import { doubleTapMs, doubleTapPx, exceedsSlop, ownsGesture } from './pointerPolicy';

export interface ZoomState {
  /** Current zoom (1 = fit). Handles divide their visual and hit sizes by it. */
  scale: number;
}

export const ZoomContext = createContext<ZoomState>({ scale: 1 });
export const useZoom = (): ZoomState => useContext(ZoomContext);

export interface TouchCanvasProps {
  children: React.ReactNode;
  maxScale?: number;
  oneFingerPan?: 'always' | 'whenZoomed' | 'never';
  onZoomChange?(scale: number): void;
  onEdgeOverscroll?(dir: -1 | 1): void;
  disabled?: boolean;
  // ── additive (optional) ──
  /** Default 1 (fit). */
  minScale?: number;
  /** Default 2.5. */
  doubleTapScale?: number;
  /** 'ctrl' (default): ctrl+wheel / trackpad pinch zooms; 'always': any wheel; 'never'. */
  wheel?: 'ctrl' | 'always' | 'never';
  /** Changing it (e.g. the page id) animates back to fit. */
  resetKey?: string;
  /** Show the − 100% + zoom pill. */
  controls?: boolean;
  /** Suspend one-finger panning (Mark-up mode draws with one finger). */
  suspendOneFinger?: boolean;
  className?: string;
  /** Accessible name of the canvas (default "Zoomable page"). */
  label?: string;
}

const UNZOOMED: ZoomState = { scale: 1 };
const EDGE_TURN_PX = 56;
const WILL_CHANGE_LINGER_MS = 150;
const SETTLE_MS = 220;

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

export const TouchCanvas: React.FC<TouchCanvasProps> = ({
  children,
  maxScale = 4,
  minScale = 1,
  oneFingerPan = 'whenZoomed',
  onZoomChange,
  onEdgeOverscroll,
  disabled = false,
  doubleTapScale = 2.5,
  wheel = 'ctrl',
  resetKey,
  controls = false,
  suspendOneFinger = false,
  className,
  label = 'Zoomable page'
}) => {
  const ff = useFormFactor();
  const rootRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const arbiter = useMemo(() => createGestureArbiter(), []);
  const z = useRef<ZoomXY>(IDENTITY);
  const [scale, setScale] = useState(1);
  const limits = useMemo(() => ({ min: Math.max(0.25, minScale), max: Math.max(minScale, maxScale) }), [minScale, maxScale]);

  // Latest props for the native listeners.
  const opts = useRef({ oneFingerPan, onZoomChange, onEdgeOverscroll, doubleTapScale, wheel, suspendOneFinger, limits, reducedMotion: ff.reducedMotion, disabled });
  opts.current = { oneFingerPan, onZoomChange, onEdgeOverscroll, doubleTapScale, wheel, suspendOneFinger, limits, reducedMotion: ff.reducedMotion, disabled };

  const lingerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stage = (): Size => {
    const r = rootRef.current?.getBoundingClientRect();
    return { w: r?.width || 1, h: r?.height || 1 };
  };

  const apply = useCallback((next: ZoomXY, animate = false) => {
    z.current = next;
    const inner = innerRef.current;
    if (!inner) return;
    inner.style.transition = animate && !opts.current.reducedMotion ? `transform ${SETTLE_MS}ms cubic-bezier(0.2,0.7,0.2,1)` : 'none';
    const identity = Math.abs(next.scale - 1) < 0.001 && Math.abs(next.x) < 0.5 && Math.abs(next.y) < 0.5;
    inner.style.transform = identity ? '' : `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`;
  }, []);

  const gesturing = (on: boolean) => {
    const inner = innerRef.current;
    if (!inner) return;
    if (lingerTimer.current) clearTimeout(lingerTimer.current);
    if (on) inner.style.willChange = 'transform';
    else lingerTimer.current = setTimeout(() => inner && (inner.style.willChange = ''), WILL_CHANGE_LINGER_MS);
  };

  /** Settle into bounds (animated) and publish the scale. */
  const commit = useCallback(
    (next: ZoomXY, animate = true) => {
      const s = stage();
      const scaleOk = { ...next, scale: Math.min(opts.current.limits.max, Math.max(opts.current.limits.min, next.scale)) };
      // Re-anchor a scale that was rubber-banded past the limits around the stage centre.
      const anchored = scaleOk.scale === next.scale ? scaleOk : zoomAt(next, { x: s.w / 2, y: s.h / 2 }, scaleOk.scale / next.scale, opts.current.limits);
      const settled = clampState(anchored, s);
      apply(settled, animate && !sameZoom(settled, z.current));
      setScale((cur) => (Math.abs(cur - settled.scale) < 0.001 ? cur : settled.scale));
    },
    [apply]
  );

  // Publish zoom changes.
  const lastPublished = useRef(1);
  useEffect(() => {
    if (Math.abs(lastPublished.current - scale) < 0.001) return;
    lastPublished.current = scale;
    opts.current.onZoomChange?.(scale);
  }, [scale]);

  // Back to fit when the page changes.
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    commit(IDENTITY, true);
  }, [resetKey, commit]);

  // ── Pointer gestures (native listeners: we need capture + non-passive wheel) ──
  useEffect(() => {
    const root = rootRef.current;
    if (!root || disabled) return;
    const pointers = new Map<number, Pt>();
    const ignored = new Set<number>();
    let pinchStart: { a: Pt; b: Pt; state: ZoomXY } | null = null;
    let candidate: { id: number; start: Pt; z0: ZoomXY; target: EventTarget | null; type: string; moved: boolean } | null = null;
    let panning: { token: number } | null = null;
    let lastTap: Tap | null = null;
    let windowBound = false;

    const local = (e: PointerEvent): Pt => {
      const r = root.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const two = (): [Pt, Pt] | null => {
      const v = [...pointers.values()];
      return v.length >= 2 ? [v[0], v[1]] : null;
    };

    const stopPan = () => {
      if (panning) arbiter.release(panning.token);
      panning = null;
    };

    const onDown = (e: PointerEvent) => {
      if (opts.current.disabled) return;
      if (e.pointerType === 'pen') arbiter.notePen(true);
      if (pointers.size === 0 && arbiter.isPalm(e.pointerType)) {
        ignored.add(e.pointerId);
        return;
      }
      pointers.set(e.pointerId, local(e));
      bindWindow();
      if (pointers.size === 2) {
        // Second finger: whoever owns the gesture (balloon drag, mark-up) is cancelled; pinch takes over.
        arbiter.preempt('pinch');
        stopPan();
        candidate = null;
        const pair = two();
        if (pair) pinchStart = { a: pair[0], b: pair[1], state: { ...z.current } };
        gesturing(true);
      } else if (pointers.size === 1) {
        candidate = { id: e.pointerId, start: local(e), z0: { ...z.current }, target: e.target, type: e.pointerType, moved: false };
      }
    };

    const onMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, local(e));
      if (pinchStart) {
        const pair = two();
        if (!pair) return;
        const next = pinch(pinchStart, { a: pair[0], b: pair[1] }, opts.current.limits, RUBBER);
        apply(clampState(next, stage(), stage(), RUBBER));
        if (e.cancelable) e.preventDefault();
        return;
      }
      const c = candidate;
      if (!c || c.id !== e.pointerId) return;
      const p = local(e);
      const dx = p.x - c.start.x;
      const dy = p.y - c.start.y;
      if (!c.moved && exceedsSlop(dx, dy, c.type)) c.moved = true;
      if (!panning) {
        const o = opts.current;
        const allow = !o.suspendOneFinger && (o.oneFingerPan === 'always' || (o.oneFingerPan === 'whenZoomed' && z.current.scale > 1.01));
        if (!c.moved || !allow || arbiter.current() || ownsGesture(c.target)) return;
        panning = {
          token: arbiter.claim('pan', () => {
            panning = null;
            commit(z.current);
          })
        };
        gesturing(true);
      }
      apply(clampState(panBy(c.z0, dx, dy), stage(), stage(), RUBBER));
      if (e.cancelable) e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'pen') arbiter.notePen(false);
      if (ignored.delete(e.pointerId)) return;
      if (!pointers.has(e.pointerId)) return;
      const cancelled = e.type === 'pointercancel';
      pointers.delete(e.pointerId);
      if (pinchStart) {
        if (pointers.size < 2) {
          pinchStart = null;
          candidate = null; // lift every finger before a new pan starts
          commit(z.current);
          gesturing(false);
        }
      } else if (panning) {
        const over = overscrollX(z.current, stage());
        stopPan();
        commit(z.current);
        gesturing(false);
        if (!cancelled && Math.abs(over) > EDGE_TURN_PX) opts.current.onEdgeOverscroll?.(over > 0 ? -1 : 1);
      } else if (candidate && candidate.id === e.pointerId && !candidate.moved && !cancelled && !ownsGesture(candidate.target)) {
        const p = local(e);
        const tap: Tap = { t: Date.now(), x: p.x, y: p.y };
        if (isDoubleTap(lastTap, tap, doubleTapMs, doubleTapPx)) {
          lastTap = null;
          if (z.current.scale > 1.01) commit(IDENTITY);
          else commit(zoomAt(z.current, p, opts.current.doubleTapScale / z.current.scale, opts.current.limits));
        } else lastTap = tap;
      }
      if (candidate?.id === e.pointerId) candidate = null;
      if (!pointers.size) unbindWindow();
    };

    const bindWindow = () => {
      if (windowBound) return;
      windowBound = true;
      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    const unbindWindow = () => {
      if (!windowBound) return;
      windowBound = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    const onWheel = (e: WheelEvent) => {
      const mode = opts.current.wheel;
      if (mode === 'never' || (mode === 'ctrl' && !e.ctrlKey)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const factor = Math.exp((-e.deltaY * unit) / 300);
      const r = root.getBoundingClientRect();
      const next = zoomAt(z.current, { x: e.clientX - r.left, y: e.clientY - r.top }, factor, opts.current.limits);
      const settled = clampState(next, stage());
      apply(settled);
      setScale(settled.scale);
    };

    root.addEventListener('pointerdown', onDown, true);
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      root.removeEventListener('pointerdown', onDown, true);
      root.removeEventListener('wheel', onWheel);
      unbindWindow();
      stopPan();
    };
  }, [disabled, arbiter, apply, commit]);

  useEffect(
    () => () => {
      if (lingerTimer.current) clearTimeout(lingerTimer.current);
    },
    []
  );

  const zoomBy = useCallback(
    (factor: number) => {
      const s = stage();
      commit(zoomAt(z.current, { x: s.w / 2, y: s.h / 2 }, factor, limits));
    },
    [commit, limits]
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled || e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-' || e.key === '_') zoomBy(0.8);
    else if (e.key === '0') commit(IDENTITY);
    else return;
    e.preventDefault();
  };

  const ctx = useMemo<ZoomState>(() => (Math.abs(scale - 1) < 0.001 ? UNZOOMED : { scale }), [scale]);
  const pct = Math.round(scale * 100);
  const btn =
    'grid h-9 w-9 place-items-center rounded-full text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/45 coarse:h-11 coarse:w-11';

  return (
    <GestureArbiterContext.Provider value={arbiter}>
      <ZoomContext.Provider value={ctx}>
        <div
          ref={rootRef}
          role="group"
          aria-label={label}
          aria-roledescription="zoomable canvas"
          tabIndex={disabled ? -1 : 0}
          onKeyDown={onKeyDown}
          data-zoom={scale.toFixed(2)}
          className={cx('relative h-full w-full overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#D97757]/40', !disabled && 'no-callout', className)}
          style={disabled ? undefined : { touchAction: 'none' }}
        >
          <div ref={innerRef} className="h-full w-full" style={{ transformOrigin: '0 0' }}>
            {children}
          </div>
          {controls && !disabled && (
            <div
              data-no-canvas-gesture
              className="absolute bottom-2 right-2 z-[5] flex items-center gap-0.5 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] p-0.5 shadow-[0_2px_10px_rgba(0,0,0,0.12)] backdrop-blur-md"
            >
              <button type="button" className={btn} aria-label="Zoom out" disabled={scale <= limits.min + 0.001} onClick={() => zoomBy(0.8)}>
                <Minus className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                className={cx(btn, 'w-auto min-w-[3.25rem] px-2 text-[12px] font-semibold tabular-nums coarse:w-auto')}
                aria-label={`Zoom ${pct}%. Reset to fit`}
                onClick={() => commit(IDENTITY)}
              >
                {pct}%
              </button>
              <button type="button" className={btn} aria-label="Zoom in" disabled={scale >= limits.max - 0.001} onClick={() => zoomBy(1.25)}>
                <Plus className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}
        </div>
      </ZoomContext.Provider>
    </GestureArbiterContext.Provider>
  );
};

export default TouchCanvas;
