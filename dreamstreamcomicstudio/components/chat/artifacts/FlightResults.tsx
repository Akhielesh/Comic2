import React from 'react';
import { Plane, ArrowRight, ExternalLink, Clock, Zap } from 'lucide-react';
import type { FlightResultsArtifact, FlightOffer } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

const fmtDuration = (mins: number): string => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
const fmtTime = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};
const stopsLabel = (n: number): string => (n === 0 ? 'Non-stop' : `${n} stop${n > 1 ? 's' : ''}`);

// Real flight-deals card (search_flights → Amadeus). Cheapest first; the cheapest and the
// fastest options are badged so the trade-off Gemini surfaces in prose is visible at a glance.
//
// TWO VERSIONS: compact (top 3 rows: airline · price · duration · stops) and detailed (all
// rows with layovers + departure/arrival times), via the WidgetFrame density context.
export const FlightResults: React.FC<{ data: FlightResultsArtifact }> = ({ data }) => {
  const compact = useCompact();
  const offers = data?.offers || [];
  if (!offers.length) return null;

  const cheapest = offers.reduce((a, b) => (b.price < a.price ? b : a), offers[0]);
  const fastest = offers.reduce((a, b) => (b.durationMinutes < a.durationMinutes ? b : a), offers[0]);
  const rows = compact ? offers.slice(0, 3) : offers;

  const header = (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 shrink-0 rounded-lg bg-[var(--ds-well-strong)] p-1.5 text-[#D97757]">
        <Plane className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <SurfaceTitle>
          <span className="inline-flex items-center gap-1.5">
            {data.origin} <ArrowRight className="h-3.5 w-3.5 text-[var(--ds-muted)]" /> {data.destination}
          </span>
        </SurfaceTitle>
        <SurfaceSubtitle>
          {data.departureDate}
          {data.returnDate ? ` · returning ${data.returnDate}` : ' · one-way'}
          {data.adults && data.adults > 1 ? ` · ${data.adults} travelers` : ''}
        </SurfaceSubtitle>
      </div>
    </div>
  );

  const right = data.searchUrl ? (
    <a
      href={data.searchUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded-md border border-[var(--ds-hairline)] px-2 py-1 text-[11px] text-[var(--ds-muted)] transition-colors hover:bg-[var(--ds-hover)]"
    >
      Google Flights <ExternalLink className="h-3 w-3" />
    </a>
  ) : undefined;

  const badge = (o: FlightOffer): React.ReactNode => {
    const isCheapest = o === cheapest;
    const isFastest = o === fastest && offers.length > 1 && fastest !== cheapest;
    if (isCheapest) return <span className="rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-semibold text-emerald-700">Cheapest</span>;
    if (isFastest) return <span className="inline-flex items-center gap-0.5 rounded-full bg-[#D97757]/10 px-1.5 py-px text-[10px] font-semibold text-[#D97757]"><Zap className="h-2.5 w-2.5" />Fastest</span>;
    return null;
  };

  return (
    <Surface accent="#D97757" header={header} right={right}>
      <ul className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {rows.map((o, i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold text-[var(--ds-ink)]">{o.airline}</span>
                {badge(o)}
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--ds-muted)]">
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <Clock className="h-3 w-3" />
                  {fmtDuration(o.durationMinutes)}
                </span>
                <span>·</span>
                <span>{stopsLabel(o.stops)}</span>
                {!compact && o.departTime && o.arriveTime && (
                  <span className="tabular-nums text-[var(--ds-faint)]">
                    {fmtTime(o.departTime)} → {fmtTime(o.arriveTime)}
                  </span>
                )}
              </span>
              {!compact && o.layovers && o.layovers.length > 0 && (
                <span className="mt-0.5 block truncate text-[11px] text-[var(--ds-faint)]">
                  via {o.layovers.join(' · ')}
                </span>
              )}
            </span>
            <span className="shrink-0 text-right">
              <span className="text-[15px] font-bold tabular-nums text-[var(--ds-ink)]">${o.price.toLocaleString()}</span>
              {o.currency && o.currency !== 'USD' && <span className="ml-0.5 text-[10px] text-[var(--ds-muted)]">{o.currency}</span>}
            </span>
          </li>
        ))}
      </ul>
      {!data.live && (
        <div className="px-3 pb-2 pt-1 text-[10px] text-[var(--ds-faint)]">Estimated — not from a live fare feed.</div>
      )}
    </Surface>
  );
};
