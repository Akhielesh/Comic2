// BookTimeline: the video-editor style dock (timeline.md §4.2, §7 client).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { makeFakeStudio, makeSampleDoc } from '../conversation/testing/fixtures';
import { BookTimeline, DOCK_OPEN_KEY, dragShift, dropIndex } from './BookTimeline';
import { clipThumbWidth } from './TimelineClip';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });

const options = () => screen.getAllByRole('option');
const optionNamed = (re: RegExp) => options().find((o) => re.test(o.getAttribute('aria-label') || ''))!;
const lastPatch = (studio: ReturnType<typeof makeFakeStudio>) => studio.patch.mock.calls[studio.patch.mock.calls.length - 1];

const setup = (doc: ComicDoc = makeSampleDoc(), extra: Parameters<typeof makeFakeStudio>[0] = {}, props: Partial<React.ComponentProps<typeof BookTimeline>> = {}) => {
  const studio = makeFakeStudio({ doc, tab: 'pages', ...extra });
  const utils = render(<BookTimeline studio={studio} reorderActivation="immediate" {...props} />);
  return { studio, ...utils };
};

beforeEach(() => {
  setWidth(1280);
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => setWidth(1024));

describe('BookTimeline', () => {
  it('shows the book in order: cover, pages, add-page, then the free software-page chips', () => {
    setup();
    const listbox = screen.getByRole('listbox', { name: 'Book timeline' });
    expect(listbox.getAttribute('aria-orientation')).toBe('horizontal');
    expect(listbox.getAttribute('aria-roledescription')).toBe('page timeline');
    const labels = options().map((o) => o.getAttribute('aria-label'));
    expect(labels[0]).toMatch(/^Cover, planned/);
    expect(labels[1]).toMatch(/^Page 1, ready/);
    expect(labels[2]).toMatch(/^Page 2, planned/);
    expect(labels[3]).toMatch(/^Page 3, failed/);
    expect(labels[4]).toMatch(/^Add page — a blank page, free/);
    expect(labels.slice(5)).toEqual(['Title page — made by software, free', '“The End” — made by software, free', 'Back cover — made by software, free']);
    // Roving focus: exactly one tab stop.
    expect(options().filter((o) => o.tabIndex === 0)).toHaveLength(1);
  });

  it('plates appear as clips when switched on; a ghost chip switches one on (free book op)', () => {
    const doc = makeSampleDoc({ book: { titlePage: true, endPage: false, backCover: 'none', firstPageRight: true, uniformTrim: true } });
    const { studio } = setup(doc);
    expect(options()[1].getAttribute('aria-label')).toBe('Title page, made by software, free');
    fireEvent.click(optionNamed(/^“The End” — /));
    expect(lastPatch(studio)[0]).toEqual([{ op: 'book', patch: { endPage: true } }]);
  });

  it('Alt+→ moves a page (pages_reorder) with an undo toast; Undo sends the inverse without a new undo entry', () => {
    const { studio } = setup();
    fireEvent.keyDown(optionNamed(/^Page 1,/), { key: 'ArrowRight', altKey: true });
    expect(lastPatch(studio)[0]).toEqual([{ op: 'pages_reorder', order: ['pg_2', 'pg_1', 'pg_3'] }]);
    expect(screen.getByText('Moved page 1 → 2')).toBeInTheDocument();
    expect(screen.getByText('Page 1 moved to position 2.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    // The exact inverse (shared undo.ts): the old order, plus the old pageCount when the op synced it.
    expect(lastPatch(studio)[0][0]).toEqual({ op: 'pages_reorder', order: ['pg_1', 'pg_2', 'pg_3'] });
    expect(lastPatch(studio)[1]).toMatchObject({ undo: false });
  });

  it('Delete removes a page with Undo; Undo restores it at its number', () => {
    const { studio } = setup();
    fireEvent.keyDown(optionNamed(/^Page 1,/), { key: 'Delete' });
    const [ops] = lastPatch(studio);
    expect(ops).toEqual([{ op: 'page_delete', id: 'pg_1', deletedAt: expect.any(Number) }]);
    expect(screen.getByText('Page 1 deleted')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(lastPatch(studio)[0][0]).toEqual({ op: 'page_restore', id: 'pg_1', n: 1 });
  });

  it('a page that is drawing cannot be deleted or duplicated — it says why and sends nothing', () => {
    const doc = makeSampleDoc();
    doc.pages[1] = { ...doc.pages[1], render: { status: 'rendering', history: [] } };
    const { studio } = setup(doc);
    const busy = optionNamed(/^Page 2,/);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    fireEvent.keyDown(busy, { key: 'Delete' });
    fireEvent.keyDown(busy, { key: 'd' });
    expect(studio.patch).not.toHaveBeenCalled();
    expect(screen.getByText(/Page 2 is still drawing — duplicate it when it's done\./)).toBeInTheDocument();
  });

  it('Enter opens the page; V opens its versions; D duplicates; I inserts after', () => {
    const doc = makeSampleDoc();
    doc.pages[0].render = { ...doc.pages[0].render, history: [{ path: 'u/x/p/pg_1-old.webp', source: 'generated', at: 1 }] };
    const { studio } = setup(doc);
    const p1 = optionNamed(/^Page 1,/);
    fireEvent.keyDown(p1, { key: 'Enter' });
    expect(studio.openPage).toHaveBeenCalledWith('pg_1');
    p1.focus();
    fireEvent.keyDown(p1, { key: 'v' });
    expect(screen.getByRole('dialog', { name: 'Page 1 · versions' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(p1); // focus goes back to the clip
    fireEvent.keyDown(p1, { key: 'd' });
    expect(lastPatch(studio)[0]).toEqual([{ op: 'page_duplicate', id: 'pg_1', newId: expect.stringMatching(/^pg_/) }]);
    fireEvent.keyDown(p1, { key: 'i' });
    expect(lastPatch(studio)[0]).toEqual([{ op: 'page_insert', id: expect.stringMatching(/^pg_/), after: 1 }]);
  });

  it('the clip menu (M) offers every action with honest prices; Redraw goes through the normal gate', () => {
    const { studio } = setup();
    fireEvent.keyDown(optionNamed(/^Page 1,/), { key: 'm' });
    const menu = screen.getByRole('menu', { name: 'Page 1 actions' });
    const items = within(menu).getAllByRole('menuitem').map((b) => b.textContent);
    expect(items).toEqual([
      'Open pageEnter',
      'Versions (1)Free',
      expect.stringMatching(/^Redraw \(new take\)≈ \$\d+\.\d\d$/),
      'DuplicateFree',
      'Insert blank page afterFree',
      'Move earlierAlt+←',
      'Move laterAlt+→',
      'Delete pageUndo'
    ]);
    expect(within(menu).getByRole('menuitem', { name: /Move earlier/ })).toBeDisabled();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Redraw/ }));
    expect(studio.act).toHaveBeenCalledWith({ type: 'render_pages', pageIds: ['pg_1'], force: true, quotedUsd: expect.any(Number) });
    expect(studio.patch).not.toHaveBeenCalled();
  });

  it('collapses below lg by default (phones keep the board), remembers the choice, hides in Read', () => {
    setWidth(360);
    const { unmount } = setup();
    const toggle = screen.getByRole('button', { name: 'Book' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText(/Cover|No cover yet/).textContent).toMatch(/1\/3 pages drawn/);
    fireEvent.click(toggle);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(window.localStorage.getItem(DOCK_OPEN_KEY)).toBe('1');
    unmount();
    const read = setup(makeSampleDoc(), { tab: 'read' });
    expect(read.container).toBeEmptyDOMElement();
  });

  it('never overflows at 360 px: the dock clips, the strip scrolls inside, clips have fixed sizes', () => {
    setWidth(360);
    window.localStorage.setItem(DOCK_OPEN_KEY, '1');
    const { container } = setup();
    const section = container.querySelector('section[aria-label="Book timeline"]') as HTMLElement;
    expect(section.className).toMatch(/\boverflow-hidden\b/);
    expect(section.className).toMatch(/\bmin-w-0\b/);
    expect(section.className).toMatch(/\bmax-w-full\b/);
    const scroller = screen.getByRole('listbox').parentElement as HTMLElement;
    expect(scroller.className).toMatch(/\boverflow-x-auto\b/);
    expect(scroller.className).toMatch(/\bmin-w-0\b/);
    expect(scroller.className).toMatch(/\bmax-w-full\b/);
    // Every clip and chip keeps a ≥ 44 px target; thumbnails are bounded whatever the art's shape.
    for (const o of options()) expect(o.style.minWidth).toBe('44px');
    expect(clipThumbWidth(21 / 9, false)).toBe(116);
    expect(clipThumbWidth(1 / 8, false)).toBe(44);
    expect(clipThumbWidth(Number.NaN, true)).toBeGreaterThanOrEqual(34);
  });

  it('compact mode (page editor strip): no dock bar, no ghost chips, tap opens the page', () => {
    const { studio } = setup(makeSampleDoc(), {}, { compact: true });
    expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
    expect(options().some((o) => /made by software/.test(o.getAttribute('aria-label') || ''))).toBe(false);
    fireEvent.click(optionNamed(/^Page 3,/));
    expect(studio.openPage).toHaveBeenCalledWith('pg_3');
  });

  it('drag maths: drop index from clip centres; neighbours shift by one clip', () => {
    const slots = [
      { left: 0, width: 60 },
      { left: 64, width: 60 },
      { left: 128, width: 60 }
    ];
    expect(dropIndex(slots, 0, 0)).toBe(0);
    expect(dropIndex(slots, 0, 70)).toBe(1);
    expect(dropIndex(slots, 0, 140)).toBe(2);
    expect(dropIndex(slots, 2, -140)).toBe(0);
    expect(dragShift(1, 0, 2, 60)).toBe(-64);
    expect(dragShift(1, 2, 0, 60)).toBe(64);
    expect(dragShift(2, 0, 1, 60)).toBe(0);
  });

  it('mouse drag reorders immediately; a click right after the drop is not an open', () => {
    const { studio } = setup();
    const p1 = optionNamed(/^Page 1,/);
    // jsdom has no layout: give the three page clips positions.
    const pageClips = options().filter((o) => /^Page \d/.test(o.getAttribute('aria-label') || ''));
    pageClips.forEach((el, i) => {
      Object.defineProperty(el, 'offsetLeft', { value: i * 64, configurable: true });
      Object.defineProperty(el, 'offsetWidth', { value: 60, configurable: true });
    });
    fireEvent.pointerDown(p1, { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 30, clientY: 10 });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 40, clientY: 10 }));
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 175, clientY: 10 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 175, clientY: 10 }));
    });
    expect(lastPatch(studio)[0]).toEqual([{ op: 'pages_reorder', order: ['pg_2', 'pg_3', 'pg_1'] }]);
    fireEvent.click(p1);
    expect(studio.openPage).not.toHaveBeenCalled();
  });
});
