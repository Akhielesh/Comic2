/**
 * The kit's models and hooks beside the components (DS-R1): useSelection's rules (explicit mode, Shift ranges in
 * display order, pruning ids that leave the list), the one polite announcer, useScrollRestore, SplitPane's keyboard
 * gutter and remembered sizes, the Inspector's presentations, Row's single primary control.
 */
import React, { useCallback, useRef } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announce, ANNOUNCE_GAP_MS, announcedText, countWords, resetAnnouncer, useAnnounce } from './announce';
import { Inspector } from './Inspector';
import { Row } from './Row';
import { SplitPane, splitBounds } from './SplitPane';
import { scopedKey } from './storage';
import { readScrollPosition, RESTORE_ATTEMPTS, useScrollRestore, writeScrollPosition } from './useScrollRestore';
import { EMPTY_SELECTION, selectionReducer, useSelection, type SelectionState } from './useSelection';

afterEach(() => {
  resetAnnouncer();
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('useSelection', () => {
  const start = EMPTY_SELECTION as SelectionState<string>;

  it('the reducer: toggle enters selection mode, Shift ranges follow display order, clear leaves the mode', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    let s = selectionReducer(start, { type: 'toggle', id: 'b' });
    expect(s).toEqual({ selecting: true, selected: ['b'], anchor: 'b' });
    s = selectionReducer(s, { type: 'range', id: 'e', order });
    expect(s.selected).toEqual(['b', 'c', 'd', 'e']);
    s = selectionReducer(s, { type: 'toggle', id: 'c' });
    expect(s.selected).toEqual(['b', 'd', 'e']);
    expect(selectionReducer(s, { type: 'toggle', id: 'b' }).selecting).toBe(true);
    expect(selectionReducer(s, { type: 'clear' })).toEqual(EMPTY_SELECTION);
  });

  it('ids that leave the list leave the selection, so a bulk action never acts on what is not shown', () => {
    const { result, rerender } = renderHook(({ ids }) => useSelection(ids), { initialProps: { ids: ['a', 'b', 'c'] } });
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('c'));
    expect(result.current.selected).toEqual(['a', 'c']);
    rerender({ ids: ['a', 'b'] });
    expect(result.current.selected).toEqual(['a']);
    expect(result.current.count).toBe(1);
    act(() => result.current.selectAll());
    expect(result.current.selected).toEqual(['a', 'b']);
    act(() => result.current.clear());
    expect(result.current.selecting).toBe(false);
  });

  it('an id filtered out is dropped for good: hidden it is not selected, and back in view it is still not selected', () => {
    const { result, rerender } = renderHook(({ ids }) => useSelection(ids), { initialProps: { ids: ['a', 'b', 'c'] } });
    act(() => result.current.toggle('a'));
    act(() => result.current.toggle('c'));
    rerender({ ids: ['a', 'b'] });
    // While hidden, nothing reports it as selected (a bulk action reads isSelected too).
    expect(result.current.isSelected('c')).toBe(false);
    expect(result.current.selected).toEqual(['a']);
    rerender({ ids: ['a', 'b', 'c'] });
    expect(result.current.selected).toEqual(['a']);
    expect(result.current.isSelected('c')).toBe(false);
    expect(result.current.count).toBe(1);
  });
});

