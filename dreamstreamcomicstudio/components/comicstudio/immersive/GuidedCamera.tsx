// Guided View camera (reader.md §5.2): moves the book wrapper so a panel fills the screen, with a
// spotlight that dims the neighbouring panels. Moves are written per frame (no React render); 120 ms
// after a move settles the stage re-lays the book out at the zoomed size so lettering is pixel-crisp
// (balloon fonts scale linearly with page width), and the wrapper keeps only a translation.
//
// GPU budget (reader.md §5.3, RD-0): per frame the camera writes ONLY `transform` and `opacity`. The
// spotlight is four full-room shutters (top, bottom, left, right) moved by transform so their inner edges
// sit on the panel — never left/top/width/height under a 200vmax box-shadow, which re-laid the stage out
// and repainted the whole viewport every frame.

import React, { useCallback, useEffect, useRef } from 'react';
import { cameraEase, paperEase } from './flipPhysics';
import type { Camera, CameraRect } from './guidedModel';
import { lerpCamera } from './guidedModel';

const raf = (fn: FrameRequestCallback): number =>
  typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : (setTimeout(() => fn(performance.now()), 16) as unknown as number);
const caf = (id: number) => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : clearTimeout(id));

export const cameraTransform = (cam: Pick<Camera, 's' | 'tx' | 'ty'>, layoutScale: number): string =>
  `translate3d(${Math.round(cam.tx * 100) / 100}px, ${Math.round(cam.ty * 100) / 100}px, 0) scale(${Math.round((cam.s / Math.max(1e-6, layoutScale)) * 10000) / 10000})`;

export interface CameraMove {
  to: Camera;
  durationMs: number;
  /** Zoom-changing moves ease in-out; pans use the paper ease. */
  ease?: 'camera' | 'paper';
  /** The curve itself (the reader's computed --ds-reader-ease-*), overriding `ease`. */
  easing?: (u: number) => number;
  /** Spotlight rect for a camera (null hides it). */
  spotFor?: (cam: Camera) => CameraRect | null;
  onDone?: () => void;
}

export type ShutterSide = 'top' | 'bottom' | 'left' | 'right';
export const SHUTTER_SIDES: readonly ShutterSide[] = ['top', 'bottom', 'left', 'right'];

const px = (n: number) => Math.round(n * 100) / 100;

/**
 * The four shutter transforms that leave `rect` (room coordinates) uncovered in a room `W × H`. Each shutter
 * is a full-room box with its origin at the top-left corner: top and bottom slide vertically so their edge
 * sits on the rect; left and right slide sideways and squash to the rect's height (scaleY of a flat fill —
 * no visible distortion), so the four never overlap and the dimming is even everywhere.
 */
export const shutterTransforms = (rect: CameraRect, W: number, H: number): Record<ShutterSide, string> => {
  const w = Math.max(1, W);
  const h = Math.max(1, H);
  const x = rect.x;
  const y = rect.y;
  const rw = Math.max(0, rect.w);
  const rh = Math.max(0, rect.h);
  const sy = Math.round((rh / h) * 10000) / 10000;
  return {
    top: `translate3d(0px, ${px(y - h)}px, 0)`,
    bottom: `translate3d(0px, ${px(y + rh)}px, 0)`,
    left: `translate3d(${px(x - w)}px, ${px(y)}px, 0) scale(1, ${sy})`,
    right: `translate3d(${px(x + rw)}px, ${px(y)}px, 0) scale(1, ${sy})`
  };
};

/**
 * Imperative camera: `set` jumps, `move` animates; both write the wrapper transform for the current
 * layout scale and place the spotlight. Reduced motion: moves become instant (the caller crossfades).
 * `room` is the stage size the spotlight covers (the shutters need it; read from the element when absent).
 */
