import React, { useMemo, useState } from 'react';
import {
  Plane,
  TrainFront,
  Bus,
  Car,
  Ship,
  Footprints,
  BedDouble,
  UtensilsCrossed,
  Landmark,
  Ticket,
  ShoppingBag,
  MapPin,
  ArrowRight,
  ExternalLink,
  Check,
  CheckCircle2,
  CloudSun,
  Droplets,
  LayoutDashboard
} from 'lucide-react';
import { createDashboard } from '../../../services/customDashboards';
import type { ItineraryArtifact, ItineraryDay, ItineraryStop, ItineraryStopKind, ItineraryTransport, MapArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Expandable, useCompact, resolveTheme, formatPrice } from './kit';
import { InlineMap } from './InlineMap';

// Travel itinerary card — the full interactive trip widget.
//  • detailed — weather chip + forecast strip, macOS segmented day tabs (with per-day
//    cost chips), a stop timeline (kind icons, expandable notes, costs), an inline map
//    of the active day's located stops with a route polyline, a budget footer, and an
//    expandable tips & packing section.
//  • compact — a ~140px glance card: destination, dates, "N days · M stops", weather
//    chip, and the first stops of day one as a muted one-liner. No tabs, no map.

const KIND_ICONS: Record<ItineraryStopKind, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  flight: Plane,
  transit: TrainFront,
  train: TrainFront,
  bus: Bus,
  car: Car,
  ferry: Ship,
  walk: Footprints,
  hotel: BedDouble,
  food: UtensilsCrossed,
  sight: Landmark,
  activity: Ticket,
  shopping: ShoppingBag,
  other: MapPin
};

const TRANSPORT_KINDS = new Set<ItineraryStopKind>(['flight', 'transit', 'train', 'bus', 'car', 'ferry', 'walk']);
const MODE_ICONS: Record<NonNullable<ItineraryTransport['mode']>, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  flight: Plane,
  train: TrainFront,
  bus: Bus,
  car: Car,
  ferry: Ship,
  walk: Footprints,
  transit: TrainFront
};

/** A stop is a transport leg when it carries structured transport data or a travel kind. */
const isTransportStop = (s: ItineraryStop): boolean => !!s.transport || (!!s.kind && TRANSPORT_KINDS.has(s.kind));

/**
 * Turn a finalized trip into a live dashboard — destination weather, a map of the
 * trip's located stops, local news and places to eat. One tap; no manual board
 * building. (Tiles are whitelisted live-data calls, so the board refreshes itself.)
 */
const saveTripAsDashboard = (data: ItineraryArtifact): void => {
  const destination = data.destination || data.title;
  const located = data.days
    .flatMap((d) => d.stops)
    .filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
    .map((s) => (data.destination ? `${s.name}, ${data.destination}` : s.name))
    .slice(0, 8);
  createDashboard(`Trip: ${destination}`, '🧳', [
    { tool: 'get_weather', args: { location: destination }, label: destination, density: 'detailed' },
    ...(located.length ? [{ tool: 'show_map', args: { places: located }, label: 'Trip map', density: 'detailed' as const }] : []),
    { tool: 'get_news', args: { query: destination }, label: `${destination} news`, density: 'compact' },
    { tool: 'find_places', args: { query: 'restaurants', near: destination }, label: `Eat · ${destination}`, density: 'compact' }
  ]);
};

const shortDay = (iso?: string): string => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const weekday = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short' });
};

