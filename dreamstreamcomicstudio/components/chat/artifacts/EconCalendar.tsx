import React from 'react';
import type { EconCalendarArtifact, EconEvent } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Badge, relativeTime, shortDate, useCompact, useLiveData, withAlpha, BULL, BEAR, NEUTRAL, PALETTES } from './kit';

// Economic calendar — the day's (or week's) data prints on a timeline.
//  • detailed — a horizontal "today strip" SVG spanning min→max event time: one dot
//    per event positioned by time, sized by importance, colored by outcome (future
//    neutral; past green on a beat, red on a miss, faded gray otherwise) with a
//    vertical NOW hairline when now falls inside the range. Below, divided rows
//    grouped by day (Today / Tomorrow / date): time, country chip, importance dots,
//    title, and an "act · fcst · prev" mini-table with the actual tinted beat/miss.
//  • compact — the next three upcoming events as glance rows (last three if the
//    calendar is entirely in the past).
// Header right shows a Live badge (or "model data") plus "Updated Xm ago".

const DAY_MS = 86_400_000;
/** Importance dots tint (amber, from the kit sunset ramp). */
const IMPORTANCE_TINT = PALETTES.sunset.series[2]; // #f59e0b

/** Parse "3.2%", "-0.4", 3.2 → number; undefined when it doesn't look numeric. */
const parseNum = (v?: string | number): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const n = parseFloat(v.replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : undefined;
};

/** Dot color: future neutral; past beat/miss; faded gray when uncomparable. */
const dotColor = (ev: EconEvent, now: number): string => {
  const t = new Date(ev.time).getTime();
  if (!Number.isFinite(t) || t > now) return NEUTRAL;
  const actual = parseNum(ev.actual);
  const forecast = parseNum(ev.forecast);
  if (actual !== undefined && forecast !== undefined) {
    if (actual > forecast) return BULL;
    if (actual < forecast) return BEAR;
  }
  return withAlpha(NEUTRAL, 0.45);
};

const startOfDay = (t: number): number => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

const dayLabelFor = (iso: string, now: number): string => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return shortDate(iso);
};

const timeLabel = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** 1–3 stacked importance dots; unfilled slots stay hairline-toned. */
const ImportanceDots: React.FC<{ importance?: 1 | 2 | 3 }> = ({ importance = 1 }) => (
  <span className="flex shrink-0 flex-col-reverse gap-[2px]" title={`Importance ${importance}/3`}>
    {[1, 2, 3].map((n) => (
      <span
        key={n}
        className="h-1 w-1 rounded-full"
        style={{ backgroundColor: n <= importance ? IMPORTANCE_TINT : 'var(--ds-hairline)' }}
      />
    ))}
  </span>
);

/** The "today strip": dots by time/importance/outcome plus a NOW hairline. */
const TimelineStrip: React.FC<{ events: EconEvent[]; now: number }> = ({ events, now }) => {
  const times = events.map((e) => new Date(e.time).getTime()).filter((t) => Number.isFinite(t));
  if (times.length < 2) return null;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = max - min || 1;
  // Keep the largest dot fully inside the strip.
  const pctOf = (t: number): number => 3 + ((t - min) / span) * 94;
  const showNow = now >= min && now <= max;
  const nowPct = pctOf(now);
  return (
    <div className="border-y border-[var(--ds-hairline-soft)] bg-[var(--ds-well)]">
      <svg className="block h-10 w-full" role="img" aria-label="Event timeline">
        <line x1="2%" y1={24} x2="98%" y2={24} stroke="var(--ds-hairline)" strokeWidth="1" />
        {events.map((ev, i) => {
          const t = new Date(ev.time).getTime();
          if (!Number.isFinite(t)) return null;
          const r = ev.importance === 3 ? 4.5 : ev.importance === 2 ? 3.5 : 2.5;
          return (
            <circle key={i} cx={`${pctOf(t)}%`} cy={24} r={r} fill={dotColor(ev, now)}>
              <title>{`${timeLabel(ev.time)} · ${ev.title}`}</title>
            </circle>
          );
        })}
        {showNow && (
          <g>
            <line x1={`${nowPct}%`} y1={12} x2={`${nowPct}%`} y2={36} stroke="var(--ds-accent)" strokeWidth="1" />
            <text
              x={`${Math.min(Math.max(nowPct, 5), 95)}%`}
              y={9}
              textAnchor="middle"
              fontSize="7"
              fontWeight="700"
              letterSpacing="0.1em"
              fill="var(--ds-accent)"
            >
              NOW
            </text>
          </g>
        )}
      </svg>
    </div>
  );
};

