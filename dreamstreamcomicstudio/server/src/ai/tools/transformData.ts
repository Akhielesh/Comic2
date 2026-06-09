import type { ChatTool } from './types.js';
import { parseTable, toDelimited, toJsonRows, toDataTableArtifact, type ParsedTable, type DataFormat } from './convertData.js';

// `transform_data` — deterministic data wrangling: filter rows, sort, select/drop
// columns, limit. The reshape verb between convert_data (parse) and analyze_data
// (compute). The model passes raw CSV/TSV/JSON + a structured set of operations and
// this applies them in code — no model row-shuffling. Returns the reshaped data
// (csv/json/table) so it chains into render_chart / analyze_data.

type Op = 'eq' | 'ne' | 'gt' | 'lt' | 'ge' | 'le' | 'contains' | 'startsWith';

const toNum = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const t = v.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const colIndex = (t: ParsedTable, name: string): number =>
  t.columns.findIndex((c) => c.trim().toLowerCase() === String(name).trim().toLowerCase());

function matches(cell: string, op: Op, value: string): boolean {
  const cn = toNum(cell);
  const vn = toNum(value);
  const bothNum = cn !== null && vn !== null;
  switch (op) {
    case 'eq': return bothNum ? cn === vn : cell === value;
    case 'ne': return bothNum ? cn !== vn : cell !== value;
    case 'gt': return bothNum ? cn! > vn! : cell > value;
    case 'lt': return bothNum ? cn! < vn! : cell < value;
    case 'ge': return bothNum ? cn! >= vn! : cell >= value;
    case 'le': return bothNum ? cn! <= vn! : cell <= value;
    case 'contains': return cell.toLowerCase().includes(value.toLowerCase());
    case 'startsWith': return cell.toLowerCase().startsWith(value.toLowerCase());
    default: return false;
  }
}

export interface TransformOpts {
  select?: string[];
  drop?: string[];
  filter?: { column: string; op: Op; value: string | number };
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
}

/** Apply filter → sort → column projection → limit. Filter/sort reference the
 *  original columns (before projection). Pure; exported for testing. */
export function applyTransform(table: ParsedTable, o: TransformOpts): ParsedTable {
  let rows = table.rows;

  if (o.filter && o.filter.column) {
    const fi = colIndex(table, o.filter.column);
    if (fi >= 0) {
      const val = String(o.filter.value ?? '');
      rows = rows.filter((r) => matches(r[fi] ?? '', o.filter!.op, val));
    }
  }

  if (o.sortBy) {
    const si = colIndex(table, o.sortBy);
    if (si >= 0) {
      const dir = o.sortDir === 'desc' ? -1 : 1;
      rows = [...rows].sort((a, b) => {
        const av = a[si] ?? '';
        const bv = b[si] ?? '';
        const an = toNum(av);
        const bn = toNum(bv);
        if (an !== null && bn !== null) return (an - bn) * dir;
        return av.localeCompare(bv) * dir;
      });
    }
  }

  let colIdx = table.columns.map((_, i) => i);
  if (o.select?.length) {
    colIdx = o.select.map((n) => colIndex(table, n)).filter((i) => i >= 0);
  } else if (o.drop?.length) {
    const dropSet = new Set(o.drop.map((n) => colIndex(table, n)).filter((i) => i >= 0));
    colIdx = colIdx.filter((i) => !dropSet.has(i));
  }
  const columns = colIdx.map((i) => table.columns[i]);
  let outRows = rows.map((r) => colIdx.map((i) => r[i] ?? ''));

  if (typeof o.limit === 'number' && o.limit >= 0) outRows = outRows.slice(0, Math.floor(o.limit));

  return { columns, rows: outRows, truncated: table.truncated };
}