describe('announce', () => {
  it('speaks through one polite region, re-speaks the same words, and says counts the kit way', () => {
    vi.useFakeTimers();
    announce('12 comics');
    expect(announcedText()).toBe('');
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(announcedText()).toBe('12 comics');
    const regions = document.querySelectorAll('[data-ds-announcer="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveAttribute('aria-live', 'polite');
    announce('12 comics');
    expect(announcedText()).toBe('');
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(announcedText()).toBe('12 comics');
    expect(document.querySelectorAll('[data-ds-announcer]')).toHaveLength(1);
    expect([countWords(0, 'comic'), countWords(1, 'comic'), countWords(1204, 'comic')]).toEqual(['No comics', '1 comic', `${(1204).toLocaleString()} comics`]);
  });

  it('useAnnounce stays quiet on the first render and speaks each change', () => {
    vi.useFakeTimers();
    const { rerender } = renderHook(({ m }) => useAnnounce(m), { initialProps: { m: '6 comics' } });
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(announcedText()).toBe('');
    rerender({ m: '2 comics' });
    act(() => vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(announcedText()).toBe('2 comics');
  });
});

describe('useScrollRestore', () => {
  const List: React.FC<{ id: string }> = ({ id }) => {
    const ref = useRef<HTMLDivElement>(null);
    useScrollRestore(ref, id);
    return <div ref={ref} data-testid="list" />;
  };


  it('saves the position when the list unmounts', () => {
    const { unmount } = render(<List id="pages" />);
    const el = screen.getByTestId('list');
    el.scrollTop = 300;
    unmount();
    expect(readScrollPosition('pages')).toBe(300);
  });

  /** A scroller that behaves like a browser's: 100 px rows in a 400 px box, scrollTop clamped to what the rows allow. */
  const fakeScroller = (el: HTMLElement) => {
    let top = 0;
    const max = () => Math.max(0, el.children.length * 100 - 400);
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => Math.max(400, el.children.length * 100) });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.min(max(), Math.max(0, v));
      }
    });
  };
  const Growing: React.FC<{ id: string; rows: number }> = ({ id, rows }) => {
    const ref = useRef<HTMLDivElement | null>(null);
    const attach = useCallback((el: HTMLDivElement | null) => {
      ref.current = el;
      if (el) fakeScroller(el);
    }, []);
    useScrollRestore(ref, id);
    return (
      <div ref={attach} data-testid="grow">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i}>row {i}</div>
        ))}
      </div>
    );
  };

  it('puts a list back where it was left, per key, for this tab', () => {
    writeScrollPosition('library:grid', 640);
    render(<Growing id="library:grid" rows={20} />);
    expect(screen.getByTestId('grow').scrollTop).toBe(640);
    expect(window.sessionStorage.getItem(scopedKey('scroll', 'library:grid'))).toBe('640');
    expect(readScrollPosition('studio:other')).toBe(0);
  });

  it('a list whose items arrive after mount is restored once they are tall enough, and the wait never overwrites the position', async () => {
    writeScrollPosition('library:grid', 640);
    const { rerender, unmount } = render(<Growing id="library:grid" rows={0} />);
    const el = screen.getByTestId('grow');
    // Nothing to scroll yet: it waits instead of clamping to 0 and forgetting.
    expect(el.scrollTop).toBe(0);
    rerender(<Growing id="library:grid" rows={4} />);
    await act(async () => {});
    expect(el.scrollTop).toBe(0);
    expect(readScrollPosition('library:grid')).toBe(640);
    // The comics arrive: 20 rows reach 640.
    rerender(<Growing id="library:grid" rows={20} />);
    await act(async () => {});
    expect(el.scrollTop).toBe(640);
    unmount();
    expect(readScrollPosition('library:grid')).toBe(640);
  });

  it('a list that unmounts before its content arrives keeps the remembered position; the person scrolling first wins', async () => {
    writeScrollPosition('pages', 900);
    const first = render(<Growing id="pages" rows={0} />);
    first.unmount();
    expect(readScrollPosition('pages')).toBe(900);
    const again = render(<Growing id="pages" rows={6} />);
    const el = screen.getByTestId('grow');
    el.scrollTop = 120;
    fireEvent.scroll(el);
    // The person's own scroll ends the wait: growing later does not jump them to 900.
    again.rerender(<Growing id="pages" rows={30} />);
    await act(async () => {});
    expect(el.scrollTop).toBe(120);
    again.unmount();
    expect(readScrollPosition('pages')).toBe(120);
    expect(RESTORE_ATTEMPTS).toBeGreaterThan(0);
  });
});

