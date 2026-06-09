import type { ChatTool } from './types.js';

// `convert_data` — deterministic (non-AI) data conversion. The model hands over raw
// tabular text (CSV / TSV / JSON) and this parses it in code and converts between
// formats, rather than having the model transcribe rows by hand (error-prone and
// token-heavy). Returns the converted text plus a `data_table` artifact for preview.
// Pure TS, no dependencies, no sandbox needed — the first piece of the deterministic
// toolbelt from docs/agent-runtime/04-toolbelt-and-verification.md.

const MAX_ROWS = 500;
const MAX_COLS = 50;
const MAX_CELL = 500;
const MAX_OUTPUT = 8000;

export type DataFormat = 'auto' | 'csv' | 'tsv' | 'json';
export interface ParsedTable {
  columns: string[];
  rows: string[][];
  /** rows beyond MAX_ROWS were dropped. */
  truncated: boolean;
}

const cap = (s: string): string => (s.length > MAX_CELL ? s.slice(0, MAX_CELL) : s);

/** RFC4180-ish delimited parser: honors quoted fields with embedded delimiters,
 *  newlines and doubled-"" quotes. */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => {
    row.push(cap(field));
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // swallow; \r\n handled by the \n branch
    } else {
      field += c;
    }
  }
  // trailing field/row (unless the text ended exactly on a newline)
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

const isNumeric = (v: string): boolean => /^-?\d+(?:\.\d+)?$/.test(v.trim());

/** Detect the source format from the raw text. */
export function detectFormat(text: string): Exclude<DataFormat, 'auto'> {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) return 'json';
  const firstLine = t.split('\n', 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  return tabs > commas ? 'tsv' : 'csv';
}

