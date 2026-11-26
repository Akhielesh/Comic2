import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef, useState, type ReactNode } from 'react';
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

// ── The page flip (turnStyle 'flip'): the Classic reader's swing, everywhere ─────────────────────────────────────
import { FLIP_DECODE_MS, FLIP_MS, FLIP_NEXT, FLIP_PREV } from './pageFlip';

type HostProps = Partial<PaperTurnProps> & { pages?: number; adjacent?: (n: number) => ReactNode };
function flipHost(extra: HostProps = {}) {
  const ref = createRef<PaperTurnHandle>();
  const onTurn = vi.fn();
  const { pages = 4, adjacent, ...rest } = extra;
  const Host = (props: HostProps) => {
    const [n, setN] = useState(1);
    return (
      <PaperTurnSurface
        ref={ref}
        turnStyle="flip"
        pageKey={n}
        canTurn={(d) => n + d >= 0 && n + d < pages}
        onTurn={(d) => {
          onTurn(d);
          setN(n + d);
        }}
        renderAdjacent={(d) => (adjacent ? adjacent(n + d) : <h2>Page {n + d}</h2>)}
        {...rest}
        {...props}
      >
        <h2>Page {n}</h2>
      </PaperTurnSurface>
    );
  };
  const view = render(<Host />);
  const element = view.container.querySelector<HTMLElement>('[data-paper-turn-surface]')!;
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(box(400, 600));
  const face = () => element.querySelector<HTMLElement>('.paper-turn-face')!;
  const swipe = (from: number, to: number, y0 = 430, y1 = y0) => {
    fireEvent.touchStart(element, { touches: [touch(from, y0)] });
    advance(20);
    fireEvent.touchMove(element, { touches: [touch(to, y1)] });
    fireEvent.touchEnd(element, { touches: [], changedTouches: [touch(to, y1)] });
  };
  return { ref, onTurn, element, face, swipe, view, Host };
}
const page = () => screen.getByRole('heading').textContent;

