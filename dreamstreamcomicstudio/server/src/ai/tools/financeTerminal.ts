// Finance Terminal tools — the dataviz/finance power-pack the markets agent uses to
// assemble a full terminal in chat:
//   • render_table          — a typed, sortable data table from model-provided rows
//   • render_heatmap         — a green→red market/sector heatmap
//   • build_finance_terminal — fetches LIVE quotes and assembles a composite terminal
//                              (focus quote + KPI ribbon + watchlist + heatmap + news)
//
// render_table / render_heatmap are pure (no network): they validate + normalize the
// structure into an artifact the client draws. build_finance_terminal is the only one
// that hits the network, and it degrades gracefully per-symbol.

import type { ChatTool, ToolExecResult } from './types.js';
import { getStockQuote, getLightQuote, type LightQuote } from './stocks.js';
import type {
  DataTableArtifact,
  DataTableColumn,
  DataTableRowCell,
  HeatmapArtifact,
  HeatmapCell,
  FinanceTerminalArtifact,
  MetricBoardArtifact,
  StockQuoteArtifact
} from '../../../../apiTypes.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const numOr = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const compact = (n?: number): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};
const pct = (n?: number): string => (typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—');

// ----------------------------------------------------------------- render_table -----

const COLUMN_KINDS = ['text', 'number', 'currency', 'percent', 'delta', 'deltaPercent', 'spark', 'badge'];

const normalizeColumns = (raw: unknown[]): DataTableColumn[] =>
  raw
    .map((c): DataTableColumn | null => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      const label = str(o.label);
      if (!label) return null;
      const kind = COLUMN_KINDS.includes(String(o.kind)) ? (o.kind as DataTableColumn['kind']) : 'text';
      const align = ['left', 'right', 'center'].includes(String(o.align)) ? (o.align as DataTableColumn['align']) : undefined;
      return { label, kind, align, currency: str(o.currency), sortable: typeof o.sortable === 'boolean' ? o.sortable : undefined };
    })
    .filter((c): c is DataTableColumn => c !== null)
    .slice(0, 12);

const normalizeCell = (raw: unknown): DataTableRowCell => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' || typeof raw === 'string') return raw;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const spark = arr(o.spark).map(Number).filter((n) => Number.isFinite(n));
    return {
      value: typeof o.value === 'number' || typeof o.value === 'string' ? (o.value as string | number) : o.value == null ? null : String(o.value),
      spark: spark.length ? spark : undefined,
      color: str(o.color),
      sub: str(o.sub),
      href: str(o.href),
      currency: str(o.currency)
    };
  }
  return String(raw);
};