describe('SplitPane', () => {
  it('the gutter is a separator that moves with the arrow keys, resets with Home and remembers its sizes', () => {
    render(<SplitPane id="director" label="Resize the Director" defaultSizes={[40, 60]} start={<div>Director</div>} end={<div>Pages</div>} />);
    const gutter = screen.getByRole('separator', { name: 'Resize the Director' });
    expect(gutter).toHaveAttribute('aria-valuenow', '40');
    fireEvent.keyDown(gutter, { key: 'ArrowRight' });
    expect(gutter).toHaveAttribute('aria-valuenow', '43');
    expect(JSON.parse(window.localStorage.getItem('ds.split.director')!)).toEqual([43, 57]);
    fireEvent.keyDown(gutter, { key: 'Home' });
    expect(gutter).toHaveAttribute('aria-valuenow', '40');
  });

  it('a drag holds each pane in its own px range (the Director 320–520 at 1440), measures once, and is saved once when it ends', () => {
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const w = this.getAttribute('data-slot') === 'split-pane' ? 1440 : 0;
      return { x: 0, y: 0, left: 0, top: 0, width: w, height: 900, right: w, bottom: 900, toJSON: () => ({}) } as DOMRect;
    });
    const { container } = render(
      <SplitPane id="studio" label="Resize the Director" defaultSizes={[1040, 400]} minPx={320} endMinPx={320} endMaxPx={520} start={<div>Pages</div>} end={<div>Director</div>} />
    );
    const gutter = screen.getByRole('separator', { name: 'Resize the Director' });
    const endPx = () => {
      const [a, b] = [container.querySelector('[data-pane="start"]'), container.querySelector('[data-pane="end"]')].map((p) => Number((p as HTMLElement).style.flexGrow));
      return (b / (a + b)) * 1440;
    };
    const writes = vi.spyOn(Storage.prototype, 'setItem');
    rect.mockClear();
    fireEvent.pointerDown(gutter, { pointerType: 'mouse', button: 0, clientX: 1040 });
    // Drag the gutter far left: the Director would grow to ~1000 px; it stops at 520.
    for (const x of [900, 700, 500, 300, 100]) fireEvent.pointerMove(window, { clientX: x });
    expect(Math.round(endPx())).toBe(520);
    expect((container.querySelector('[data-pane="end"]') as HTMLElement).style.maxWidth).toBe('520px');
    // Far right: never under 320.
    for (const x of [1200, 1400, 1440]) fireEvent.pointerMove(window, { clientX: x });
    expect(Math.round(endPx())).toBe(320);
    expect(rect).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    fireEvent.pointerUp(window, { clientX: 1440 });
    expect(writes).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(window.localStorage.getItem('ds.split.studio')!) as [number, number];
    expect(Math.round((saved[1] / (saved[0] + saved[1])) * 1440)).toBe(320);
    writes.mockRestore();
    rect.mockRestore();
  });

  it('splitBounds: both minimums (capped at 45 %), then the maximums; a window too narrow for a maximum keeps the minimums', () => {
    const b = splitBounds(1440, 100, { minPx: 320, endMinPx: 320, endMaxPx: 520 });
    expect(b.lo).toBeCloseTo(((1440 - 520) / 1440) * 100);
    expect(b.hi).toBeCloseTo(((1440 - 320) / 1440) * 100);
    const narrow = splitBounds(600, 100, { minPx: 320, endMaxPx: 100 });
    expect(narrow).toEqual({ lo: 45, hi: 55 });
    expect(splitBounds(0, 100, { minPx: 320 })).toEqual({ lo: 25, hi: 75 });
  });

  it('a hidden pane stays mounted, hidden and inert', () => {
    const { container } = render(<SplitPane label="Resize" show="end" start={<textarea defaultValue="draft" />} end={<div>Pages</div>} />);
    const startPane = container.querySelector('[data-pane="start"]') as HTMLElement;
    expect(startPane.hidden).toBe(true);
    expect(startPane.hasAttribute('inert')).toBe(true);
    expect(startPane.querySelector('textarea')).not.toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
  });
});

describe('Inspector', () => {
  it('a foldable segment is always mounted and says what to do while nothing is selected; a panel is an aside of its width', () => {
    const { rerender } = render(<Inspector layout={{ mode: 'segment', widthPx: null, scrim: false, detents: null }} open={false} onClose={() => {}} label="Comic details" />);
    expect(screen.getByRole('complementary', { name: 'Comic details' })).toHaveTextContent('Select a comic to see its details');
    rerender(
      <Inspector layout={{ mode: 'panel', widthPx: 360, scrim: false, detents: null }} open onClose={() => {}} label="Comic details">
        <p>The Harbor Lights</p>
      </Inspector>
    );
    const panel = screen.getByRole('complementary', { name: 'Comic details' });
    expect(panel.style.width).toBe('360px');
    expect(panel).toHaveTextContent('The Harbor Lights');
    rerender(<Inspector layout={{ mode: 'none', widthPx: null, scrim: false, detents: null }} open onClose={() => {}} label="Comic details" />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});

describe('Row', () => {
  it('has one primary control named by its title; the trailing actions are their own controls', () => {
    const open = vi.fn();
    const more = vi.fn();
    render(<Row title="The Harbor Lights" titleAs="h3" onOpen={open} meta={['Comic', '4 of 6 pages']} trailing={<button onClick={more}>More</button>} />);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'The Harbor Lights' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(more).toHaveBeenCalledTimes(1);
    expect(screen.getByText('4 of 6 pages')).toBeInTheDocument();
  });
});
