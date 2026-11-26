// The comic's parts as a tree (SH-C2), for the side panel's "This comic" section: the board's areas in board order
// (Story, Cast, Style, Pages, Read and the registry tabs), with the Cover after Pages, each character under Cast and each
// page under Pages. Pure, so it is tested without a DOM. Every part says where it is edited (`target`): a board tab, a
// character's card, a page (the page editor) or the cover card; a group of pages only opens and closes.
//
// Long books stay cheap: pages group by chapter (`page.chapterTitle`, the rule StoryMap uses), or in blocks of 20 when a
// book has no chapters and more than 24 pages (a long chapter splits the same way), and a collapsed group renders
// nothing. A page's state is the stage's own reading (`pageStanding`, shared/comic/stage.ts), so the pages marked drawn
// here are exactly the strip's "6 of 12 pages drawn" and the Pages badge. Older docs read as far as their fields go.

import type { Character, ComicDoc, Page } from '../../../shared/comic/doc';
import { pageStanding, pictureStanding, type PictureStanding } from '../../../shared/comic/stage';
import type { StudioTab } from '../types';
import { chapterStart, pageGist, readingOrder } from '../breakdown/storyMapIndex';

/** Where a part is edited. */
export type PartTarget = { kind: 'area'; tab: StudioTab } | { kind: 'character'; id: string } | { kind: 'page'; id: string } | { kind: 'cover' };

/** The part a person is on inside the board (a character, page or cover card), tracked by the shell. */
export type BoardPart = { kind: 'character'; id: string } | { kind: 'page'; id: string } | { kind: 'cover' };

export type PartKind = 'area' | 'character' | 'group' | 'page' | 'cover';

export interface PartNode {
  key: string;
  kind: PartKind;
  /** What the row shows. */
  label: string;
  /** What a screen reader hears: the label, with a page's state or a group's count. */
  name: string;
  /** Where it is edited; a group of pages has none (it only opens and closes). */
  target?: PartTarget;
  /** An area row's board tab (its icon and its id). */
  tab?: StudioTab;
  /** A short figure beside the label: the cast size, "6/12" pages drawn. */
  count?: string;
  /** A page's or the cover's picture. */
  standing?: PictureStanding;
  /** The tooltip: every word of the label, and a page's gist. */
  hint?: string;
  children?: PartNode[];
}

/** A book up to this many pages lists them flat; a longer one without chapters groups them in blocks. */
export const PAGES_FLAT_MAX = 24;
/** Pages per block in a long book (or a long chapter). */
export const PAGE_BLOCK = 20;

/** A picture's state in one word (the page card's words: Drawn, Out of date, Drawing, Failed, Planned, Empty). */
export const STANDING_WORD: Readonly<Record<PictureStanding, string>> = {
  current: 'Drawn',
  out_of_date: 'Out of date',
  redrawing: 'Redrawing',
  redraw_failed: 'Redraw failed',
  drawing: 'Drawing',
  withheld: 'Withheld',
  failed: 'Failed',
  planned: 'Planned',
  empty: 'Empty'
};

const list = <T>(v: T[] | undefined | null): T[] => (Array.isArray(v) ? v : []);
const TIER_ORDER: Readonly<Record<string, number>> = { lead: 0, support: 1, extra: 2 };

export const partKey = (target: PartTarget | BoardPart): string =>
  target.kind === 'area' ? `tab:${target.tab}` : target.kind === 'cover' ? 'cover' : `${target.kind}:${target.id}`;

/** The cast in the Cast tab's order: leads, then support, then extras (stable within a tier). */
const castInOrder = (cast: Character[]): Character[] =>
  cast
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (TIER_ORDER[a.c.tier] ?? 3) - (TIER_ORDER[b.c.tier] ?? 3) || a.i - b.i)
    .map((x) => x.c);

/** "Pages 21–40", or "Page 7" for one page. */
const range = (numbers: number[]): string => {
  const first = numbers[0];
  const last = numbers[numbers.length - 1];
  return first === last ? `Page ${first}` : `Pages ${first}–${last}`;
};

