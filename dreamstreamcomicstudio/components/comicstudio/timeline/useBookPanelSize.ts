import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

export const BOOK_SIZE_KEY = 'comicstudio.timeline.thumb-height';
export const BOOK_THUMB_DEFAULT = 64;
export const BOOK_THUMB_MIN = 48;
export const BOOK_THUMB_MAX = 260;
const clamp = (value: number, max: number) => Math.round(Math.max(BOOK_THUMB_MIN, Math.min(max, value)));

/** Reserve board space before growing the dock; very short views keep usable 48px thumbnails. */
export const bookThumbMax = (available: number): number =>
  clamp(Math.min(available * 0.45 - 92, available - 232), BOOK_THUMB_MAX);

const readSize = (key: string): number => {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value >= BOOK_THUMB_MIN && value <= BOOK_THUMB_MAX ? value : BOOK_THUMB_DEFAULT;
  } catch { return BOOK_THUMB_DEFAULT; }
};
const saveSize = (key: string, value: number) => {
  try { window.localStorage.setItem(key, String(value)); } catch { /* This visit still resizes when storage is unavailable. */ }
};

/** Local display preference only: resizing never changes the comic or its undo history. */
export function useBookPanelSize(ref: RefObject<HTMLElement | null>, options: { enabled: boolean; phone: boolean; viewportHeight: number }) {
  const key = `${BOOK_SIZE_KEY}.${options.phone ? 'phone' : 'wide'}`;
  const [preference, setPreference] = useState(() => readSize(key));
  const [available, setAvailable] = useState(options.viewportHeight - 96);
  const max = bookThumbMax(available);
  const height = clamp(preference, max);
  const live = useRef({ height, max, key });
  live.current = { height, max, key };
  const stopDrag = useRef<((cancel?: boolean) => void) | null>(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => { stopDrag.current?.(true); setPreference(readSize(key)); }, [key]);
  useLayoutEffect(() => {
    if (!options.enabled) return;
    const board = ref.current?.closest<HTMLElement>('[data-board]');
    const measure = () => setAvailable(board?.getBoundingClientRect().height || Math.max(0, options.viewportHeight - 96));
    measure();
    if (!board || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(board);
    return () => observer.disconnect();
  }, [options.enabled, options.viewportHeight, ref]);
  useEffect(() => {
    if (!options.enabled) stopDrag.current?.(true);
  }, [options.enabled]);
  useEffect(() => () => stopDrag.current?.(true), []);

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || event.isPrimary === false || !options.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    stopDrag.current?.(true);
    const start = { y: event.clientY, height: live.current.height, preference, key: live.current.key, pointerId: event.pointerId };
    let pending = start.height;
    let frame = 0;
    const element = event.currentTarget;
    element.focus({ preventScroll: true });
    element.setPointerCapture?.(event.pointerId);
    setResizing(true);
    const apply = () => { frame = 0; setPreference(pending); };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== start.pointerId) return;
      e.preventDefault();
      pending = clamp(start.height + start.y - e.clientY, live.current.max);
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const finish = (cancel = false) => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancelPointer);
      window.removeEventListener('keydown', escape, true);
      element.removeEventListener('lostpointercapture', lostCapture);
      stopDrag.current = null;
      if (element.hasPointerCapture?.(start.pointerId)) element.releasePointerCapture(start.pointerId);
      setResizing(false);
      setPreference(cancel ? start.preference : pending);
      if (!cancel) saveSize(start.key, pending);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== start.pointerId) return;
      pending = clamp(start.height + start.y - e.clientY, live.current.max);
      finish();
    };
    const cancelPointer = (e: PointerEvent) => { if (e.pointerId === start.pointerId) finish(true); };
    const lostCapture = () => finish(true);
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation(); finish(true);
    };
    stopDrag.current = finish;
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancelPointer);
    window.addEventListener('keydown', escape, true);
    element.addEventListener('lostpointercapture', lostCapture);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 40 : 16;
    const next = event.key === 'ArrowUp' ? height + step : event.key === 'ArrowDown' ? height - step
      : event.key === 'Home' ? BOOK_THUMB_MIN : event.key === 'End' ? max
        : event.key === 'Enter' ? BOOK_THUMB_DEFAULT : undefined;
    if (next === undefined) return;
    event.preventDefault(); event.stopPropagation();
    const value = clamp(next, max);
    setPreference(value);
    saveSize(key, value);
  };
  return { height, max, resizing, onPointerDown, onKeyDown };
}