const durationLabel = (min?: number): string | undefined => {
  if (typeof min !== 'number' || min <= 0) return undefined;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

const dayCost = (day: ItineraryDay): number =>
  day.stops.reduce((sum, s) => sum + (typeof s.cost === 'number' ? s.cost : 0), 0);

/** "Tokyo, Japan · Jul 10 – Jul 12 · 2 travelers" */
const metaLine = (data: ItineraryArtifact): string => {
  const range = [shortDay(data.startDate), shortDay(data.endDate)].filter(Boolean).join(' – ');
  return [
    data.destination,
    range,
    typeof data.travelers === 'number' ? `${data.travelers} traveler${data.travelers === 1 ? '' : 's'}` : undefined
  ]
    .filter(Boolean)
    .join(' · ');
};

// ── Live weather chip (header) ────────────────────────────────────────────────
const WeatherChip: React.FC<{ weather: NonNullable<ItineraryArtifact['weather']> }> = ({ weather }) => {
  const temp =
    typeof weather.tempC === 'number'
      ? `${Math.round(weather.tempC)}°C`
      : typeof weather.tempF === 'number'
        ? `${Math.round(weather.tempF)}°F`
        : undefined;
  if (!temp && !weather.description) return null;
  return (
    <span className="inline-flex max-w-[160px] items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[11px] text-[var(--ds-muted)]">
      <CloudSun className="h-3 w-3 shrink-0 text-sky-600" />
      {temp && <span className="font-semibold tabular-nums text-[var(--ds-ink)]">{temp}</span>}
      {weather.description && <span className="truncate">{weather.description}</span>}
    </span>
  );
};

// ── Slim multi-day forecast strip (recessed well) ─────────────────────────────
const ForecastStrip: React.FC<{ daily: NonNullable<NonNullable<ItineraryArtifact['weather']>['daily']> }> = ({ daily }) => (
  <div className="flex divide-x divide-[var(--ds-hairline-soft)] overflow-hidden rounded-xl bg-[var(--ds-well)]">
    {daily.slice(0, 7).map((d) => (
      <div key={d.date} className="min-w-0 flex-1 px-2 py-1.5 text-center" title={d.description}>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{weekday(d.date)}</p>
        <p className="text-[11px] tabular-nums text-[var(--ds-ink)]">
          {typeof d.maxC === 'number' ? `${Math.round(d.maxC)}°` : '–'}
          <span className="text-[var(--ds-muted)]">/{typeof d.minC === 'number' ? `${Math.round(d.minC)}°` : '–'}</span>
        </p>
        {typeof d.precipProb === 'number' && (
          <p className="flex items-center justify-center gap-0.5 text-[10px] tabular-nums text-sky-700/80">
            <Droplets className="h-2.5 w-2.5" />
            {Math.round(d.precipProb)}%
          </p>
        )}
      </div>
    ))}
  </div>
);

// ── Day tabs — macOS segmented control with optional per-day cost chips ───────
const DayTabs: React.FC<{
  days: ItineraryDay[];
  active: number;
  accent: string;
  currency: string;
  onChange: (i: number) => void;
}> = ({ days, active, accent, currency, onChange }) => (
  <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-well-strong)] p-0.5 text-[11px] font-semibold">
    {days.map((d, i) => {
      const isActive = i === active;
      const cost = dayCost(d);
      return (
        <button
          key={i}
          onClick={() => onChange(i)}
          aria-pressed={isActive}
          className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 transition-all duration-200 ${
            isActive ? 'bg-[var(--ds-raised)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
          }`}
          style={isActive ? { color: accent } : undefined}
        >
          Day {i + 1}
          {cost > 0 && (
            <span className={`text-[9px] font-medium tabular-nums ${isActive ? 'opacity-70' : 'text-[var(--ds-muted)]'}`}>
              {formatPrice(cost, currency)}
            </span>
          )}
        </button>
      );
    })}
  </div>
);

// ── Per-day weather pill, matched from the trip's daily forecast by date ──────
const dayWeather = (
  weather: ItineraryArtifact['weather'],
  date?: string
): NonNullable<NonNullable<ItineraryArtifact['weather']>['daily']>[number] | undefined =>
  date ? weather?.daily?.find((d) => d.date === date) : undefined;

// ── Transport leg — a rich row: mode icon, from → to, carrier · code, times ────
const TransportLeg: React.FC<{ stop: ItineraryStop; currency: string; accent: string }> = ({ stop, currency, accent }) => {
  const tp = stop.transport ?? {};
  const mode = tp.mode ?? (stop.kind && stop.kind !== 'other' ? (stop.kind as NonNullable<ItineraryTransport['mode']>) : 'transit');
  const Icon = MODE_ICONS[mode] ?? TrainFront;
  const dur = durationLabel(stop.durationMin);
  const from = tp.from;
  const to = tp.to;
  const carrierLine = [tp.carrier, tp.code].filter(Boolean).join(' · ');
  return (
    <li className="px-3 py-2">
      <div className="flex items-stretch gap-2.5 rounded-xl border border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] p-2.5 transition-colors duration-200 hover:bg-[var(--ds-well-strong)]">
        <span className="w-11 shrink-0 pt-px text-[11px] tabular-nums text-[var(--ds-muted)]">{stop.time ?? tp.depart ?? ''}</span>
        <span
          className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${accent}1a`, color: accent }}
          title={mode}
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          {/* Route line: from → to (falls back to the stop name). */}
          {from || to ? (
            <p className="flex items-center gap-1.5 text-[12px] font-semibold leading-snug text-[var(--ds-ink)]">
              <span className="truncate">{from}</span>
              <ArrowRight className="h-3 w-3 shrink-0 text-[var(--ds-muted)]" />
              <span className="truncate">{to}</span>
            </p>
          ) : (
            <p className="truncate text-[12px] font-semibold leading-snug text-[var(--ds-ink)]">{stop.name}</p>
          )}
          {/* Carrier · code, then a depart→arrive time strip. */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--ds-muted)]">
            {carrierLine && <span className="truncate">{carrierLine}</span>}
            {(tp.depart || tp.arrive) && (
              <span className="inline-flex items-center gap-1 tabular-nums">
                {tp.depart && <span className="font-medium text-[var(--ds-ink)]">{tp.depart}</span>}
                {tp.depart && tp.arrive && <span className="text-[var(--ds-muted)]">→</span>}
                {tp.arrive && <span className="font-medium text-[var(--ds-ink)]">{tp.arrive}</span>}
              </span>
            )}
            {dur && <span>· {dur}</span>}
            {(from || to) && stop.name && stop.name !== `${from} → ${to}` && (
              <span className="truncate opacity-80">· {stop.name}</span>
            )}
          </div>
          {stop.notes && <p className="mt-0.5 truncate text-[11px] text-[var(--ds-muted)]">{stop.notes}</p>}
        </div>
        {typeof stop.cost === 'number' && (
          <span className="shrink-0 pt-px text-right text-[11px] font-semibold tabular-nums text-[var(--ds-ink)]">
            {formatPrice(stop.cost, currency)}
          </span>
        )}
      </div>
    </li>
  );
};

