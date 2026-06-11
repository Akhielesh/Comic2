import React, { useEffect, useState } from 'react';
import { ArrowUp, Clock, Gauge, Plane } from 'lucide-react';
import type { FlightStatusArtifact, FlightEndpointStatus, FlightPhase } from '../../../apiTypes';
import {
  Surface,
  SurfaceTitle,
  SurfaceSubtitle,
  Badge,
  withAlpha,
  useCompact,
  useLiveData,
  relativeTime,
  BULL,
  BEAR,
  NEUTRAL
} from './kit';

// Live flight tracker — a great-circle arc with the plane positioned by progress.
//  • detailed — "{airline} {flightNumber}" header with status badge ("Live" when the
//    data came from a real provider, "updated Xm ago" beneath), a dashed bezier arc
//    with a solid status-colored segment up to progressPct and a pulsing plane dot
//    at the current position, IATA codes at both ends, DEP/ARR columns (scheduled
//    struck through when the estimate moved, delays tinted) and altitude / speed /
//    delay chips.
//  • compact — one row: "UA 2402 · SFO → HND" + status badge + delay chip.

const STATUS_COLORS: Record<FlightPhase, string> = {
  scheduled: NEUTRAL,
  active: '#0ea5e9',
  landed: BULL,
  cancelled: BEAR,
  diverted: '#f97316',
  unknown: NEUTRAL
};

const STATUS_LABELS: Record<FlightPhase, string> = {
  scheduled: 'Scheduled',
  active: 'In flight',
  landed: 'Landed',
  cancelled: 'Cancelled',
  diverted: 'Diverted',
  unknown: 'Unknown'
};

/** ISO timestamp → "10:45"; non-parseable strings pass through untouched. */
const timeLabel = (value?: string): string | undefined => {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
};

// The arc is the quadratic bezier M20,78 Q140,-42 260,78 — control at (140,−42)
// puts the visual apex at (140,18) inside the 280×90 viewBox.
const P0 = [20, 78] as const;
const C = [140, -42] as const;
const P1 = [260, 78] as const;

const bezier = (t: number): readonly [number, number] => {
  const u = 1 - t;
  return [
    u * u * P0[0] + 2 * u * t * C[0] + t * t * P1[0],
    u * u * P0[1] + 2 * u * t * C[1] + t * t * P1[1]
  ];
};

const ARC_PATH = `M${P0[0]},${P0[1]} Q${C[0]},${C[1]} ${P1[0]},${P1[1]}`;

