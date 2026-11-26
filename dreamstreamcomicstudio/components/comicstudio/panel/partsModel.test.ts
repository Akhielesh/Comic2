// @vitest-environment node
// The comic's parts tree (SH-C2): the board's areas in board order with the Cover after Pages, the cast in the Cast tab's
// order, pages flat, by chapter or in blocks, each with the stage's own drawn state, the current part and what opens for
// it. Older comics with missing fields, empty pages and a 200-page book. Synthetic docs only.
import { describe, expect, it } from 'vitest';
import { createEmptyDoc, type AssetRef, type Character, type ComicDoc, type Page, type RenderState } from '../../../shared/comic/doc';
import { stageFacts } from '../../../shared/comic/stage';
import { pageProgress } from '../board/boardModel';
import { BOARD_TABS } from '../board/boardNavigation';
import {
  PAGE_BLOCK,
  PAGES_FLAT_MAX,
  ancestorKeys,
  currentPartKey,
  indexParts,
  pageGroups,
  partLabelOf,
  partsTree,
  visibleRows,
  type PartNode
} from './partsModel';

const NOW = 1_800_000_000_000;
const TABS = BOARD_TABS.map(({ id, label }) => ({ id, label }));
const picture = (extra: Partial<AssetRef> = {}): AssetRef => ({ path: 'u/p/pages/a.webp', source: 'generated', at: NOW, ...extra });
const render = (status: RenderState['status'], asset?: AssetRef): RenderState => ({ status, history: [], ...(asset ? { asset } : {}), updatedAt: NOW });
const page = (n: number, extra: Partial<Page> = {}): Page => ({
  id: `pg_${n}`,
  n,
  summary: '',
  layout: '',
  panels: [{ id: `pg_${n}_p1`, n: 1, size: 'medium', shot: 'medium', action: `Beat ${n}`, castIds: [], lines: [] }],
  render: render('none'),
  balloons: [],
  ...extra
});
const character = (id: string, name: string, tier: Character['tier']): Character => ({ id, name, tier, look: { summary: '' }, refs: [], sheet: render('none') });

const comic = (pages: number, patch: (doc: ComicDoc) => void = () => undefined): ComicDoc => {
  const doc = createEmptyDoc('c1', 'Salt Road', NOW);
  doc.brief.premise = 'A road along the salt flats.';
  doc.pages = Array.from({ length: pages }, (_, i) => page(i + 1));
  patch(doc);
  return doc;
};

const tree = (doc: ComicDoc) => partsTree({ doc, tabs: TABS });
const keys = (nodes: PartNode[] | undefined) => (nodes ?? []).map((n) => n.key);
const leaves = (nodes: PartNode[]): PartNode[] => nodes.flatMap((n) => (n.children ? leaves(n.children) : [n]));

