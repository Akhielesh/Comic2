import React, { useMemo, useState } from 'react';
import {
  Plane,
  TrainFront,
  BedDouble,
  UtensilsCrossed,
  Landmark,
  Ticket,
  ShoppingBag,
  MapPin,
  ExternalLink,
  CheckCircle2,
  CloudSun,
  Droplets
} from 'lucide-react';
import type { ItineraryArtifact, ItineraryDay, ItineraryStop, ItineraryStopKind, MapArtifact } from '../../../apiTypes';
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
  hotel: BedDouble,
  food: UtensilsCrossed,
  sight: Landmark,
  activity: Ticket,
  shopping: ShoppingBag,
  other: MapPin
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
    <span className="inline-flex max-w-[160px] items-center gap-1 rounded-full border border-black/10 bg-black/[0.03] px-2 py-0.5 text-[11px] text-[#6e6a60]">
      <CloudSun className="h-3 w-3 shrink-0 text-sky-600" />
      {temp && <span className="font-semibold tabular-nums text-[#1a1915]">{temp}</span>}
      {weather.description && <span className="truncate">{weather.description}</span>}
    </span>
  );
};

// ── Slim multi-day forecast strip (recessed well) ─────────────────────────────
const ForecastStrip: React.FC<{ daily: NonNullable<NonNullable<ItineraryArtifact['weather']>['daily']> }> = ({ daily }) => (
  <div className="flex divide-x divide-black/5 overflow-hidden rounded-xl bg-black/[0.03]">
    {daily.slice(0, 7).map((d) => (
      <div key={d.date} className="min-w-0 flex-1 px-2 py-1.5 text-center" title={d.description}>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">{weekday(d.date)}</p>
        <p className="text-[11px] tabular-nums text-[#1a1915]">
          {typeof d.maxC === 'number' ? `${Math.round(d.maxC)}°` : '–'}
          <span className="text-[#6e6a60]">/{typeof d.minC === 'number' ? `${Math.round(d.minC)}°` : '–'}</span>
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
  <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-black/10 bg-black/[0.04] p-0.5 text-[11px] font-semibold">
    {days.map((d, i) => {
      const isActive = i === active;
      const cost = dayCost(d);
      return (
        <button
          key={i}
          onClick={() => onChange(i)}
          aria-pressed={isActive}
          className={`flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 transition-all duration-200 ${
            isActive ? 'bg-white shadow-[0_1px_2px_rgba(0,0,0,0.12)]' : 'text-[#6e6a60] hover:text-[#1a1915]'
          }`}
          style={isActive ? { color: accent } : undefined}
        >
          Day {i + 1}
          {cost > 0 && (
            <span className={`text-[9px] font-medium tabular-nums ${isActive ? 'opacity-70' : 'text-[#6e6a60]/80'}`}>
              {formatPrice(cost, currency)}
            </span>
          )}
        </button>
      );
    })}
  </div>
);

// ── One stop on the timeline ──────────────────────────────────────────────────
const StopRow: React.FC<{ stop: ItineraryStop; currency: string; accent: string }> = ({ stop, currency, accent }) => {
  const [notesOpen, setNotesOpen] = useState(false);
  const Icon = KIND_ICONS[stop.kind ?? 'other'] ?? MapPin;
  const dur = durationLabel(stop.durationMin);
  return (
    <li className="flex items-start gap-2.5 px-3 py-2 transition-colors duration-200 hover:bg-black/[0.03]">
      <span className="w-11 shrink-0 pt-px text-[11px] tabular-nums text-[#6e6a60]">{stop.time ?? ''}</span>
      <span
        className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-black/[0.04]"
        title={stop.kind ?? 'other'}
      >
        <Icon className="h-3 w-3" style={{ color: accent }} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[12px] font-medium leading-snug text-[#1a1915]">
          <span className="truncate">{stop.name}</span>
          {stop.url && (
            <a
              href={stop.url}
              target="_blank"
              rel="noopener noreferrer"
              title={stop.url}
              className="shrink-0 text-[#6e6a60] transition-colors duration-200 hover:text-[#1a1915]"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {dur && <span className="shrink-0 text-[10px] font-normal text-[#6e6a60]">· {dur}</span>}
        </p>
        {stop.address && <p className="truncate text-[11px] text-[#6e6a60]/80">{stop.address}</p>}
        {stop.notes && (
          <button
            onClick={() => setNotesOpen((v) => !v)}
            title={notesOpen ? 'Collapse notes' : 'Expand notes'}
            className={`block w-full text-left text-[11px] text-[#6e6a60] transition-colors duration-200 hover:text-[#1a1915] ${
              notesOpen ? '' : 'truncate'
            }`}
          >
            {stop.notes}
          </button>
        )}
      </div>
      {typeof stop.cost === 'number' && (
        <span className="shrink-0 pt-px text-right text-[11px] font-semibold tabular-nums text-[#1a1915]">
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
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">Budget</p>
      <dl className="space-y-0.5">
        {hasBudget ? (
          <>
            {(budget?.lines ?? []).map((line, i) => (
              <div key={i} className="flex items-baseline justify-between gap-2 text-[11px] text-[#6e6a60]">
                <dt className="min-w-0 truncate">{line.label}</dt>
                <dd className="shrink-0 tabular-nums text-[#1a1915]">{formatPrice(line.amount, currency)}</dd>
              </div>
            ))}
            {typeof budget?.total === 'number' && (
              <div className="mt-1 flex items-baseline justify-between gap-2 border-t border-black/10 pt-1 text-[12px] font-semibold text-[#1a1915]">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatPrice(budget.total, currency)}</dd>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-baseline justify-between gap-2 text-[12px] font-semibold text-[#1a1915]">
            <dt className="flex items-baseline gap-1">
              Stops cost <span className="text-[10px] font-normal text-[#6e6a60]">(from listed stop prices)</span>
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
    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#6e6a60]">{label}</p>
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-[#1a1915]/80">
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
        <div className="border-t border-black/5 px-3 py-2">
          <p className="text-[11px] text-[#6e6a60]">
            <span className="font-semibold text-[#1a1915]">{days.length} day{days.length === 1 ? '' : 's'}</span>
            {' · '}
            {totalStops} stop{totalStops === 1 ? '' : 's'}
          </p>
          {firstStops.length > 0 && (
            <p className="mt-0.5 truncate text-[11px] text-[#6e6a60]">{firstStops.join(' · ')}</p>
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
      right={data.weather ? <WeatherChip weather={data.weather} /> : undefined}
      footer={<BudgetFooter data={data} currency={currency} />}
    >
      {data.weather?.daily && data.weather.daily.length > 0 && (
        <div className="px-3 pb-2">
          <ForecastStrip daily={data.weather.daily} />
        </div>
      )}

      <div className="border-t border-black/5 px-3 pt-2">
        <DayTabs days={days} active={activeDay} accent={theme.accent} currency={currency} onChange={setActiveDay} />
        <div className="mt-1.5">
          <p className="text-[13px] font-semibold tracking-tight text-[#1a1915]">
            {day.label ?? `Day ${activeDay + 1}`}
            {day.date && <span className="ml-1.5 text-[11px] font-normal text-[#6e6a60]">{shortDay(day.date)}</span>}
          </p>
          {day.summary && <p className="text-[11px] text-[#6e6a60]">{day.summary}</p>}
        </div>
      </div>

      <ul className="mt-1 divide-y divide-black/5 border-t border-black/5">
        {day.stops.map((stop, i) => (
          <StopRow key={`${activeDay}-${i}`} stop={stop} currency={currency} accent={theme.accent} />
        ))}
      </ul>

      {dayMap && (
        <div className="border-t border-black/5 px-3 py-2">
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
