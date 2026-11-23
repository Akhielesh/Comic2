import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperTurnSurface, type PaperTurnHandle, type PaperTurnProps } from './PaperTurnSurface';

const box = (width: number, height: number, left = 0, top = 0) => ({
  width,
  height,
  left,
  top,
  x: left,
  y: top,
  right: left + width,
  bottom: top + height,
  toJSON: () => ({})
});
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const touch = (x: number, y = 430, identifier = 0) => ({ identifier, clientX: x, clientY: y });
function stage(extra: Partial<PaperTurnProps> = {}) {
  const ref = createRef<PaperTurnHandle>();
  const onTurn = vi.fn();
  const base: PaperTurnProps = {
    pageKey: 'current',
    canTurn: () => true,
    onTurn,
    renderAdjacent: (d) => <h2>{d === 1 ? 'Next page' : 'Previous page'}</h2>,
    children: <h2>Current page</h2>,
    ...extra
  };
  const view = render(<PaperTurnSurface {...base} ref={ref} />);
  const element = view.container.querySelector<HTMLElement>('[data-paper-turn-surface]')!;
  const rect = vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(box(400, 600));
  const drag = (from: number, to: number, y = 430) => {
    fireEvent.touchStart(element, { touches: [touch(from)] });
    advance(20);
    fireEvent.touchMove(element, { touches: [touch(to, y)] });
  };
  const release = (x: number, y = 430) => fireEvent.touchEnd(element, { touches: [], changedTouches: [touch(x, y)] });
  return { ref, onTurn, element, rect, drag, release, view, base };
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'performance', 'Date']
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('controlled paper turn', () => {
  it('exposes only the active reading tree and commits one button turn after the fold settles', () => {
    const s = stage();
    act(() => {
      s.ref.current!.turn(1);
      s.ref.current!.turn(1);
    });
    advance(180);
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(s.element.querySelector('.paper-turn-preview')).toHaveAttribute('inert');
    expect(s.element.querySelector<HTMLElement>('.paper-turn-face')!.style.clipPath).toMatch(/^polygon/);
    expect(s.element.querySelector<HTMLElement>('.paper-turn-back')!.style.transform).toMatch(/^matrix/);
    expect(s.onTurn).not.toHaveBeenCalled();
    advance(800);
    expect(s.onTurn.mock.calls).toEqual([[1]]);
    expect(s.element).not.toHaveAttribute('data-turning');
  });

  it.each([false, true])('follows a horizontal drag and safely springs back or commits in RTL=%s', (rtl) => {
    const s = stage({ rtl });
    const start = rtl ? 32 : 368;
    const step = rtl ? 1 : -1;
    s.drag(start, start + step * 28);
    expect(s.element).toHaveAttribute('data-turning');
    s.release(start + step * 28);
    advance(1500);
    expect(s.onTurn).not.toHaveBeenCalled();
    s.drag(start, start + step * 160);
    s.release(start + step * 160);
    expect(s.onTurn).not.toHaveBeenCalled();
    advance(1500);
    expect(s.onTurn.mock.calls).toEqual([[1]]);
  });

  it('leaves vertical scroll, multitouch, interactive children and zoomed drag alone', () => {
    let zoomed = false;
    const s = stage({ isZoomed: () => zoomed, children: <button>Read transcript</button> });
    s.drag(120, 119, 510);
    s.release(119, 510);
    fireEvent.touchStart(screen.getByRole('button'), { touches: [touch(360)] });
    fireEvent.touchMove(s.element, { touches: [touch(90)] });
    s.release(90);
    s.drag(350, 160);
    fireEvent.touchStart(s.element, { touches: [touch(160), touch(200, 300, 1)] });
    fireEvent.touchEnd(s.element, { touches: [], changedTouches: [touch(160)] });
    zoomed = true;
    s.drag(360, 20);
    s.release(20);
    advance(1500);
    expect(s.onTurn).not.toHaveBeenCalled();
    act(() => s.ref.current!.turn(-1));
    expect(s.onTurn.mock.calls).toEqual([[-1]]);
  });

  it('shows actual adjacent spread on the verso while its text stays inaccessible until landing', () => {
    const s = stage({ spread: true });
    act(() => s.ref.current!.turn(-1));
    advance(160);
    expect(s.element.querySelector('.paper-turn-verso')).toHaveTextContent('Previous page');
    expect(s.element.querySelector('.paper-turn-back')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    s.view.rerender(<PaperTurnSurface {...s.base} pageKey="a different edition" ref={s.ref} />);
    advance(1500);
    expect(s.onTurn).not.toHaveBeenCalled();
  });

  it('snaps for reduced motion and no measurable layout, but refuses an unauthorized direction', () => {
    const s = stage({ canTurn: (d) => d === 1 });
    s.rect.mockReturnValue(box(0, 0));
    act(() => s.ref.current!.turn(1));
    s.rect.mockReturnValue(box(400, 600));
    const old = window.matchMedia('(prefers-reduced-motion: reduce)');
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...old, matches: true });
    act(() => {
      s.ref.current!.turn(1);
      s.ref.current!.turn(-1);
    });
    expect(s.onTurn.mock.calls).toEqual([[1], [1]]);
    expect(s.element).not.toHaveAttribute('data-turning');
  });

  it('starts the fold after every composed frame loads or reports an error', () => {
    const s = stage({ renderAdjacent: () => <svg><image href="/first"/><image href="/second"/></svg> });
    act(() => s.ref.current!.turn(1));
    advance(100);
    const front = s.element.querySelector<HTMLElement>('.paper-turn-face')!;
    const bits = s.element.querySelectorAll('.paper-turn-preview image');
    expect(front.style.clipPath).toBe('');
    fireEvent.load(bits[0]);
    advance(100);
    expect(front.style.clipPath).toBe('');
    fireEvent.error(bits[1]);
    advance(175);
    expect(front.style.clipPath).toMatch(/^polygon/);
    advance(500);
    expect(s.onTurn.mock.calls).toEqual([[1]]);
  });

  it('keeps current art until a slow target can display, and clears a pending change on resize', () => {
    const s = stage({ renderAdjacent: () => <img src="/authorized-preview" alt="Next image" /> });
    act(() => s.ref.current!.turn(1));
    advance(800);
    expect(s.element.querySelector<HTMLElement>('.paper-turn-face')!.style.clipPath).toBe('');
    expect(s.onTurn).not.toHaveBeenCalled();
    fireEvent(window, new Event('resize'));
    advance(2000);
    expect(s.onTurn).not.toHaveBeenCalled();
    act(() => s.ref.current!.turn(1));
    advance(1850);
    expect(s.onTurn.mock.calls).toEqual([[1]]);
  });
});