// ── One stop on the timeline ──────────────────────────────────────────────────
const StopRow: React.FC<{ stop: ItineraryStop; currency: string; accent: string }> = ({ stop, currency, accent }) => {
  const [notesOpen, setNotesOpen] = useState(false);
  const Icon = KIND_ICONS[stop.kind ?? 'other'] ?? MapPin;
  const dur = durationLabel(stop.durationMin);
  return (
    <li className="flex items-start gap-2.5 px-3 py-2 transition-colors duration-200 hover:bg-[var(--ds-well)]">
      <span className="w-11 shrink-0 pt-px text-[11px] tabular-nums text-[var(--ds-muted)]">{stop.time ?? ''}</span>
      <span
        className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--ds-well-strong)]"
        title={stop.kind ?? 'other'}
      >
        <Icon className="h-3 w-3" style={{ color: accent }} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[12px] font-medium leading-snug text-[var(--ds-ink)]">
          <span className="truncate">{stop.name}</span>
          {stop.url && (
            <a
              href={stop.url}
              target="_blank"
              rel="noopener noreferrer"
              title={stop.url}
              className="shrink-0 text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)]"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {dur && <span className="shrink-0 text-[10px] font-normal text-[var(--ds-muted)]">· {dur}</span>}
        </p>
        {stop.address && <p className="truncate text-[11px] text-[var(--ds-muted)]">{stop.address}</p>}
        {stop.notes && (
          <button
            onClick={() => setNotesOpen((v) => !v)}
            title={notesOpen ? 'Collapse notes' : 'Expand notes'}
            className={`block w-full text-left text-[11px] text-[var(--ds-muted)] transition-colors duration-200 hover:text-[var(--ds-ink)] ${
              notesOpen ? '' : 'truncate'
            }`}
          >
            {stop.notes}
          </button>
        )}
      </div>
      {typeof stop.cost === 'number' && (
        <span className="shrink-0 pt-px text-right text-[11px] font-semibold tabular-nums text-[var(--ds-ink)]">
          {formatPrice(stop.cost, currency)}
        </span>
      )}
    </li>
  );
};