/** "act 3.2 · fcst 3.0 · prev 2.9" with the actual tinted by beat/miss. */
const StatLine: React.FC<{ event: EconEvent; now: number }> = ({ event, now }) => {
  const actual = parseNum(event.actual);
  const forecast = parseNum(event.forecast);
  const tint =
    actual !== undefined && forecast !== undefined ? (actual > forecast ? BULL : actual < forecast ? BEAR : undefined) : undefined;
  const isPast = new Date(event.time).getTime() <= now;
  const parts: React.ReactNode[] = [];
  if (event.actual !== undefined && isPast) {
    parts.push(
      <span key="a">
        act{' '}
        <span className="font-semibold" style={tint ? { color: tint } : undefined}>
          {String(event.actual)}
        </span>
      </span>
    );
  }
  if (event.forecast !== undefined) parts.push(<span key="f">fcst {String(event.forecast)}</span>);
  if (event.previous !== undefined) parts.push(<span key="p">prev {String(event.previous)}</span>);
  if (!parts.length) return null;
  return (
    <span className="shrink-0 text-right text-[10px] tabular-nums text-[var(--ds-muted)]">
      {parts.map((p, i) => (
        <React.Fragment key={i}>
          {i > 0 && ' · '}
          {p}
        </React.Fragment>
      ))}
    </span>
  );
};

export const EconCalendar: React.FC<{ data: EconCalendarArtifact }> = ({ data }) => {
  const compact = useCompact();
  const live = useLiveData();
  const now = Date.now();

  const events = (data.events ?? [])
    .filter((e) => e?.title && Number.isFinite(new Date(e.time).getTime()))
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  if (!events.length) return null;

  const updated = relativeTime(live.asOf ?? data.asOf);
  const header = (
    <>
      <SurfaceTitle>{data.title ?? 'Economic calendar'}</SurfaceTitle>
      <SurfaceSubtitle>{events.length} {events.length === 1 ? 'event' : 'events'}</SurfaceSubtitle>
    </>
  );
  const headerRight = (
    <div className="flex flex-col items-end gap-0.5">
      {data.live ? <Badge color={BULL}>Live</Badge> : <SurfaceSubtitle>model data</SurfaceSubtitle>}
      {updated && <SurfaceSubtitle>Updated {updated}</SurfaceSubtitle>}
    </div>
  );

  // ── Compact: the next three upcoming events (last three if all are past). ────
  if (compact) {
    const upcoming = events.filter((e) => new Date(e.time).getTime() >= now);
    const picks = upcoming.length ? upcoming.slice(0, 3) : events.slice(-3);
    return (
      <Surface header={header} right={headerRight}>
        <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {picks.map((ev, i) => {
            const label = dayLabelFor(ev.time, now);
            return (
              <div key={`${ev.title}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-16 shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">
                  {label === 'Today' ? timeLabel(ev.time) : label}
                </span>
                <ImportanceDots importance={ev.importance} />
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-[var(--ds-ink)]">{ev.title}</span>
              </div>
            );
          })}
        </div>
      </Surface>
    );
  }

  // ── Detailed: timeline strip + day-grouped rows. ─────────────────────────────
  const groups: { label: string; events: EconEvent[] }[] = [];
  for (const ev of events) {
    const label = dayLabelFor(ev.time, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.events.push(ev);
    else groups.push({ label, events: [ev] });
  }

  return (
    <Surface header={header} right={headerRight}>
      <TimelineStrip events={events} now={now} />
      <div>
        {groups.map((group) => (
          <section key={group.label}>
            <div className="sticky top-0 border-b border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
              {group.label}
            </div>
            <ul className="divide-y divide-[var(--ds-hairline-soft)]">
              {group.events.map((ev, i) => (
                <li key={`${ev.title}-${i}`} className="flex items-center gap-2 px-3 py-1.5 transition-colors duration-200 hover:bg-[var(--ds-well)]">
                  <span className="w-12 shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">{timeLabel(ev.time)}</span>
                  {ev.country && (
                    <span className="shrink-0 rounded bg-[var(--ds-well)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ds-muted)]">
                      {ev.country}
                    </span>
                  )}
                  <ImportanceDots importance={ev.importance} />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ds-ink)]">{ev.title}</span>
                  <StatLine event={ev} now={now} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Surface>
  );
};