const tableTool: ChatTool = {
  name: 'render_table',
  description:
    'Render a polished, SORTABLE table from data you have ALREADY gathered (from another tool this turn) or that the user explicitly provided — for comparisons, schedules, fundamentals grids, screeners, lists. Each column declares how its cells render: text, number, currency, percent, delta (signed +/- green/red), deltaPercent (signed % green/red), spark (inline sparkline from an array of numbers), or badge (a colored chip). Rows are arrays of cells aligned to the columns; a cell is a bare value OR an object {value, spark, color, sub, href}. CRITICAL: this tool does NOT fetch anything — it only draws the numbers you pass. NEVER type in stock/crypto prices, %s, market caps or any live market figure from memory; those MUST come from get_stock / crypto_price / build_finance_terminal first (build_finance_terminal already produces the watchlist table for you). A clean table of invented numbers is worse than no table. Keep prose brief.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      caption: { type: 'string', description: 'Footnote under the table (source, as-of, methodology).' },
      palette: { type: 'string', enum: ['brand', 'ocean', 'sunset', 'violet', 'bull', 'bear', 'mono'] },
      columns: {
        type: 'array',
        description: 'Column definitions in display order.',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            kind: { type: 'string', enum: COLUMN_KINDS, description: 'How cells render. Default "text".' },
            align: { type: 'string', enum: ['left', 'right', 'center'] },
            currency: { type: 'string', description: 'ISO currency for "currency" cells, e.g. "USD".' },
            sortable: { type: 'boolean' }
          },
          required: ['label']
        }
      },
      rows: {
        type: 'array',
        description: 'Each row is an ARRAY of cells aligned to columns. A cell is a value (string/number) or an object {value, spark:[numbers], color:"#hex", sub:"second line", href:"url"}.',
        items: {
          type: 'array',
          // A cell is a primitive value OR a rich object. An explicit union keeps the
          // schema valid for strict function-calling models (an empty `items: {}` schema
          // makes some providers reject the whole call).
          items: {
            anyOf: [
              { type: 'string' },
              { type: 'number' },
              { type: 'boolean' },
              { type: 'null' },
              {
                type: 'object',
                properties: {
                  value: { type: ['string', 'number', 'boolean', 'null'] },
                  spark: { type: 'array', items: { type: 'number' } },
                  color: { type: 'string' },
                  sub: { type: 'string' },
                  href: { type: 'string' }
                }
              }
            ]
          }
        }
      },
      sort: {
        type: 'object',
        properties: { column: { type: 'number', description: '0-based column index to sort by.' }, dir: { type: 'string', enum: ['asc', 'desc'] } }
      }
    },
    required: ['columns', 'rows']
  },
  execute: async (args): Promise<ToolExecResult> => {
    const columns = normalizeColumns(arr(args.columns));
    if (!columns.length) return { content: 'No usable columns were provided for the table (each needs a label).' };
    const rows = arr(args.rows)
      .map((r) => arr(r).map(normalizeCell))
      .filter((r) => r.length > 0)
      .slice(0, 200);
    if (!rows.length) return { content: 'No usable rows were provided for the table.' };
    const sortRaw = args.sort && typeof args.sort === 'object' ? (args.sort as Record<string, unknown>) : undefined;
    const sort =
      sortRaw && typeof sortRaw.column === 'number' && sortRaw.column >= 0 && sortRaw.column < columns.length
        ? { column: Math.round(sortRaw.column), dir: sortRaw.dir === 'asc' ? ('asc' as const) : ('desc' as const) }
        : undefined;
    const data: DataTableArtifact = {
      title: str(args.title),
      subtitle: str(args.subtitle),
      caption: str(args.caption),
      palette: str(args.palette),
      columns,
      rows,
      sort
    };
    return {
      content: `Rendered a ${rows.length}-row table${data.title ? ` ("${data.title}")` : ''} with ${columns.length} columns. A sortable table is shown to the user.`,
      artifacts: [{ type: 'data_table', data }]
    };
  }
};

// --------------------------------------------------------------- render_heatmap -----

const normalizeHeatCells = (raw: unknown[]): HeatmapCell[] =>
  raw
    .map((c): HeatmapCell | null => {
      const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
      const label = str(o.label);
      if (!label) return null;
      return { label, value: numOr(o.value), sub: str(o.sub), weight: numOr(o.weight), href: str(o.href) };
    })
    .filter((c): c is HeatmapCell => c !== null)
    .slice(0, 64);

const heatmapTool: ChatTool = {
  name: 'render_heatmap',
  description:
    'Render a market HEATMAP — a grid of tiles colored green→red by their value (a change %, by default) — from data you have ALREADY fetched. Use it to show breadth at a glance: a sector map, an index\'s movers, a watchlist\'s day. Provide either flat `cells` or `groups` (e.g. one group per sector), each cell = {label, value (the % that colors it), sub (price/cap), weight (optional, sizes the tile by e.g. market cap)}. CRITICAL: this tool does NOT fetch anything. NEVER invent the change %s — they MUST come from real quotes (get_stock / build_finance_terminal, which already builds a movers heatmap for you). Keep prose brief.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      subtitle: { type: 'string' },
      unit: { type: 'string', description: 'Value unit shown on tiles (default "%").' },
      caption: { type: 'string' },
      cells: {
        type: 'array',
        description: 'Flat tiles (use this OR groups).',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'number', description: 'Drives the color (a change %).' },
            sub: { type: 'string' },
            weight: { type: 'number', description: 'Relative tile size, e.g. market cap.' }
          },
          required: ['label']
        }
      },
      groups: {
        type: 'array',
        description: 'Grouped tiles, e.g. one group per sector.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            cells: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'number' }, sub: { type: 'string' }, weight: { type: 'number' } }, required: ['label'] } }
          },
          required: ['cells']
        }
      }
    }
  },
  execute: async (args): Promise<ToolExecResult> => {
    const rawGroups = arr(args.groups)
      .map((g): { name?: string; cells: HeatmapCell[] } | null => {
        const o = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
        const cells = normalizeHeatCells(arr(o.cells));
        return cells.length ? { name: str(o.name), cells } : null;
      })
      .filter((g): g is { name?: string; cells: HeatmapCell[] } => g !== null)
      .slice(0, 16);
    const flatCells = normalizeHeatCells(arr(args.cells));
    if (!rawGroups.length && !flatCells.length) return { content: 'No usable tiles were provided for the heatmap (each needs a label).' };
    const data: HeatmapArtifact = {
      title: str(args.title),
      subtitle: str(args.subtitle),
      unit: str(args.unit),
      caption: str(args.caption),
      groups: rawGroups.length ? rawGroups : undefined,
      cells: rawGroups.length ? undefined : flatCells
    };
    const n = rawGroups.length ? rawGroups.reduce((a, g) => a + g.cells.length, 0) : flatCells.length;
    return { content: `Rendered a heatmap with ${n} tiles. A market map is shown to the user.`, artifacts: [{ type: 'market_heatmap', data }] };
  }
};

