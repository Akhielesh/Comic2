// The parts tree in the side panel (SH-C2): an ARIA tree drawn flat, one tab stop, APG keys (Up/Down, Home/End, Right
// opens or steps in, Left closes or steps out, Enter/Space go there), the current part marked once, the open tab's path
// open by itself, a 200-page book cheap, and "Find a page" from StoryMap's index on books over 10 pages. Ink only.
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createEmptyDoc, type AssetRef, type Character, type ComicDoc, type Page, type RenderState } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { stageFacts } from '../../../shared/comic/stage';
import { BOARD_TABS } from '../board/boardNavigation';
import type { StudioTab } from '../types';
import { ComicSection } from './ComicSection';
import { PartsTree } from './PartsTree';
import type { BoardPart, PartTarget } from './partsModel';

const NOW = 1_800_000_000_000;
const picture = (): AssetRef => ({ path: 'u/p/pages/a.webp', source: 'generated', at: NOW });
const render_ = (status: RenderState['status'], asset?: AssetRef): RenderState => ({ status, history: [], ...(asset ? { asset } : {}) });
const page = (n: number, extra: Partial<Page> = {}): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: '',
  panels: [{ id: `pg_${n}_p1`, n: 1, size: 'medium', shot: 'medium', action: n === 7 ? 'Maya climbs the lighthouse' : 'A beat', castIds: [], lines: [] }],
  render: render_('none'),
  balloons: [],
  ...extra
});
const character = (id: string, name: string): Character => ({ id, name, tier: 'lead', look: { summary: '' }, refs: [], sheet: render_('none') });
const comic = (pages: number, patch: (doc: ComicDoc) => void = () => undefined): ComicDoc => {
  const doc = createEmptyDoc('c1', 'Salt Road', NOW);
  doc.brief.premise = 'A road along the salt flats.';
  doc.cast = [character('c_maya', 'Maya'), character('c_ossie', 'Ossie')];
  doc.pages = Array.from({ length: pages }, (_, i) => page(i + 1, i < 2 ? { render: render_('ready', picture()) } : {}));
  patch(doc);
  return doc;
};

type Opts = { tab?: StudioTab; focusedPageId?: string | null; part?: BoardPart | null };
const mount = (doc: ComicDoc, opts: Opts = {}) => {
  const onOpen = vi.fn<(target: PartTarget) => void>();
  const ui = (o: Opts) => <PartsTree doc={doc} tabs={BOARD_TABS} tab={o.tab ?? 'story'} focusedPageId={o.focusedPageId} part={o.part} onOpen={onOpen} />;
  const utils = render(ui(opts));
  return { ...utils, onOpen, rerenderWith: (o: Opts) => utils.rerender(ui(o)) };
};
const tree = () => screen.getByRole('tree', { name: 'Board' });
const items = () => within(tree()).getAllByRole('treeitem');
const item = (name: string) => within(tree()).getByRole('treeitem', { name });
const names = () => items().map((i) => i.getAttribute('aria-label'));

afterEach(cleanup);