describe('the parts, in board order', () => {
  it('lists the board’s areas with the Cover after Pages, the cast in the Cast tab’s order and every page', () => {
    const doc = comic(3, (d) => {
      d.cast = [character('c_extra', 'Gull', 'extra'), character('c_support', 'Ossie', 'support'), character('c_lead', 'Maya', 'lead')];
    });
    const parts = tree(doc);
    expect(keys(parts)).toEqual(['tab:story', 'tab:cast', 'tab:style', 'tab:pages', 'cover', 'tab:read']);
    const cast = parts.find((n) => n.key === 'tab:cast')!;
    expect(cast.count).toBe('3');
    expect(cast.children!.map((c) => c.label)).toEqual(['Maya', 'Ossie', 'Gull']);
    expect(cast.children![0].target).toEqual({ kind: 'character', id: 'c_lead' });
    const pages = parts.find((n) => n.key === 'tab:pages')!;
    expect(keys(pages.children)).toEqual(['page:pg_1', 'page:pg_2', 'page:pg_3']);
    expect(pages.children![1]).toMatchObject({ label: 'Page 2', name: 'Page 2, Planned', standing: 'planned', target: { kind: 'page', id: 'pg_2' }, hint: 'Page 2 · Beat 2' });
    expect(parts.find((n) => n.key === 'cover')).toMatchObject({ name: 'Cover, Not drawn', target: { kind: 'cover' } });
    // The registry's tabs take their place in the board's order, as leaves.
    const withAssets = partsTree({ doc, tabs: [...TABS.slice(0, 4), { id: 'media', label: 'Assets' }, TABS[4]] });
    expect(keys(withAssets)).toEqual(['tab:story', 'tab:cast', 'tab:style', 'tab:pages', 'cover', 'tab:media', 'tab:read']);
    expect(withAssets.find((n) => n.key === 'tab:media')).toMatchObject({ label: 'Assets', target: { kind: 'area', tab: 'media' } });
  });

  it('marks pages drawn exactly as the strip and the Pages badge count them', () => {
    const doc = comic(6, (d) => {
      d.pages[0].render = render('ready', picture());
      d.pages[1].render = render('ready', picture());
      d.pages[2].render = render('stale', picture());
      d.pages[3].render = render('rendering');
      d.pages[4].render = render('ready', picture({ safety: { quarantined: true, at: NOW } }));
      d.pages[5].render = render('failed');
    });
    const pages = tree(doc).find((n) => n.key === 'tab:pages')!;
    expect(pages.children!.map((p) => p.name)).toEqual(['Page 1, Drawn', 'Page 2, Drawn', 'Page 3, Out of date', 'Page 4, Drawing', 'Page 5, Withheld', 'Page 6, Failed']);
    const drawn = pages.children!.filter((p) => p.standing === 'current').length;
    expect(drawn).toBe(stageFacts(doc).current);
    expect(pages.count).toBe(`${pageProgress(doc).ready}/${pageProgress(doc).total}`);
  });

  it('an empty comic has its areas and nothing under Cast or Pages; an empty page says so', () => {
    const empty = tree(createEmptyDoc('c0', 'Untitled comic', NOW));
    expect(keys(empty)).toEqual(['tab:story', 'tab:cast', 'tab:style', 'tab:pages', 'cover', 'tab:read']);
    expect(empty.find((n) => n.key === 'tab:cast')).toMatchObject({ count: undefined, children: undefined });
    expect(empty.find((n) => n.key === 'tab:pages')).toMatchObject({ count: undefined, children: undefined });
    const blank = tree(comic(1, (d) => (d.pages[0].panels = [])));
    expect(blank.find((n) => n.key === 'tab:pages')!.children![0]).toMatchObject({ name: 'Page 1, Empty', standing: 'empty', hint: 'Page 1' });
  });

  it('older comics read as far as their fields go: no cast list, pages without panels, numbers or renders, no cover', () => {
    const doc = comic(0) as unknown as Record<string, unknown>;
    delete doc.cast;
    delete doc.cover;
    doc.pages = [{ id: 'pg_b', n: 2 }, { id: 'pg_a' }, null, { id: 'pg_c', n: 3, panels: null, render: { status: 'ready', asset: picture() } }];
    const parts = tree(doc as unknown as ComicDoc);
    expect(parts.find((n) => n.key === 'tab:cast')!.children).toBeUndefined();
    expect(parts.find((n) => n.key === 'tab:pages')!.children!.map((p) => [p.label, p.standing])).toEqual([
      ['Page 1', 'empty'],
      ['Page 2', 'empty'],
      ['Page 3', 'current']
    ]);
    expect(parts.find((n) => n.key === 'cover')!.standing).toBe('empty');
    const unnamed = tree(comic(0, (d) => (d.cast = [{ ...character('c_x', '  ', 'lead'), tier: undefined as never }])));
    expect(unnamed.find((n) => n.key === 'tab:cast')!.children![0].label).toBe('Unnamed character');
  });
});

