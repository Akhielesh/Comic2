import React, { useState } from 'react';
import { Plane } from 'lucide-react';
import type { BoardingPassArtifact, BoardingPassStatus } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Badge, withAlpha, useCompact } from './kit';

// Apple-Wallet boarding pass in the calm-studio glass language.
//  • detailed — a 3D flip card: the FRONT is the pass (airline + flight + status
//    badge, big IATA route with a plane on a hairline, gate/seat/group/boards
//    stats and a QR of the confirmation); tapping flips (rotateY) to the BACK
//    with passenger, fare, baggage, aircraft, duration and agent tips. A soft
//    status-colored edge glow tints the card. Reduced motion swaps instantly.
//  • compact — a one-row glance: "UA 82 · IAD → BLR · 10:45" + status badge,
//    gate/seat inline muted. No flip, no QR.

const STATUS_COLORS: Record<BoardingPassStatus, string> = {
  'on-time': '#059669',
  boarding: '#059669',
  delayed: '#f59e0b',
  cancelled: '#dc2626',
  departed: '#64748b'
};

const STATUS_LABELS: Record<BoardingPassStatus, string> = {
  'on-time': 'On time',
  boarding: 'Boarding',
  delayed: 'Delayed',
  cancelled: 'Cancelled',
  departed: 'Departed'
};

