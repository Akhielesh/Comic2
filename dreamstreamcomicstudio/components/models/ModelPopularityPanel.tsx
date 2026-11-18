import React, { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Surface, SurfaceTitle, SurfaceSubtitle, RangeTabs, compactNumber, relativeTime } from '../chat/artifacts/kit';
import { fetchModelPopularity, type ModelPopularity, type PopularityWindow } from '../../services/modelPopularity';

// "What DreamStream users run" — an OpenRouter-style popularity ranking of the models
// the platform's users actually call, from /api/models/popularity (hourly server cache).
// Built from the calm-studio Primitive Kit (Surface + RangeTabs, --ds-* tokens, inline
// bars — no chart libs). Degrades gracefully: loading skeleton first, and the whole
// panel hides itself if the endpoint doesn't exist yet or returns an error.

const WINDOW_LABELS = ['Weekly', 'Monthly', 'All-time'] as const;
type WindowLabel = (typeof WINDOW_LABELS)[number];
const LABEL_TO_WINDOW: Record<WindowLabel, PopularityWindow> = {
  Weekly: 'week',
  Monthly: 'month',
  'All-time': 'all'
};


/** The ranked horizontal bar list — rank #, model (provider as muted suffix), share bar, counts. */
export const ModelPopularityList: React.FC<{ data: ModelPopularity; limit?: number }> = ({ data, limit = 10 }) => {
  const rows = data.models.slice(0, limit);
  // Bars are scaled to the leader's share (like OpenRouter's rankings) so #1 reads full-width.
  const maxShare = Math.max(...rows.map((r) => r.sharePct), 0.0001);
  return (
    <div className="space-y-2 px-3 pb-3">
      {rows.map((row, i) => (
        <div key={`${row.provider}/${row.model}`} className="flex items-center gap-2.5">
          <span className="w-6 shrink-0 text-right text-[11px] font-semibold tabular-nums text-[var(--ds-muted)]">
            {i + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[12px] font-medium text-[var(--ds-ink)]">
                {row.model}
                {row.provider && <span className="ml-1.5 text-[10px] text-[var(--ds-muted)]">{row.provider}</span>}
              </span>
              <span
                className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]"
                title={`${row.requests.toLocaleString()} requests · ${row.users.toLocaleString()} users`}
              >
                {compactNumber(row.requests)} req · {compactNumber(row.users)} users
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--ds-well)]">
              <div
                className="h-full rounded-full bg-[var(--ds-chart-1)] transition-[width] duration-[var(--ds-motion-slow)] ease-[var(--ds-ease)] motion-reduce:transition-none"
                style={{ width: `${Math.max(1.5, (row.sharePct / maxShare) * 100)}%` }}
              />
            </div>
          </div>
          <span className="w-12 shrink-0 text-right text-[11px] font-semibold tabular-nums text-[var(--ds-ink)]">
            {row.sharePct.toFixed(1)}%
          </span>
        </div>
      ))}
    </div>
  );
};

/** Presentational card shell (also rendered in the component Gallery with sample data). */
export const ModelPopularityCard: React.FC<{
  data: ModelPopularity | null;
  loading?: boolean;
  right?: React.ReactNode;
}> = ({ data, loading = false, right }) => (
  <Surface
    header={
      <>
        <SurfaceTitle>
          <span className="inline-flex items-center gap-1.5">
            <BarChart3 className="h-3.5 w-3.5 text-[var(--ds-muted)]" aria-hidden />
            What DreamStream users run
          </span>
        </SurfaceTitle>
        <SurfaceSubtitle>
          Most-used models across the platform
          {data?.generatedAt ? ` · updated ${relativeTime(data.generatedAt)}` : ''}
        </SurfaceSubtitle>
      </>
    }
    right={right}
  >
    {loading ? (
      <div className="motion-safe:animate-pulse space-y-2.5 px-3 pb-3 pt-1" aria-label="Loading model rankings">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <div className="h-3 w-6 rounded-[var(--ds-radius-sm)] bg-[var(--ds-well)]" />
            <div className="h-6 flex-1 rounded-[var(--ds-radius-control)] bg-[var(--ds-well)]" />
            <div className="h-3 w-12 rounded-[var(--ds-radius-sm)] bg-[var(--ds-well)]" />
          </div>
        ))}
      </div>
    ) : data ? (
      <ModelPopularityList data={data} />
    ) : (
      <div className="px-3 pb-4 text-[11px] text-[var(--ds-muted)]">No usage data for this range yet.</div>
    )}
  </Surface>
);

/** Live panel: Weekly / Monthly / All-time tabs over /api/models/popularity. */
export const ModelPopularityPanel: React.FC = () => {
  const [label, setLabel] = useState<WindowLabel>('Weekly');
  const [cache, setCache] = useState<Partial<Record<PopularityWindow, ModelPopularity>>>({});
  const [failed, setFailed] = useState<Partial<Record<PopularityWindow, boolean>>>({});

  const win = LABEL_TO_WINDOW[label];
  const data = cache[win] ?? null;
  const loading = !data && !failed[win];

  useEffect(() => {
    if (cache[win] || failed[win]) return;
    let on = true;
    void fetchModelPopularity(win).then((res) => {
      if (!on) return;
      if (res) setCache((c) => ({ ...c, [win]: res }));
      else setFailed((f) => ({ ...f, [win]: true }));
    });
    return () => {
      on = false;
    };
  }, [win, cache, failed]);

  // Endpoint missing/erroring and nothing ever loaded → hide the panel entirely.
  const anyData = Object.keys(cache).length > 0;
  if (failed[win] && !anyData) return null;

  return (
    <ModelPopularityCard
      data={data}
      loading={loading}
      right={<RangeTabs<WindowLabel> options={WINDOW_LABELS} value={label} accent="var(--ds-ink)" onChange={setLabel} />}
    />
  );
};
