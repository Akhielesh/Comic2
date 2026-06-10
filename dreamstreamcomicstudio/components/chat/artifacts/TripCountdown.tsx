import React, { useEffect, useState } from 'react';
import { CheckCircle2, Circle, CloudSun, Droplets, Plane } from 'lucide-react';
import type { TripCountdownArtifact } from '../../../apiTypes';
import { Surface, SurfaceSubtitle, useCompact, shortDate } from './kit';

// Trip countdown hero — a live second-by-second countdown to departure.
//  • detailed — big destination + four DAYS/HRS/MIN/SEC stat blocks ticking in
//    real time (rolls over to "Trip in progress · day N" between the dates, then
//    "Trip completed"), the live destination weather strip (current + up to five
//    daily chips) and a read-only prep checklist.
//  • compact — a one-liner: "Bali · 23 days to go" + start date muted and the
//    current temperature chip when the server attached weather.

const DAY_MS = 86_400_000;

type Phase = 'upcoming' | 'active' | 'done';

/** "Tue, Jun 10" header-style date for the start line. */
const startLabel = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

const StatBlock: React.FC<{ value: number; label: string }> = ({ value, label }) => (
  <div className="flex-1 rounded-xl bg-[var(--ds-well)] px-3 py-2 text-center">
    <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--ds-ink)]">
      {String(value).padStart(2, '0')}
    </p>
    <p className="text-[9px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{label}</p>
  </div>
);

// Slim daily forecast strip, in the same recessed-well language as ItineraryCard.
const WeatherStrip: React.FC<{ weather: NonNullable<TripCountdownArtifact['weather']> }> = ({ weather }) => {
  const daily = (weather.daily ?? []).slice(0, 5);
  const current = [
    typeof weather.tempC === 'number' ? `${Math.round(weather.tempC)}°C` : null,
    weather.description
  ].filter(Boolean);
  if (!current.length && !daily.length) return null;
  return (
    <div>
      {current.length > 0 && (
        <p className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--ds-muted)]">
          <CloudSun className="h-3.5 w-3.5 shrink-0 text-sky-600" />
          {typeof weather.tempC === 'number' && (
            <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{Math.round(weather.tempC)}°C</span>
          )}
          {weather.description && <span className="truncate">{weather.description}</span>}
        </p>
      )}
      {daily.length > 0 && (
        <div className="flex divide-x divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl bg-[var(--ds-well)]">
          {daily.map((d) => (
            <div key={d.date} className="min-w-0 flex-1 px-2 py-1.5 text-center" title={d.description}>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{shortDate(d.date)}</p>
              <p className="text-[11px] tabular-nums text-[var(--ds-ink)]">
                {typeof d.maxC === 'number' ? `${Math.round(d.maxC)}°` : '–'}
                <span className="text-[var(--ds-muted)]">/{typeof d.minC === 'number' ? `${Math.round(d.minC)}°` : '–'}</span>
              </p>
              {typeof d.precipProb === 'number' && d.precipProb >= 30 && (
                <p className="flex items-center justify-center gap-0.5 text-[10px] tabular-nums text-sky-700/80">
                  <Droplets className="h-2.5 w-2.5" />
                  {Math.round(d.precipProb)}%
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export const TripCountdown: React.FC<{ data: TripCountdownArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const start = new Date(data.startDate).getTime();
  if (!data.destination || !Number.isFinite(start)) return null;

  const endRaw = data.endDate ? new Date(data.endDate).getTime() : NaN;
  const end = Number.isFinite(endRaw) ? endRaw : undefined;

  const phase: Phase = now < start ? 'upcoming' : end !== undefined && now >= end ? 'done' : 'active';
  const diff = Math.max(0, start - now);
  const days = Math.floor(diff / DAY_MS);
  const hrs = Math.floor(diff / 3_600_000) % 24;
  const min = Math.floor(diff / 60_000) % 60;
  const sec = Math.floor(diff / 1_000) % 60;
  const dayN = Math.floor((now - start) / DAY_MS) + 1;

  const accent = data.accent ?? '#0ea5e9';
  const tempChip =
    typeof data.weather?.tempC === 'number' ? (
      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[11px]">
        <CloudSun className="h-3 w-3 shrink-0 text-sky-600" />
        <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{Math.round(data.weather.tempC)}°C</span>
      </span>
    ) : undefined;

  const phaseLine =
    phase === 'upcoming'
      ? days > 0
        ? `${days} day${days === 1 ? '' : 's'} to go`
        : 'less than a day to go'
      : phase === 'active'
        ? `day ${dayN}`
        : 'trip completed';

  // ── Compact: "✈ Bali · 23 days to go" one-liner. ─────────────────────────────
  if (compact) {
    return (
      <Surface accent={accent}>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Plane className="h-3.5 w-3.5 shrink-0" style={{ color: accent }} />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ds-ink)]">
            <span className="font-semibold">{data.destination}</span>
            <span className="tabular-nums"> · {phaseLine}</span>
          </span>
          <span className="shrink-0 text-[11px] text-[var(--ds-muted)]">{startLabel(data.startDate)}</span>
          {tempChip}
        </div>
      </Surface>
    );
  }

  // ── Detailed: hero countdown + weather + checklist. ──────────────────────────
  const checklist = data.checklist ?? [];

  return (
    <Surface
      accent={accent}
      header={
        <div className="flex min-w-0 items-center gap-2">
          <Plane className="h-4 w-4 shrink-0" style={{ color: accent }} />
          <div className="min-w-0">
            <h3 className="truncate text-lg font-semibold tracking-tight text-[var(--ds-ink)]">{data.destination}</h3>
            <SurfaceSubtitle>
              {[data.title, `Starts ${startLabel(data.startDate)}`, data.endDate ? `ends ${shortDate(data.endDate)}` : null]
                .filter(Boolean)
                .join(' · ')}
            </SurfaceSubtitle>
          </div>
        </div>
      }
      right={tempChip}
    >
      <div className="space-y-2.5 px-3 pb-3 pt-0.5">
        {phase === 'upcoming' ? (
          <div className="flex gap-2">
            <StatBlock value={days} label="Days" />
            <StatBlock value={hrs} label="Hrs" />
            <StatBlock value={min} label="Min" />
            <StatBlock value={sec} label="Sec" />
          </div>
        ) : (
          <div className="rounded-xl bg-[var(--ds-well)] px-3 py-2.5 text-center">
            <p className="text-lg font-semibold tracking-tight text-[var(--ds-ink)]">
              {phase === 'active' ? (
                <>
                  Trip in progress <span className="text-[var(--ds-muted)]">·</span>{' '}
                  <span className="tabular-nums">day {dayN}</span>
                </>
              ) : (
                'Trip completed'
              )}
            </p>
            {phase === 'active' && data.endDate && (
              <p className="text-[11px] text-[var(--ds-muted)]">ends {shortDate(data.endDate)}</p>
            )}
          </div>
        )}

        {data.weather && <WeatherStrip weather={data.weather} />}

        {checklist.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Before you go</p>
            <ul className="space-y-1">
              {checklist.map((item, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug">
                  {item.done ? (
                    <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-emerald-600/80" />
                  ) : (
                    <Circle className="mt-px h-3 w-3 shrink-0 text-[var(--ds-muted)]" />
                  )}
                  <span
                    className={`min-w-0 ${
                      item.done
                        ? 'text-[var(--ds-muted)] line-through decoration-[var(--ds-hairline)]'
                        : 'text-[var(--ds-ink)] opacity-90'
                    }`}
                  >
                    {item.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Surface>
  );
};