const pageNode = (doc: ComicDoc, page: Page, n: number): PartNode => {
  const standing = pageStanding(doc, page);
  const label = `Page ${n}`;
  const gist = pageGist(page);
  return {
    key: `page:${page.id}`,
    kind: 'page',
    label,
    name: `${label}, ${STANDING_WORD[standing]}`,
    target: { kind: 'page', id: page.id },
    standing,
    hint: gist ? `${label} · ${gist}` : label
  };
};

const drawnOf = (nodes: PartNode[]): number => nodes.filter((n) => n.standing === 'current').length;

const groupNode = (kind: 'chapter' | 'block', label: string, pages: PartNode[], firstId: string): PartNode => {
  const drawn = drawnOf(pages);
  return {
    key: `${kind}:${firstId}`,
    kind: 'group',
    label,
    name: `${label}, ${drawn} of ${pages.length} drawn`,
    count: `${drawn}/${pages.length}`,
    hint: label,
    children: pages
  };
};

/** Pages in blocks of PAGE_BLOCK ("Pages 21–40"). */
const blocks = (pages: Page[], numbers: number[], nodes: PartNode[]): PartNode[] => {
  const out: PartNode[] = [];
  for (let i = 0; i < pages.length; i += PAGE_BLOCK) out.push(groupNode('block', range(numbers.slice(i, i + PAGE_BLOCK)), nodes.slice(i, i + PAGE_BLOCK), pages[i].id));
  return out;
};

