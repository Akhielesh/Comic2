import React, { useMemo, useState } from 'react';
import { Search, Download } from 'lucide-react';
import type {
  DataTableArtifact,
  DataTableColumn,
  DataTableCell,
  DataTableRowCell,
  DataTableValue
} from '../../../apiTypes';
import {
  Surface,
  SurfaceTitle,
  SurfaceSubtitle,
  Sparkline,
  resolveTheme,
  formatPriceCompact,
  formatPercent,
  formatSigned,
  compactNumber,
  useCompact
} from './kit';
import type { PaletteName } from './kit';

// The universal, schema-driven data TABLE — the tabular counterpart to ChartCard,
// styled as a macOS list view: sticky hairline header, tabular-nums right-aligned
// numbers, hover row tint, click-to-sort with ▲▼ indicators, hairline row dividers.
// Typed cells (currency / percent / signed-delta / sparkline / badge) let one
// artifact power watchlists, holdings, fundamentals grids, screeners, comparisons.
//
// Two densities:
// - compact: title + first 4 rows + "N more rows" hint, no controls.
// - detailed: full table with client-side search, row-count footer and CSV export.

const NUMERIC_KINDS = new Set(['number', 'currency', 'percent', 'delta', 'deltaPercent']);

// Normalize a row cell (which may be a bare primitive) into the rich cell shape.
const toCell = (raw: DataTableRowCell): DataTableCell =>
  raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw as DataTableValue };

// The value we sort/compare a cell by.
const sortValue = (raw: DataTableRowCell): number | string => {
  const cell = toCell(raw);
  if (typeof cell.value === 'number') return cell.value;
  if (Array.isArray(cell.spark) && cell.spark.length) return cell.spark[cell.spark.length - 1];
  const n = Number(cell.value);
  return Number.isFinite(n) && String(cell.value).trim() !== '' ? n : String(cell.value ?? '').toLowerCase();
};

const alignClass = (col: DataTableColumn): string => {
  const a = col.align ?? (NUMERIC_KINDS.has(col.kind ?? 'text') || col.kind === 'spark' ? 'right' : 'left');
  return a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left';
};

const isSortable = (col: DataTableColumn): boolean =>
  col.sortable ?? (NUMERIC_KINDS.has(col.kind ?? 'text') || col.kind === 'spark');

// Plain-text projection of a cell, shared by the search filter and the CSV export so
// both operate on what the user actually sees.
const cellText = (col: DataTableColumn, raw: DataTableRowCell): string => {
  const cell = toCell(raw);
  const kind = col.kind ?? 'text';
  if (kind === 'spark') {
    const last = cell.spark && cell.spark.length ? cell.spark[cell.spark.length - 1] : undefined;
    return last != null ? String(last) : '';
  }
  const num = typeof cell.value === 'number' ? cell.value : Number(cell.value);
  const hasNum = Number.isFinite(num) && String(cell.value ?? '').trim() !== '';
  let text: string;
  if (kind === 'currency' && hasNum) text = formatPriceCompact(num, cell.currency ?? col.currency ?? 'USD');
  else if (kind === 'percent' && hasNum) text = `${num.toFixed(2)}%`;
  else if (kind === 'deltaPercent' && hasNum) text = formatPercent(num);
  else if (kind === 'delta' && hasNum) text = formatSigned(num);
  else if (kind === 'number' && hasNum) text = Math.abs(num) >= 100000 ? compactNumber(num) : num.toLocaleString();
  else text = cell.value == null ? '' : String(cell.value);
  return cell.sub ? `${text} ${cell.sub}` : text;
};