describe('the page flip', () => {
  it('Next and Prev swing the new page in from the spine (index.css’s classes), then the class comes off', () => {
    const s = flipHost();
    act(() => s.ref.current!.turn(1));
    expect(page()).toBe('Page 2');
    expect(s.face().classList.contains(FLIP_NEXT)).toBe(true);
    // Only the page being read is in the reading tree; nothing folds.
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(s.element).not.toHaveAttribute('data-turning');
    advance(FLIP_MS + 150);
    expect(s.face().className).toBe('paper-turn-face');
    act(() => s.ref.current!.turn(-1));
    expect(page()).toBe('Page 1');
    expect(s.face().classList.contains(FLIP_PREV)).toBe(true);
    expect(s.onTurn.mock.calls).toEqual([[1], [-1]]);
  });

  it('mirrors the swing in a right-to-left book', () => {
    const s = flipHost({ rtl: true });
    act(() => s.ref.current!.turn(1));
    expect(s.face().classList.contains(FLIP_PREV)).toBe(true);
    advance(FLIP_MS + 150);
    act(() => s.ref.current!.turn(-1));
    expect(s.face().classList.contains(FLIP_NEXT)).toBe(true);
  });

  it('a spread swings as a pair around its spine (the host’s origin), the swing restarts on a quick second turn', () => {
    const s = flipHost({ spread: true, flipOrigin: '300px 50%' });
    act(() => s.ref.current!.turn(1));
    expect(s.face().style.transformOrigin).toBe('300px 50%');
    act(() => s.ref.current!.turn(1));
    expect(page()).toBe('Page 3');
    expect([...s.face().classList]).toEqual(['paper-turn-face', FLIP_NEXT]);
    advance(FLIP_MS + 150);
    expect(s.face().style.transformOrigin).toBe('');
  });

  it('swings the host’s sheet when it names one (the Classic reader’s page inside its mat)', () => {
    const sheet = document.createElement('div');
    const s = flipHost({ paperElement: () => sheet });
    act(() => s.ref.current!.turn(1));
    expect(sheet.classList.contains(FLIP_NEXT)).toBe(true);
    expect(s.face().classList.contains(FLIP_NEXT)).toBe(false);
  });

  it('never swings a blank page in: the incoming page decodes out of sight first (or after a deadline)', () => {
    const s = flipHost({ adjacent: (n) => <svg><image href={`/page-${n}`} /></svg> });
    act(() => s.ref.current!.turn(1));
    const layer = s.element.querySelector<HTMLElement>('.paper-turn-preview[data-decode]')!;
    expect(layer).toHaveAttribute('inert');
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(s.element).toHaveAttribute('aria-busy', 'true');
    advance(400);
    expect(page()).toBe('Page 1');
    // A second press while it waits never queues a second turn.
    act(() => s.ref.current!.turn(1));
    act(() => {
      fireEvent.load(layer.querySelector('image')!);
    });
    expect(page()).toBe('Page 2');
    expect(s.face().classList.contains(FLIP_NEXT)).toBe(true);
    expect(s.element.querySelector('[data-decode]')).toBeNull();
    expect(s.element).not.toHaveAttribute('aria-busy');
    advance(FLIP_MS + 150);
    // A picture that never arrives holds the turn at most FLIP_DECODE_MS.
    act(() => s.ref.current!.turn(1));
    advance(FLIP_DECODE_MS - 50);
    expect(page()).toBe('Page 2');
    advance(100);
    expect(page()).toBe('Page 3');
    expect(s.onTurn.mock.calls).toEqual([[1], [1]]);
  });

  it('reduced motion, from the reader’s own setting or the OS, turns at once with no swing', () => {
    const s = flipHost({ reducedMotion: true });
    act(() => s.ref.current!.turn(1));
    expect(page()).toBe('Page 2');
    expect(s.face().className).toBe('paper-turn-face');
    s.view.unmount();
    const old = window.matchMedia('(prefers-reduced-motion: reduce)');
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...old, matches: true });
    const os = flipHost();
    act(() => os.ref.current!.turn(1));
    act(() => os.ref.current!.jump(1, () => os.ref.current!.turn(1)));
    expect(page()).toBe('Page 3');
    expect(os.face().className).toBe('paper-turn-face');
  });

  it('a horizontal swipe flips (mirrored in RTL); short, vertical, two-finger and zoomed swipes never turn', () => {
    let zoomed = false;
    const s = flipHost({ isZoomed: () => zoomed });
    s.swipe(360, 330); // 30 px: too short
    s.swipe(300, 240, 200, 400); // mostly vertical
    fireEvent.touchStart(s.element, { touches: [touch(360), touch(200, 300, 1)] });
    fireEvent.touchMove(s.element, { touches: [touch(160)] });
    fireEvent.touchEnd(s.element, { touches: [], changedTouches: [touch(160)] });
    zoomed = true;
    s.swipe(360, 100);
    zoomed = false;
    advance(500);
    expect(s.onTurn).not.toHaveBeenCalled();
    s.swipe(360, 200);
    // The swipe never lifts a paper leaf: the page swings in once it is released.
    expect(s.element).not.toHaveAttribute('data-turning');
    expect(page()).toBe('Page 2');
    expect(s.face().classList.contains(FLIP_NEXT)).toBe(true);
    advance(FLIP_MS + 150);
    s.swipe(100, 260);
    expect(page()).toBe('Page 1');
    s.view.unmount();
    const rtl = flipHost({ rtl: true });
    rtl.swipe(60, 240);
    expect(page()).toBe('Page 2');
    expect(rtl.face().classList.contains(FLIP_PREV)).toBe(true);
  });

  it('Home and End jump with the swing once the target page has decoded; other styles jump at once', () => {
    const s = flipHost({ pages: 9 });
    const commit = vi.fn();
    act(() => s.ref.current!.jump(1, commit, <svg><image href="/page-8" /></svg>));
    expect(commit).not.toHaveBeenCalled();
    act(() => {
      fireEvent.load(s.element.querySelector('[data-decode] image')!);
    });
    expect(commit).toHaveBeenCalledTimes(1);
    s.view.unmount();
    const paper = stage();
    const now = vi.fn();
    act(() => paper.ref.current!.jump(-1, now, <h2>First</h2>));
    expect(now).toHaveBeenCalledTimes(1);
    expect(paper.element.querySelector('[data-decode]')).toBeNull();
  });

  it('a hidden stage turns at once; a commit the host refuses never swings later, on an unrelated change', () => {
    const hidden = flipHost();
    vi.mocked(hidden.element.getBoundingClientRect).mockReturnValue(box(0, 0));
    act(() => hidden.ref.current!.turn(1));
    expect(page()).toBe('Page 2');
    expect(hidden.face().className).toBe('paper-turn-face');
    hidden.view.unmount();
    const ref = createRef<PaperTurnHandle>();
    const view = render(
      <PaperTurnSurface ref={ref} turnStyle="flip" pageKey="a" canTurn={() => true} onTurn={() => undefined} renderAdjacent={() => null}>
        <h2>Page</h2>
      </PaperTurnSurface>
    );
    vi.spyOn(view.container.querySelector<HTMLElement>('[data-paper-turn-surface]')!, 'getBoundingClientRect').mockReturnValue(box(400, 600));
    act(() => ref.current!.turn(1));
    advance(FLIP_MS * 4);
    view.rerender(
      <PaperTurnSurface ref={ref} turnStyle="flip" pageKey="b" canTurn={() => true} onTurn={() => undefined} renderAdjacent={() => null}>
        <h2>Page</h2>
      </PaperTurnSurface>
    );
    expect(view.container.querySelector('.paper-turn-face')!.className).toBe('paper-turn-face');
  });
});

describe('slide and fade (a creator’s choice) on the inline stage', () => {
  it.each(['slide', 'fade'] as const)('%s turns on the engine and commits once it lands; a swipe never drags it', (turnStyle) => {
    const s = stage({ turnStyle });
    act(() => s.ref.current!.turn(1));
    expect(s.element).toHaveAttribute('data-turn-kind', turnStyle);
    expect(s.element.querySelector('.paper-turn-back')).toBeNull();
    expect(s.onTurn).not.toHaveBeenCalled();
    advance(800);
    expect(s.onTurn.mock.calls).toEqual([[1]]);
    s.drag(360, 200);
    expect(s.element).not.toHaveAttribute('data-turning');
  });
});
