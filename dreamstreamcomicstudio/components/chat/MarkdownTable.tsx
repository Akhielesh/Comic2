import React, { useMemo, useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, Search } from 'lucide-react';

// react-markdown hands component renderers the underlying hast `node`. We pull the
// table's headers and rows out of it so we can render an interactive table (column
// sort + free-text filter) instead of a static one. Inline emphasis is flattened to
// text for sort/search, but links are preserved for display — which covers the data
// tables models actually produce.

interface Cell {
  text: string;
  href?: string;
}

// Recursively collect visible text from a hast node.
const nodeText = (node: any): string => {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (Array.isArray(node.children)) return node.children.map(nodeText).join('');
  return '';
};

// Find the first descendant <a href> in a hast node.
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

export const MarkdownTable: React.FC<{ node?: any; children?: React.ReactNode }> = ({ node, children }) => {
  const { headers, rows } = useMemo(() => extractTable(node), [node]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q ? rows.filter((r) => r.some((c) => c.text.toLowerCase().includes(q))) : rows;
    if (!sort) return base;
    const sorted = [...base].sort((ra, rb) => compare(ra[sort.col]?.text || '', rb[sort.col]?.text || ''));
    return sort.dir === 'desc' ? sorted.reverse() : sorted;
  }, [rows, query, sort]);

  // Fall back to the default-rendered table if extraction yielded nothing usable.
  if (!headers.length || !rows.length) {
    return <table>{children}</table>;
  }

  const toggleSort = (col: number) =>
    setSort((prev) =>
      prev?.col === col ? (prev.dir === 'asc' ? { col, dir: 'desc' } : null) : { col, dir: 'asc' }
    );

  const showSearch = rows.length > 5;

  return (
    <div className="my-2 not-prose">
      {showSearch && (
        <div className="flex items-center gap-2 mb-1.5">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Filter ${rows.length} rows…`}
              className="w-full pl-7 pr-2 py-1 text-xs border-2 border-black rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-blue/40"
            />
          </div>
          {query && <span className="text-[11px] text-slate-500">{filtered.length} match{filtered.length === 1 ? '' : 'es'}</span>}
        </div>
      )}
      <div className="overflow-x-auto border-2 border-black rounded-lg">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="bg-slate-100">
              {headers.map((h, i) => {
                const active = sort?.col === i;
                const Icon = !active ? ArrowUpDown : sort!.dir === 'asc' ? ArrowUp : ArrowDown;
                return (
                  <th key={i} className="text-left p-0 border-b-2 border-black">
                    <button
                      onClick={() => toggleSort(i)}
                      className="w-full flex items-center gap-1 px-2.5 py-1.5 font-bold hover:bg-slate-200 transition-colors"
                      title="Sort"
                    >
                      <span className="truncate">{h}</span>
                      <Icon className={`w-3 h-3 shrink-0 ${active ? 'text-brand-blue' : 'text-slate-400'}`} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, ri) => (
              <tr key={ri} className="odd:bg-white even:bg-slate-50/60 hover:bg-brand-yellow/20">
                {row.map((cell, ci) => (
                  <td key={ci} className="px-2.5 py-1.5 border-b border-slate-200 align-top">
                    {cell.href ? (
                      <a href={cell.href} target="_blank" rel="noopener noreferrer" className="text-brand-blue underline">
                        {cell.text}
                      </a>
                    ) : (
                      cell.text
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
