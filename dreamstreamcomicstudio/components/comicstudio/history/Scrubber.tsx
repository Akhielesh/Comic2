// Comic History — the moment scrubber under the filmstrip (versions plan §8 panel 3; package H5).
//
// A range slider with a 44 px hit area that drives the same selection as tapping a row. Oldest on the left, newest
// on the right. Arrow keys step one moment, Page Up / Page Down five, Home / End jump to the ends; aria-valuetext
// reads "Tuesday 10:42, AI drew pages 1 to 6" (and "From a version you removed" for a removed version's row, as the
// row's own label says). Dragging only previews: nothing here changes the live book.

import React, { useId } from 'react';
import type { VersionRow } from '../../../shared/comic/history/types';
import { FOCUS_RING } from '../../chat/studioDesign';
import { HISTORY_COPY, isRemovedLineRow, scrubValueText, whenText } from './historyModel';
import { cx } from './ui';

export interface ScrubberProps {
  /** Newest first (the list's order). */
  rows: readonly VersionRow[];
  selectedId: string | null;
  onSelect(id: string): void;
  /** The line listed (null / absent = "Original"): a row of another line came from a version the creator removed. */
  line?: string | null;
  now: number;
  tz: string;
  reducedMotion?: boolean;
}

/** Moments per Page Up / Page Down. */
export const SCRUB_PAGE_STEP = 5;

export const Scrubber: React.FC<ScrubberProps> = ({ rows, selectedId, onSelect, line = null, now, tz, reducedMotion }) => {
  const id = useId();
  if (rows.length < 2) return null;
  // Oldest → newest along the track.
  const ordered = [...rows].reverse();
  const at = Math.max(0, ordered.findIndex((r) => r.id === selectedId));
  const index = selectedId ? at : ordered.length - 1;
  const row = ordered[index];
  const go = (i: number) => {
    const next = ordered[Math.max(0, Math.min(ordered.length - 1, i))];
    if (next && next.id !== row?.id) onSelect(next.id);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -SCRUB_PAGE_STEP, PageUp: SCRUB_PAGE_STEP };
    if (e.key in step) {
      e.preventDefault();
      go(index + step[e.key]);
    } else if (e.key === 'Home') {
      e.preventDefault();
      go(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      go(ordered.length - 1);
    }
  };
  return (
    <div className="min-w-0 px-4" data-history-scrubber>
      <label htmlFor={id} className="sr-only">
        Moment in this comic’s history
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={ordered.length - 1}
        step={1}
        value={index}
        aria-valuetext={row ? `${scrubValueText(row, now, tz)}${isRemovedLineRow(row, line) ? `. ${HISTORY_COPY.removedLine}` : ''}` : undefined}
        onChange={(e) => go(Number(e.target.value))}
        onKeyDown={onKeyDown}
        className={cx('block h-11 min-h-11 w-full cursor-pointer accent-[var(--ds-ink)]', FOCUS_RING, reducedMotion ? 'transition-none' : '')}
      />
      <div className="flex min-w-0 justify-between gap-2 text-[11px] tabular-nums text-[var(--ds-muted)]" aria-hidden>
        <span className="min-w-0 truncate">{whenText(ordered[0].contentAt, now, tz)}</span>
        <span className="min-w-0 truncate">{whenText(ordered[ordered.length - 1].contentAt, now, tz)}</span>
      </div>
    </div>
  );
};

export default Scrubber;