export const transformDataTool: ChatTool = {
  name: 'transform_data',
  description:
    'Reshape tabular data deterministically: filter rows, sort, select/drop columns, and limit. Paste raw CSV/TSV/JSON into `data` and pass operations. Use to clean or narrow data before charting or analyzing it — e.g. "top 10 by revenue", "only rows where status = active", "keep just name and score, sorted high to low". Returns the reshaped data (and a table preview) so you can chart or analyze the result.',
  parameters: {
    type: 'object',
    properties: {
      data: { type: 'string', description: 'Raw tabular data (CSV, TSV or JSON text).' },
      from: { type: 'string', enum: ['auto', 'csv', 'tsv', 'json'], description: 'Source format (default auto-detect).' },
      select: { type: 'array', items: { type: 'string' }, description: 'Column names to keep, in order. Omit to keep all.' },
      drop: { type: 'array', items: { type: 'string' }, description: 'Column names to remove (ignored if `select` is given).' },
      filter: {
        type: 'object',
        description: 'Keep only rows matching this condition.',
        properties: {
          column: { type: 'string' },
          op: { type: 'string', enum: ['eq', 'ne', 'gt', 'lt', 'ge', 'le', 'contains', 'startsWith'] },
          value: { type: ['string', 'number'] }
        },
        required: ['column', 'op', 'value']
      },
      sortBy: { type: 'string', description: 'Column name to sort by (numeric-aware).' },
      sortDir: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction (default asc).' },
      limit: { type: 'number', description: 'Keep only the first N rows after filtering/sorting.' },
      to: { type: 'string', enum: ['csv', 'json', 'table'], description: 'Output format for the reshaped data (default table preview only).' }
    },
    required: ['data']
  },
  execute: async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const raw = typeof a.data === 'string' ? a.data : '';
    if (!raw.trim()) return { content: 'No data was provided to transform.' };

    let table: ParsedTable;
    try {
      table = parseTable(raw, (typeof a.from === 'string' ? a.from : 'auto') as DataFormat);
    } catch (err) {
      return { content: `Couldn't parse the data: ${(err as Error).message}.` };
    }
    if (!table.columns.length) return { content: 'The data parsed to an empty table — nothing to transform.' };

    const strArr = (v: unknown): string[] | undefined =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
    const f = a.filter as Record<string, unknown> | undefined;
    const opts: TransformOpts = {
      select: strArr(a.select),
      drop: strArr(a.drop),
      filter: f && typeof f.column === 'string' && typeof f.op === 'string'
        ? { column: f.column, op: f.op as Op, value: (f.value as string | number) ?? '' }
        : undefined,
      sortBy: typeof a.sortBy === 'string' ? a.sortBy : undefined,
      sortDir: a.sortDir === 'desc' ? 'desc' : a.sortDir === 'asc' ? 'asc' : undefined,
      limit: typeof a.limit === 'number' ? a.limit : undefined
    };

    if (opts.select?.length) {
      const missing = opts.select.filter((n) => colIndex(table, n) < 0);
      if (missing.length === opts.select.length) return { content: `None of the selected columns exist. Available: ${table.columns.join(', ')}.` };
    }

    const result = applyTransform(table, opts);
    if (!result.columns.length) return { content: 'The transform removed all columns — check your select/drop names.' };

    const to = (typeof a.to === 'string' ? a.to : 'table') as 'csv' | 'json' | 'table';
    const artifact = { type: 'data_table', data: toDataTableArtifact(result, 'Transformed data') };
    const summary = `Reshaped to ${result.rows.length} row${result.rows.length === 1 ? '' : 's'} × ${result.columns.length} column${result.columns.length === 1 ? '' : 's'}.`;

    if (to === 'table') return { content: `${summary} A preview is shown — chart or analyze it next.`, artifacts: [artifact] };

    let out = to === 'json' ? JSON.stringify(toJsonRows(result), null, 2) : toDelimited(result);
    let clip = '';
    if (out.length > 8000) { out = out.slice(0, 8000); clip = ' …(truncated)'; }
    return { content: `${summary}\n\n\`\`\`${to === 'json' ? 'json' : 'csv'}\n${out}${clip}\n\`\`\``, artifacts: [artifact] };
  }
};
