// The comic's parts as a tree in the side panel (SH-C2): the board's areas (the tabs it grew from), each character under
// Cast, each page under Pages with its drawn state, and the Cover. Every row goes where its part is edited; a group of
// pages only opens and closes. Ink only: the current row is the panel's current tint, the rows above it heavier ink, a
// drawn page a check, any other page one word. Never a hue, a spark or a price.
//
// An ARIA tree, drawn flat (each visible row is a treeitem with its level, position and set size), so a collapsed group
// renders nothing and a 200-page book is about ten rows. One tab stop (the current row); Up and Down, Home and End move;
// Right opens a group or steps into it, Left closes it or steps out; Enter or Space goes there. Moving never navigates, so
// the phone drawer stays open while you explore. The path to where you are opens by itself, and a deliberate move (a tab,
// a page opened) brings its row into view. Books over 10 pages get "Find a page" (StoryMap's index, in the ds
// SearchField): while it has words the matching pages replace the tree.

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookImage, Check, ChevronRight } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { StudioTab } from '../types';
import type { ShownTab } from '../board/boardNavigation';
import { matchStoryPages, storyPageIndex } from '../breakdown/storyMapIndex';
import { useBoardPart, type BoardPartStore } from '../board/boardPartStore';
import { SearchField } from '../../ds/SearchField';
import { cn } from '../../../lib/utils';
import { CLIP_TEXT, MUTED, TRANSITION } from '../../chat/studioDesign';
import { ancestorKeys, currentPartKey, indexParts, partsTree, STANDING_WORD, visibleRows, type BoardPart, type PartRow, type PartTarget } from './partsModel';
import { PANEL_ROW, PANEL_ROW_CURRENT, PANEL_ROW_IDLE, PANEL_ROW_SHORT } from './panelStyles';

/** Books with more pages than this get the page search (as the breakdown card's "Find a page in this story"). */
export const PAGE_SEARCH_MIN = 10;
/** Matches shown at once; more asks for another word. */
export const PAGE_SEARCH_SHOWN = 50;

export interface PartsTreeProps {
  doc: ComicDoc;
  /** The board's tabs in order (boardTabsFor): the tree's areas, with their icons. */
  tabs: ShownTab[];
  tab: StudioTab;
  /** The page open in the page editor. */
  focusedPageId?: string | null;
  /** The card the person is on in the board. */
  part?: BoardPart | null;
  onOpen: (target: PartTarget) => void;
}

/** A level's left inset: level 1 has the icon column, deeper rows line up under its words. */
const INDENT = ['', 'pl-11', 'pl-14', 'pl-16'];

const ATTENTION = new Set(['out_of_date', 'withheld', 'failed', 'redraw_failed']);

