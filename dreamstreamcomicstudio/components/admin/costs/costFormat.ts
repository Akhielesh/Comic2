// Formatting + CSV helpers for the admin cost centre. Costs here are often fractions of a
// cent ($0.0027 of AI), so the dollar formatter keeps two significant digits below a cent
// instead of rounding honest small numbers to "$0.00".

import { compactNumber } from '../../chat/artifacts/kit';

/** "$1,234" · "$12.34" · "$0.15" · "$0.0027" · "$0". */
export const fmtUsd = (n: number | null | undefined): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n === 0) return '$0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 100_000) return `${sign}$${compactNumber(abs)}`;
  if (abs >= 1000) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
  if (abs >= 0.01) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${Number(abs.toPrecision(2)).toString()}`;
};

/** Axis ticks: short and clean ("$0", "$0.05", "$1.2", "$12"). */
export const fmtUsdAxis = (n: number): string => {
  if (n === 0) return '$0';
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${compactNumber(n)}`;
  if (abs >= 10) return `$${Math.round(n)}`;
  if (abs >= 1) return `$${Number(n.toFixed(1))}`;
  return `$${Number(n.toPrecision(2))}`;
};

export const fmtCount = (n: number | null | undefined): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US');

export const fmtPct = (n: number | null | undefined, digits = 0): string =>
  n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;

/** Signed percent change, or null when there is no baseline to compare with. */
export const pctChange = (current: number, previous: number): number | null => {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
};

export const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

/** "Oct 16" from a UTC day key, rendered in UTC so the label matches the bucket. */
export const fmtDay = (dayKey: string): string => {
  const d = new Date(`${dayKey}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? dayKey : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

// ─── CSV ──────────────────────────────────────────────────────────────────────────────────

export type CsvCell = string | number | boolean | null | undefined;

const escapeCell = (cell: CsvCell): string => {
  if (cell === null || cell === undefined) return '';
  let text = typeof cell === 'number' ? (Number.isFinite(cell) ? String(cell) : '') : String(cell);
  // Spreadsheet formula-injection guard: data (emails, model ids) never executes on open.
  if (typeof cell === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export const toCsv = (header: string[], rows: CsvCell[][]): string =>
  [header, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n');

/** Save a CSV in the browser. Best-effort (no-op where Blob URLs aren't available). */
export const downloadCsv = (filename: string, csv: string): void => {
  try {
    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    /* non-browser environment */
  }
};