/** The Pages area's children: flat, by chapter, or in blocks. */
export const pageGroups = (doc: ComicDoc): PartNode[] => {
  const ordered = readingOrder(doc).map((x) => x.page);
  // A page without a number (an older doc) takes its place in reading order.
  const numbers = ordered.map((page, i) => (Number.isFinite(page.n) && page.n > 0 ? page.n : i + 1));
  const nodes = ordered.map((page, i) => pageNode(doc, page, numbers[i]));
  const starts = ordered.map((page, i) => (chapterStart(page) ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) return ordered.length > PAGES_FLAT_MAX ? blocks(ordered, numbers, nodes) : nodes;
  // Chapters: the pages before the first one are a group of their own, named by their numbers (never an invented title).
  const bounds = starts[0] > 0 ? [0, ...starts] : starts;
  return bounds.map((from, j) => {
    const to = j + 1 < bounds.length ? bounds[j + 1] : ordered.length;
    const pages = ordered.slice(from, to);
    const children = nodes.slice(from, to);
    const group = groupNode('chapter', chapterStart(pages[0]) ?? range(numbers.slice(from, to)), children, pages[0].id);
    // A long chapter splits in blocks too, so an opened group never lists more than PAGES_FLAT_MAX pages.
    return pages.length <= PAGES_FLAT_MAX ? group : { ...group, children: blocks(pages, numbers.slice(from, to), children) };
  });
};

export interface PartsInput {
  doc: ComicDoc;
  /** The board's tabs in board order (boardTabsFor): the tree's areas. */
  tabs: ReadonlyArray<{ id: StudioTab; label: string }>;
}

/** The comic's parts. The Cover follows Pages (it leads the Pages grid, where it is edited). */
export function partsTree({ doc, tabs }: PartsInput): PartNode[] {
  const out: PartNode[] = [];
  for (const tab of tabs) {
    const area: PartNode = { key: `tab:${tab.id}`, kind: 'area', label: tab.label, name: tab.label, target: { kind: 'area', tab: tab.id }, tab: tab.id, hint: tab.label };
    if (tab.id === 'cast') {
      const cast = castInOrder(list(doc?.cast).filter((c): c is Character => !!c && typeof c.id === 'string'));
      out.push({
        ...area,
        count: cast.length ? String(cast.length) : undefined,
        children: cast.length
          ? cast.map((c) => {
              const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'Unnamed character';
              return { key: `character:${c.id}`, kind: 'character' as const, label: name, name, target: { kind: 'character' as const, id: c.id }, hint: name };
            })
          : undefined
      });
    } else if (tab.id === 'pages') {
      const groups = pageGroups(doc);
      const pages = list(doc?.pages).length;
      const flat = groups.flatMap(function leaves(n: PartNode): PartNode[] {
        return n.children ? n.children.flatMap(leaves) : [n];
      });
      out.push({ ...area, count: pages ? `${drawnOf(flat)}/${pages}` : undefined, children: groups.length ? groups : undefined });
      const standing = pictureStanding(doc?.cover?.render);
      const word = standing === 'empty' || standing === 'planned' ? 'Not drawn' : STANDING_WORD[standing];
      out.push({ key: 'cover', kind: 'cover', label: 'Cover', name: `Cover, ${word}`, target: { kind: 'cover' }, standing, hint: 'Cover' });
    } else out.push(area);
  }
  return out;
}

/** Every node by key, with its parent. */
export const indexParts = (tree: PartNode[]): Map<string, { node: PartNode; parent?: string }> => {
  const index = new Map<string, { node: PartNode; parent?: string }>();
  const walk = (nodes: PartNode[], parent?: string) => {
    for (const node of nodes) {
      index.set(node.key, { node, parent });
      if (node.children) walk(node.children, node.key);
    }
  };
  walk(tree);
  return index;
};

/** The keys above a node, nearest last (what must be open for it to show). */
export const ancestorKeys = (index: Map<string, { parent?: string }>, key: string | null): string[] => {
  const out: string[] = [];
  for (let at = key ? index.get(key)?.parent : undefined; at; at = index.get(at)?.parent) out.unshift(at);
  return out;
};

export interface CurrentInput {
  tab: StudioTab;
  /** The page open in the page editor. */
  focusedPageId?: string | null;
  /** The card the person is on in the board, if any. */
  part?: BoardPart | null;
}

/** The tab a board part lives in. */
export const partTab = (part: BoardPart): StudioTab => (part.kind === 'character' ? 'cast' : 'pages');

/**
 * The part the person is on: the page in the editor; else the card they are on in the open tab; else the open tab.
 * Null when none of those is in the tree (a tab hidden from this doc).
 */
export const currentPartKey = (index: Map<string, unknown>, { tab, focusedPageId, part }: CurrentInput): string | null => {
  if (focusedPageId && index.has(`page:${focusedPageId}`)) return `page:${focusedPageId}`;
  if (part && partTab(part) === tab && index.has(partKey(part))) return partKey(part);
  return index.has(`tab:${tab}`) ? `tab:${tab}` : null;
};

export interface PartRow {
  node: PartNode;
  level: number;
  setSize: number;
  posInSet: number;
  parent?: string;
  /** Parents only. */
  expanded?: boolean;
}

/** The rows on screen: every node whose ancestors are all open, in order. */
export const visibleRows = (tree: PartNode[], expanded: ReadonlySet<string>): PartRow[] => {
  const rows: PartRow[] = [];
  const walk = (nodes: PartNode[], level: number, parent?: string) => {
    nodes.forEach((node, i) => {
      const open = node.children ? expanded.has(node.key) : undefined;
      rows.push({ node, level, setSize: nodes.length, posInSet: i + 1, parent, expanded: open });
      if (node.children && open) walk(node.children, level + 1, node.key);
    });
  };
  walk(tree, 1);
  return rows;
};

/**
 * A board part in words ("Maya", "Page 3", "Cover"), or null when it is no longer in the comic (a character removed, a
 * page deleted): the breadcrumb's last crumb.
 */
export const partLabelOf = (doc: ComicDoc, part: BoardPart | { kind: 'page'; id: string }): string | null => {
  if (part.kind === 'cover') return 'Cover';
  if (part.kind === 'character') {
    const c = list(doc?.cast).find((x) => x?.id === part.id);
    if (!c) return null;
    return typeof c.name === 'string' && c.name.trim() ? c.name.trim() : 'Unnamed character';
  }
  const ordered = readingOrder(doc);
  const at = ordered.findIndex((x) => x.page.id === part.id);
  if (at < 0) return null;
  const n = ordered[at].page.n;
  return `Page ${Number.isFinite(n) && n > 0 ? n : at + 1}`;
};
