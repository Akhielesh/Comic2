// BookTimeline: the video-editor style dock (timeline.md §4.2, §7 client).
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { emptyRender, type ComicDoc } from '../../../shared/comic/doc';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices, showUsagePrices } from '../conversation/testing/fixtures';
import { BookTimeline, DOCK_OPEN_KEY, LONG_PRESS_MS, dragShift, dropIndex, stripScrollDelta } from './BookTimeline';
import { computeAccessibleName } from 'dom-accessibility-api';
import { FormFactorProvider, formFactorFor } from '../mobile/useFormFactor';
import { clipThumbWidth } from './TimelineClip';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });

const options = () => screen.getAllByRole('option');
/** Clips are named by their own content (no aria-label that could drift from the visible text). */
const nameOf = (el: Element) => computeAccessibleName(el);
const optionNamed = (re: RegExp) => options().find((o) => re.test(nameOf(o)))!;
const lastPatch = (studio: ReturnType<typeof makeFakeStudio>) => studio.patch.mock.calls[studio.patch.mock.calls.length - 1];

const setup = (doc: ComicDoc = makeSampleDoc(), extra: Parameters<typeof makeFakeStudio>[0] = {}, props: Partial<React.ComponentProps<typeof BookTimeline>> = {}) => {
  const studio = makeFakeStudio({ doc, tab: 'pages', ...extra });
  const utils = render(<BookTimeline studio={studio} reorderActivation="immediate" {...props} />);
  return { studio, ...utils };
};

beforeEach(() => {
  // Admin / own-key wording (dollars); governed users have their own tests.
  showDollarPrices();
  setWidth(1280);
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  setWidth(1024);
  resetUsageStatus();
});