// ── Budget footer ─────────────────────────────────────────────────────────────
const BudgetFooter: React.FC<{ data: ItineraryArtifact; currency: string }> = ({ data, currency }) => {
  const stopsCost = data.days.reduce((sum, d) => sum + dayCost(d), 0);
  const budget = data.budget;
  const hasBudget = !!budget && ((budget.lines?.length ?? 0) > 0 || typeof budget.total === 'number');
  if (!hasBudget && stopsCost <= 0) return null;
  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Budget</p>
      <dl className="space-y-0.5">
        {hasBudget ? (
          <>
            {(budget?.lines ?? []).map((line, i) => (
              <div key={i} className="flex items-baseline justify-between gap-2 text-[11px] text-[var(--ds-muted)]">
                <dt className="min-w-0 truncate">{line.label}</dt>
                <dd className="shrink-0 tabular-nums text-[var(--ds-ink)]">{formatPrice(line.amount, currency)}</dd>
              </div>
            ))}
            {typeof budget?.total === 'number' && (
              <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-[var(--ds-hairline)] pt-1 text-[12px] font-semibold text-[var(--ds-ink)]">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatPrice(budget.total, currency)}</dd>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-baseline justify-between gap-2 text-[12px] font-semibold text-[var(--ds-ink)]">
            <dt className="flex items-baseline gap-1">
              Stops cost <span className="text-[10px] font-normal text-[var(--ds-muted)]">(from listed stop prices)</span>
            </dt>
            <dd className="tabular-nums">{formatPrice(stopsCost, currency)}</dd>
          </div>
        )}
      </dl>
    </div>
  );
};

// ── Tips & packing checklists ─────────────────────────────────────────────────
const CheckList: React.FC<{ label: string; items: string[] }> = ({ label, items }) => (
  <div className="min-w-0">
    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{label}</p>
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--ds-ink)] opacity-80">
          <CheckCircle2 className="mt-px h-3 w-3 shrink-0 text-emerald-600/80" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  </div>
);

