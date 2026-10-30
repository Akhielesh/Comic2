// Trends (models.md §4.4) — only from data we actually hold or fetch:
//   T1 this comic's spend over time (doc.spend.entries; sparkline in Easy, stacked bars by kind in Pro);
//   T2 your images by model per month (comic_image_calls) + the platform's monthly counters;
//   T3 price changes (change-only snapshots; "Tracking since {first fetch}", no line before it);
//   T4 leaderboard movement ("#1 → #3 since April"); T5 new on OpenRouter; T6 reliability, ours and
//   OpenRouter's, each labelled with its source; T7 most used by creators, hidden below 5 distinct users.
// T2–T7 are fetched when this tab opens (and when the range changes) — never on a timer.

import React, { useMemo, useState } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { ModelTrends, TrendRange } from '../../../shared/comic/modelCatalog';
import { Segmented, cx, plural } from '../conversation/ui';
import { NOT_ENOUGH_DATA_COPY, NO_UPTIME_COPY, couldntRefreshCopy, recentLabel } from './copy';
import { SERIES_GROUPS, bucketLabel, clockText, dateText, nicknameOf, priceView, spendSeries, uptimeLines, type InsightsMoney } from './insightsModel';
import { Sparkline, StackedBars } from './Sparkline';
import { useInsightsTrends } from './useInsights';
import { MAX_SPEND_ENTRIES } from '../../../shared/comic/limits';
import { Section, Source, TextButton, WRAP } from './ui';

export interface TrendsTabProps {
  doc: ComicDoc;
  money: InsightsMoney;
  pro: boolean;
  now?: number;
}

const Lines: React.FC<{ lines: string[]; label: string; muted?: boolean }> = ({ lines, label, muted }) => (
  <ul aria-label={label} className={cx('min-w-0 space-y-0.5 text-[11.5px] tabular-nums', muted ? 'text-[var(--ds-muted)]' : 'text-[var(--ds-ink)]')}>
    {lines.map((l, i) => (
      <li key={`${i}:${l}`} className={cx('min-w-0', WRAP)}>
        {l}
      </li>
    ))}
  </ul>
);

/** T1 — no request: the doc's own entries. */
const ComicSpend: React.FC<{ doc: ComicDoc; money: InsightsMoney; pro: boolean }> = ({ doc, money, pro }) => {
  const capped = doc.spend.entries.length >= MAX_SPEND_ENTRIES;
  const series = useMemo(() => spendSeries(doc, capped), [doc, capped]);
  if (!series) return <p className="text-[12px] text-[var(--ds-muted)]">Nothing spent on this comic yet.</p>;
  const first = series.buckets[0];
  const last = series.buckets[series.buckets.length - 1];
  const span = first === last ? bucketLabel(first.start, series.unit) : `${bucketLabel(first.start, series.unit)} – ${bucketLabel(last.start, series.unit)}`;
  return (
    <div className="min-w-0">
      {pro ? (
        <StackedBars
          label="Spent on this comic over time, by kind"
          bars={series.buckets.map((b) => ({
            key: String(b.start),
            label: bucketLabel(b.start, series.unit),
            total: b.total,
            segments: SERIES_GROUPS.map((g) => ({ id: g.id, value: b.byGroup[g.id] ?? 0 }))
          }))}
          series={SERIES_GROUPS}
          format={(usd) => money.spent(usd)}
        />
      ) : (
        <Sparkline values={series.cumulative} label={`Spent on this comic over time: ${money.spent(series.cumulative[series.cumulative.length - 1] ?? 0)} so far`} />
      )}
      <Source>
        {span} · per {series.unit} · this comic’s spend ledger{series.recentN ? ` ${recentLabel(series.recentN)}` : ''}
      </Source>
    </div>
  );
};

const t2Lines = (t: ModelTrends): { yours: string[]; platform: string[] } => ({
  yours: t.t2.yours.map((r) => `${dateText(r.month)} · ${nicknameOf(r.modelId)} · ${plural(r.images, 'image')}`),
  platform: t.t2.platform.map((r) => `${dateText(r.month)} · ${r.model} · ${plural(r.requests, 'request')}`)
});

const rankWords = (p: { rank?: number; score: number }) => (typeof p.rank === 'number' ? `#${p.rank}` : `score ${Math.round(p.score)}`);

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const sinceMonth = (asOf: string) => {
  const m = /^\d{4}-(\d{2})/.exec(asOf);
  const name = m ? MONTH_NAMES[Number(m[1]) - 1] : undefined;
  return name ? `since ${name}` : `since ${dateText(asOf)}`;
};

export const TrendsTab: React.FC<TrendsTabProps> = ({ doc, money, pro, now }) => {
  const [range, setRange] = useState<TrendRange>('30d');
  const trends = useInsightsTrends(range, true);
  const t = trends.data;
  const stale = trends.stale && trends.fetchedAt ? couldntRefreshCopy(clockText(trends.fetchedAt, now)) : null;
  return (
    <div className="min-w-0 space-y-4">
      <Section title="This comic">
        <ComicSpend doc={doc} money={money} pro={pro} />
      </Section>

      <Segmented<TrendRange>
        label="Trend period"
        value={range}
        onChange={setRange}
        options={[
          { value: '30d', label: 'Last 30 days' },
          { value: '90d', label: 'Last 90 days' }
        ]}
      />

      {!t && trends.loading && (
        <p className="text-[12px] text-[var(--ds-muted)]" aria-busy="true">
          Loading trends…
        </p>
      )}
      {!t && !trends.loading && trends.error && (
        <p className={cx('text-[12px] text-[var(--ds-muted)]', WRAP)}>
          Trends couldn’t load right now. Nothing here is estimated, so nothing is shown. <TextButton onClick={trends.refresh}>Try again</TextButton>
        </p>
      )}
      {t && (
        <>
          {stale && <Source>{stale}</Source>}
          <TrendSections t={t} money={money} now={now} />
        </>
      )}
    </div>
  );
};