export function PartsTree({ doc, tabs, tab, focusedPageId, part, onOpen }: PartsTreeProps) {
  // The tab list is rebuilt on every render; its ids and labels are what the tree depends on.
  const tabsKey = tabs.map((t) => `${t.id}:${t.label}`).join('|');
  const tree = useMemo(() => partsTree({ doc, tabs }), [doc, tabsKey]);
  const index = useMemo(() => indexParts(tree), [tree]);
  const current = currentPartKey(index, { tab, focusedPageId, part });
  // Where the person deliberately went (the tab, the page they opened): its row comes into view.
  const navKey = currentPartKey(index, { tab, focusedPageId });
  // The path to where you are opens by itself, a card you are on in the board included, so the current row shows and is
  // the one selected row. A card is only reached from the board, so its group opens while the tree has no focus, never
  // under the person exploring it.
  const auto = useMemo(() => new Set([...ancestorKeys(index, current), `tab:${tab}`]), [index, current, tab]);
  const [manual, setManual] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    // Going somewhere opens its path again, whatever was closed by hand before.
    setSeen(current);
    setManual((prev) => new Map([...prev].filter(([key]) => !auto.has(key))));
  }
  const expanded = useMemo(() => new Set([...index.keys()].filter((key) => manual.get(key) ?? auto.has(key))), [index, manual, auto]);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);
  const path = useMemo(() => new Set(ancestorKeys(index, current)), [index, current]);

  const elements = useRef(new Map<string, HTMLElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const shown = (key: string | null) => !!key && rows.some((r) => r.node.key === key);
  const nearestShown = (key: string | null): string | null => {
    if (shown(key)) return key;
    const up = ancestorKeys(index, key);
    for (let i = up.length - 1; i >= 0; i -= 1) if (shown(up[i])) return up[i];
    return rows[0]?.node.key ?? null;
  };
  const tabbable = shown(focusKey) ? focusKey : nearestShown(current);
  // Where you are, inside a group closed by hand: the row that holds it says so to a screen reader too.
  const holder = current && !shown(current) ? nearestShown(current) : null;
  const holderHintId = useId();
  const currentLabel = current ? index.get(current)?.node.label : undefined;

  useEffect(() => {
    // A deliberate move (another tab, a page opened in the editor), and the panel opening: the row comes into view in the
    // panel's scrolling list (no smooth scroll; nothing moves when it is already in view).
    if (navKey) elements.current.get(navKey)?.scrollIntoView?.({ block: 'nearest' });
  }, [navKey]);

  const setOpen = (key: string, open: boolean) => setManual((prev) => new Map(prev).set(key, open));
  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    elements.current.get(key)?.focus();
  };
  const activate = (row: PartRow) => {
    const { node } = row;
    if (!node.target) {
      setOpen(node.key, !row.expanded);
      return;
    }
    // Going to a part with parts of its own opens them too: its path opens by itself once you are there, so only a
    // close by hand is undone.
    if (node.children && manual.has(node.key)) setManual((prev) => new Map([...prev].filter(([key]) => key !== node.key)));
    onOpen(node.target);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const at = rows.findIndex((r) => r.node.key === (event.target as HTMLElement).dataset?.partKey);
    if (at < 0) return;
    const row = rows[at];
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        focusRow(rows[Math.min(rows.length - 1, at + 1)]?.node.key);
        break;
      case 'ArrowUp':
        focusRow(rows[Math.max(0, at - 1)]?.node.key);
        break;
      case 'Home':
        focusRow(rows[0]?.node.key);
        break;
      case 'End':
        focusRow(rows[rows.length - 1]?.node.key);
        break;
      case 'ArrowRight':
        if (row.node.children && !row.expanded) setOpen(row.node.key, true);
        else if (row.node.children) focusRow(row.node.children[0]?.key);
        break;
      case 'ArrowLeft':
        if (row.node.children && row.expanded) setOpen(row.node.key, false);
        else focusRow(row.parent);
        break;
      case 'Enter':
      case ' ':
        activate(row);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };

  const icons = useMemo(() => new Map(tabs.map((t) => [t.id, t.icon])), [tabs]);

  return (
    <div
      role="tree"
      aria-label="Board"
      className="flex min-w-0 flex-col gap-0.5"
      onKeyDown={onKeyDown}
      // Coming back into the tree lands on the current part again (the APG rule), not on the row last explored.
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusKey(null);
      }}
      data-parts-tree
    >
      {rows.map((row) => {
        const { node } = row;
        const selected = node.key === current;
        const onPath = !selected && path.has(node.key);
        const top = row.level === 1;
        const attention = !!node.standing && ATTENTION.has(node.standing);
        return (
          <div
            key={node.key}
            ref={(el) => {
              if (el) elements.current.set(node.key, el);
              else elements.current.delete(node.key);
            }}
            // The areas keep the board tabs' ids (the book timeline's dock reads them to avoid a second Assets link).
            id={node.tab ? `board-tab-${node.tab}` : undefined}
            role="treeitem"
            aria-level={row.level}
            aria-setsize={row.setSize}
            aria-posinset={row.posInSet}
            aria-expanded={row.expanded}
            aria-selected={selected || undefined}
            aria-label={node.name}
            aria-describedby={node.key === holder ? holderHintId : undefined}
            title={node.hint}
            tabIndex={node.key === tabbable ? 0 : -1}
            data-part-key={node.key}
            onFocus={() => setFocusKey(node.key)}
            onClick={() => activate(row)}
            className={cn(
              PANEL_ROW,
              !top && PANEL_ROW_SHORT,
              INDENT[Math.min(row.level, INDENT.length) - 1],
              'cursor-pointer select-none',
              selected ? PANEL_ROW_CURRENT : onPath ? 'font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]' : PANEL_ROW_IDLE
            )}
          >
            {top && (
              <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
                {node.kind === 'cover' ? <BookImage className="h-3.5 w-3.5" /> : node.tab ? icons.get(node.tab) : null}
              </span>
            )}
            <span className={cn('flex-1 text-left', CLIP_TEXT)}>{node.label}</span>
            {node.count !== undefined && <span className={cn('shrink-0 text-xs font-normal tabular-nums', MUTED)}>{node.count}</span>}
            {node.standing &&
              (node.standing === 'current' ? (
                <Check className="h-3.5 w-3.5 shrink-0 text-[var(--ds-ink)]" aria-hidden />
              ) : (
                <span aria-hidden className={cn('shrink-0 text-xs font-normal', attention ? 'text-[var(--ds-ink)]' : MUTED)}>
                  {node.kind === 'cover' && (node.standing === 'empty' || node.standing === 'planned') ? 'Not drawn' : STANDING_WORD[node.standing]}
                </span>
              ))}
            {node.children && (
              <span
                aria-hidden
                // The pointer's own open/close, apart from going there (the keyboard uses Right and Left).
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(node.key, !row.expanded);
                }}
                className={cn('-mr-2 grid h-8 w-8 shrink-0 place-items-center coarse:h-11 coarse:w-11', MUTED)}
                data-part-toggle
              >
                <ChevronRight className={cn('h-3.5 w-3.5', TRANSITION, row.expanded && 'rotate-90')} />
              </span>
            )}
          </div>
        );
      })}
      {holder && currentLabel && (
        <span id={holderHintId} hidden>
          Holds {currentLabel}, where you are
        </span>
      )}
    </div>
  );
}