// ── Card ──────────────────────────────────────────────────────────────────────
export const ItineraryCard: React.FC<{ data: ItineraryArtifact }> = ({ data }) => {
  const compact = useCompact();
  const theme = resolveTheme({ palette: (data.palette as never) ?? 'ocean' });
  const [activeDay, setActiveDay] = useState(0);
  // "Save as dashboard" confirmation beat.
  const [savedBoard, setSavedBoard] = useState(false);
  const currency = data.currency ?? 'USD';
  const days = data.days ?? [];
  const totalStops = days.reduce((n, d) => n + d.stops.length, 0);
  const day = days[Math.min(activeDay, Math.max(0, days.length - 1))];

  // Map of the active day's located stops, in visit order, with a route polyline.
  const dayMap = useMemo<MapArtifact | null>(() => {
    if (!day) return null;
    const located = day.stops.filter((s): s is ItineraryStop & { lat: number; lng: number } =>
      typeof s.lat === 'number' && typeof s.lng === 'number'
    );
    if (located.length === 0) return null;
    const points = located.map((s) => ({ lat: s.lat, lng: s.lng }));
    return {
      title: day.label ?? `Day ${activeDay + 1}`,
      markers: located.map((s, i) => ({
        lat: s.lat,
        lng: s.lng,
        label: `${i + 1}. ${s.name}`,
        description: [s.time, s.address, s.notes].filter(Boolean).join(' · ') || undefined
      })),
      route: points.length > 1 ? points : undefined
    };
  }, [day, activeDay]);

  if (days.length === 0) return null;

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <Plane className="h-4 w-4 shrink-0" style={{ color: theme.accent }} />
      <div className="min-w-0">
        <SurfaceTitle>{data.title}</SurfaceTitle>
        <SurfaceSubtitle>{metaLine(data)}</SurfaceSubtitle>
      </div>
    </div>
  );

  // ── Compact: a ~140px glance card. ──────────────────────────────────────────
  if (compact) {
    const firstStops = days[0]?.stops.slice(0, 3).map((s) => s.name) ?? [];
    return (
      <Surface accent={theme.accent} header={header} right={data.weather ? <WeatherChip weather={data.weather} /> : undefined}>
        <div className="border-t border-[var(--ds-hairline-soft)] px-3 py-2">
          <p className="text-[11px] text-[var(--ds-muted)]">
            <span className="font-semibold text-[var(--ds-ink)]">{days.length} day{days.length === 1 ? '' : 's'}</span>
            {' · '}
            {totalStops} stop{totalStops === 1 ? '' : 's'}
          </p>
          {firstStops.length > 0 && (
            <p className="mt-0.5 truncate text-[11px] text-[var(--ds-muted)]">{firstStops.join(' · ')}</p>
          )}
        </div>
      </Surface>
    );
  }

  // ── Detailed. ────────────────────────────────────────────────────────────────
  const hasTipsOrPacking = (data.tips?.length ?? 0) > 0 || (data.packing?.length ?? 0) > 0;

  return (
    <Surface
      accent={theme.accent}
      header={header}
      right={
        <span className="flex shrink-0 items-center gap-1.5">
          {data.weather && <WeatherChip weather={data.weather} />}
          {/* Finalized the plan? One tap turns it into a live trip dashboard. */}
          <button
            type="button"
            onClick={() => {
              saveTripAsDashboard(data);
              setSavedBoard(true);
              window.setTimeout(() => setSavedBoard(false), 2000);
            }}
            title={savedBoard ? 'Saved — open Dashboards in the sidebar' : 'Save this trip as a live dashboard (weather, map, news, places)'}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-colors duration-200 ${
              savedBoard
                ? 'border-emerald-600/40 text-emerald-600'
                : 'border-[var(--ds-hairline)] text-[var(--ds-muted)] hover:border-[var(--ds-accent)] hover:text-[var(--ds-ink)]'
            }`}
          >
            {savedBoard ? <Check className="h-3 w-3" /> : <LayoutDashboard className="h-3 w-3" />}
            {savedBoard ? 'Saved' : 'Make board'}
          </button>
        </span>
      }
      footer={<BudgetFooter data={data} currency={currency} />}
    >
      {data.weather?.daily && data.weather.daily.length > 0 && (
        <div className="px-3 pb-2">
          <ForecastStrip daily={data.weather.daily} />
        </div>
      )}

      <div className="border-t border-[var(--ds-hairline-soft)] px-3 pt-2">
        <DayTabs days={days} active={activeDay} accent={theme.accent} currency={currency} onChange={setActiveDay} />
        <div className="mt-1.5 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-tight text-[var(--ds-ink)]">
              {day.label ?? `Day ${activeDay + 1}`}
              {day.date && <span className="ml-1.5 text-[11px] font-normal text-[var(--ds-muted)]">{shortDay(day.date)}</span>}
            </p>
            {day.summary && <p className="text-[11px] text-[var(--ds-muted)]">{day.summary}</p>}
          </div>
          {/* Small per-day weather — the live forecast for this exact date. */}
          {(() => {
            const w = dayWeather(data.weather, day.date);
            if (!w || (typeof w.maxC !== 'number' && typeof w.minC !== 'number')) return null;
            return (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[11px] text-[var(--ds-muted)]"
                title={w.description}
              >
                <CloudSun className="h-3 w-3 shrink-0 text-sky-600" />
                <span className="font-semibold tabular-nums text-[var(--ds-ink)]">
                  {typeof w.maxC === 'number' ? `${Math.round(w.maxC)}°` : '–'}
                  <span className="text-[var(--ds-muted)]">/{typeof w.minC === 'number' ? `${Math.round(w.minC)}°` : '–'}</span>
                </span>
                {typeof w.precipProb === 'number' && w.precipProb > 0 && (
                  <span className="inline-flex items-center gap-0.5 tabular-nums text-sky-700/80">
                    <Droplets className="h-2.5 w-2.5" />
                    {Math.round(w.precipProb)}%
                  </span>
                )}
              </span>
            );
          })()}
        </div>
      </div>

      {/* Day timeline. Keyed by activeDay so switching days gently fades the new plan in. */}
      <ul key={activeDay} className="mt-1 animate-fade-in divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {day.stops.map((stop, i) =>
          isTransportStop(stop) ? (
            <TransportLeg key={`${activeDay}-${i}`} stop={stop} currency={currency} accent={theme.accent} />
          ) : (
            <StopRow key={`${activeDay}-${i}`} stop={stop} currency={currency} accent={theme.accent} />
          )
        )}
      </ul>

      {dayMap && (
        <div className="border-t border-[var(--ds-hairline-soft)] px-3 py-2">
          <InlineMap data={dayMap} height={200} />
        </div>
      )}

      {hasTipsOrPacking && (
        <Expandable moreLabel="Tips & packing" lessLabel="Tips & packing">
          <div className="grid grid-cols-1 gap-3 px-3 py-2.5 sm:grid-cols-2">
            {(data.tips?.length ?? 0) > 0 && <CheckList label="Tips" items={data.tips!} />}
            {(data.packing?.length ?? 0) > 0 && <CheckList label="Packing" items={data.packing!} />}
          </div>
        </Expandable>
      )}
    </Surface>
  );
};
