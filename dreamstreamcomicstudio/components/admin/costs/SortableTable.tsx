import React, { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from 'lucide-react';
import { downloadCsv, toCsv, type CsvCell } from './costFormat';

// A quiet, sortable data table with CSV export — every cost-centre table is one of these.
// Click a header to sort (numbers start descending, text ascending; click again to flip).
// Numeric columns are right-aligned with tabular figures so digits line up.

export interface Column<T> {
  key: string;
  label: string;
  /** Sort + CSV value. Numbers sort numerically; null/undefined always sink to the bottom. */
  value: (row: T) => string | number | null | undefined;
  /** Optional rich cell; defaults to the raw value. */
  render?: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  /** Extra classes for the cell (e.g. a max width). */
  className?: string;
  /** Leave the column out of sorting (still exported). */
  sortable?: boolean;
}

interface SortableTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** CSV file name (without extension). */
  csvName: string;
  /** Shown when there are no rows — say what was (not) recorded, not just "empty". */
  emptyText: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** Optional footer row (totals). */
  footer?: React.ReactNode;
  /** Short caption for screen readers. */
  caption: string;
}

type SortState = { key: string; dir: 'asc' | 'desc' } | null;

const compare = (a: string | number | null | undefined, b: string | number | null | undefined): number => {
  const aMissing = a === null || a === undefined || a === '';
  const bMissing = b === null || b === undefined || b === '';
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
};

export function SortableTable<T>({ columns, rows, rowKey, csvName, emptyText, initialSort, footer, caption }: SortableTableProps<T>) {
  const [sort, setSort] = useState<SortState>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const withIndex = rows.map((row, i) => ({ row, i }));
    withIndex.sort((x, y) => {
      const vx = col.value(x.row);
      const vy = col.value(y.row);
      const missingX = vx === null || vx === undefined || vx === '';
      const missingY = vy === null || vy === undefined || vy === '';
      // Missing values stay at the bottom in both directions.
      if (missingX || missingY) return missingX === missingY ? x.i - y.i : missingX ? 1 : -1;
      const c = compare(vx, vy);
      return (sort.dir === 'asc' ? c : -c) || x.i - y.i;
    });
    return withIndex.map((w) => w.row);
  }, [rows, columns, sort]);

  const toggleSort = (col: Column<T>) => {
    if (col.sortable === false) return;
    setSort((cur) => {
      if (cur?.key === col.key) return { key: col.key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
      const sample = rows.map(col.value).find((v) => v !== null && v !== undefined);
      return { key: col.key, dir: typeof sample === 'number' ? 'desc' : 'asc' };
    });
  };

  const exportCsv = () => {
    const csv = toCsv(
      columns.map((c) => c.label),
      sorted.map((row) => columns.map((c) => c.value(row) as CsvCell))
    );
    downloadCsv(`${csvName}.csv`, csv);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-[var(--ds-muted)]">
          {rows.length === 0 ? 'No rows' : `${rows.length.toLocaleString('en-US')} row${rows.length === 1 ? '' : 's'}`}
          {sort ? ' · sorted by ' + (columns.find((c) => c.key === sort.key)?.label || sort.key).toLowerCase() : ''}
        </span>
        <button
          type="button"
          onClick={exportCsv}
          disabled={rows.length === 0}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] disabled:opacity-40"
          aria-label={`Export ${caption} as CSV`}
        >
          <Download className="h-3.5 w-3.5" /> Export CSV
        </button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-[var(--ds-hairline-soft)]">
        <table className="w-full min-w-[560px] text-left text-xs">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-[var(--ds-hairline)] bg-[var(--ds-well)]">
              {columns.map((col) => {
                const active = sort?.key === col.key;
                const Icon = !active ? ArrowUpDown : sort?.dir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                    className={`px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-muted)] ${col.align === 'right' ? 'text-right' : ''}`}
                  >
                    {col.sortable === false ? (
                      col.label
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleSort(col)}
                        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-[var(--ds-ink)] ${active ? 'text-[var(--ds-ink)]' : ''} ${col.align === 'right' ? 'flex-row-reverse' : ''}`}
                      >
                        {col.label}
                        <Icon className={`h-3 w-3 ${active ? '' : 'opacity-40'}`} aria-hidden />
                      </button>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-xs text-[var(--ds-muted)]">
                  {emptyText}
                </td>
              </tr>
            )}
            {sorted.map((row, i) => (
              <tr key={rowKey(row, i)} className="border-b border-[var(--ds-hairline-soft)] last:border-0 hover:bg-[var(--ds-hover)]">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-3 py-2 align-top text-[var(--ds-ink)] ${col.align === 'right' ? 'text-right tabular-nums' : ''} ${col.className ?? ''}`}
                  >
                    {col.render ? col.render(row) : (col.value(row) ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {footer && sorted.length > 0 && <tfoot>{footer}</tfoot>}
        </table>
      </div>
    </div>
  );
}