describe('PartsTree', () => {
  it('lists the areas, opens the open tab’s parts by itself, and marks the current part once', () => {
    mount(comic(3), { tab: 'pages' });
    expect(names()).toEqual(['Story', 'Cast', 'Style', 'Pages', 'Page 1, Drawn', 'Page 2, Drawn', 'Page 3, Planned', 'Cover, Not drawn', 'Read']);
    expect(item('Cast')).toHaveAttribute('aria-expanded', 'false');
    expect(item('Pages')).toHaveAttribute('aria-expanded', 'true');
    expect(item('Story')).not.toHaveAttribute('aria-expanded');
    expect(item('Pages')).toHaveAttribute('aria-selected', 'true');
    expect(tree().querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    // Never the panel's one current-page mark.
    expect(tree().querySelectorAll('[aria-current]')).toHaveLength(0);
    expect(item('Page 2, Drawn')).toHaveAttribute('aria-level', '2');
    expect(item('Page 2, Drawn')).toHaveAttribute('aria-posinset', '2');
    expect(item('Page 2, Drawn')).toHaveAttribute('aria-setsize', '3');
    // The areas keep the board tabs' ids, and their counts.
    expect(item('Pages').id).toBe('board-tab-pages');
    expect(item('Pages')).toHaveTextContent('2/3');
    expect(item('Cast')).toHaveTextContent('2');
  });

  it('the page in the editor is current and its block opens; so does the block of a card you are on', () => {
    const doc = comic(60);
    const { rerenderWith } = mount(doc, { tab: 'pages', focusedPageId: 'pg_37' });
    expect(item('Pages 21–40, 0 of 20 drawn')).toHaveAttribute('aria-expanded', 'true');
    expect(item('Page 37, Planned')).toHaveAttribute('aria-selected', 'true');
    expect(item('Page 37, Planned')).toHaveAttribute('tabindex', '0');
    rerenderWith({ tab: 'pages', part: { kind: 'page', id: 'pg_45' } });
    // The card you are on is the one selected row: its block opens, the one opened for page 37 closes again.
    expect(item('Pages 41–60, 0 of 20 drawn')).toHaveAttribute('aria-expanded', 'true');
    expect(item('Page 45, Planned')).toHaveAttribute('aria-selected', 'true');
    expect(item('Page 45, Planned')).toHaveAttribute('tabindex', '0');
    expect(tree().querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    expect(item('Pages 21–40, 0 of 20 drawn')).toHaveAttribute('aria-expanded', 'false');
    rerenderWith({ tab: 'cast', part: { kind: 'character', id: 'c_ossie' } });
    expect(item('Ossie')).toHaveAttribute('aria-selected', 'true');
    expect(item('Cast')).toHaveAttribute('aria-expanded', 'true');
    // Pages closed again: it was open only because you were there.
    expect(item('Pages')).toHaveAttribute('aria-expanded', 'false');
  });

  it('where you are, inside a group closed by hand: the group row holds the tab stop and says so to a screen reader', () => {
    mount(comic(60), { tab: 'pages', part: { kind: 'page', id: 'pg_45' } });
    const block = item('Pages 41–60, 0 of 20 drawn');
    fireEvent.click(block.querySelector('[data-part-toggle]') as HTMLElement);
    expect(block).toHaveAttribute('aria-expanded', 'false');
    expect(tree().querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
    expect(block).toHaveAttribute('tabindex', '0');
    expect(block.className).toContain('font-semibold');
    expect(block).toHaveAccessibleDescription('Holds Page 45, where you are');
    // Every other row has no such words.
    expect(items().filter((i) => i.hasAttribute('aria-describedby'))).toEqual([block]);
  });

  it('a deliberate move brings its row into view in the panel; a card you move to in the board does not scroll it', () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      const { rerenderWith } = mount(comic(24), { tab: 'pages' });
      expect(scrolled).toEqual([item('Pages')]);
      // A card you move to in the board: marked, not scrolled to (the panel does not move while you work).
      rerenderWith({ tab: 'pages', part: { kind: 'page', id: 'pg_3' } });
      expect(item('Page 3, Planned')).toHaveAttribute('aria-selected', 'true');
      expect(scrolled).toHaveLength(1);
      // A page opened in the editor (from the book timeline, say): its row, 22 rows down, comes into view.
      rerenderWith({ tab: 'pages', focusedPageId: 'pg_22', part: { kind: 'page', id: 'pg_3' } });
      expect(scrolled).toEqual([item('Pages'), item('Page 22, Planned')]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('a 200-page book renders about ten rows under Pages until a block opens', () => {
    mount(comic(200), { tab: 'pages' });
    expect(items()).toHaveLength(6 + 10);
    fireEvent.click(item('Pages 181–200, 0 of 20 drawn'));
    expect(items()).toHaveLength(6 + 10 + 20);
    expect(item('Page 200, Planned')).toHaveAttribute('aria-level', '3');
  });

  it('one tab stop; Up, Down, Home and End move without going anywhere; Right and Left open, step in and out', () => {
    const { onOpen } = mount(comic(3), { tab: 'story' });
    const tabbable = items().filter((i) => i.tabIndex === 0);
    expect(tabbable).toEqual([item('Story')]);
    item('Story').focus();
    fireEvent.keyDown(item('Story'), { key: 'ArrowDown' });
    expect(item('Cast')).toHaveFocus();
    expect(item('Cast')).toHaveAttribute('tabindex', '0');
    expect(item('Story')).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(item('Cast'), { key: 'ArrowRight' });
    expect(item('Cast')).toHaveAttribute('aria-expanded', 'true');
    expect(item('Cast')).toHaveFocus();
    fireEvent.keyDown(item('Cast'), { key: 'ArrowRight' });
    expect(item('Maya')).toHaveFocus();
    fireEvent.keyDown(item('Maya'), { key: 'ArrowLeft' });
    expect(item('Cast')).toHaveFocus();
    fireEvent.keyDown(item('Cast'), { key: 'ArrowLeft' });
    expect(item('Cast')).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(item('Cast'), { key: 'End' });
    expect(item('Read')).toHaveFocus();
    fireEvent.keyDown(item('Read'), { key: 'ArrowDown' });
    expect(item('Read')).toHaveFocus();
    fireEvent.keyDown(item('Read'), { key: 'Home' });
    expect(item('Story')).toHaveFocus();
    expect(onOpen).not.toHaveBeenCalled();
    // Leaving the tree after exploring: coming back lands on the current part, not the row last visited.
    fireEvent.keyDown(item('Story'), { key: 'End' });
    expect(item('Read')).toHaveAttribute('tabindex', '0');
    fireEvent.blur(item('Read'), { relatedTarget: document.body });
    expect(item('Story')).toHaveAttribute('tabindex', '0');
    expect(item('Read')).toHaveAttribute('tabindex', '-1');
  });

  it('Enter, Space or a click goes where each part is edited; a group only opens and closes', () => {
    const { onOpen } = mount(comic(30), { tab: 'pages' });
    fireEvent.keyDown(item('Cover, Not drawn'), { key: 'Enter' });
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'cover' });
    fireEvent.keyDown(item('Style'), { key: ' ' });
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'area', tab: 'style' });
    const calls = onOpen.mock.calls.length;
    fireEvent.keyDown(item('Pages 21–30, 0 of 10 drawn'), { key: 'Enter' });
    expect(item('Pages 21–30, 0 of 10 drawn')).toHaveAttribute('aria-expanded', 'true');
    expect(onOpen).toHaveBeenCalledTimes(calls);
    fireEvent.click(item('Page 22, Planned'));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'page', id: 'pg_22' });
    fireEvent.click(item('Cast'));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'area', tab: 'cast' });
  });

  it('the chevron opens and closes a part without going there; going to a closed area opens it again', () => {
    const { onOpen } = mount(comic(3), { tab: 'pages' });
    const toggle = item('Pages').querySelector('[data-part-toggle]') as HTMLElement;
    fireEvent.click(toggle);
    expect(item('Pages')).toHaveAttribute('aria-expanded', 'false');
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(item('Pages'));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'area', tab: 'pages' });
    expect(item('Pages')).toHaveAttribute('aria-expanded', 'true');
  });

  it('rows are 44 px at the top and 36 px (44 px for touch) below, clip long names, and stay ink', () => {
    mount(comic(3, (d) => (d.cast = [character('c_long', 'A character with a very long name that will never fit the panel')])), { tab: 'cast' });
    const long = item('A character with a very long name that will never fit the panel');
    expect(item('Cast').className).toMatch(/(?:^|\s)min-h-11(?:\s|$)/);
    expect(long.className).toContain('min-h-9');
    expect(long.className).toContain('coarse:min-h-11');
    expect(long).toHaveAttribute('title', 'A character with a very long name that will never fit the panel');
    expect(long.querySelector('.truncate')).not.toBeNull();
    const classes = Array.from(tree().querySelectorAll('[class]'), (el) => el.getAttribute('class')).join(' ');
    expect(classes).not.toMatch(/hue|wash|spark|accent|success|warning|danger/);
  });
});

