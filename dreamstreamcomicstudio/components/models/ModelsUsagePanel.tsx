import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, RefreshCw } from 'lucide-react';
import { fetchModelUsageMonthly, type ModelUsageRow } from '../../services/modelUsageTrends';
import { sourceLabel } from '../../services/modelCatalog';
import { summarizeUsage } from './workspaceData';
import { Button } from '../ds/Button';
import { EmptyState } from '../ds/EmptyState';
import { CHART_PLOT_BG, HEADING, MUTED, RADIUS_PANEL, HAIRLINE } from '../chat/studioDesign';

/** Two small, labelled bar charts. Values are visible without hover; missing months are not invented. */
export function ModelsUsagePanel({ revision, previewRows }: { revision: number; previewRows?: ModelUsageRow[] }) {
  const [rows, setRows] = useState<ModelUsageRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (previewRows !== undefined) { setRows(previewRows); setLoading(false); return; }
    const abort = new AbortController();
    setLoading(true);
    void fetchModelUsageMonthly(6, { signal: abort.signal }).then((next) => {
      if (!abort.signal.aborted) { setRows(next); setLoading(false); }
    });
    return () => abort.abort();
  }, [revision, retry, previewRows]);
  const data = useMemo(() => summarizeUsage(rows ?? []), [rows]);
  if (loading) return <p className={`py-16 text-center ${MUTED}`} role="status">Loading recorded usage…</p>;
  if (rows === null) return <EmptyState icon={<BarChart3 />} title="Usage couldn’t load" description="The usage service did not return data. This is not a zero-usage result." action={{ label: 'Try again', onClick: () => setRetry((n) => n + 1) }} />;
  if (!data.monthly.length) return <EmptyState icon={<BarChart3 />} title="No usage recorded yet" description="Monthly request counts will appear here when DreamStream has recorded activity. No estimated activity is shown." action={{ label: 'Refresh usage', onClick: () => setRetry((n) => n + 1) }} />;
  const maxMonth = Math.max(1, ...data.monthly.map((m) => m.requests));
  const topModels = data.models.slice(0, 8);
  const maxModel = Math.max(1, ...topModels.map((m) => m.requests));
  return <section className="space-y-6" aria-labelledby="models-usage-heading">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 id="models-usage-heading" className={`${HEADING} text-xl`}>Recorded model usage</h2><p className={`mt-1 text-sm ${MUTED}`}>Platform-wide request counts · last six months · {data.total.toLocaleString()} recorded requests</p></div>
      <Button variant="outline" onClick={() => setRetry((n) => n + 1)}><RefreshCw />Refresh usage</Button>
    </div>
    <div className="grid gap-6 lg:grid-cols-2">
      <figure className={`${HAIRLINE} ${RADIUS_PANEL} ${CHART_PLOT_BG} p-5 sm:p-6`}>
        <figcaption className="mb-6 font-semibold">Requests by month</figcaption>
        <ol className="space-y-5" aria-label="Monthly requests">
          {data.monthly.map((row) => <li key={row.month} className="space-y-2"><div className="flex justify-between gap-4 text-sm"><span>{new Date(`${row.month}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</span><span className="font-medium tabular-nums">{row.requests.toLocaleString()}</span></div><div className="h-2 bg-[var(--ds-well)]" aria-hidden="true"><div className="h-full bg-[var(--ds-chart-1)]" style={{ width: `${row.requests / maxMonth * 100}%` }} /></div></li>)}
        </ol>
        <p className={`mt-6 text-xs ${MUTED}`}>Each bar starts at zero. Months without published records are omitted.</p>
      </figure>
      <figure className={`${HAIRLINE} ${RADIUS_PANEL} ${CHART_PLOT_BG} p-5 sm:p-6`}>
        <figcaption className="mb-6 font-semibold">Most used models in this period</figcaption>
        <ol className="space-y-4" aria-label="Requests by model">{topModels.map((row) => <li key={row.id} className="space-y-2"><div className="flex items-start justify-between gap-4 text-sm"><div className="min-w-0 [overflow-wrap:anywhere]">{row.model}<span className={`block text-xs ${MUTED}`}>{sourceLabel(row.source)}</span></div><span className="shrink-0 font-medium tabular-nums">{row.requests.toLocaleString()}</span></div><div className="h-1.5 bg-[var(--ds-well)]" aria-hidden="true"><div className="h-full bg-[var(--ds-chart-2)]" style={{ width: `${row.requests / maxModel * 100}%` }} /></div></li>)}</ol>
      </figure>
    </div>
    <p className={`text-xs ${MUTED}`}>Source: DreamStream’s monthly counters for recorded Chat responses and successful Comic calls. Coverage depends on the studio’s reporting. These are platform totals, not your personal usage, provider market share, or model quality scores.</p>
  </section>;
}
