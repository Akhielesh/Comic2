import type { ChatTool } from './types.js';
import { parseTable, type ParsedTable } from './convertData.js';

// `analyze_data` — deterministic (non-AI) analysis of tabular data. Pairs with
// convert_data: the model hands over raw CSV/TSV/JSON and this computes descriptive
// statistics per numeric column, or a group-by aggregation, in code — no transcription,
// no sandbox, no model arithmetic (which is error-prone). Returns a data_table artifact
// + a short summary. Second piece of the deterministic toolbelt.

const round = (n: number): number => Math.round(n * 1e4) / 1e4;
const toNum = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const t = v.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export interface ColumnStat {
  column: string;
  count: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  sum: number;
}

const median = (sorted: number[]): number => {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Descriptive stats for every column that contains numbers. */
export function columnStats(table: ParsedTable): ColumnStat[] {
  const out: ColumnStat[] = [];
  table.columns.forEach((label, i) => {
    const nums = table.rows.map((r) => toNum(r[i])).filter((n): n is number => n !== null);
    if (!nums.length) return;
    const sorted = [...nums].sort((a, b) => a - b);
    const sum = nums.reduce((a, b) => a + b, 0);
    out.push({
      column: label || `col${i + 1}`,
      count: nums.length,
      mean: round(sum / nums.length),
      median: round(median(sorted)),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      sum: round(sum)
    });
  });
  return out;
}

export type Agg = 'sum' | 'avg' | 'count' | 'min' | 'max';

/** Group rows by one column and aggregate another (or count rows). Sorted desc. */
export function groupAggregate(table: ParsedTable, groupCol: number, valueCol: number | null, agg: Agg): { key: string; value: number }[] {
  const buckets = new Map<string, number[]>();
  for (const r of table.rows) {
    const key = (r[groupCol] ?? '').trim() || '(blank)';
    const arr = buckets.get(key) ?? [];
    if (valueCol !== null) {
      const n = toNum(r[valueCol]);
      if (n !== null) arr.push(n);
    } else {
      arr.push(1);
    }
    buckets.set(key, arr);
  }
  const reduce = (vals: number[]): number => {
    if (agg === 'count') return vals.length;
    if (!vals.length) return 0;
    if (agg === 'sum') return vals.reduce((a, b) => a + b, 0);
    if (agg === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
    if (agg === 'min') return Math.min(...vals);
    return Math.max(...vals);
  };
  return [...buckets.entries()]
    .map(([key, vals]) => ({ key, value: round(reduce(vals)) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 200);
}

const findCol = (table: ParsedTable, name: string): number =>
  table.columns.findIndex((c) => c.trim().toLowerCase() === name.trim().toLowerCase());

export const analyzeDataTool: ChatTool = {
  name: 'analyze_data',
  description:
    'Analyze tabular data deterministically (no model arithmetic). Paste the raw CSV/TSV/JSON into `data`. With no other args it returns descriptive statistics (count, mean, median, min, max, sum) for every numeric column. Provide `groupBy` (and optionally `value` + `agg`) to aggregate — e.g. total sales by region, average score by team. Returns a table of results you can then chart with render_chart. Use for "what\'s the average/total", "summarize this data", "sum/group by X".',
  parameters: {
    type: 'object',
    properties: {
      data: { type: 'string', description: 'Raw tabular data (CSV, TSV or JSON text).' },
      from: { type: 'string', enum: ['auto', 'csv', 'tsv', 'json'], description: 'Source format (default auto-detect).' },
      groupBy: { type: 'string', description: 'Column name to group rows by (for aggregation).' },
      value: { type: 'string', description: 'Numeric column to aggregate. Omit with agg="count".' },
      agg: { type: 'string', enum: ['sum', 'avg', 'count', 'min', 'max'], description: 'Aggregation for grouped analysis (default sum).' }
    },
    required: ['data']
  },
  execute: async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const raw = typeof a.data === 'string' ? a.data : '';
    if (!raw.trim()) return { content: 'No data was provided to analyze.' };

    let table: ParsedTable;
    try {
      table = parseTable(raw, (typeof a.from === 'string' ? a.from : 'auto') as 'auto' | 'csv' | 'tsv' | 'json');
    } catch (err) {
      return { content: `Couldn't parse the data: ${(err as Error).message}.` };
    }
    if (!table.columns.length || !table.rows.length) return { content: 'The data parsed to an empty table — nothing to analyze.' };

    const groupBy = typeof a.groupBy === 'string' ? a.groupBy : undefined;

    if (groupBy) {
      const gi = findCol(table, groupBy);
      if (gi < 0) return { content: `Column "${groupBy}" not found. Available columns: ${table.columns.join(', ')}.` };
      const agg = (typeof a.agg === 'string' ? a.agg : 'sum') as Agg;
      const valueName = typeof a.value === 'string' ? a.value : undefined;
      let vi: number | null = null;
      if (agg !== 'count') {
        if (!valueName) return { content: `Aggregation "${agg}" needs a \`value\` column (or use agg="count").` };
        vi = findCol(table, valueName);
        if (vi < 0) return { content: `Value column "${valueName}" not found. Available columns: ${table.columns.join(', ')}.` };
      }
      const grouped = groupAggregate(table, gi, vi, agg);
      const valueLabel = agg === 'count' ? 'count' : `${agg}(${valueName})`;
      const data = {
        title: `${valueLabel} by ${table.columns[gi] || groupBy}`,
        columns: [
          { label: table.columns[gi] || groupBy, kind: 'text', align: 'left' },
          { label: valueLabel, kind: 'number', align: 'right' }
        ],
        rows: grouped.map((g) => [g.key, g.value])
      };
      return {
        content: `Grouped ${table.rows.length} rows into ${grouped.length} group${grouped.length === 1 ? '' : 's'} by "${table.columns[gi] || groupBy}" (${valueLabel}). Top: ${grouped.slice(0, 3).map((g) => `${g.key}=${g.value}`).join(', ')}. A results table is shown — chart it with render_chart if useful.`,
        artifacts: [{ type: 'data_table', data }]
      };
    }

    const stats = columnStats(table);
    if (!stats.length) return { content: `No numeric columns found to analyze. Columns: ${table.columns.join(', ')}.` };
    const data = {
      title: 'Descriptive statistics',
      columns: [
        { label: 'Column', kind: 'text', align: 'left' },
        { label: 'Count', kind: 'number', align: 'right' },
        { label: 'Mean', kind: 'number', align: 'right' },
        { label: 'Median', kind: 'number', align: 'right' },
        { label: 'Min', kind: 'number', align: 'right' },
        { label: 'Max', kind: 'number', align: 'right' },
        { label: 'Sum', kind: 'number', align: 'right' }
      ],
      rows: stats.map((s) => [s.column, s.count, s.mean, s.median, s.min, s.max, s.sum])
    };
    return {
      content: `Analyzed ${stats.length} numeric column${stats.length === 1 ? '' : 's'} across ${table.rows.length} rows. A statistics table is shown.`,
      artifacts: [{ type: 'data_table', data }]
    };
  }
};
