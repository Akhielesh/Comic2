import React, { useEffect, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { Surface, SurfaceTitle, SurfaceSubtitle, RangeTabs, compactNumber, relativeTime } from '../chat/artifacts/kit';
import { fetchModelPopularity, type ModelPopularity, type PopularityWindow } from '../../services/modelPopularity';

// "What DreamStream users run" — an OpenRouter-style popularity ranking of the models
// the platform's users actually call, from /api/models/popularity (hourly server cache).
// Built from the calm-studio Primitive Kit (Surface + RangeTabs, --ds-* tokens, inline
// bars — no chart libs). The route is served behind sign-in, so the Model Library renders this
// panel only for a signed-in user. Loading skeleton first; then the ranking, or a calm empty state.
// The server lists a model only once enough distinct people used it in the window (a k-anonymity
// floor), so an empty list is the normal answer on a young platform, and only a list known to be
// empty gets that explanation. fetchModelPopularity (services/modelPopularity) currently answers null
// both for an empty list and for a failed request: null gets neutral words that give no reason, and is
// not kept, so switching windows or reopening the view asks again.

const WINDOW_LABELS = ['Weekly', 'Monthly', 'All-time'] as const;
type WindowLabel = (typeof WINDOW_LABELS)[number];
const LABEL_TO_WINDOW: Record<WindowLabel, PopularityWindow> = {
  Weekly: 'week',
  Monthly: 'month',
  'All-time': 'all'
};

const ACCENT = '#D97757'; // theme-invariant terracotta accent (see studioDesign.ts)

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
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.max(1.5, (row.sharePct / maxShare) * 100)}%`, background: ACCENT }}
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
    accent={ACCENT}
    header={
      <>
        <SurfaceTitle>
          <span className="inline-flex items-center gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" style={{ color: ACCENT }} />
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
      <div className="animate-pulse space-y-2.5 px-3 pb-3 pt-1" aria-label="Loading model rankings">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5">
            <div className="h-3 w-6 rounded bg-[var(--ds-well)]" />
            <div className="h-6 flex-1 rounded-lg bg-[var(--ds-well)]" />
            <div className="h-3 w-12 rounded bg-[var(--ds-well)]" />
          </div>
        ))}
      </div>
    ) : data && data.models.length > 0 ? (
      <ModelPopularityList data={data} />
    ) : data ? (
      <ModelPopularityEmpty />
    ) : (
      <ModelPopularityUnavailable />
    )}
  </Surface>
);

/** Nothing could be shown, and the reason is not known (an empty list or a failed read): no reason given. */
export const ModelPopularityUnavailable: React.FC = () => (
  <div className="px-3 pb-4 pt-1" data-popularity-unavailable>
    <p className="text-[12px] font-medium text-[var(--ds-ink)]">No rankings to show right now</p>
    <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-[var(--ds-muted)]">Check back later.</p>
  </div>
);

/** The empty state: the window was read and no model has enough distinct users in it to be listed. */
export const ModelPopularityEmpty: React.FC = () => (
  <div className="px-3 pb-4 pt-1" data-popularity-empty>
    <p className="text-[12px] font-medium text-[var(--ds-ink)]">No rankings to show yet</p>
    <p className="mt-0.5 max-w-prose text-[11px] leading-snug text-[var(--ds-muted)]">
      A model appears here once enough different people have used it in this period, so no one&apos;s usage can be singled out.
    </p>
  </div>
);

/** Live panel: Weekly / Monthly / All-time tabs over /api/models/popularity. */
export const ModelPopularityPanel: React.FC = () => {
  const [label, setLabel] = useState<WindowLabel>('Weekly');
  // Per window, what was read (kept: the server caches hourly). A null answer is not kept.
  const [results, setResults] = useState<Partial<Record<PopularityWindow, ModelPopularity>>>({});
  // The window whose last read answered null (an empty list or a failure; not told apart yet).
  const [unavailable, setUnavailable] = useState<PopularityWindow | null>(null);

  const win = LABEL_TO_WINDOW[label];
  const result = results[win];
  const loading = !result && unavailable !== win;

  useEffect(() => {
    if (results[win]) return;
    setUnavailable(null);
    let on = true;
    void fetchModelPopularity(win).then((res) => {
      if (!on) return;
      if (res) setResults((r) => ({ ...r, [win]: res }));
      else setUnavailable(win);
    });
    return () => {
      on = false;
    };
  }, [win, results]);

  return (
    <ModelPopularityCard
      data={result ?? null}
      loading={loading}
      right={<RangeTabs<WindowLabel> options={WINDOW_LABELS} value={label} accent={ACCENT} onChange={setLabel} />}
    />
  );
};