// Render one cell body according to its column kind.
const CellBody: React.FC<{ col: DataTableColumn; raw: DataTableRowCell; accent: string }> = ({ col, raw, accent }) => {
  const cell = toCell(raw);
  const kind = col.kind ?? 'text';
  const num = typeof cell.value === 'number' ? cell.value : Number(cell.value);
  const hasNum = Number.isFinite(num) && String(cell.value ?? '').trim() !== '';
  const currency = cell.currency ?? col.currency ?? 'USD';

  let body: React.ReactNode;
  if (kind === 'spark') {
    body = cell.spark && cell.spark.length > 1
      ? <span className="inline-block w-20 align-middle"><Sparkline values={cell.spark} color={cell.color || accent} height={22} width={80} /></span>
      : <span className="text-[var(--ds-faint)]">—</span>;
  } else if (kind === 'badge') {
    const col2 = cell.color || '#64748b';
    body = cell.value != null && cell.value !== ''
      ? <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: col2, backgroundColor: `${col2}1a` }}>{String(cell.value)}</span>
      : <span className="text-[var(--ds-faint)]">—</span>;
  } else if ((kind === 'delta' || kind === 'deltaPercent') && hasNum) {
    const pos = num > 0;
    const neg = num < 0;
    const color = pos ? '#059669' : neg ? '#dc2626' : '#64748b';
    body = <span className="font-semibold tabular-nums" style={{ color }}>{kind === 'deltaPercent' ? formatPercent(num) : formatSigned(num)}</span>;
  } else if (kind === 'currency' && hasNum) {
    body = <span className="font-medium tabular-nums text-[var(--ds-ink)]">{formatPriceCompact(num, currency)}</span>;
  } else if (kind === 'percent' && hasNum) {
    body = <span className="font-medium tabular-nums text-[var(--ds-ink)]">{`${num.toFixed(2)}%`}</span>;
  } else if (kind === 'number' && hasNum) {
    body = <span className="font-medium tabular-nums text-[var(--ds-ink)]">{Math.abs(num) >= 100000 ? compactNumber(num) : num.toLocaleString()}</span>;
  } else {
    const text = cell.value == null || cell.value === '' ? '—' : String(cell.value);
    body = <span className={cell.value == null || cell.value === '' ? 'text-[var(--ds-faint)]' : 'font-medium text-[var(--ds-ink)]'} style={cell.color ? { color: cell.color } : undefined}>{text}</span>;
  }

  const wrapped = cell.href ? (
    <a href={cell.href} target="_blank" rel="noopener noreferrer" className="hover:underline">{body}</a>
  ) : body;

  return (
    <div className="leading-tight">
      {wrapped}
      {cell.sub && <div className="text-[10px] text-[var(--ds-muted)]">{cell.sub}</div>}
    </div>
  );
};

const COMPACT_ROWS = 4;