// ----------------------------------------------------- build_finance_terminal -----

const lightRow = (q: LightQuote): DataTableRowCell[] => [
  { value: q.symbol, color: q.changePercent >= 0 ? '#059669' : '#dc2626' },
  { value: q.name || q.symbol },
  { value: q.price, currency: q.currency },
  q.changePercent,
  { spark: q.spark }
];

const buildTerminalTool: ChatTool = {
  name: 'build_finance_terminal',
  description:
    'Assemble a LIVE finance terminal panel in one call: a focus quote, an index/KPI ribbon, a watchlist table, a sector/market heatmap and a news rail — all from REAL, freshly-fetched quotes (this is the source of truth for any market figures; never type prices yourself). Use whenever the user wants a market dashboard, overview, "terminal", watchlist, or to track several tickers at once. Pass `focus` (one ticker for the featured chart), `symbols` (the watchlist), and optionally `indices` (e.g. ["^GSPC","^IXIC","^DJI"]). ONLY use the tickers the user actually named or that are clearly implied — do NOT pad the list with default/example stocks (Apple, Tesla, Microsoft, …) the user didn\'t ask about. If the user wants a dashboard but named no tickers, ask which ones first. The composite carries the numbers — add a short, insightful read of breadth, leaders/laggards and what\'s notable.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Panel title, e.g. "Tech watchlist" or "Markets today".' },
      subtitle: { type: 'string' },
      focus: { type: 'string', description: 'Ticker for the featured rich quote/chart, e.g. "AAPL", "BTC-USD", "^GSPC".' },
      symbols: { type: 'array', items: { type: 'string' }, description: 'Watchlist tickers for the table + heatmap.' },
      indices: { type: 'array', items: { type: 'string' }, description: 'Index/benchmark tickers for the KPI ribbon, e.g. ["^GSPC","^IXIC","^DJI","^VIX"].' }
    }
  },
  execute: async (args, signal): Promise<ToolExecResult> => {
    const focusSym = str(args.focus);
    const symbols = arr(args.symbols).map((s) => String(s).trim()).filter(Boolean).slice(0, 16);
    const indices = arr(args.indices).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
    if (!focusSym && !symbols.length && !indices.length) {
      return { content: 'Provide a focus ticker and/or a list of symbols to build a terminal.' };
    }

    // Focus quote (full enrichment) + watchlist & indices (light) — all in parallel.
    const [focusR, watchR, idxR] = await Promise.all([
      focusSym ? getStockQuote(focusSym, signal).catch(() => undefined) : Promise.resolve(undefined),
      symbols.length ? Promise.allSettled(symbols.map((s) => getLightQuote(s, signal))) : Promise.resolve([]),
      indices.length ? Promise.allSettled(indices.map((s) => getLightQuote(s, signal))) : Promise.resolve([])
    ]);

    const focus = focusR as StockQuoteArtifact | undefined;
    const watchSettled = watchR as PromiseSettledResult<LightQuote>[];
    const idxSettled = idxR as PromiseSettledResult<LightQuote>[];
    const watch = watchSettled
      .filter((r): r is PromiseFulfilledResult<LightQuote> => r.status === 'fulfilled')
      .map((r) => r.value);
    const idx = idxSettled
      .filter((r): r is PromiseFulfilledResult<LightQuote> => r.status === 'fulfilled')
      .map((r) => r.value);
    // Be honest about what couldn't be fetched, so the model reports gaps instead of
    // silently filling them in from memory.
    const failed = [
      ...(focusSym && !focus ? [focusSym] : []),
      ...symbols.filter((_, i) => watchSettled[i]?.status === 'rejected'),
      ...indices.filter((_, i) => idxSettled[i]?.status === 'rejected')
    ];

    if (!focus && !watch.length && !idx.length) {
      return { content: `Couldn't fetch live quotes for ${[focusSym, ...symbols, ...indices].filter(Boolean).join(', ')}. The market data sources may be temporarily unavailable.`, notice: { level: 'warn', message: 'No live market data could be fetched for the terminal.' } };
    }

    // KPI ribbon from indices.
    const metrics: MetricBoardArtifact | undefined = idx.length
      ? {
          columns: Math.min(4, idx.length) as 1 | 2 | 3 | 4,
          tiles: idx.map((q) => ({
            label: q.name || q.symbol,
            value: q.price >= 1000 ? Math.round(q.price).toLocaleString() : q.price.toFixed(2),
            deltaPercent: q.changePercent,
            delta: q.change,
            status: q.changePercent > 0 ? ('good' as const) : q.changePercent < 0 ? ('bad' as const) : ('neutral' as const),
            spark: q.spark
          }))
        }
      : undefined;

    // Watchlist table.
    const table: DataTableArtifact | undefined = watch.length
      ? {
          title: 'Watchlist',
          palette: 'ocean',
          sort: { column: 3, dir: 'desc' },
          columns: [
            { label: 'Symbol', kind: 'badge' },
            { label: 'Name', kind: 'text' },
            { label: 'Price', kind: 'currency' },
            { label: 'Chg %', kind: 'deltaPercent' },
            { label: 'Trend', kind: 'spark' }
          ],
          rows: watch.map(lightRow)
        }
      : undefined;

    // Heatmap from the watchlist's day.
    const heatmap: HeatmapArtifact | undefined = watch.length
      ? {
          title: 'Movers',
          unit: '%',
          cells: watch.map((q) => ({ label: q.symbol, value: q.changePercent, sub: typeof q.price === 'number' ? q.price.toFixed(2) : undefined }))
        }
      : undefined;

    const news = focus?.headlines?.slice(0, 6).map((h) => ({ title: h.title, url: h.url, source: h.source, publishedAt: h.publishedAt }));

    const data: FinanceTerminalArtifact = {
      title: str(args.title) || (focus ? `${focus.name || focus.symbol} terminal` : 'Markets terminal'),
      subtitle: str(args.subtitle),
      asOf: focus?.asOf,
      palette: 'mono',
      focus,
      metrics,
      table,
      heatmap,
      news
    };

    // Compact text summary for the model to reason over (it should add the READ).
    const lines: string[] = [];
    if (focus) lines.push(`Focus ${focus.symbol}: ${focus.price.toFixed(2)} ${pct(focus.changePercent)}.`);
    if (idx.length) lines.push(`Indices — ${idx.map((q) => `${q.name || q.symbol} ${pct(q.changePercent)}`).join(', ')}.`);
    if (watch.length) {
      const sorted = [...watch].sort((a, b) => b.changePercent - a.changePercent);
      const top = sorted[0];
      const bottom = sorted[sorted.length - 1];
      const up = watch.filter((q) => q.changePercent > 0).length;
      lines.push(`Watchlist (${watch.length}): ${up} up / ${watch.length - up} down. Leader ${top.symbol} ${pct(top.changePercent)}, laggard ${bottom.symbol} ${pct(bottom.changePercent)}.`);
    }
    if (failed.length) lines.push(`NOTE: no live quote could be fetched for ${failed.join(', ')} — these are OMITTED from the panel. Tell the user they couldn't be retrieved; do NOT fill in prices for them from memory.`);
    lines.push('A live finance terminal panel is shown to the user. Add a brief, insightful read of breadth, leaders/laggards and anything notable — do not just restate these numbers, and never add figures that are not in the panel above.');

    return {
      content: lines.join(' '),
      artifacts: [{ type: 'finance_terminal', data }],
      citations: focus?.headlines?.slice(0, 3).map((h) => ({ url: h.url, title: h.title })),
      ...(failed.length ? { notice: { level: 'warn' as const, message: `Couldn't fetch live quotes for ${failed.join(', ')}; they were left out of the terminal.` } } : {})
    };
  }
};

export const FINANCE_TERMINAL_TOOLS: ChatTool[] = [tableTool, heatmapTool, buildTerminalTool];
