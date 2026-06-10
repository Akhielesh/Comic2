import React, { useMemo, useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, Search, Copy, Check, BarChart3 } from 'lucide-react';

// react-markdown hands component renderers the underlying hast `node`. We pull the
// table's headers and rows out of it so we can render an interactive data grid —
// column sort, free-text filter, numeric-aware alignment + in-cell magnitude bars,
// CSV copy, and pagination — instead of a static table. Inline emphasis is flattened
// to text for sort/search; links are preserved for display.
//
// Styled as a macOS list view: rounded hairline container, sticky hairline header,
// tabular-nums right-aligned numbers, hover row tint, hairline dividers (no zebra).

interface Cell {
  text: string;
  href?: string;
}

const nodeText = (node: any): string => {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (Array.isArray(node.children)) return node.children.map(nodeText).join('');
  return '';
};

const findHref = (node: any): string | undefined => {
  if (!node || typeof node !== 'object') return undefined;
  if (node.tagName === 'a' && node.properties?.href) return String(node.properties.href);
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      const h = findHref(c);
      if (h) return h;
    }
  }
  return undefined;
};

const childElements = (node: any, tag: string): any[] =>
  Array.isArray(node?.children) ? node.children.filter((c: any) => c.tagName === tag) : [];

const extractTable = (node: any): { headers: string[]; rows: Cell[][] } => {
  const thead = childElements(node, 'thead')[0];
  const tbody = childElements(node, 'tbody')[0];
  const headerRow = thead ? childElements(thead, 'tr')[0] : undefined;
  const headers = headerRow ? childElements(headerRow, 'th').map(nodeText) : [];
  const rows = (tbody ? childElements(tbody, 'tr') : []).map((tr: any) =>
    childElements(tr, 'td').map((td: any): Cell => ({ text: nodeText(td).trim(), href: findHref(td) }))
  );
  return { headers, rows };
};

