import React from 'react';
import { Newspaper } from 'lucide-react';
import type { FinanceTerminalArtifact } from '../../../apiTypes';
import { MarketCard } from './MarketCard';
import { MetricBoard } from './MetricBoard';
import { DataTableCard } from './DataTableCard';
import { HeatmapCard } from './HeatmapCard';
import { ChartCard } from './ChartCard';
import { relativeTime } from './kit';

// The FLAGSHIP composite artifact — a Bloomberg-style terminal panel. It assembles
// whichever sections the model provides (focus quote, KPI ribbon, watchlist table,
// sector heatmap, supporting charts, news rail) into one framed dashboard. Every
// section reuses an existing artifact component, so the terminal stays consistent
// with the rest of the chat UI and adds no new rendering primitives.

const MARKET_STATE: Record<string, { label: string; dot: string }> = {
  open: { label: 'Market open', dot: '#34d399' },
  closed: { label: 'Market closed', dot: '#94a3b8' },
  pre: { label: 'Pre-market', dot: '#fbbf24' },
  after: { label: 'After hours', dot: '#a78bfa' }
};

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <section>
    <div className="mb-1.5 flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</span>
      <span className="h-px flex-1 bg-black/10" />
    </div>
    {children}
  </section>
);

export const FinanceTerminal: React.FC<{ data: FinanceTerminalArtifact }> = ({ data }) => {
  const charts = data.charts ?? [];
  const news = data.news ?? [];
  const hasBody =
    data.focus || data.metrics || data.table || data.heatmap || charts.length > 0 || news.length > 0;
  if (!hasBody) return null;

  // Honest status: prefer the focus instrument's real session state; else the as-of
  // date; else just "Snapshot" — never a blanket "Live" claim.
  const state = data.focus?.marketState ? MARKET_STATE[data.focus.marketState] : null;
  const status = state?.label ?? (data.asOf ? `As of ${data.asOf}` : 'Snapshot');

  return (
    <div className="my-2 overflow-hidden rounded-xl border-2 border-black bg-slate-100 shadow-comic animate-fade-in">
      <div className="flex items-center justify-between gap-2 border-b-2 border-black bg-slate-900 px-3 py-2 text-white">
        <div className="min-w-0">
          <div className="truncate text-sm font-extrabold tracking-tight">{data.title || 'Finance Terminal'}</div>
          {data.subtitle && <div className="truncate text-[11px] font-semibold text-slate-400">{data.subtitle}</div>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider">
          {state && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: state.dot }} />}
          {status}
        </div>
      </div>

      <div className="space-y-3 p-3">
        {data.metrics && (
          <Section label="Overview">
            <MetricBoard data={data.metrics} embedded />
          </Section>
        )}

        {data.focus && (
          <Section label="Focus">
            <MarketCard data={data.focus} embedded />
          </Section>
        )}

        {data.table && (
          <Section label="Watchlist">
            <DataTableCard data={data.table} embedded />
          </Section>
        )}

        {data.heatmap && (
          <Section label="Market map">
            <HeatmapCard data={data.heatmap} embedded />
          </Section>
        )}

        {charts.length > 0 && (
          <Section label="Analysis">
            <div className={charts.length > 1 ? 'grid gap-2 md:grid-cols-2' : 'space-y-2'}>
              {charts.map((c, i) => <ChartCard key={i} data={c} embedded />)}
            </div>
          </Section>
        )}

        {news.length > 0 && (
          <Section label="News">
            <div className="overflow-hidden rounded-lg border border-black/10 bg-white">
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
          </Section>
        )}
      </div>
    </div>
  );
};