const TrendSections: React.FC<{ t: ModelTrends; money: InsightsMoney; now?: number }> = ({ t, money, now }) => {
  const t2 = t2Lines(t);
  // A price, or the exact §4.6 copy when the change was to "no price" (unpublished / OpenRouter lists none).
  const changes = t.t3.changes.map((c) => `${dateText(c.at)} · ${nicknameOf(c.modelId)} ${c.res}: ${priceView({ usd: c.usd, basis: c.basis, note: c.note ?? undefined }, money)!.text}`);
  const moves = t.t4.moves.map((m) => `${nicknameOf(m.modelId)}: ${rankWords(m.from)} → ${rankWords(m.to)} ${sinceMonth(m.from.asOf)}`);
  const ours = t.t6.ours.map(
    (o) => `${nicknameOf(o.modelId)}, last ${o.window === '24h' ? '24 h' : '7 days'} (${o.scope === 'you' ? 'your calls' : 'all creators'}): ${plural(o.calls, 'call')} · ${o.failed} failed · ${o.rateLimited} rate-limited`
  );
  // OpenRouter uptime: the latest capture per model and provider.
  const latest = new Map<string, ModelTrends['t6']['openrouter'][number]>();
  for (const u of t.t6.openrouter) {
    const k = `${u.modelId}|${u.provider}`;
    const prev = latest.get(k);
    if (!prev || prev.fetchedAt < u.fetchedAt) latest.set(k, u);
  }
  const uptime = [...latest.values()].flatMap((u) => uptimeLines([{ provider: u.provider, uptime1d: u.uptime1d, uptime30m: u.uptime30m }]).map((l) => `${nicknameOf(u.modelId)} · ${l} (${dateText(u.day)})`));
  return (
    <>
      <Section title="Your images by model">
        {t2.yours.length ? <Lines lines={t2.yours} label="Your images by model per month" /> : <p className="text-[11.5px] text-[var(--ds-muted)]">No images in this period.</p>}
        <Source>{t.t2.source.yours || 'Your image calls'}</Source>
        {t2.platform.length > 0 && (
          <>
            <Lines lines={t2.platform} label="Comic Studio use per month, platform-wide" muted />
            <Source>{t.t2.source.platform}</Source>
          </>
        )}
      </Section>

      {(t.t3.note || changes.length > 0) && (
        <Section title="Price changes">
          {changes.length ? <Lines lines={changes} label="Price changes" /> : <p className="text-[11.5px] text-[var(--ds-muted)]">No price changes in this period.</p>}
          {t.t3.note && <Source>{t.t3.note}</Source>}
        </Section>
      )}

      <Section title="Leaderboard movement">
        {moves.length ? <Lines lines={moves} label="Leaderboard movement" /> : <p className="text-[11.5px] text-[var(--ds-muted)]">No rank changes in the history we hold.</p>}
        <Source>
          {t.t4.source}
          {t.t4.asOf ? ` · as of ${dateText(t.t4.asOf)}` : ''}
          {t.t4.trackingSince ? ` · history since ${dateText(t.t4.trackingSince)}` : ''}
        </Source>
      </Section>

      <Section title={`New on OpenRouter (last ${t.t5.sinceDays} days)`}>
        {t.t5.models.length ? (
          <Lines lines={t.t5.models.map((m) => `${m.name} · ${dateText(m.created)}`)} label="New image models on OpenRouter" />
        ) : (
          <p className="text-[11.5px] text-[var(--ds-muted)]">Nothing new in this period.</p>
        )}
        {t.t5.fetchedAt && <Source>{t.t5.stale ? couldntRefreshCopy(clockText(t.t5.fetchedAt, now)) : `OpenRouter image models, ${clockText(t.t5.fetchedAt, now)}`}</Source>}
      </Section>

      <Section title="Reliability">
        {ours.length ? <Lines lines={ours} label="Our reliability" /> : <p className="text-[11.5px] text-[var(--ds-muted)]">No image calls in the last 7 days.</p>}
        <Source>{t.t6.source.ours}</Source>
        <Lines lines={uptime.length ? uptime : [NO_UPTIME_COPY]} label="OpenRouter uptime" muted={!uptime.length} />
        <Source>{t.t6.source.openrouter}</Source>
      </Section>

      <Section title="Most used by DreamStream creators">
        {t.t7.available && t.t7.models?.length ? (
          <Lines lines={t.t7.models.map((m) => `${nicknameOf(m.modelId)} · ${plural(m.calls, 'image')} by ${plural(m.users, 'creator')}`)} label="Most used models" />
        ) : (
          <p className="text-[11.5px] text-[var(--ds-muted)]">{t.t7.copy || NOT_ENOUGH_DATA_COPY}</p>
        )}
        <Source>All DreamStream creators, last {t.t7.sinceDays} days · shown only once 5 or more creators used a model</Source>
      </Section>
    </>
  );
};

export default TrendsTab;