export const DataTableCard: React.FC<{ data: DataTableArtifact }> = ({ data }) => {
  const compact = useCompact();
  const theme = resolveTheme({ palette: (data.palette as PaletteName) || 'brand' });
  const columns = data.columns ?? [];
  const [sort, setSort] = useState<{ column: number; dir: 'asc' | 'desc' } | null>(data.sort ?? null);
  const [query, setQuery] = useState('');

  const allRows = data.rows ?? [];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter((row) => columns.some((col, ci) => cellText(col, row[ci] ?? null).toLowerCase().includes(q)));
  }, [allRows, query, columns]);

  const rows = useMemo(() => {
    if (!sort || !columns[sort.column]) return filtered;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = sortValue(a[sort.column] ?? null);
      const vb = sortValue(b[sort.column] ?? null);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [filtered, sort, columns]);

  if (!columns.length || !allRows.length) return null;

  const onSort = (ci: number) => {
    if (!isSortable(columns[ci])) return;
    setSort((prev) => (prev?.column === ci ? { column: ci, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { column: ci, dir: 'desc' }));
  };

  // Build the CSV client-side from the visible (filtered + sorted) rows and download
  // it via an object-URL blob.
  const exportCsv = () => {
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = [
      columns.map((c) => esc(c.label)).join(','),
      ...rows.map((row) => columns.map((col, ci) => esc(cellText(col, row[ci] ?? null))).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(data.title || 'table').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'table'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const visibleRows = compact ? rows.slice(0, COMPACT_ROWS) : rows;
  const hiddenCount = compact ? rows.length - visibleRows.length : 0;

  const header = (data.title || data.subtitle) ? (
    <>
      {data.title && <SurfaceTitle>{data.title}</SurfaceTitle>}
      {data.subtitle && <SurfaceSubtitle>{data.subtitle}</SurfaceSubtitle>}
    </>
  ) : undefined;

  const table = (
    <table className="w-full min-w-0 border-collapse text-xs">
      <thead className={compact ? '' : 'sticky top-0 z-10 bg-[var(--ds-surface-strong)] backdrop-blur-sm'}>
        <tr>
          {columns.map((col, ci) => {
            const sortable = isSortable(col);
            const active = sort?.column === ci;
            return (
              <th
                key={ci}
                onClick={() => onSort(ci)}
                aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                className={`whitespace-nowrap border-b border-[var(--ds-hairline)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider ${alignClass(col)} ${
                  active ? 'text-[var(--ds-ink)]' : 'text-[var(--ds-muted)]'
                } ${sortable && !compact ? 'cursor-pointer select-none transition-colors duration-200 hover:text-[var(--ds-ink)]' : ''}`}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {!compact && active && <span className="text-[8px] leading-none">{sort!.dir === 'asc' ? '▲' : '▼'}</span>}
                </span>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {visibleRows.map((row, ri) => (
          <tr key={ri} className="border-b border-[var(--ds-hairline-soft)] transition-colors duration-200 last:border-0 hover:bg-[var(--ds-well)]">
            {columns.map((col, ci) => (
              <td key={ci} className={`px-2.5 py-1.5 align-middle ${alignClass(col)}`}>
                <CellBody col={col} raw={row[ci] ?? null} accent={theme.accent} />
              </td>
            ))}
          </tr>
        ))}
        {!compact && visibleRows.length === 0 && (
          <tr>
            <td colSpan={columns.length} className="px-2.5 py-4 text-center text-[11px] text-[var(--ds-muted)]">
              No rows match “{query.trim()}”
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );

  // ── Compact: title + first rows + "N more" hint; no search/sort/export. ──
  if (compact) {
    return (
      <Surface
        accent={theme.accent}
        header={header}
        footer={hiddenCount > 0 ? <div className="text-[11px] text-[var(--ds-muted)]">+{hiddenCount} more rows</div> : undefined}
      >
        <div className="min-w-0 overflow-x-auto">{table}</div>
      </Surface>
    );
  }

  return (
    <Surface
      accent={theme.accent}
      header={header}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
          <span className="text-[11px] tabular-nums text-[var(--ds-muted)]">
            {rows.length === allRows.length ? `${allRows.length} rows` : `${rows.length} of ${allRows.length} rows`}
          </span>
          {data.caption && <span className="min-w-0 truncate text-[10px] text-[var(--ds-muted)]">{data.caption}</span>}
        </div>
      }
    >
      {/* Toolbar: client-side filter + CSV export */}
      <div className={`flex items-center gap-2 px-3 pb-2 ${header ? '' : 'pt-2.5'}`}>
        <div className="relative min-w-0 flex-1 max-w-[220px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ds-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Filter ${allRows.length} rows…`}
            className="w-full rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface)] py-1 pl-7 pr-2 text-xs text-[var(--ds-ink)] placeholder:text-[var(--ds-muted)] transition-colors duration-200 focus:border-[var(--ds-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--ds-hairline-soft)]"
          />
        </div>
        <button
          onClick={exportCsv}
          title="Download as CSV"
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg border border-[var(--ds-hairline)] px-2 py-1 text-[11px] font-semibold text-[var(--ds-muted)] transition-colors duration-200 hover:bg-[var(--ds-well)] hover:text-[var(--ds-ink)]"
        >
          <Download className="h-3 w-3" />
          CSV
        </button>
      </div>

      <div className="min-w-0 max-h-[360px] overflow-auto">{table}</div>
    </Surface>
  );
};
