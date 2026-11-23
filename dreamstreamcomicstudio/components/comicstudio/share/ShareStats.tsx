// Owner analytics: seven UTC dates of link opens, daily unique readers and finish events, top
// channels (inline SVG bars) and a 14-day sparkline. No chart library; tabular numbers; honest
// empty state. Also used as a Gallery demo.

import React from 'react';
import type { PublicationOwnerView } from '../../../shared/comic/publication';
import { CHANNEL_LABEL, compactCount } from './shareModel';
import type { ShareChannel } from '../../../shared/comic/publication';

type Stats = NonNullable<PublicationOwnerView['stats']>;

const Sparkline: React.FC<{ values: number[] }> = ({ values }) => {
  const w = 160;
  const h = 36;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} preserveAspectRatio="none" aria-hidden className="block max-w-[200px] text-[var(--ds-accent)]">
      {values.length > 1 && <polyline points={points} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
};

export const ShareStats: React.FC<{ stats?: Stats | null }> = ({ stats }) => {
  if (!stats) return <p className="text-[13px] text-[var(--ds-muted)]">No reader activity figures are available yet.</p>;
  const counts = Object.entries(stats.byChannel7d || {}).filter(([, n]) => n > 0);
  const channels = counts
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);
  const top = Math.max(1, ...channels.map(([, v]) => v));
  const opens = counts.reduce((total, [, n]) => total + n, 0);
  const tiles: Array<[string, string]> = [
    ['Link opens', compactCount(opens)],
    ['Reader-days', compactCount(stats.uniques7d)],
    ['Finishes', compactCount(stats.completes7d)]
  ];
  return (
    <div className="min-w-0 space-y-3">
      <p className="m-0 text-[12px] text-[var(--ds-muted)]">Last seven days. A reader counts once each day they visit. Finishes count visits that reached the last page.</p>
      <dl className="grid grid-cols-3 gap-2">
        {tiles.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-xl bg-[var(--ds-well)] px-2.5 py-2">
            <dt className="truncate text-[11px] text-[var(--ds-muted)]">{label}</dt>
            <dd className="m-0 truncate text-[16px] font-semibold tabular-nums text-[var(--ds-ink)]">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="m-0 text-[12px] text-[var(--ds-muted)]">Lifetime reader-days: {compactCount(stats.views)}</p>
      {stats.daily?.length > 1 && (
        <div>
          <div className="mb-1 text-[11px] text-[var(--ds-muted)]">Opens on recorded days</div>
          <Sparkline values={stats.daily.map((d) => d.views)} />
        </div>
      )}
      {channels.length > 0 && (
        <ul className="m-0 list-none space-y-1.5 p-0" aria-label="Link opens by channel, last 7 days">
          {channels.map(([ch, v]) => (
            <li key={ch} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="w-20 shrink-0 truncate text-[var(--ds-muted)]">{CHANNEL_LABEL[ch as ShareChannel] || ch}</span>
              <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2 min-w-0 flex-1" aria-hidden>
                <rect width="100" height="8" rx="4" fill="var(--ds-well-strong)" />
                <rect width={Math.max(4, (v / top) * 100)} height="8" rx="4" className="fill-[var(--ds-chart-1)]" />
              </svg>
              <span className="w-8 shrink-0 text-right tabular-nums text-[var(--ds-ink)]">{compactCount(v)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default ShareStats;
