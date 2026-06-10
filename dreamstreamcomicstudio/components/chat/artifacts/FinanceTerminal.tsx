import React from 'react';
import { Newspaper } from 'lucide-react';
import type { FinanceTerminalArtifact } from '../../../apiTypes';
import { MarketCard } from './MarketCard';
import { MetricBoard } from './MetricBoard';
import { DataTableCard } from './DataTableCard';
import { HeatmapCard } from './HeatmapCard';
import { ChartCard } from './ChartCard';
import { Surface, SurfaceTitle, SurfaceSubtitle, TrendPill, resolveTheme, relativeTime, formatPrice, useCompact } from './kit';
import type { PaletteName } from './kit';

// The FLAGSHIP composite artifact — a Bloomberg-style terminal panel in the calm
// studio glass language. It assembles whichever sections the model provides (focus
// quote, KPI ribbon, watchlist table, sector heatmap, supporting charts, news rail)
// into one framed dashboard. Every section reuses an existing artifact component,
// so the terminal stays consistent with the rest of the chat UI.
//
// Two densities: compact distills the terminal to the focus quote + a few key
// metrics in one row; detailed renders every section in full.

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-1 mt-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">{children}</div>
);

export const FinanceTerminal: React.FC<{ data: FinanceTerminalArtifact }> = ({ data }) => {
  const compact = useCompact();
  const theme = resolveTheme({ palette: (data.palette as PaletteName) || 'mono' });
  const charts = data.charts ?? [];
  const news = data.news ?? [];
  const hasBody =
    data.focus || data.metrics || data.table || data.heatmap || charts.length > 0 || news.length > 0;
  if (!hasBody) return null;

  // ── Compact: the focus quote + 2–3 key metrics in one hairline-divided row. ──
  if (compact) {
    const focus = data.focus;
    const tiles = (data.metrics?.tiles ?? []).filter((t) => !t.chart).slice(0, 3);
    return (
      <Surface
        accent={theme.accent}
        header={
          <>
            <SurfaceTitle>{data.title || 'Finance Terminal'}</SurfaceTitle>
            {(data.subtitle || data.asOf) && (
              <SurfaceSubtitle>
                {data.subtitle}
                {data.subtitle && data.asOf ? ' · ' : ''}
                {data.asOf ? `As of ${data.asOf}` : ''}
              </SurfaceSubtitle>
            )}
          </>
        }
        right={
          focus ? (
            <>
              <div className="text-[11px] font-semibold text-[#6e6a60]">{focus.symbol}</div>
              <div className="text-lg font-semibold tracking-tight tabular-nums leading-none text-[#1a1915]">
                {formatPrice(focus.price, focus.currency ?? 'USD')}
              </div>
              <div className="mt-1 flex justify-end">
                <TrendPill change={focus.change} changePercent={focus.changePercent} size="sm" />
              </div>
            </>
          ) : undefined
        }
      >
        {tiles.length > 0 && (
          <div className="flex divide-x divide-black/5 px-1 pb-2.5">
            {tiles.map((tile, i) => (
              <div key={i} className="min-w-0 flex-1 px-2.5">
                <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">{tile.label}</div>
                <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-[#1a1915]">
                  {typeof tile.value === 'number' ? tile.value.toLocaleString() : tile.value}
                  {tile.unit ? <span className="ml-0.5 text-[11px] font-medium text-[#6e6a60]">{tile.unit}</span> : null}
                </div>
                {typeof tile.deltaPercent === 'number' && (
                  <div className={`text-[10px] font-semibold tabular-nums ${tile.deltaPercent >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {`${tile.deltaPercent >= 0 ? '+' : ''}${tile.deltaPercent.toFixed(2)}%`}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Surface>
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-2xl border border-black/10 bg-white/70 backdrop-blur-md shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.06)] animate-fade-in">
      <div className="h-[3px]" style={{ background: `linear-gradient(90deg, ${theme.accent}, ${theme.accent}66)` }} />
      <div className="flex items-center justify-between gap-2 border-b border-black/5 bg-white/80 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold tracking-tight text-[#1a1915]">{data.title || 'Finance Terminal'}</div>
          {data.subtitle && <div className="truncate text-[11px] text-[#6e6a60]">{data.subtitle}</div>}
        </div>
        <div className="shrink-0 rounded-full border border-black/10 bg-black/[0.04] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">
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
            <div className="divide-y divide-black/5 rounded-xl border border-black/10 bg-white/85">
              {news.slice(0, 6).map((n, i) => {
                const inner = (
                  <>
                    <Newspaper className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#9b968c]" />
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-[#1a1915] transition-colors duration-200 group-hover:text-blue-600">{n.title}</div>
                      {(n.source || n.publishedAt) && (
                        <div className="text-[10px] text-[#6e6a60]">
                          {n.source}
                          {n.source && n.publishedAt ? ' · ' : ''}
                          {n.publishedAt ? relativeTime(n.publishedAt) : ''}
                        </div>
                      )}
                    </div>
                  </>
                );
                return n.url ? (
                  <a key={i} href={n.url} target="_blank" rel="noopener noreferrer" className="group flex items-start gap-2 px-3 py-2 transition-colors duration-200 hover:bg-black/[0.03]">
                    {inner}
                  </a>
                ) : (
                  <div key={i} className="group flex items-start gap-2 px-3 py-2">{inner}</div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
