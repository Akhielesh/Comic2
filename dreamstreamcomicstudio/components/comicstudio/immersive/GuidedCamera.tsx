// Guided View camera (reader.md §5.2): moves the book wrapper so a panel fills the screen, with a
// spotlight that dims the neighbouring panels. Moves are written per frame (no React render); 120 ms
// after a move settles the stage re-lays the book out at the zoomed size so lettering is pixel-crisp
// (balloon fonts scale linearly with page width), and the wrapper keeps only a translation.

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
  /** Spotlight rect for a camera (null hides it). */
  spotFor?: (cam: Camera) => CameraRect | null;
  onDone?: () => void;
}

/**
 * Imperative camera: `set` jumps, `move` animates; both write the wrapper transform for the current
 * layout scale and place the spotlight. Reduced motion: moves become instant (the caller crossfades).
 */
export function useCameraAnimator(wrapper: React.RefObject<HTMLDivElement | null>, spot: React.RefObject<HTMLDivElement | null>) {
  const current = useRef<Camera>({ s: 1, tx: 0, ty: 0, rect: { x: 0, y: 0, w: 1, h: 1 } });
  const layoutScale = useRef(1);
  const anim = useRef<number | null>(null);

  const writeSpot = (rect: CameraRect | null | undefined) => {
    const el = spot.current;
    if (!el) return;
    if (!rect) {
      el.style.opacity = '0';
      return;
    }
    el.style.opacity = '1';
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${Math.max(0, rect.w)}px`;
    el.style.height = `${Math.max(0, rect.h)}px`;
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
      const ease = m.ease === 'paper' ? paperEase : cameraEase;
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

/** Dims everything outside the current panel; follows the camera. */
export const Spotlight = React.forwardRef<HTMLDivElement, { reduced: boolean }>(({ reduced }, ref) => (
  <div
    ref={ref}
    aria-hidden
    data-testid="guided-spotlight"
    className="pointer-events-none absolute z-[20] rounded-[6px] opacity-0"
    style={{ left: 0, top: 0, width: 0, height: 0, boxShadow: '0 0 0 200vmax rgba(10,9,8,0.78)', transition: reduced ? 'opacity 140ms ease-out' : 'opacity 220ms ease-out' }}
  />
));
Spotlight.displayName = 'Spotlight';