describe('long books stay cheap', () => {
  it('a book up to 24 pages lists them flat; a longer one without chapters groups them in blocks of 20', () => {
    expect(pageGroups(comic(PAGES_FLAT_MAX)).every((n) => n.kind === 'page')).toBe(true);
    const groups = pageGroups(comic(45));
    expect(groups.map((g) => [g.label, g.children!.length])).toEqual([
      ['Pages 1–20', 20],
      ['Pages 21–40', 20],
      ['Pages 41–45', 5]
    ]);
    expect(groups[0]).toMatchObject({ kind: 'group', count: '0/20', name: 'Pages 1–20, 0 of 20 drawn' });
    expect(groups[0].target).toBeUndefined();
  });

  it('chapters group the pages (the pages before the first are named by their numbers); a long chapter splits in blocks', () => {
    const doc = comic(40, (d) => {
      d.pages[3].chapterTitle = 'The flats';
      d.pages[6].chapterTitle = '  The long night  ';
      d.pages[0].render = render('ready', picture());
    });
    const groups = pageGroups(doc);
    expect(groups.map((g) => [g.label, g.children!.length])).toEqual([
      ['Pages 1–3', 3],
      ['The flats', 3],
      ['The long night', 2]
    ]);
    expect(groups[0].count).toBe('1/3');
    // 34 pages in the last chapter: blocks inside it, so an opened group never lists more than 24 pages.
    expect(groups[2].children!.map((b) => [b.label, b.children!.length])).toEqual([
      ['Pages 7–26', 20],
      ['Pages 27–40', 14]
    ]);
    expect(groups[2].count).toBe('0/34');
  });

  it('a 200-page book is about ten rows until a group opens, and an opened block is 20 rows', () => {
    const doc = comic(200);
    const parts = tree(doc);
    const pages = parts.find((n) => n.key === 'tab:pages')!;
    expect(pages.children).toHaveLength(200 / PAGE_BLOCK);
    expect(leaves(pages.children!)).toHaveLength(200);
    const closed = visibleRows(parts, new Set(['tab:pages']));
    expect(closed).toHaveLength(6 + 10);
    const index = indexParts(parts);
    const current = currentPartKey(index, { tab: 'pages', focusedPageId: 'pg_137' });
    expect(current).toBe('page:pg_137');
    const path = ancestorKeys(index, current);
    expect(path).toEqual(['tab:pages', 'block:pg_121']);
    const opened = visibleRows(parts, new Set(path));
    expect(opened).toHaveLength(6 + 10 + 20);
    const row = opened.find((r) => r.node.key === 'page:pg_137')!;
    expect(row).toMatchObject({ level: 3, setSize: 20, posInSet: 17, parent: 'block:pg_121' });
  });
});

describe('the current part', () => {
  const doc = comic(3, (d) => {
    d.cast = [character('c_maya', 'Maya', 'lead')];
  });
  const index = indexParts(tree(doc));

  it('is the page in the editor, else the card you are on in the open tab, else the open tab', () => {
    expect(currentPartKey(index, { tab: 'pages', focusedPageId: 'pg_2', part: { kind: 'cover' } })).toBe('page:pg_2');
    expect(currentPartKey(index, { tab: 'pages', part: { kind: 'cover' } })).toBe('cover');
    expect(currentPartKey(index, { tab: 'cast', part: { kind: 'character', id: 'c_maya' } })).toBe('character:c_maya');
    // A card in another tab, or one no longer in the comic, leaves the tab current.
    expect(currentPartKey(index, { tab: 'story', part: { kind: 'character', id: 'c_maya' } })).toBe('tab:story');
    expect(currentPartKey(index, { tab: 'cast', part: { kind: 'character', id: 'c_gone' } })).toBe('tab:cast');
    expect(currentPartKey(index, { tab: 'pages', focusedPageId: 'pg_gone' })).toBe('tab:pages');
    expect(currentPartKey(index, { tab: 'languages' })).toBeNull();
  });

  it('names a part for the breadcrumb, or nothing once it is gone', () => {
    expect(partLabelOf(doc, { kind: 'page', id: 'pg_3' })).toBe('Page 3');
    expect(partLabelOf(doc, { kind: 'character', id: 'c_maya' })).toBe('Maya');
    expect(partLabelOf(doc, { kind: 'cover' })).toBe('Cover');
    expect(partLabelOf(doc, { kind: 'page', id: 'pg_gone' })).toBeNull();
    expect(partLabelOf(doc, { kind: 'character', id: 'c_gone' })).toBeNull();
  });
});
