// Touch-first editing (mobile.md §5, §10.1): pinch/pan/zoom math, the gesture arbiter, pointer policy,
// long-press, and the TouchCanvas wiring (second finger preempts a drag; double-tap zooms).

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { IDENTITY, clampState, fitState, isDoubleTap, overscrollX, panBy, pinch, softScale, zoomAt, type ZoomXY } from './gestureMath';
import { createGestureArbiter, useGestureArbiter } from './GestureArbiter';
import { dragSlopPx, exceedsSlop, isPalmTouch, ownsGesture } from './pointerPolicy';
import { useLongPress } from './useLongPress';
import { TouchCanvas, useZoom } from './TouchCanvas';

const LIMITS = { min: 1, max: 5 };
const screenOf = (s: ZoomXY, c: { x: number; y: number }) => ({ x: s.x + c.x * s.scale, y: s.y + c.y * s.scale });

describe('gestureMath', () => {
  it('pinch keeps the content under the starting midpoint under the current midpoint (anchor invariance)', () => {
    const start = { a: { x: 100, y: 100 }, b: { x: 200, y: 200 }, state: IDENTITY };
    const next = pinch(start, { a: { x: 50, y: 60 }, b: { x: 290, y: 300 } }, LIMITS);
    expect(next.scale).toBeCloseTo(2.4, 5);
    // The content point under the first midpoint (150,150) is now under the new midpoint (170,180).
    const p = screenOf(next, { x: 150, y: 150 });
    expect(p.x).toBeCloseTo(170, 5);
    expect(p.y).toBeCloseTo(180, 5);
  });

  it('pinch respects the limits (hard) and rubber-bands when asked', () => {
    const start = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, state: IDENTITY };
    expect(pinch(start, { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 } }, LIMITS).scale).toBe(5);
    expect(pinch(start, { a: { x: 0, y: 0 }, b: { x: 1000, y: 0 } }, LIMITS, 0.35).scale).toBeCloseTo(5 + 5 * 0.35);
    expect(softScale(0.5, LIMITS, 0)).toBe(1);
  });

  it('zoomAt keeps the point fixed', () => {
    const z = zoomAt({ scale: 1, x: 0, y: 0 }, { x: 120, y: 80 }, 2, LIMITS);
    expect(screenOf(z, { x: 120, y: 80 })).toEqual({ x: 120, y: 80 });
    expect(z.scale).toBe(2);
  });

  it('clampState: no gaps when zoomed, centred when smaller, rubber past the edge', () => {
    const stage = { w: 400, h: 600 };
    const zoomed = { scale: 2, x: 50, y: -2000 };
    const clamped = clampState(zoomed, stage);
    expect([clamped.scale, clamped.x + 0, clamped.y]).toEqual([2, 0, -600]);
    expect(clampState({ scale: 0.5, x: 0, y: 0 }, stage)).toEqual({ scale: 0.5, x: 100, y: 150 });
    expect(clampState(zoomed, stage, stage, 0.35).x).toBeCloseTo(50 * 0.35);
    expect(overscrollX({ scale: 2, x: 80, y: -100 }, stage)).toBe(80);
  });

  it('fitState centres smaller content; panBy moves; isDoubleTap within 300 ms and 24 px', () => {
    expect(fitState({ w: 400, h: 600 }, { w: 300, h: 450 })).toEqual({ scale: 1, x: 50, y: 75 });
    expect(panBy(IDENTITY, 5, -3)).toEqual({ scale: 1, x: 5, y: -3 });
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 250, x: 10, y: 10 })).toBe(true);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 350, x: 0, y: 0 })).toBe(false);
    expect(isDoubleTap({ t: 0, x: 0, y: 0 }, { t: 100, x: 30, y: 0 })).toBe(false);
    expect(isDoubleTap(null, { t: 100, x: 0, y: 0 })).toBe(false);
  });
});

describe('pointer policy', () => {
  it('slop depends on the input: touch 10, pen 2, mouse 3', () => {
    expect([dragSlopPx('touch'), dragSlopPx('pen'), dragSlopPx('mouse')]).toEqual([10, 2, 3]);
    expect(exceedsSlop(9, 0, 'touch')).toBe(false);
    expect(exceedsSlop(11, 0, 'touch')).toBe(true);
    expect(exceedsSlop(3, 0, 'pen')).toBe(true);
  });

  it('palm rejection: single touches while a pen is down or just lifted', () => {
    expect(isPalmTouch('touch', true, -Infinity, 1000)).toBe(true);
    expect(isPalmTouch('touch', false, 900, 1000)).toBe(true);
    expect(isPalmTouch('touch', false, 500, 1000)).toBe(false);
    expect(isPalmTouch('pen', true, 0, 0)).toBe(false);
  });

  it('controls and text fields own their own gestures', () => {
    const wrap = document.createElement('div');
    wrap.innerHTML = '<button><span id="in-btn">x</span></button><div id="art"></div><div data-no-canvas-gesture><i id="pill"></i></div>';
    expect(ownsGesture(wrap.querySelector('#in-btn'))).toBe(true);
    expect(ownsGesture(wrap.querySelector('#art'))).toBe(false);
    expect(ownsGesture(wrap.querySelector('#pill'))).toBe(true);
  });
});

