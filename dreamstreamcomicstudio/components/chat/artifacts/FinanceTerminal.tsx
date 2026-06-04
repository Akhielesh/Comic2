import React from 'react';
import { Newspaper } from 'lucide-react';
import type { FinanceTerminalArtifact } from '../../../apiTypes';
import { MarketCard } from './MarketCard';
import { MetricBoard } from './MetricBoard';
import { DataTableCard } from './DataTableCard';
import { HeatmapCard } from './HeatmapCard';
import { ChartCard } from './ChartCard';
import { resolveTheme, relativeTime } from './kit';
import type { PaletteName } from './kit';

// The FLAGSHIP composite artifact — a Bloomberg-style terminal panel. It assembles
// whichever sections the model provides (focus quote, KPI ribbon, watchlist table,
// sector heatmap, supporting charts, news rail) into one framed dashboard. Every
// section reuses an existing artifact component, so the terminal stays consistent
// with the rest of the chat UI and adds no new rendering primitives.

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-1 mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-400">{children}</div>
);

export const FinanceTerminal: React.FC<{ data: FinanceTerminalArtifact }> = ({ data }) => {
  const theme = resolveTheme({ palette: (data.palette as PaletteName) || 'mono' });
  const charts = data.charts ?? [];
  const news = data.news ?? [];
  const hasBody =
    data.focus || data.metrics || data.table || data.heatmap || charts.length > 0 || news.length > 0;
  if (!hasBody) return null;

  return (
    <div className="my-2 overflow-hidden rounded-xl border-2 border-black bg-slate-50 shadow-comic animate-fade-in">
      <div className="h-1.5" style={{ backgroundColor: theme.accent }} />
      <div className="flex items-center justify-between gap-2 border-b-2 border-black/10 bg-white px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-extrabold tracking-tight">{data.title || 'Finance Terminal'}</div>
          {data.subtitle && <div className="truncate text-[11px] font-semibold text-slate-500">{data.subtitle}</div>}
        </div>
        <div className="shrink-0 rounded-full border-2 border-black/10 bg-slate-900 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
          {data.asOf ? `As of ${data.asOf}` : 'Live'}
        </div>
      </div>

      <div className="space-y-2 p-2.5">
        {data.metrics && (
          <div>
            <SectionLabel>Overview</SectionLabel>
            <MetricBoard data={data.metrics} />
          </div>
        )}

        {data.focus && (
          <div>
            <SectionLabel>Focus</SectionLabel>
            <MarketCard data={data.focus} />
          </div>
        )}

        {data.table && (
          <div>
            <SectionLabel>Watchlist</SectionLabel>
            <DataTableCard data={data.table} />
          </div>
        )}

        {data.heatmap && (
          <div>
            <SectionLabel>Market map</SectionLabel>
            <HeatmapCard data={data.heatmap} />
          </div>
        )}

        {charts.length > 0 && (
          <div>
            <SectionLabel>Analysis</SectionLabel>
            <div className={charts.length > 1 ? 'grid gap-2 md:grid-cols-2' : ''}>
              {charts.map((c, i) => <ChartCard key={i} data={c} />)}
            </div>
          </div>
        )}

        {news.length > 0 && (
          <div>
            <SectionLabel>News</SectionLabel>
            <div className="rounded-xl border-2 border-black bg-white shadow-comic">
              {news.slice(0, 6).map((n, i) => {
                const inner = (
                  <>
                    <Newspaper className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-bold text-slate-800 group-hover:text-blue-600">{n.title}</div>
                      {(n.source || n.publishedAt) && (
                        <div className="text-[10px] font-medium text-slate-400">
                          {n.source}
                          {n.source && n.publishedAt ? ' · ' : ''}
                          {n.publishedAt ? relativeTime(n.publishedAt) : ''}
                        </div>
                      )}
                    </div>
                  </>
                );
                return n.url ? (
                  <a key={i} href={n.url} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-2 border-b border-black/5 px-3 py-2 last:border-0 hover:bg-slate-50">
                    {inner}
                  </a>
                ) : (
                  <div key={i} className="group flex items-start gap-2 border-b border-black/5 px-3 py-2 last:border-0">{inner}</div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
