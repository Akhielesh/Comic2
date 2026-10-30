// useLongPress (mobile.md §5.5): press-and-hold for context menus on balloons, filmstrip clips and
// page cards. Fires after `delay` ms; cancels on movement past `tolerance`, a second pointer or a
// scroll; swallows the click that follows a fired press. Also binds `contextmenu` (right-click,
// iPad trackpad secondary click, Android's own long-press) and Shift+F10 / the Menu key, so the
// actions are always reachable without a long-press.

import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { haptic, longPressMs, longPressTolerancePx } from './pointerPolicy';

export interface LongPressInfo {
  x: number;
  y: number;
  pointerType: string;
  target: EventTarget | null;
}

export interface LongPressOptions {
  onLongPress: (info: LongPressInfo) => void;
  delay?: number;
  tolerance?: number;
  disabled?: boolean;
  /** Called when a press starts charging / stops (the UI may draw a progress ring). */
  onCharge?: (charging: boolean, at?: { x: number; y: number }) => void;
}

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: (e: React.PointerEvent) => void;
  onClickCapture: (e: React.MouseEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}

export function useLongPress({ onLongPress, delay = longPressMs, tolerance = longPressTolerancePx, disabled, onCharge }: LongPressOptions): LongPressHandlers {
  const cb = useRef(onLongPress);
  cb.current = onLongPress;
  const chargeCb = useRef(onCharge);
  chargeCb.current = onCharge;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number; id: number; type: string; target: EventTarget | null } | null>(null);
  const pointers = useRef(new Set<number>());
  const firedAt = useRef(0);
  const swallowClick = useRef(false);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      chargeCb.current?.(false);
    }
    start.current = null;
  }, []);

  // A scroll anywhere while charging cancels (the finger was scrolling a list).
  useEffect(() => {
    const onScroll = () => cancel();
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [cancel]);

  const fire = (info: LongPressInfo) => {
    firedAt.current = Date.now();
    swallowClick.current = true;
    haptic(8);
    cb.current(info);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // The primary pointer starts a fresh gesture (an up delivered elsewhere must not leave a ghost).
    if (e.isPrimary) pointers.current.clear();
    pointers.current.add(e.pointerId);
    if (disabled) return;
    if (pointers.current.size > 1) {
      cancel(); // second finger: a pinch, not a press
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return; // right-click goes through contextmenu
    swallowClick.current = false;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType, target: e.target };
    chargeCb.current?.(true, { x: e.clientX, y: e.clientY });
    timer.current = setTimeout(() => {
      timer.current = null;
      const s = start.current;
      start.current = null;
      chargeCb.current?.(false);
      if (s) fire({ x: s.x, y: s.y, pointerType: s.type, target: s.target });
    }, delay);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > tolerance) cancel();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    cancel();
  };

  const onClickCapture = (e: React.MouseEvent) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (disabled) return;
    e.preventDefault();
    // Android fires contextmenu for the same hold our timer already answered.
    if (Date.now() - firedAt.current < 700) return;
    cancel();
    fire({ x: e.clientX, y: e.clientY, pointerType: 'mouse', target: e.target });
    swallowClick.current = false;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      fire({ x: r.left + r.width / 2, y: r.top + r.height / 2, pointerType: 'keyboard', target: e.currentTarget });
      swallowClick.current = false;
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp, onClickCapture, onContextMenu, onKeyDown };
}

export default useLongPress;