/** Parse raw text into a normalized {columns, rows} table. */
export function parseTable(text: string, format: DataFormat = 'auto'): ParsedTable {
  const fmt = format === 'auto' ? detectFormat(text) : format;
  let columns: string[] = [];
  let body: string[][] = [];

  if (fmt === 'json') {
    const parsed: unknown = JSON.parse(text);
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    if (arr.length && arr.every((r) => r !== null && typeof r === 'object' && !Array.isArray(r))) {
      // array of objects → union of keys (first-seen order)
      const seen: string[] = [];
      for (const obj of arr) {
        for (const k of Object.keys(obj as Record<string, unknown>)) if (!seen.includes(k)) seen.push(k);
      }
      columns = seen.slice(0, MAX_COLS);
      body = arr.map((obj) =>
        columns.map((k) => {
          const v = (obj as Record<string, unknown>)[k];
          return cap(v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
        })
      );
    } else {
      // array of arrays / scalars → first row is the header
      const grid = arr.map((r) => (Array.isArray(r) ? r.map((c) => cap(String(c))) : [cap(String(r))]));
      columns = (grid[0] ?? []).slice(0, MAX_COLS);
      body = grid.slice(1).map((r) => r.slice(0, MAX_COLS));
    }
  } else {
    const grid = parseDelimited(text, fmt === 'tsv' ? '\t' : ',');
    columns = (grid[0] ?? []).slice(0, MAX_COLS);
    body = grid.slice(1).map((r) => r.slice(0, MAX_COLS));
  }

  const truncated = body.length > MAX_ROWS;
  return { columns, rows: body.slice(0, MAX_ROWS), truncated };
}

const csvCell = (v: string): string => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Serialize a normalized table to CSV (or TSV). */
export function toDelimited(table: ParsedTable, delim = ','): string {
  const enc = delim === ',' ? csvCell : (v: string) => v.replace(/\t/g, ' ');
  return [table.columns, ...table.rows].map((r) => r.map(enc).join(delim)).join('\n');
}

/** Serialize a normalized table to an array of objects (numbers coerced). */
export function toJsonRows(table: ParsedTable): Record<string, string | number>[] {
  return table.rows.map((r) => {
    const obj: Record<string, string | number> = {};
    table.columns.forEach((c, i) => {
      const v = r[i] ?? '';
      obj[c || `col${i + 1}`] = isNumeric(v) ? Number(v) : v;
    });
    return obj;
  });
}

/** Build a `data_table` artifact (number columns inferred + right-aligned). */
export function toDataTableArtifact(table: ParsedTable, title?: string): unknown {
  const numericCol = table.columns.map((_, i) => table.rows.length > 0 && table.rows.every((r) => r[i] === undefined || r[i] === '' || isNumeric(r[i])));
  const columns = table.columns.map((label, i) => ({
    label: label || `col${i + 1}`,
    kind: numericCol[i] ? 'number' : 'text',
    align: numericCol[i] ? 'right' : 'left'
  }));
  const rows = table.rows.map((r) => table.columns.map((_, i) => {
    const v = r[i] ?? '';
    return numericCol[i] && isNumeric(v) ? Number(v) : v;
  }));
  return { title, columns, rows };
}

export const convertDataTool: ChatTool = {
  name: 'convert_data',
  description:
    'Convert raw tabular data between formats deterministically (no transcription). Paste the raw CSV, TSV or JSON the user provided into `data`; this parses it in code and converts to the target format (csv | json | table), returning the converted text plus a table preview. Use for "turn this into a CSV", "parse/clean this data", "convert this JSON to a table", or to reshape pasted data before charting it. Prefer this over hand-writing rows.',
  parameters: {
    type: 'object',
    properties: {
      data: { type: 'string', description: 'The raw data to convert (CSV, TSV or JSON text).' },
      from: { type: 'string', enum: ['auto', 'csv', 'tsv', 'json'], description: 'Source format. Defaults to auto-detect.' },
      to: { type: 'string', enum: ['csv', 'json', 'table'], description: 'Target format. "table" shows only the preview card. Defaults to csv.' },
      title: { type: 'string', description: 'Optional title for the preview table.' }
    },
    required: ['data']
  },
  execute: async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const raw = typeof a.data === 'string' ? a.data : '';
    if (!raw.trim()) return { content: 'No data was provided to convert.' };
    const from = (typeof a.from === 'string' ? a.from : 'auto') as DataFormat;
    const to = (typeof a.to === 'string' ? a.to : 'csv') as 'csv' | 'json' | 'table';
    const title = typeof a.title === 'string' ? a.title.slice(0, 200) : undefined;

    let table: ParsedTable;
    try {
      table = parseTable(raw, from);
    } catch (err) {
      return { content: `Couldn't parse the data as ${from === 'auto' ? 'CSV/TSV/JSON' : from}: ${(err as Error).message}. Check the format and try again.` };
    }
    if (!table.columns.length) return { content: 'The data parsed to an empty table (no columns/headers found).' };

    const artifact = { type: 'data_table', data: toDataTableArtifact(table, title) };
    const note = table.truncated ? ` (truncated to the first ${MAX_ROWS} rows)` : '';

    if (to === 'table') {
      return { content: `Parsed ${table.rows.length} row${table.rows.length === 1 ? '' : 's'} × ${table.columns.length} column${table.columns.length === 1 ? '' : 's'}${note}. A table preview is shown.`, artifacts: [artifact] };
    }

    let out = to === 'json' ? JSON.stringify(toJsonRows(table), null, 2) : toDelimited(table);
    let clipped = '';
    if (out.length > MAX_OUTPUT) {
      out = out.slice(0, MAX_OUTPUT);
      clipped = ' …(output truncated)';
    }
    const fence = to === 'json' ? 'json' : 'csv';
    return {
      content: `Converted ${table.rows.length} row${table.rows.length === 1 ? '' : 's'} to ${to.toUpperCase()}${note}:\n\n\`\`\`${fence}\n${out}${clipped}\n\`\`\``,
      artifacts: [artifact]
    };
  }
};
