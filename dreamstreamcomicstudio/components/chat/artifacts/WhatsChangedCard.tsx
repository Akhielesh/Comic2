import React from 'react';
import { TrendingUp, TrendingDown, Newspaper, CalendarClock, Activity, Sparkles } from 'lucide-react';
import type { WhatsChangedArtifact, ChangeItem } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, TrendPill, useCompact } from './kit';

// "What changed since you last looked" — the agent's prioritized changelog of the
// world (prices, news, calendar, metrics). Rows sort by importance; weight-3 items
// get the warm accent tint on their kind icon so headline changes pop quietly.
//  • compact — "N changes · since" plus the two most important rows.
//  • detailed — optional summary paragraph above the full divided changelog, with
//    delta pills on the right and outbound links where the change has a source.

const iconFor = (change: ChangeItem) => {
  switch (change.kind) {
    case 'price':
      return (change.delta ?? change.deltaPercent ?? 0) < 0 ? TrendingDown : TrendingUp;
    case 'news':
      return Newspaper;
    case 'event':
      return CalendarClock;
    case 'metric':
      return Activity;
    default:
      return Sparkles;
  }
};

/** The kind icon in a small rounded square, tinted by importance. */
const KindIcon: React.FC<{ change: ChangeItem }> = ({ change }) => {
  const Icon = iconFor(change);
  const weight = change.weight ?? 1;
  const box =
    weight >= 3
      ? 'bg-[#D97757]/10 text-[#D97757]'
      : weight === 2
        ? 'bg-[var(--ds-well)] text-[var(--ds-muted)]'
        : 'text-[var(--ds-muted)]';
  return (
    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${box}`}>
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
};

const ChangeRow: React.FC<{ change: ChangeItem }> = ({ change }) => {
  const hasDelta = typeof change.delta === 'number' || typeof change.deltaPercent === 'number';
  const title = change.url ? (
    <a href={change.url} target="_blank" rel="noopener noreferrer" className="transition-colors duration-200 hover:underline">
      {change.title}
    </a>
  ) : (
    change.title
  );
  return (
    <li className="flex items-start gap-2.5 px-3 py-2">
      <span className="mt-0.5">
        <KindIcon change={change} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium leading-snug text-[var(--ds-ink)]">{title}</div>
        {change.detail && <div className="mt-0.5 text-[11px] leading-snug text-[var(--ds-muted)]">{change.detail}</div>}
      </div>
      {hasDelta && (
        <span className="mt-0.5 shrink-0">
          <TrendPill change={change.delta} changePercent={change.deltaPercent} size="sm" />
        </span>
      )}
    </li>
  );
};

export const WhatsChangedCard: React.FC<{ data: WhatsChangedArtifact }> = ({ data }) => {
  const compact = useCompact();
  const changes = data.changes ?? [];
  if (!changes.length) return null;

  const sorted = [...changes].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1));
  const subtitle = compact
    ? `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}${data.since ? ` · ${data.since}` : ''}`
    : data.since;
  const header = (
    <>
      <SurfaceTitle>{data.title ?? 'What changed'}</SurfaceTitle>
      {subtitle && <SurfaceSubtitle>{subtitle}</SurfaceSubtitle>}
    </>
  );

  // ── Compact: count + window, then the two most important changes. ────────────
  if (compact) {
    return (
      <Surface header={header}>
        <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {sorted.slice(0, 2).map((c, i) => <ChangeRow key={i} change={c} />)}
        </ul>
      </Surface>
    );
  }

  // ── Detailed: summary paragraph + the full changelog. ────────────────────────
  return (
    <Surface header={header}>
      {data.summary && <p className="px-3 pb-2 text-[13px] leading-snug text-[var(--ds-ink)]">{data.summary}</p>}
      <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {sorted.map((c, i) => <ChangeRow key={i} change={c} />)}
      </ul>
    </Surface>
  );
};
