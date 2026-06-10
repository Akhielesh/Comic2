import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type {
  DataTableArtifact,
  DataTableColumn,
  DataTableCell,
  DataTableRowCell,
  DataTableValue
} from '../../../apiTypes';
import { Surface, Sparkline, resolveTheme, formatPriceCompact, formatPercent, formatSigned, compactNumber } from './kit';
import type { PaletteName } from './kit';

// The universal, schema-driven data TABLE — the tabular counterpart to ChartCard.
// One artifact renders watchlists, holdings, fundamentals grids, screeners and
// comparisons, with typed cells (currency / percent / signed-delta / sparkline /
// badge), client-side sorting and a totals-free, dependency-free build. Gives the
// model (and any AI-authored component) a structured way to lay out ANY rows.

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
      : <span className="text-slate-300">—</span>;
  } else if (kind === 'badge') {
    const col2 = cell.color || '#64748b';
    body = cell.value != null && cell.value !== ''
      ? <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" style={{ color: col2, backgroundColor: `${col2}1a` }}>{String(cell.value)}</span>
      : <span className="text-slate-300">—</span>;
  } else if ((kind === 'delta' || kind === 'deltaPercent') && hasNum) {
    const pos = num > 0;
    const neg = num < 0;
    const color = pos ? '#059669' : neg ? '#dc2626' : '#64748b';
    body = <span className="font-bold" style={{ color }}>{kind === 'deltaPercent' ? formatPercent(num) : formatSigned(num)}</span>;
  } else if (kind === 'currency' && hasNum) {
    body = <span className="font-semibold text-slate-800">{formatPriceCompact(num, currency)}</span>;
  } else if (kind === 'percent' && hasNum) {
    body = <span className="font-semibold text-slate-800">{`${num.toFixed(2)}%`}</span>;
  } else if (kind === 'number' && hasNum) {
    body = <span className="font-semibold text-slate-800">{Math.abs(num) >= 100000 ? compactNumber(num) : num.toLocaleString()}</span>;
  } else {
    const text = cell.value == null || cell.value === '' ? '—' : String(cell.value);
    body = <span className={cell.value == null || cell.value === '' ? 'text-slate-300' : 'font-semibold text-slate-800'} style={cell.color ? { color: cell.color } : undefined}>{text}</span>;
  }

  const wrapped = cell.href ? (
    <a href={cell.href} target="_blank" rel="noopener noreferrer" className="hover:underline">{body}</a>
  ) : body;

  return (
    <div className="leading-tight">
      {wrapped}
      {cell.sub && <div className="text-[10px] font-medium text-slate-400">{cell.sub}</div>}
    </div>
  );
};

export const DataTableCard: React.FC<{ data: DataTableArtifact; embedded?: boolean }> = ({ data, embedded }) => {
  const theme = resolveTheme({ palette: (data.palette as PaletteName) || 'brand' });
  const columns = data.columns ?? [];
  const [sort, setSort] = useState<{ column: number; dir: 'asc' | 'desc' } | null>(data.sort ?? null);

  const rows = useMemo(() => {
    const base = data.rows ?? [];
    if (!sort || !columns[sort.column]) return base;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...base].sort((a, b) => {
      const va = sortValue(a[sort.column] ?? null);
      const vb = sortValue(b[sort.column] ?? null);
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [data.rows, sort, columns]);

  if (!columns.length || !rows.length) return null;

  const onSort = (ci: number) => {
    if (!isSortable(columns[ci])) return;
    setSort((prev) => (prev?.column === ci ? { column: ci, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { column: ci, dir: 'desc' }));
  };

  return (
    <Surface
      embedded={embedded}
      accent={theme.accent}
      header={data.title ? (
        <div>
          <div className="text-sm font-extrabold">{data.title}</div>
          {data.subtitle && <div className="text-[11px] font-semibold text-slate-500">{data.subtitle}</div>}
        </div>
      ) : undefined}
      footer={data.caption ? <div className="text-[10px] font-medium text-slate-400">{data.caption}</div> : undefined}
    >
      <div className="overflow-x-auto px-1 pb-1">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b-2 border-black/10">
              {columns.map((col, ci) => (
                <th
                  key={ci}
                  onClick={() => onSort(ci)}
                  className={`px-2 py-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-500 ${alignClass(col)} ${isSortable(col) ? 'cursor-pointer select-none hover:text-slate-800' : ''}`}
                >
                  <span className="inline-flex items-center gap-0.5">
                    {col.label}
                    {isSortable(col) && sort?.column === ci && (sort.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b border-black/5 transition-colors hover:bg-slate-50">
                {columns.map((col, ci) => (
                  <td key={ci} className={`px-2 py-1.5 ${alignClass(col)}`}>
                    <CellBody col={col} raw={row[ci] ?? null} accent={theme.accent} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Surface>
  );
};