/** The tree with the card the person is on read from the board's part store (only the tree re-renders on a move). */
export function LivePartsTree({ partStore, ...props }: Omit<PartsTreeProps, 'part'> & { partStore?: BoardPartStore | null }) {
  const part = useBoardPart(partStore);
  return <PartsTree {...props} part={part} />;
}

/** "Find a page" for a long book: the breakdown card's StoryMap index, matched as there. */
export function PageSearch({ doc, query, onQuery, onPage }: { doc: ComicDoc; query: string; onQuery: (q: string) => void; onPage: (id: string) => void }) {
  const active = query.trim().length > 0;
  // Built only while searching: it reads the scenes of every page.
  const index = useMemo(() => (active ? storyPageIndex(doc) : []), [doc, active]);
  const matches = active ? matchStoryPages(index, query) : [];
  const count = !active ? '' : matches.length ? `${matches.length} ${matches.length === 1 ? 'page' : 'pages'}` : 'No matching pages. Try a name or a shorter phrase.';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* The one search box: Escape clears it while it has words (in the drawer too, before a second Escape closes it),
          and Clear is there on touch. */}
      <SearchField label="Find a page" placeholder="Find a page" value={query} onChange={onQuery} resultText={count || undefined} />
      {/* Always rendered, empty while there are no words: a live region that mounts with its first message often goes
          unannounced. */}
      <p role="status" className={cn('m-0 px-3 text-xs', MUTED)}>
        {count}
      </p>
      {active && (
        <>
          <ol aria-label="Matching pages" className="m-0 flex list-none flex-col gap-0.5 p-0">
            {matches.slice(0, PAGE_SEARCH_SHOWN).map((page) => (
              <li key={page.id} className="min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    onQuery('');
                    onPage(page.id);
                  }}
                  title={[`Page ${page.n}`, page.label, page.summary].filter(Boolean).join(' · ')}
                  className={cn(PANEL_ROW, PANEL_ROW_SHORT, PANEL_ROW_IDLE, 'flex-col items-start justify-center gap-0 py-1 leading-4')}
                >
                  <span className="font-medium text-[var(--ds-ink)]">Page {page.n}</span>
                  {(page.label || page.summary) && <span className={cn('max-w-full text-xs', CLIP_TEXT)}>{page.label || page.summary}</span>}
                </button>
              </li>
            ))}
          </ol>
          {matches.length > PAGE_SEARCH_SHOWN && (
            <p className={cn('m-0 px-3 text-xs', MUTED)}>
              Showing {PAGE_SEARCH_SHOWN} of {matches.length}. Add a word to narrow it.
            </p>
          )}
        </>
      )}
    </div>
  );
}