describe('BookTimeline', () => {
  it('shows the book in order: cover, pages, add-page, then the free software-page chips', () => {
    setup();
    const listbox = screen.getByRole('listbox', { name: 'Book timeline' });
    expect(listbox.getAttribute('aria-orientation')).toBe('horizontal');
    expect(listbox.getAttribute('aria-roledescription')).toBe('page timeline');
    const labels = options().map((o) => nameOf(o));
    for (const o of options()) expect(o).not.toHaveAttribute('aria-label');
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
    expect(nameOf(options()[1])).toBe('Title page, made by software, free');
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

  it('governed users: the clip menu, the dock summary and clip names speak in shares of their usage', () => {
    showUsagePrices(1);
    const doc = makeSampleDoc();
    doc.spend = { ...doc.spend, totalUsd: 0.42, savedUsd: 0.06 };
    const { container } = setup(doc);
    expect(container.textContent).not.toMatch(/\$/);
    fireEvent.keyDown(optionNamed(/^Page 1,/), { key: 'm' });
    const menu = screen.getByRole('menu', { name: 'Page 1 actions' });
    expect(within(menu).getByRole('menuitem', { name: /Redraw/ }).textContent).toMatch(/(≈[\d.]+%|<0\.1%) of your usage$/);
    expect(menu.textContent).not.toMatch(/\$/);
    for (const o of options()) expect(nameOf(o)).not.toMatch(/\$/);
  });

  it('before the usage status loads (non-admin): no dollar figure anywhere in the dock', () => {
    resetUsageStatus();
    const doc = makeSampleDoc();
    doc.spend = { ...doc.spend, totalUsd: 0.42 };
    const { container } = setup(doc);
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('the toast Undo runs the studio undo while this edit is still on top of the one undo stack', () => {
    const { studio, rerender } = setup();
    fireEvent.keyDown(optionNamed(/^Page 1,/), { key: 'Delete' });
    const [, opts] = lastPatch(studio);
    // The studio recorded it (under this label) and nothing landed on top since.
    const live = { ...studio, canUndo: true, undoLabel: opts.label };
    rerender(<BookTimeline studio={live} reorderActivation="immediate" />);
    const before = studio.patch.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(studio.undo).toHaveBeenCalledTimes(1);
    expect(studio.patch.mock.calls.length).toBe(before);
  });

  it('a hidden-state clip has no focusable control inside it (nested-interactive) and failed badges keep 4.5:1', () => {
    setup();
    for (const o of options()) expect(o.querySelector('button, [tabindex]:not([tabindex="-1"]), a[href], input')).toBeNull();
    expect(document.querySelector('.bg-red-600\\/90')).toBeNull();
    // The failed badge: red-700 (white text 6.5:1) at a readable 10 px, never the old 8.5 px.
    const badge = document.querySelector('[data-clip-badge="failed"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.className).toContain('bg-red-700');
    expect(badge.className).toContain('text-[10px]');
  });

  it('the dock keeps its buttons out of the home-indicator inset on tablets and desktops; phones leave it to the tab bar (timeline-dock-safe-area)', () => {
    const { container, unmount } = setup();
    const dock = container.querySelector('section[aria-label="Book timeline"]') as HTMLElement;
    expect(dock.style.paddingBottom).toBe('var(--sa-bottom, 0px)');
    unmount();
    const phone = render(
      <FormFactorProvider value={formFactorFor({ w: 390, h: 844, coarse: true })}>
        <BookTimeline studio={makeFakeStudio({ doc: makeSampleDoc(), tab: 'pages' })} />
      </FormFactorProvider>
    );
    expect((phone.container.querySelector('section[aria-label="Book timeline"]') as HTMLElement).style.paddingBottom).toBe('');
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
    expect(options().some((o) => /made by software/.test(nameOf(o)))).toBe(false);
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

  describe('keeps the page being edited in view by scrolling only its own strip (gate: editor-tools-sheet-header-scrolled-away)', () => {
    /** jsdom has no layout: give an element a horizontal box (viewport coordinates). */
    const box = (el: Element, left: number, right: number) => {
      (el as HTMLElement).getBoundingClientRect = () => ({ left, right, width: right - left, top: 0, bottom: 64, height: 64, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
    };
    let intoView: ReturnType<typeof vi.fn>;
    let restore: () => void;
    beforeEach(() => {
      // jsdom has no scrollIntoView: install a spy so any call — the bug — is seen.
      const proto = Element.prototype as unknown as Record<string, unknown>;
      const had = Object.prototype.hasOwnProperty.call(proto, 'scrollIntoView');
      const prev = proto.scrollIntoView;
      intoView = vi.fn();
      proto.scrollIntoView = intoView;
      restore = () => {
        if (had) proto.scrollIntoView = prev;
        else delete proto.scrollIntoView;
      };
    });
    afterEach(() => restore());

    it('scrolls the strip sideways to the page; never scrollIntoView, so no ancestor (the phone tools sheet and its aside) moves', () => {
      const studio = makeFakeStudio({ doc: makeSampleDoc(), tab: 'pages' });
      // As on a phone: the compact strip inside the tools aside inside the sheet's clipped root.
      const tree = (s: typeof studio) => (
        <div data-testid="sheet-root" style={{ overflow: 'hidden', height: 208 }}>
          <aside data-testid="tools-aside" style={{ overflowY: 'auto' }}>
            <BookTimeline studio={s} compact />
          </aside>
        </div>
      );
      const { rerender } = render(tree(studio));
      const scroller = screen.getByRole('listbox').parentElement as HTMLElement;
      // A 300 px strip at the left edge; page 3 is off to the right, page 1 in view, the cover too.
      box(scroller, 0, 300);
      Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true });
      box(optionNamed(/^Cover,/), 6, 66);
      box(optionNamed(/^Page 1,/), 70, 130);
      box(optionNamed(/^Page 2,/), 134, 194);
      box(optionNamed(/^Page 3,/), 500, 560);

      rerender(tree({ ...studio, focusedPageId: 'pg_3' }));
      expect(intoView).not.toHaveBeenCalled();
      // jsdom has no Element.scrollTo: the strip's scrollLeft is set directly — 560 − (300 − 4 px margin).
      expect(scroller.scrollLeft).toBe(264);
      expect(screen.getByTestId('sheet-root').scrollTop).toBe(0);
      expect(screen.getByTestId('tools-aside').scrollTop).toBe(0);

      // Back to page 1 (now off to the left), where scrollTo exists: one smooth sideways scroll of the strip.
      const scrollTo = vi.fn();
      (scroller as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
      box(optionNamed(/^Page 1,/), -194, -134);
      rerender(tree({ ...studio, focusedPageId: 'pg_1' }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo).toHaveBeenCalledWith({ left: 264 - 198, behavior: 'smooth' });

      // A page already fully in view: nothing scrolls.
      rerender(tree({ ...studio, focusedPageId: 'pg_2' }));
      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(intoView).not.toHaveBeenCalled();
      expect(screen.getByTestId('sheet-root').scrollTop).toBe(0);
      expect(screen.getByTestId('tools-aside').scrollTop).toBe(0);
    });

    it('the dock strip too: opening a page scrolls only the strip, never the studio around it', () => {
      window.localStorage.setItem(DOCK_OPEN_KEY, '1');
      const studio = makeFakeStudio({ doc: makeSampleDoc(), tab: 'pages' });
      const { rerender } = render(<BookTimeline studio={studio} reorderActivation="immediate" />);
      const scroller = screen.getByRole('listbox').parentElement as HTMLElement;
      box(scroller, 0, 300);
      Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true });
      box(optionNamed(/^Page 3,/), 400, 460);
      rerender(<BookTimeline studio={{ ...studio, focusedPageId: 'pg_3' }} reorderActivation="immediate" />);
      expect(intoView).not.toHaveBeenCalled();
      expect(scroller.scrollLeft).toBe(164);
    });

    it('nearest-edge maths with a 4 px margin; a clip wider than the view shows its start', () => {
      const view = { left: 0, right: 300 };
      expect(stripScrollDelta(view, { left: 10, right: 70 })).toBe(0);
      expect(stripScrollDelta(view, { left: 4, right: 296 })).toBe(0);
      expect(stripScrollDelta(view, { left: 500, right: 560 })).toBe(264);
      expect(stripScrollDelta(view, { left: -60, right: 0 })).toBe(-64);
      expect(stripScrollDelta(view, { left: 100, right: 500 })).toBe(96);
      expect(stripScrollDelta(view, { left: -100, right: 400 })).toBe(-104);
      // No layout (hidden strip, jsdom): never scroll.
      expect(stripScrollDelta({ left: 0, right: 0 }, { left: 500, right: 560 })).toBe(0);
    });
  });

  it('the dock’s Media shortcut appears only once the comic has an image (no dead button before)', () => {
    const { unmount } = setup();
    expect(screen.getByRole('button', { name: 'Open Media: every image in this comic' })).toBeInTheDocument();
    unmount();
    const bare = makeSampleDoc();
    bare.pages = bare.pages.map((p) => ({ ...p, render: emptyRender() }));
    bare.style = { ...bare.style, options: [], board: undefined, refs: [] };
    bare.cast = bare.cast.map((c) => ({ ...c, refs: [], sheet: emptyRender() }));
    bare.places = [];
    bare.cover = { ...bare.cover, render: emptyRender() };
    bare.conversation = [];
    setup(bare);
    expect(screen.getByRole('button', { name: 'Book' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Media/ })).toBeNull();
  });

  describe('touch: long-press lifts a clip so scrolling never turns into a move', () => {
    const layout = () =>
      options()
        .filter((o) => /^Page \d/.test(nameOf(o)))
        .forEach((el, i) => {
          Object.defineProperty(el, 'offsetLeft', { value: i * 64, configurable: true });
          Object.defineProperty(el, 'offsetWidth', { value: 60, configurable: true });
        });
    const touch = (type: string, x: number, y = 10) => window.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', clientX: x, clientY: y }));
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('hold, then drag: the page moves (pages_reorder) and the tap after the drop does not open it', () => {
      const { studio } = setup(makeSampleDoc(), {}, { reorderActivation: 'longpress' });
      layout();
      const p1 = optionNamed(/^Page 1,/);
      fireEvent.pointerDown(p1, { button: 0, pointerId: 7, pointerType: 'touch', clientX: 30, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS + 10);
      });
      act(() => {
        touch('pointermove', 100);
        touch('pointermove', 175);
        touch('pointerup', 175);
      });
      expect(lastPatch(studio)[0]).toEqual([{ op: 'pages_reorder', order: ['pg_2', 'pg_3', 'pg_1'] }]);
      fireEvent.click(p1);
      expect(studio.openPage).not.toHaveBeenCalled();
    });

    it('a finger that moves before the hold completes is a scroll: nothing moves, no menu', () => {
      const { studio } = setup(makeSampleDoc(), {}, { reorderActivation: 'longpress' });
      layout();
      const p1 = optionNamed(/^Page 1,/);
      fireEvent.pointerDown(p1, { button: 0, pointerId: 7, pointerType: 'touch', clientX: 30, clientY: 10 });
      act(() => {
        touch('pointermove', 60);
        vi.advanceTimersByTime(LONG_PRESS_MS + 10);
        touch('pointermove', 175);
        touch('pointerup', 175);
      });
      expect(studio.patch).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('hold and release without moving opens the clip menu', () => {
      setup(makeSampleDoc(), {}, { reorderActivation: 'longpress' });
      layout();
      const p2 = optionNamed(/^Page 2,/);
      fireEvent.pointerDown(p2, { button: 0, pointerId: 7, pointerType: 'touch', clientX: 94, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_MS + 10);
        touch('pointerup', 94);
      });
      expect(screen.getByRole('menu', { name: 'Page 2 actions' })).toBeInTheDocument();
    });
  });

  it('mouse drag reorders immediately; a click right after the drop is not an open', () => {
    const { studio } = setup();
    const p1 = optionNamed(/^Page 1,/);
    // jsdom has no layout: give the three page clips positions.
    const pageClips = options().filter((o) => /^Page \d/.test(nameOf(o)));
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