describe('Find a page (books over 10 pages)', () => {
  const section = (doc: ComicDoc, onOpenPart = vi.fn()) => {
    render(<ComicSection doc={doc} caps={DEFAULT_CAPS} tab="pages" facts={stageFacts(doc)} onSelect={vi.fn()} onConversation={vi.fn()} onGo={vi.fn()} onOpenPart={onOpenPart} />);
    return onOpenPart;
  };

  it('is not offered on a short book', () => {
    section(comic(10));
    expect(screen.queryByRole('searchbox', { name: 'Find a page' })).toBeNull();
  });

  it('searches the book with StoryMap’s index, replaces the tree while it has words, and opens the page', () => {
    const onOpenPart = section(comic(12));
    const field = screen.getByRole('searchbox', { name: 'Find a page' });
    fireEvent.change(field, { target: { value: 'lighthouse' } });
    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('1 page');
    const results = screen.getByRole('list', { name: 'Matching pages' });
    fireEvent.click(within(results).getByRole('button', { name: /^Page 7/ }));
    expect(onOpenPart).toHaveBeenCalledWith({ kind: 'page', id: 'pg_7' });
    expect(field).toHaveValue('');
    expect(screen.getByRole('tree', { name: 'Board' })).toBeInTheDocument();
  });

  it('says so when nothing matches, and Escape clears it', () => {
    section(comic(12));
    const field = screen.getByRole('searchbox', { name: 'Find a page' });
    fireEvent.change(field, { target: { value: 'submarine' } });
    expect(screen.getByRole('status')).toHaveTextContent('No matching pages');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveValue('');
    expect(screen.getByRole('tree', { name: 'Board' })).toBeInTheDocument();
  });
});
