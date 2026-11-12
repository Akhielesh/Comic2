/**
 * The kit's models and hooks beside the components (DS-R1): useSelection's rules (explicit mode, Shift ranges in
 * display order, pruning ids that leave the list), the one polite announcer, useScrollRestore, SplitPane's keyboard
 * gutter and remembered sizes, the Inspector's presentations, Row's single primary control.
 */
import React, { useRef } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { announce, ANNOUNCE_GAP_MS, announcedText, countWords, resetAnnouncer, useAnnounce } from './announce';
import { Inspector } from './Inspector';
import { Row } from './Row';
import { SplitPane } from './SplitPane';
import { scopedKey } from './storage';
import { readScrollPosition, useScrollRestore, writeScrollPosition } from './useScrollRestore';
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

  it('puts a list back where it was left, per key, for this tab', () => {
    writeScrollPosition('library:grid', 640);
    render(<List id="library:grid" />);
    expect(screen.getByTestId('list').scrollTop).toBe(640);
    expect(window.sessionStorage.getItem(scopedKey('scroll', 'library:grid'))).toBe('640');
  });

  it('saves the position when the list unmounts', () => {
    const { unmount } = render(<List id="pages" />);
    const el = screen.getByTestId('list');
    el.scrollTop = 300;
    unmount();
    expect(readScrollPosition('pages')).toBe(300);
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
