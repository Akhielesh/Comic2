// Comic History — the moment list (versions plan §8 panel 4; package H5).
//
// Grouped Today / Yesterday / "Mon 27 Oct" (the viewer's zone), filter chips (All · Saved by you · AI changes · This
// page), older moments on demand. Rows skip layout and paint off screen (content-visibility), so a 300-moment list
// stays light on a phone.

import React from 'react';
import type { VersionRow } from '../../../shared/comic/history/types';
import type { HistoryFilter } from './historyApi';
import { FILTER_LABEL, groupRowsByDay, isRemovedLineRow, type MoneyWords } from './historyModel';
import { MomentRow } from './MomentRow';
import { ChipBtn, Overline, QuietBtn } from './ui';

export interface MomentListProps {
  rows: readonly VersionRow[];
  selectedId: string | null;
  money: MoneyWords;
  now: number;
  tz: string;
  urlFor(path: string): string | undefined;
  onOpen(row: VersionRow): void;
  onFocusRow?(row: VersionRow): void;
  filter: HistoryFilter;
  onFilter(filter: HistoryFilter): void;
  /** Offer "This page" (a page is in focus). */
  pageLabel?: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?(): void;
  /** The line listed (null / absent = "Original"): its rows of other lines came from versions the creator removed. */
  line?: string | null;
}

export const MomentList: React.FC<MomentListProps> = ({ rows, selectedId, money, now, tz, urlFor, onOpen, onFocusRow, filter, onFilter, pageLabel, hasMore, loadingMore, onLoadMore, line = null }) => {
  const filters: HistoryFilter[] = pageLabel ? ['all', 'saved', 'ai', 'page'] : ['all', 'saved', 'ai'];
  const groups = groupRowsByDay(rows, now, tz);
  return (
    <section aria-label="Moments" className="min-w-0">
      <div role="group" aria-label="Show" className="flex min-w-0 gap-2 overflow-x-auto px-4 py-2">
        {filters.map((f) => (
          <ChipBtn key={f} selected={filter === f} onClick={() => onFilter(f)}>
            {f === 'page' && pageLabel ? pageLabel : FILTER_LABEL[f]}
          </ChipBtn>
        ))}
      </div>
      {!rows.length && <p className="m-0 px-4 py-3 text-[13px] text-[var(--ds-muted)]">{filter === 'all' ? 'Nothing saved yet.' : 'No moments match this filter yet.'}</p>}
      {groups.map((g) => (
        <div key={g.label} className="min-w-0">
          <Overline as="h3" className="sticky top-0 z-[1] bg-[var(--ds-surface-strong)] px-4 py-1.5">
            {g.label}
          </Overline>
          <ul className="m-0 list-none px-1 pb-1">
            {g.rows.map((row) => (
              <li key={row.id} className="min-w-0">
                <MomentRow row={row} selected={row.id === selectedId} removed={isRemovedLineRow(row, line)} money={money} tz={tz} urlFor={urlFor} onOpen={onOpen} onFocusRow={onFocusRow} />
              </li>
            ))}
          </ul>
        </div>
      ))}
      {hasMore && onLoadMore && (
        <div className="px-4 py-2">
          <QuietBtn onClick={onLoadMore} disabled={loadingMore} className="w-full">
            {loadingMore ? 'Loading older moments…' : 'Show older moments'}
          </QuietBtn>
        </div>
      )}
    </section>
  );
};

export default MomentList;