/** 155 → "2h 35m". */
const durationLabel = (min?: number): string | undefined => {
  if (typeof min !== 'number' || !Number.isFinite(min) || min <= 0) return undefined;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

/** Tiny labeled stat: 10px uppercase muted label over a 13px semibold value. */
const Stat: React.FC<{ label: string; value?: string }> = ({ label, value }) => (
  <div className="min-w-0">
    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{label}</p>
    <p className="truncate text-[13px] font-semibold tabular-nums text-[var(--ds-ink)]">{value ?? '—'}</p>
  </div>
);

/** One side of the route: big IATA code with city/time/date muted beneath. */
const Endpoint: React.FC<{ point: BoardingPassArtifact['from']; align: 'left' | 'right' }> = ({ point, align }) => (
  <div className={`min-w-0 ${align === 'right' ? 'text-right' : 'text-left'}`}>
    <p className="text-3xl font-semibold tracking-tight text-[var(--ds-ink)]">{point?.code ?? '—'}</p>
    {point?.city && <p className="truncate text-[11px] text-[var(--ds-muted)]">{point.city}</p>}
    {(point?.time || point?.date) && (
      <p className="truncate text-[11px] tabular-nums text-[var(--ds-muted)]">
        {point.time && <span className="font-medium text-[var(--ds-ink)]">{point.time}</span>}
        {point.time && point.date && ' · '}
        {point.date}
      </p>
    )}
  </div>
);

/** "Passenger / Confirmation / …" row on the back of the pass. */
const BackRow: React.FC<{ label: string; value?: string }> = ({ label, value }) =>
  value ? (
    <div className="flex items-baseline justify-between gap-2 text-[11px]">
      <dt className="shrink-0 text-[var(--ds-muted)]">{label}</dt>
      <dd className="min-w-0 truncate text-right font-semibold tabular-nums text-[var(--ds-ink)]">{value}</dd>
    </div>
  ) : null;

export const BoardingPass: React.FC<{ data: BoardingPassArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [flipped, setFlipped] = useState(false);

  if (!data.from?.code && !data.to?.code && !data.flightNumber) return null;

  const accent = data.accent ?? '#0ea5e9';
  const status = data.status && STATUS_COLORS[data.status] ? data.status : undefined;
  const statusColor = status ? STATUS_COLORS[status] : '#64748b';
  const qrPayload = data.confirmation ?? data.flightNumber;
  const notes = data.notes ?? [];
  const dur = durationLabel(data.durationMin);

  const statusBadge = status ? (
    <Badge color={statusColor} title={data.statusNote}>{STATUS_LABELS[status]}</Badge>
  ) : null;

  // ── Compact: a single glance row — flight · route · time + status. ──────────
  if (compact) {
    return (
      <Surface accent={accent}>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Plane className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tabular-nums text-[var(--ds-ink)]">
            {data.flightNumber}
            {' · '}
            {data.from?.code ?? '—'} → {data.to?.code ?? '—'}
            {data.from?.time ? ` · ${data.from.time}` : ''}
          </span>
          {(data.gate || data.seat) && (
            <span className="shrink-0 text-[11px] tabular-nums text-[var(--ds-muted)]">
              {[data.gate && `Gate ${data.gate}`, data.seat && `Seat ${data.seat}`].filter(Boolean).join(' · ')}
            </span>
          )}
          {statusBadge}
        </div>
      </Surface>
    );
  }

  // ── Detailed: the flip card. ─────────────────────────────────────────────────
  const face =
    'absolute inset-0 flex flex-col justify-between rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-raised)] p-3 [backface-visibility:hidden]';

  return (
    <Surface accent={accent}>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={flipped}
        aria-label={flipped ? 'Show boarding pass' : 'Show flight details'}
        onClick={() => setFlipped((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setFlipped((v) => !v);
          }
        }}
        className="m-3 h-[230px] cursor-pointer [perspective:1000px] focus:outline-none"
      >
        <div
          className="relative h-full w-full rounded-xl transition-transform duration-500 motion-reduce:transition-none [transform-style:preserve-3d]"
          style={{
            transform: flipped ? 'rotateY(180deg)' : 'rotateY(0deg)',
            boxShadow: `0 0 0 1px ${withAlpha(statusColor, 0.25)}, 0 0 16px ${withAlpha(statusColor, 0.25)}`
          }}
        >
          {/* FRONT — the pass */}
          <div className={face}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <SurfaceTitle>{data.airline}</SurfaceTitle>
                <span className="shrink-0 text-[11px] font-medium tabular-nums text-[var(--ds-muted)]">{data.flightNumber}</span>
              </div>
              {statusBadge}
            </div>

            <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
              <Endpoint point={data.from} align="left" />
              <div className="flex items-center gap-1">
                <span className="h-px w-5 bg-[var(--ds-hairline)] sm:w-8" />
                <Plane className="h-4 w-4 rotate-45 text-[var(--ds-muted)]" />
                <span className="h-px w-5 bg-[var(--ds-hairline)] sm:w-8" />
              </div>
              <Endpoint point={data.to} align="right" />
            </div>

            <div>
              <div className="flex items-end justify-between gap-3">
                <div className="grid min-w-0 flex-1 grid-cols-4 gap-2">
                  <Stat label="Gate" value={data.gate} />
                  <Stat label="Seat" value={data.seat} />
                  <Stat label="Group" value={data.boardingGroup} />
                  <Stat label="Boards" value={data.boardingTime} />
                </div>
                {qrPayload && (
                  <img
                    src={`https://api.qrserver.com/v1/create-qr-code/?size=96x96&data=${encodeURIComponent(qrPayload)}`}
                    alt={`QR code for ${qrPayload}`}
                    loading="lazy"
                    className="h-16 w-16 shrink-0 rounded bg-white p-1 ring-1 ring-[var(--ds-hairline)]"
                  />
                )}
              </div>
              <p className="mt-1 text-[9px] text-[var(--ds-muted)]">tap for details ↻</p>
            </div>
          </div>

          {/* BACK — fare / baggage / tips */}
          <div className={`${face} overflow-hidden`} style={{ transform: 'rotateY(180deg)' }}>
            <div className="min-h-0">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Flight details</p>
                <span className="text-[11px] font-medium tabular-nums text-[var(--ds-muted)]">{data.flightNumber}</span>
              </div>
              <dl className="space-y-1">
                <BackRow label="Passenger" value={data.passenger} />
                <BackRow label="Confirmation" value={data.confirmation} />
                <BackRow label="Fare class" value={data.fareClass} />
                <BackRow label="Baggage" value={data.baggage} />
                <BackRow label="Aircraft" value={data.aircraft} />
                <BackRow label="Duration" value={dur} />
              </dl>
              {notes.length > 0 && (
                <ul className="mt-2 space-y-0.5 border-t border-[var(--ds-hairline-soft)] pt-1.5">
                  {notes.slice(0, 3).map((n, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--ds-ink)] opacity-80">
                      <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full" style={{ backgroundColor: statusColor }} />
                      <span className="min-w-0">{n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-[9px] text-[var(--ds-muted)]">tap to flip back ↻</p>
          </div>
        </div>
      </div>
      {data.statusNote && (
        <div className="px-3 pb-2.5 -mt-1">
          <SurfaceSubtitle>{data.statusNote}</SurfaceSubtitle>
        </div>
      )}
    </Surface>
  );
};