/** The route arc: dashed track, solid progress segment, plane dot at t=planeT. */
const RouteArc: React.FC<{
  from?: string;
  to?: string;
  /** 0–1 flown fraction for the solid segment; undefined → fully dashed. */
  progress?: number;
  /** 0–1 plane position along the arc. */
  planeT: number;
  color: string;
  pulse: boolean;
}> = ({ from, to, progress, planeT, color, pulse }) => {
  const [px, py] = bezier(Math.max(0, Math.min(1, planeT)));
  const flown =
    progress === undefined
      ? null
      : Array.from({ length: 41 }, (_, i) =>
          bezier((i / 40) * Math.max(0, Math.min(1, progress))).map((n) => n.toFixed(1)).join(',')
        ).join(' ');
  return (
    <svg viewBox="0 0 280 90" className="w-full">
      <path d={ARC_PATH} fill="none" stroke="var(--ds-hairline)" strokeWidth="2" strokeDasharray="4 5" strokeLinecap="round" />
      {flown && <polyline points={flown} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
      {pulse && <circle cx={px} cy={py} r="8" fill={withAlpha(color, 0.3)} className="motion-safe:animate-pulse" />}
      <circle cx={px} cy={py} r="4" fill={color} stroke="var(--ds-surface)" strokeWidth="1.5" />
      <text x={P0[0]} y="89" textAnchor="start" fontSize="12" fontWeight="600" fill="var(--ds-ink)">
        {from ?? '—'}
      </text>
      <text x={P1[0]} y="89" textAnchor="end" fontSize="12" fontWeight="600" fill="var(--ds-ink)">
        {to ?? '—'}
      </text>
    </svg>
  );
};

/** DEP/ARR column: city, scheduled (struck when superseded), best time, terminal · gate. */
const EndpointColumn: React.FC<{
  label: string;
  point?: FlightEndpointStatus;
  align: 'left' | 'right';
  /** Tint the best time (departure side of a delayed flight). */
  delayed?: boolean;
}> = ({ label, point, align, delayed }) => {
  const scheduled = timeLabel(point?.scheduled);
  const best = timeLabel(point?.actual ?? point?.estimated);
  const superseded = Boolean(scheduled && best && scheduled !== best);
  const terminalGate = [point?.terminal && `Terminal ${point.terminal}`, point?.gate && `Gate ${point.gate}`]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={`min-w-0 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{label}</p>
      {point?.city && <p className="truncate text-[11px] text-[var(--ds-muted)]">{point.city}</p>}
      <p className="truncate text-[13px] tabular-nums">
        {superseded && (
          <span className="mr-1 text-[var(--ds-muted)] line-through decoration-[var(--ds-hairline)]">{scheduled}</span>
        )}
        <span className="font-semibold" style={{ color: delayed ? BEAR : 'var(--ds-ink)' }}>
          {best ?? scheduled ?? '—'}
        </span>
      </p>
      {terminalGate && <p className="truncate text-[11px] tabular-nums text-[var(--ds-muted)]">{terminalGate}</p>}
    </div>
  );
};

export const FlightStatus: React.FC<{ data: FlightStatusArtifact }> = ({ data }) => {
  const compact = useCompact();
  const live = useLiveData();
  // Re-render every minute so "updated Xm ago" stays honest while the card is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  if (!data.flightNumber && !data.departure?.code && !data.arrival?.code) return null;

  const phase: FlightPhase = STATUS_COLORS[data.status] ? data.status : 'unknown';
  const statusColor = STATUS_COLORS[phase];
  const delayed = typeof data.delayMin === 'number' && data.delayMin > 0;
  const title = [data.airline, data.flightNumber].filter(Boolean).join(' ');

  const statusBadge = (
    <Badge color={statusColor} title={data.statusNote}>
      {STATUS_LABELS[phase]}
    </Badge>
  );
  const delayChip = delayed ? (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums"
      style={{ color: BEAR, backgroundColor: withAlpha(BEAR, 0.1) }}
    >
      <Clock className="h-3 w-3" />+{Math.round(data.delayMin!)} min
    </span>
  ) : null;

  // ── Compact: "UA 2402 · SFO → HND" + status + delay. ─────────────────────────
  if (compact) {
    return (
      <Surface accent={statusColor}>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Plane className="h-3.5 w-3.5 shrink-0" style={{ color: statusColor }} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tabular-nums text-[var(--ds-ink)]">
            {title || '—'}
            {' · '}
            {data.departure?.code ?? '—'} → {data.arrival?.code ?? '—'}
          </span>
          {delayChip}
          {statusBadge}
        </div>
      </Surface>
    );
  }

  // ── Detailed: arc tracker + endpoint columns + telemetry chips. ──────────────
  const updated = relativeTime(live.asOf ?? data.asOf);
  // Solid segment only when the provider reported real progress; otherwise the arc
  // stays fully dashed and the plane parks at the start (scheduled) or end (landed).
  const progress =
    typeof data.progressPct === 'number' && Number.isFinite(data.progressPct)
      ? Math.max(0, Math.min(1, data.progressPct / 100))
      : undefined;
  const planeT = progress ?? (phase === 'landed' ? 1 : phase === 'active' ? 0.5 : 0);
  const route = [data.departure?.city ?? data.departure?.code, data.arrival?.city ?? data.arrival?.code]
    .filter(Boolean)
    .join(' → ');

  const chips: { icon: React.ReactNode; text: string }[] = [];
  if (typeof data.altitudeM === 'number' && Number.isFinite(data.altitudeM)) {
    chips.push({ icon: <ArrowUp className="h-3 w-3" />, text: `${(data.altitudeM / 1000).toFixed(1)} km` });
  }
  if (typeof data.speedKmh === 'number' && Number.isFinite(data.speedKmh)) {
    chips.push({ icon: <Gauge className="h-3 w-3" />, text: `${Math.round(data.speedKmh)} km/h` });
  }

  return (
    <Surface
      accent={statusColor}
      header={
        <div className="flex min-w-0 items-center gap-2">
          <Plane className="h-4 w-4 shrink-0" style={{ color: statusColor }} />
          <div className="min-w-0">
            <SurfaceTitle>{title || 'Flight'}</SurfaceTitle>
            {route && <SurfaceSubtitle>{route}</SurfaceSubtitle>}
          </div>
        </div>
      }
      right={
        <div className="flex flex-col items-end gap-0.5">
          <div className="flex items-center gap-1">
            {data.live && <Badge color={BULL}>Live</Badge>}
            {statusBadge}
          </div>
          {updated && <SurfaceSubtitle>updated {updated}</SurfaceSubtitle>}
        </div>
      }
    >
      <div className="space-y-2 px-3 pb-3 pt-0.5">
        <RouteArc
          from={data.departure?.code}
          to={data.arrival?.code}
          progress={progress}
          planeT={planeT}
          color={statusColor}
          pulse={phase === 'active'}
        />

        <div className="grid grid-cols-2 gap-3">
          <EndpointColumn label="Departure" point={data.departure} align="left" delayed={delayed} />
          <EndpointColumn label="Arrival" point={data.arrival} align="right" />
        </div>

        {(chips.length > 0 || delayChip) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((c, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--ds-ink)]"
              >
                <span className="text-[var(--ds-muted)]">{c.icon}</span>
                <span className="font-semibold">{c.text}</span>
              </span>
            ))}
            {delayChip}
          </div>
        )}

        {data.statusNote && <SurfaceSubtitle>{data.statusNote}</SurfaceSubtitle>}
      </div>
    </Surface>
  );
};