export function useCameraAnimator(
  wrapper: React.RefObject<HTMLDivElement | null>,
  spot: React.RefObject<HTMLDivElement | null>,
  room?: { w: number; h: number }
) {
  const current = useRef<Camera>({ s: 1, tx: 0, ty: 0, rect: { x: 0, y: 0, w: 1, h: 1 } });
  const layoutScale = useRef(1);
  const anim = useRef<number | null>(null);
  const roomSize = useRef(room);
  roomSize.current = room;
  /** The last opacity written, so a frame never rewrites an unchanged value. */
  const spotShown = useRef<boolean | null>(null);

  const writeSpot = (rect: CameraRect | null | undefined) => {
    const el = spot.current;
    if (!el) return;
    if (!rect) {
      if (spotShown.current !== false) el.style.opacity = '0';
      spotShown.current = false;
      return;
    }
    // Size is read once per move from the stage geometry the caller passed (no layout read per frame).
    const W = roomSize.current?.w || el.clientWidth || 0;
    const H = roomSize.current?.h || el.clientHeight || 0;
    const t = shutterTransforms(rect, W, H);
    for (const child of Array.from(el.children) as HTMLElement[]) {
      const side = child.dataset.shutter as ShutterSide | undefined;
      if (side && t[side]) child.style.transform = t[side];
    }
    if (spotShown.current !== true) el.style.opacity = '1';
    spotShown.current = true;
  };

  const write = useCallback(
    (cam: Camera, spotRect?: CameraRect | null) => {
      current.current = cam;
      if (wrapper.current) wrapper.current.style.transform = cameraTransform(cam, layoutScale.current);
      if (spotRect !== undefined) writeSpot(spotRect);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wrapper]
  );

  const stop = useCallback(() => {
    if (anim.current !== null) caf(anim.current);
    anim.current = null;
  }, []);

  const set = useCallback(
    (cam: Camera, spotRect?: CameraRect | null) => {
      stop();
      write(cam, spotRect);
    },
    [stop, write]
  );

  const move = useCallback(
    (m: CameraMove) => {
      stop();
      const from = current.current;
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const ease = m.easing ?? (m.ease === 'paper' ? paperEase : cameraEase);
      const tick = (t: number) => {
        const u = Math.min(1, Math.max(0, (t - t0) / Math.max(1, m.durationMs)));
        const cam = u >= 1 ? m.to : lerpCamera(from, m.to, ease(u));
        write(cam, m.spotFor ? m.spotFor(cam) : undefined);
        if (u >= 1) {
          anim.current = null;
          m.onDone?.();
          return;
        }
        anim.current = raf(tick);
      };
      if (m.durationMs <= 0) {
        write(m.to, m.spotFor ? m.spotFor(m.to) : undefined);
        m.onDone?.();
        return;
      }
      anim.current = raf(tick);
    },
    [stop, write]
  );

  /** The book was re-laid out at a new scale: keep the same view (translation only when equal). */
  const setLayoutScale = useCallback(
    (L: number) => {
      layoutScale.current = L;
      write(current.current);
    },
    [write]
  );

  useEffect(() => stop, [stop]);

  return { set, move, stop, current, layoutScale, setLayoutScale };
}

/** Shutters start parked outside the room (nothing dimmed until the camera places them). */
const PARKED: Record<ShutterSide, string> = {
  top: 'translate3d(0px, -100%, 0)',
  bottom: 'translate3d(0px, 100%, 0)',
  left: 'translate3d(-100%, 0px, 0)',
  right: 'translate3d(100%, 0px, 0)'
};

/**
 * Dims everything outside the current panel; follows the camera. Four full-room shutters inside one
 * clipping layer: the camera moves them with transforms only, and the layer fades with opacity.
 */
export const Spotlight = React.forwardRef<HTMLDivElement, { reduced: boolean }>(({ reduced }, ref) => (
  <div
    ref={ref}
    aria-hidden
    data-testid="guided-spotlight"
    className="pointer-events-none absolute inset-0 z-[20] overflow-hidden opacity-0"
    style={{
      transition: reduced
        ? 'opacity var(--ds-reader-spot-fade-reduced, 140ms) ease-out'
        : 'opacity var(--ds-reader-spot-fade, 220ms) ease-out'
    }}
  >
    {SHUTTER_SIDES.map((side) => (
      <div
        key={side}
        data-shutter={side}
        className="absolute inset-0"
        style={{ transformOrigin: '0 0', transform: PARKED[side], background: 'var(--ds-reader-spot-fill)' }}
      />
    ))}
  </div>
));
Spotlight.displayName = 'Spotlight';
