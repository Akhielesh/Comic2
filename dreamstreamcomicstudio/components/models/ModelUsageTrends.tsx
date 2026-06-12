import React, { useEffect, useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { Surface, SurfaceTitle, SurfaceSubtitle, Chart, compactNumber, type ChartPoint } from '../chat/artifacts/kit';
import { fetchModelUsageMonthly, type ModelUsageRow } from '../../services/modelUsageTrends';

// Model-choice trends — how the platform's model usage moves month by month:
// a total-requests trend chart (kit Chart, inline SVG) plus a "Top models this
// month" ranking with per-product chips. All counts are monthly aggregates;
// nothing here is tied to an individual user. Built from the calm-studio
// Primitive Kit — no chart libraries, --ds-* tokens only.

const ACCENT = '#D97757'; // theme-invariant terracotta accent (see studioDesign.ts)
const MONTHS_SHOWN = 6;
const TOP_MODELS = 8;

const PRODUCT_LABELS: Record<string, string> = {
  chat_studio: 'Chat Studio',
  stream_studio: 'Code Studio',
  comic_studio: 'Comic Studio'
};
const productLabel = (product: string): string =>
  PRODUCT_LABELS[product] ?? product.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const SOURCE_LABEL: Record<string, string> = { openrouter: 'OpenRouter', nvidia: 'NVIDIA' };

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 'YYYY-MM' → "Jan 26" (short month + 2-digit year, no timezone surprises). */
const monthLabel = (month: string): string => {
  const [y, m] = month.split('-');
  const idx = Number(m) - 1;
  if (!y || idx < 0 || idx > 11) return month;
  return `${MONTH_NAMES[idx]} ${y.slice(2)}`;
};

interface TopModelRow {
  key: string;
  model: string;
  source: string;
  requests: number;
  products: { product: string; requests: number }[];
}

export const ModelUsageTrends: React.FC = () => {
  const [rows, setRows] = useState<ModelUsageRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let on = true;
    void fetchModelUsageMonthly(MONTHS_SHOWN).then((res) => {
      if (!on) return;
      setRows(res);
      setLoading(false);
    });
    return () => {
      on = false;
    };
  }, []);

  // Month-by-month total requests (all products + models combined), oldest → newest.
  const monthly = useMemo<ChartPoint[]>(() => {
    const totals = new Map<string, number>();
    for (const r of rows ?? []) totals.set(r.month, (totals.get(r.month) ?? 0) + r.requests);
    return [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, value]) => ({ label: monthLabel(month), value }));
  }, [rows]);

  // "This month" = the latest month in the data; rank its models by total requests.
  const latestMonth = useMemo(() => {
    let latest = '';
    for (const r of rows ?? []) if (r.month > latest) latest = r.month;
    return latest;
  }, [rows]);

  const topModels = useMemo<TopModelRow[]>(() => {
    if (!latestMonth) return [];
    const byModel = new Map<string, TopModelRow>();
    for (const r of rows ?? []) {
      if (r.month !== latestMonth || !r.model) continue;
      const key = `${r.source}:${r.model}`;
      const entry = byModel.get(key) ?? { key, model: r.model, source: r.source, requests: 0, products: [] };
      entry.requests += r.requests;
      const prod = entry.products.find((p) => p.product === r.product);
      if (prod) prod.requests += r.requests;
      else if (r.product) entry.products.push({ product: r.product, requests: r.requests });
      byModel.set(key, entry);
    }
    return [...byModel.values()]
      .map((e) => ({ ...e, products: [...e.products].sort((a, b) => b.requests - a.requests) }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, TOP_MODELS);
  }, [rows, latestMonth]);

  const maxRequests = Math.max(...topModels.map((m) => m.requests), 1);
  const totalLatest = topModels.reduce((s, m) => s + m.requests, 0);

  const header = (
    <>
      <SurfaceTitle>
        <span className="inline-flex items-center gap-1.5">
          <TrendingUp className="h-3.5 w-3.5" style={{ color: ACCENT }} />
          Model usage trends
        </span>
      </SurfaceTitle>
      <SurfaceSubtitle>Which models DreamStream runs, month by month</SurfaceSubtitle>
    </>
  );

  if (loading) {
    return (
      <Surface accent={ACCENT} header={header}>
        <div className="animate-pulse space-y-2.5 px-3 pb-3 pt-1" aria-label="Loading usage trends">
          <div className="h-28 rounded-xl bg-[var(--ds-well)]" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-5 rounded bg-[var(--ds-well)]" />
          ))}
        </div>
      </Surface>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <Surface accent={ACCENT} header={header}>
        <div className="px-3 pb-4 text-[12px] text-[var(--ds-muted)]">
          No usage data published yet — monthly trends will appear here once requests are aggregated.
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      accent={ACCENT}
      header={header}
      footer={
        <p className="text-[10px] text-[var(--ds-muted)]">
          Aggregated monthly counts only — never tied to individual users.
        </p>
      }
    >
      {/* Month-by-month total requests (kit Chart — inline SVG, no chart libs). */}
      {monthly.length >= 2 ? (
        <div className="px-2 pb-1">
          <Chart points={monthly} variant="area" color={ACCENT} height={150} formatValue={(n) => compactNumber(n)} />
        </div>
      ) : monthly.length === 1 ? (
        <div className="px-3 pb-2 text-[12px] text-[var(--ds-muted)]">
          <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{compactNumber(monthly[0].value)}</span> requests in {monthly[0].label} — the trend line appears after a second month.
        </div>
      ) : null}

      {/* Top models this month, with per-product chips. */}
      {topModels.length > 0 && (
        <div className="px-3 pb-3 pt-2">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">
              Top models this month{latestMonth ? ` · ${monthLabel(latestMonth)}` : ''}
            </h4>
            <span className="text-[11px] tabular-nums text-[var(--ds-muted)]">{compactNumber(totalLatest)} requests</span>
          </div>
          <div className="space-y-2.5">
            {topModels.map((m, i) => (
              <div key={m.key} className="flex items-start gap-2.5">
                <span className="w-5 shrink-0 pt-0.5 text-right text-[11px] font-semibold tabular-nums text-[var(--ds-muted)]">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate text-[12px] font-medium text-[var(--ds-ink)]" title={m.model}>
                      {m.model}
                      {m.source && <span className="ml-1.5 text-[10px] text-[var(--ds-muted)]">{SOURCE_LABEL[m.source] ?? m.source}</span>}
                    </span>
                    <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--ds-ink)]">{compactNumber(m.requests)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--ds-well)]">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{ width: `${Math.max(2, (m.requests / maxRequests) * 100)}%`, background: ACCENT }}
                    />
                  </div>
                  {m.products.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {m.products.map((p) => (
                        <span
                          key={p.product}
                          className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-1.5 py-px text-[10px] text-[var(--ds-muted)]"
                          title={`${productLabel(p.product)} · ${p.requests.toLocaleString()} requests`}
                        >
                          {productLabel(p.product)}
                          <span className="tabular-nums">{compactNumber(p.requests)}</span>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Surface>
  );
};
