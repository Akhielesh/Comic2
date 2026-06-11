import React from 'react';
import { AlertTriangle, Banknote, Check, Coins, Droplets, HeartPulse, MapPin, Phone, Plug, Shield } from 'lucide-react';
import type { LocalCheatsheetArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, withAlpha, useCompact, BULL, BEAR } from './kit';

// Destination survival card — the facts a traveler actually needs at street level.
//  • detailed — "{destination} cheat sheet" header, a grid of mini stat tiles
//    (emergency number big in red, police/ambulance when distinct, tipping, plug +
//    voltage, cash norms, tap water tinted safe/avoid), a phrasebook (local script,
//    italic pronunciation, meaning right-aligned), an amber "Watch out" scam
//    section and plain-check etiquette rows.
//  • compact — destination + emergency / plug / tipping chips + the first warning
//    truncated.

const AMBER = '#f59e0b';

/** Tint tap-water advice: green when drinkable, red when it says bottled/avoid. */
const tapWaterColor = (value: string): string | undefined => {
  if (/bottle|avoid|unsafe|not safe|boil|don't/i.test(value)) return BEAR;
  if (/safe|potable|drinkable/i.test(value)) return BULL;
  return undefined;
};

/** Mini stat tile: icon + 10px uppercase label over a semibold value. */
const Tile: React.FC<{
  icon: React.ElementType;
  label: string;
  value?: string;
  /** Inline color for the value (emergency red, tap-water verdicts). */
  valueColor?: string;
  /** Render the value at display size (emergency number). */
  big?: boolean;
}> = ({ icon: Icon, label, value, valueColor, big }) =>
  value ? (
    <div className="min-w-0 rounded-lg bg-[var(--ds-well)] p-2">
      <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
        <Icon className="h-3 w-3 shrink-0" />
        {label}
      </p>
      <p
        className={`truncate font-semibold tabular-nums ${big ? 'text-lg tracking-tight' : 'mt-0.5 text-[12px]'}`}
        style={{ color: valueColor ?? 'var(--ds-ink)' }}
      >
        {value}
      </p>
    </div>
  ) : null;

/** Compact glance chip: icon + value. */
const FactChip: React.FC<{ icon: React.ElementType; value: string; color?: string }> = ({ icon: Icon, value, color }) => (
  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[11px]">
    <Icon className="h-3 w-3 shrink-0 text-[var(--ds-muted)]" />
    <span className="font-semibold tabular-nums" style={{ color: color ?? 'var(--ds-ink)' }}>
      {value}
    </span>
  </span>
);

export const LocalCheatsheet: React.FC<{ data: LocalCheatsheetArtifact }> = ({ data }) => {
  const compact = useCompact();

  if (!data.destination) return null;

  const phrases = data.phrases ?? [];
  const warnings = data.warnings ?? [];
  const etiquette = data.etiquette ?? [];
  const plugValue = [data.plug, data.voltage].filter(Boolean).join(' · ');
  const policeDistinct = Boolean(data.police && data.police !== data.emergency);
  const ambulanceDistinct = Boolean(data.ambulance && data.ambulance !== data.emergency);

  // ── Compact: emergency / plug / tipping chips + first warning. ───────────────
  if (compact) {
    return (
      <Surface>
        <div className="flex items-center gap-1.5 px-3 py-2.5">
          <span className="shrink-0 truncate text-[13px] font-semibold text-[var(--ds-ink)]">{data.destination}</span>
          {data.emergency && <FactChip icon={Phone} value={data.emergency} color={BEAR} />}
          {plugValue && <FactChip icon={Plug} value={plugValue} />}
          {data.tipping && <FactChip icon={Coins} value={data.tipping} />}
          {warnings[0] && (
            <span className="flex min-w-0 flex-1 items-center gap-1 text-[11px] text-[var(--ds-muted)]">
              <AlertTriangle className="h-3 w-3 shrink-0" style={{ color: AMBER }} />
              <span className="truncate">{warnings[0]}</span>
            </span>
          )}
        </div>
      </Surface>
    );
  }

  // ── Detailed: facts grid + phrasebook + warnings + etiquette. ────────────────
  const subtitle = [data.language, data.currency].filter(Boolean).join(' · ');

  return (
    <Surface
      header={
        <div className="flex min-w-0 items-center gap-2">
          <MapPin className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
          <div className="min-w-0">
            <SurfaceTitle>{data.destination} cheat sheet</SurfaceTitle>
            {subtitle && <SurfaceSubtitle>{subtitle}</SurfaceSubtitle>}
          </div>
        </div>
      }
    >
      <div className="space-y-2.5 px-3 pb-3 pt-0.5">
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          <Tile icon={Phone} label="Emergency" value={data.emergency} valueColor={BEAR} big />
          {policeDistinct && <Tile icon={Shield} label="Police" value={data.police} valueColor={BEAR} big />}
          {ambulanceDistinct && <Tile icon={HeartPulse} label="Ambulance" value={data.ambulance} valueColor={BEAR} big />}
          <Tile icon={Coins} label="Tipping" value={data.tipping} />
          <Tile icon={Plug} label="Power" value={plugValue || undefined} />
          <Tile icon={Banknote} label="Cash" value={data.cashNorm} />
          <Tile icon={Droplets} label="Tap water" value={data.tapWater} valueColor={data.tapWater ? tapWaterColor(data.tapWater) : undefined} />
        </div>

        {phrases.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Phrases</p>
            <ul className="divide-y divide-[var(--ds-hairline-soft)]">
              {phrases.map((p, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 py-1">
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-[var(--ds-ink)]">{p.local}</span>
                    {p.say && <span className="block truncate text-[11px] italic text-[var(--ds-muted)]">{p.say}</span>}
                  </span>
                  <span className="shrink-0 text-right text-[11px] text-[var(--ds-muted)]">{p.meaning}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {warnings.length > 0 && (
          <div className="rounded-lg p-2" style={{ backgroundColor: withAlpha(AMBER, 0.08) }}>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: AMBER }}>
              Watch out
            </p>
            <ul className="space-y-1">
              {warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--ds-ink)] opacity-90">
                  <AlertTriangle className="mt-px h-3 w-3 shrink-0" style={{ color: AMBER }} />
                  <span className="min-w-0">{w}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {etiquette.length > 0 && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">Etiquette</p>
            <ul className="space-y-1">
              {etiquette.map((e, i) => (
                <li key={i} className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--ds-ink)] opacity-90">
                  <Check className="mt-px h-3 w-3 shrink-0" style={{ color: BULL }} />
                  <span className="min-w-0">{e}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Surface>
  );
};