// Numeric-aware comparison: pull a leading number (handles "$1,234", "12%", "-3.4").
const asNumber = (s: string): number | null => {
  const m = s.replace(/[$,%\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const compare = (a: string, b: string): number => {
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

const DEFAULT_VISIBLE = 12;

export const MarkdownTable: React.FC<{ node?: any; children?: React.ReactNode }> = ({ node, children }) => {
  const { headers, rows } = useMemo(() => extractTable(node), [node]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showBars, setShowBars] = useState(true);
  const [copied, setCopied] = useState(false);

  // Per-column numeric profile: a column is "numeric" if most non-empty cells parse
  // as numbers; we keep min/max to scale in-cell magnitude bars.
  const colStats = useMemo(() => {
    return headers.map((_, ci) => {
      let numeric = 0;
      let total = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const r of rows) {
        const txt = r[ci]?.text ?? '';
        if (!txt) continue;
        total++;
        const n = asNumber(txt);
        if (n !== null) {
          numeric++;
          if (n < min) min = n;
          if (n > max) max = n;
        }
      }
      const isNumeric = total > 0 && numeric / total >= 0.6;
      return { isNumeric, min, max: max === min ? min + 1 : max };
    });
  }, [headers, rows]);

  const hasNumericCol = colStats.some((s) => s.isNumeric);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? rows.filter((r) => r.some((c) => c.text.toLowerCase().includes(q))) : rows;
    if (!sort) return base;
    const sorted = [...base].sort((ra, rb) => compare(ra[sort.col]?.text || '', rb[sort.col]?.text || ''));
    return sort.dir === 'desc' ? sorted.reverse() : sorted;
  }, [rows, query, sort]);

  const visible = showAll ? filtered : filtered.slice(0, DEFAULT_VISIBLE);

  // Fall back to the default-rendered table if extraction yielded nothing usable.
  if (!headers.length || !rows.length) {
    return <table>{children}</table>;
  }

  const toggleSort = (col: number) =>
    setSort((prev) => (prev?.col === col ? (prev.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' }));

  const copyCsv = async () => {
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const csv = [headers.map(esc).join(','), ...filtered.map((r) => headers.map((_, ci) => esc(r[ci]?.text ?? '')).join(','))].join('\n');
    try {
      await navigator.clipboard.writeText(csv);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be blocked; no-op */
    }
  };

  const showSearch = rows.length > 5;

  return (
    <div className="my-2 not-prose">
      {(showSearch || hasNumericCol) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          {showSearch && (
            <div className="relative max-w-xs flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#9b968c]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Filter ${rows.length} rows…`}
                className="w-full rounded-lg border border-black/10 bg-white/80 py-1 pl-7 pr-2 text-xs text-[#1a1915] placeholder:text-[#9b968c] transition-colors duration-200 focus:border-black/20 focus:outline-none focus:ring-2 focus:ring-black/5"
              />
            </div>
          )}
          <span className="text-[11px] tabular-nums text-[#6e6a60]">
            {query ? `${filtered.length} of ${rows.length}` : `${rows.length} rows`}
          </span>
          <div className="ml-auto flex items-center gap-1">
            {hasNumericCol && (
              <button
                onClick={() => setShowBars((v) => !v)}
                aria-pressed={showBars}
                title="Toggle magnitude bars"
                className={`flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold transition-colors duration-200 ${
                  showBars
                    ? 'border-black/20 bg-black/[0.06] text-[#1a1915]'
                    : 'border-black/10 text-[#6e6a60] hover:bg-black/[0.03] hover:text-[#1a1915]'
                }`}
              >
                <BarChart3 className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={copyCsv}
              title="Copy as CSV"
              className="flex items-center gap-1 rounded-md border border-black/10 px-1.5 py-0.5 text-[11px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:bg-black/[0.03] hover:text-[#1a1915]"
            >
              {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
              {copied ? 'Copied' : 'CSV'}
            </button>
          </div>
        </div>
      )}

      <div className="max-h-[420px] overflow-auto rounded-xl border border-black/10 bg-white/85 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              {headers.map((h, i) => {
                const active = sort?.col === i;
                const Icon = !active ? ArrowUpDown : sort!.dir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th key={i} className="border-b border-black/10 bg-white/95 p-0 backdrop-blur-sm">
                    <button
                      onClick={() => toggleSort(i)}
                      className={`flex w-full items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wider transition-colors duration-200 ${
                        active ? 'text-[#1a1915]' : 'text-[#6e6a60] hover:text-[#1a1915]'
                      } ${colStats[i].isNumeric ? 'justify-end text-right' : 'text-left'}`}
                      title="Sort"
                    >
                      <span className="truncate">{h}</span>
                      <Icon className={`h-3 w-3 shrink-0 ${active ? 'text-[#1a1915]' : 'text-black/30'}`} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, ri) => (
              <tr key={ri} className="border-b border-black/5 transition-colors duration-200 last:border-0 hover:bg-black/[0.03]">
                {headers.map((_, ci) => {
                  const cell = row[ci];
                  const stat = colStats[ci];
                  const n = stat.isNumeric ? asNumber(cell?.text ?? '') : null;
                  const pct = n !== null ? Math.max(0, Math.min(1, (n - stat.min) / (stat.max - stat.min))) : 0;
                  return (
                    <td
                      key={ci}
                      className={`relative px-2.5 py-1.5 align-top ${
                        stat.isNumeric ? 'text-right font-medium tabular-nums text-[#1a1915]' : 'text-[#3c3a33]'
                      }`}
                    >
                      {showBars && n !== null && (
                        <span
                          className="pointer-events-none absolute inset-y-1 left-1 rounded-sm bg-blue-500/10"
                          style={{ width: `calc(${pct * 100}% - 4px)` }}
                          aria-hidden
                        />
                      )}
                      <span className="relative">
                        {cell?.href ? (
                          <a href={cell.href} target="_blank" rel="noopener noreferrer" className="text-blue-600 transition-colors duration-200 hover:underline">
                            {cell.text}
                          </a>
                        ) : (
                          cell?.text ?? ''
                        )}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length > DEFAULT_VISIBLE && (
        <button
          onClick={() => setShowAll((v) => !v)}
          className="mt-1.5 w-full rounded-lg border border-black/10 bg-black/[0.02] py-1 text-[11px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:bg-black/[0.05] hover:text-[#1a1915]"
        >
          {showAll ? 'Show less' : `Show all ${filtered.length} rows`}
        </button>
      )}
    </div>
  );
};
