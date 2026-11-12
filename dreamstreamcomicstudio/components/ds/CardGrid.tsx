/**
 * CardGrid — every grid of cards or tiles (redesign plan §2 "Layout numbers", §4, §9): a `<ul role="list">` with an
 * explicit column count (`--cols`, from layout.ts), never an `auto-fill` grid, so the number of cards in a row is
 * a tested number at every size.
 *
 * Keyboard: outside selection mode the grid is a plain list and Tab walks the cards' controls in reading order —
 * nothing is removed from the tab order, no arrow key is taken over. In selection mode (`selecting`) the arrow keys
 * move focus card to card (Left/Right by one, mirrored right-to-left; Up/Down by a row; Home/End to the ends),
 * landing on each card's own control, and Esc leaves selection mode (`onExitSelection`).
 *
 * Motion: the first twelve items of the FIRST page rise in one after another (`ds-rise-in`, each delayed by its index
 * × --ds-motion-stagger); the thirteenth and every later item appear at once, so a 300-card first page starts twelve
 * entrances, not 300. A later page, a filter change or a re-sort appears at once (`stagger` false). Nothing moves
 * under reduced motion (`ds-rise-in` is in styles/ds-motion.css's reduced-motion block).
 */
import React, { useRef } from 'react';
import { cn } from '../../lib/utils';
import { columnsStyle } from './layout';
import { isRtl } from './roving';

export interface CardGridProps<T> {
  items: readonly T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => React.ReactNode;
  /** Explicit columns (layout.ts: `layoutFor(ff).library.columns.comfortable`, …). */
  columns: number;
  /** The list's accessible name ("Your comics", "Pages"). */
  label: string;
  /** Arrow keys move between cards; Esc calls onExitSelection. */
  selecting?: boolean;
  onExitSelection?: () => void;
  /** Rise in on first show (the first page only: pass false for later pages and re-sorts). */
  stagger?: boolean;
  /** One item spans the whole row (the Library's Continue card). */
  spanIndex?: number;
  className?: string;
  itemClassName?: string;
}

/** How many items of a first page rise in (redesign §9, styles M10). */
export const CARD_GRID_STAGGER_MAX = 12;

/** The grid: explicit columns from --cols, the 12 px gap (layout.ts GRID_GAP_PX). */
export const CARD_GRID = 'm-0 grid list-none grid-cols-[repeat(var(--cols),minmax(0,1fr))] gap-3 p-0';

/** The control a card lands focus on: its marked control, else its first focusable element. */
export function focusTargetOf(item: Element | null | undefined): HTMLElement | null {
  if (!item) return null;
  return (
    item.querySelector<HTMLElement>('[data-grid-focus]') ??
    item.querySelector<HTMLElement>('[data-card-primary], [data-slot="media-tile-open"]') ??
    item.querySelector<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')
  );
}

/** The index the arrow key moves to (null: the key is not a grid move). Left/Right flow across rows; it stops at the ends. */
export function nextGridIndex(key: string, index: number, count: number, columns: number, rtl = false): number | null {
  if (count <= 0) return null;
  const cols = Math.max(1, Math.floor(columns));
  switch (key) {
    case 'ArrowRight':
      return Math.max(0, Math.min(count - 1, index + (rtl ? -1 : 1)));
    case 'ArrowLeft':
      return Math.max(0, Math.min(count - 1, index + (rtl ? 1 : -1)));
    case 'ArrowDown':
      return index + cols < count ? index + cols : index;
    case 'ArrowUp':
      return index - cols >= 0 ? index - cols : index;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export function CardGrid<T>({ items, getKey, renderItem, columns, label, selecting = false, onExitSelection, stagger = false, spanIndex, className, itemClassName }: CardGridProps<T>) {
  const listRef = useRef<HTMLUListElement>(null);

  const onKeyDown = (e: React.KeyboardEvent<HTMLUListElement>) => {
    if (!selecting) return;
    if (e.key === 'Escape') {
      if (onExitSelection) {
        e.preventDefault();
        onExitSelection();
      }
      return;
    }
    const list = listRef.current;
    if (!list) return;
    const cells = Array.from(list.children) as HTMLElement[];
    const at = cells.findIndex((c) => c.contains(document.activeElement));
    if (at < 0) return;
    const next = nextGridIndex(e.key, at, cells.length, columns, isRtl(list));
    if (next === null) return;
    e.preventDefault();
    focusTargetOf(cells[next])?.focus();
  };

  return (
    <ul
      ref={listRef}
      role="list"
      aria-label={label}
      data-slot="card-grid"
      data-selecting={selecting || undefined}
      onKeyDown={onKeyDown}
      className={cn(CARD_GRID, className)}
      style={columnsStyle(columns)}
    >
      {items.map((item, i) => {
        const rise = stagger && i < CARD_GRID_STAGGER_MAX;
        return (
          <li
            key={getKey(item, i)}
            className={cn('min-w-0', i === spanIndex && 'col-span-full', rise && 'ds-rise-in', itemClassName)}
            style={rise ? { animationDelay: `calc(${i} * var(--ds-motion-stagger))` } : undefined}
          >
            {renderItem(item, i)}
          </li>
        );
      })}
    </ul>
  );
}