describe('GestureArbiter', () => {
  it('one owner at a time; preempt cancels (reverts) the current owner', () => {
    const arb = createGestureArbiter();
    const cancelDrag = vi.fn();
    const token = arb.claim('balloon', cancelDrag);
    expect(arb.current()).toBe('balloon');
    expect(arb.preempt('pinch')).toBe(true);
    expect(cancelDrag).toHaveBeenCalledTimes(1);
    expect(arb.current()).toBeNull();
    arb.release(token); // stale token: ignored
    const t2 = arb.claim('markup', vi.fn());
    arb.release(t2);
    expect(arb.current()).toBeNull();
    expect(arb.preempt('pinch')).toBe(false);
  });

  it('tracks the pen for palm rejection', () => {
    const arb = createGestureArbiter();
    arb.notePen(true);
    expect(arb.isPalm('touch')).toBe(true);
    arb.notePen(false, 1000);
    expect(arb.isPalm('touch', 1100)).toBe(true);
    expect(arb.isPalm('touch', 1400)).toBe(false);
  });
});

describe('useLongPress (fake timers)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const Pressable: React.FC<{ onLong: () => void; onClick?: () => void }> = ({ onLong, onClick }) => {
    const h = useLongPress({ onLongPress: onLong });
    return (
      <button type="button" onClick={onClick} {...h}>
        Card
      </button>
    );
  };
  const down = (el: Element, id = 1, x = 10, y = 10, isPrimary = true) => fireEvent.pointerDown(el, { pointerId: id, clientX: x, clientY: y, pointerType: 'touch', isPrimary });

  it('fires at 450 ms and swallows the click that follows', () => {
    const onLong = vi.fn();
    const onClick = vi.fn();
    render(<Pressable onLong={onLong} onClick={onClick} />);
    const el = screen.getByRole('button');
    down(el);
    act(() => vi.advanceTimersByTime(449));
    expect(onLong).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onLong).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(el, { pointerId: 1 });
    fireEvent.click(el);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('cancels on an 11 px move, a second finger, or a scroll', () => {
    const onLong = vi.fn();
    render(<Pressable onLong={onLong} />);
    const el = screen.getByRole('button');
    down(el);
    fireEvent.pointerMove(el, { pointerId: 1, clientX: 21, clientY: 10 });
    act(() => vi.advanceTimersByTime(600));
    down(el, 1);
    down(el, 2, 40, 40, false);
    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerUp(el, { pointerId: 2 });
    fireEvent.pointerUp(el, { pointerId: 1 });
    down(el);
    fireEvent.scroll(window);
    act(() => vi.advanceTimersByTime(600));
    expect(onLong).not.toHaveBeenCalled();
  });

  it('right-click / Android contextmenu and Shift+F10 open it too (always reachable without a long-press)', () => {
    const onLong = vi.fn();
    render(<Pressable onLong={onLong} />);
    const el = screen.getByRole('button');
    fireEvent.contextMenu(el, { clientX: 5, clientY: 5 });
    expect(onLong).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(800));
    fireEvent.keyDown(el, { key: 'F10', shiftKey: true });
    expect(onLong).toHaveBeenCalledTimes(2);
  });
});

describe('TouchCanvas', () => {
  const rect = { left: 0, top: 0, width: 400, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON: () => ({}) };
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(rect as DOMRect);
  });
  afterEach(() => vi.restoreAllMocks());

  const Probe: React.FC<{ onCancel: () => void }> = ({ onCancel }) => {
    const arbiter = useGestureArbiter();
    const zoom = useZoom();
    return (
      <div data-testid="art" data-scale={zoom.scale} onPointerDown={() => arbiter.claim('balloon', onCancel)}>
        art
      </div>
    );
  };

  it('owns the page gestures (touch-action none on the stage only) and exposes zoom', () => {
    render(
      <TouchCanvas controls>
        <Probe onCancel={vi.fn()} />
      </TouchCanvas>
    );
    const canvas = screen.getByRole('group', { name: 'Zoomable page' });
    expect(canvas.style.touchAction).toBe('none');
    expect(canvas).toHaveAttribute('data-zoom', '1.00');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(canvas).toHaveAttribute('data-zoom', '1.25');
    expect(screen.getByTestId('art')).toHaveAttribute('data-scale', '1.25');
    fireEvent.click(screen.getByRole('button', { name: /Zoom 125%/ }));
    expect(canvas).toHaveAttribute('data-zoom', '1.00');
  });

  it('a second finger preempts the balloon drag in progress (its draft reverts) and pinches', () => {
    const cancel = vi.fn();
    render(
      <TouchCanvas>
        <Probe onCancel={cancel} />
      </TouchCanvas>
    );
    const art = screen.getByTestId('art');
    fireEvent.pointerDown(art, { pointerId: 1, clientX: 100, clientY: 100, pointerType: 'touch' });
    fireEvent.pointerDown(art, { pointerId: 2, clientX: 200, clientY: 200, pointerType: 'touch' });
    expect(cancel).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 300, clientY: 300 });
    fireEvent.pointerUp(window, { pointerId: 2 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(Number(screen.getByRole('group', { name: 'Zoomable page' }).getAttribute('data-zoom'))).toBeGreaterThan(1);
  });

  it('keyboard + / − / 0 zoom while focused', () => {
    render(
      <TouchCanvas>
        <p>art</p>
      </TouchCanvas>
    );
    const canvas = screen.getByRole('group', { name: 'Zoomable page' });
    fireEvent.keyDown(canvas, { key: '+' });
    expect(canvas).toHaveAttribute('data-zoom', '1.25');
    fireEvent.keyDown(canvas, { key: '0' });
    expect(canvas).toHaveAttribute('data-zoom', '1.00');
  });

  it('disabled: a passthrough with no gesture ownership', () => {
    render(
      <TouchCanvas disabled>
        <p>art</p>
      </TouchCanvas>
    );
    expect(screen.getByRole('group', { name: 'Zoomable page' }).style.touchAction || '').toBe('');
  });
});

describe('useZoom default', () => {
  it('is 1 outside a canvas', () => {
    expect(renderHook(() => useZoom()).result.current.scale).toBe(1);
  });
});
