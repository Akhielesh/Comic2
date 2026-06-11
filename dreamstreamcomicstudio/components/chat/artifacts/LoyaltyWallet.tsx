import React, { useState } from 'react';
import { Sparkles, WalletCards } from 'lucide-react';
import type { LoyaltyCard, LoyaltyWalletArtifact } from '../../../apiTypes';
import {
  Surface,
  SurfaceTitle,
  SurfaceSubtitle,
  Badge,
  LinearGauge,
  compactNumber,
  withAlpha,
  useCompact,
  PALETTES
} from './kit';

// Apple-Wallet loyalty stack — overlapping membership cards, one selected at a time.
//  • detailed — a vertical stack where each card tucks under the next (-mt-10);
//    clicking a card lifts it (mt-0, z-priority, slight scale + shadow) and expands
//    it to show member + masked number, the points balance big, a tier-progress
//    gauge ("12 nights to Gold"), expiry and the agent's note. Brand accents come
//    from each card (default: cycle the brand series) as a soft 135° gradient.
//  • compact — one row per program: tinted dot + program + tier, points right.

/** "3081 417 892" → "•••• 7892"; short/absent numbers stay untouched. */
const maskedNumber = (number?: string): string | undefined => {
  if (!number) return undefined;
  const digits = number.replace(/\s/g, '');
  if (digits.length <= 4) return digits;
  return `•••• ${digits.slice(-4)}`;
};

const cardAccent = (card: LoyaltyCard, i: number): string =>
  card.accent ?? PALETTES.brand.series[i % PALETTES.brand.series.length];

export const LoyaltyWallet: React.FC<{ data: LoyaltyWalletArtifact }> = ({ data }) => {
  const compact = useCompact();
  const [selected, setSelected] = useState(0);

  const cards = data.cards ?? [];
  if (!cards.length) return null;
  const sel = Math.min(selected, cards.length - 1);

  const header = (
    <div className="flex min-w-0 items-center gap-2">
      <WalletCards className="h-4 w-4 shrink-0 text-[var(--ds-muted)]" />
      <div className="min-w-0">
        <SurfaceTitle>{data.title ?? 'Loyalty wallet'}</SurfaceTitle>
        <SurfaceSubtitle>
          {cards.length} program{cards.length === 1 ? '' : 's'}
        </SurfaceSubtitle>
      </div>
    </div>
  );

  // ── Compact: one glance row per program. ─────────────────────────────────────
  if (compact) {
    return (
      <Surface header={header}>
        <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {cards.map((card, i) => (
            <div key={`${card.program}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: cardAccent(card, i) }} />
              <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ds-ink)]">
                {card.program}
                {card.tier && <span className="font-normal text-[var(--ds-muted)]"> · {card.tier}</span>}
              </span>
              {typeof card.points === 'number' && (
                <span className="shrink-0 text-xs tabular-nums text-[var(--ds-ink)]">
                  {compactNumber(card.points)}
                  <span className="text-[var(--ds-muted)]"> {card.pointsLabel ?? 'pts'}</span>
                </span>
              )}
            </div>
          ))}
        </div>
      </Surface>
    );
  }

  // ── Detailed: the overlapping wallet stack. ──────────────────────────────────
  return (
    <Surface header={header}>
      <div className="px-3 pb-3 pt-0.5">
        {cards.map((card, i) => {
          const accent = cardAccent(card, i);
          const isSel = i === sel;
          const masked = maskedNumber(card.number);
          const progress = card.tierProgress;
          const toGo = progress ? Math.max(0, progress.max - progress.value) : 0;
          return (
            <button
              key={`${card.program}-${i}`}
              onClick={() => setSelected(i)}
              aria-expanded={isSel}
              aria-label={`${card.program} card`}
              className={`relative block w-full rounded-xl border border-[var(--ds-hairline)] p-3 text-left transition-all duration-300 motion-reduce:transition-none ${
                i === 0 ? '' : isSel ? 'mt-0' : '-mt-10'
              } ${isSel ? 'min-h-[120px] shadow-lg motion-safe:scale-[1.02]' : 'h-[120px] overflow-hidden'}`}
              style={{
                zIndex: isSel ? cards.length + 1 : i + 1,
                background: `linear-gradient(135deg, ${withAlpha(accent, 0.18)}, ${withAlpha(accent, 0.06)}), var(--ds-raised)`
              }}
            >
              {/* Top strip — always visible, even when tucked under the next card. */}
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-[13px] font-semibold" style={{ color: accent }}>
                  {card.program}
                </span>
                {card.tier && <Badge color={accent}>{card.tier}</Badge>}
              </div>

              {isSel && (
                <div className="mt-2 animate-fade-in space-y-2">
                  {(card.member || masked) && (
                    <div className="flex items-baseline justify-between gap-2 text-[11px]">
                      <span className="min-w-0 truncate text-[var(--ds-muted)]">{card.member}</span>
                      {masked && <span className="shrink-0 tabular-nums text-[var(--ds-muted)]">{masked}</span>}
                    </div>
                  )}

                  {typeof card.points === 'number' && (
                    <p className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--ds-ink)]">
                      {compactNumber(card.points)}
                      <span className="ml-1 text-[11px] font-normal text-[var(--ds-muted)]">{card.pointsLabel ?? 'points'}</span>
                    </p>
                  )}

                  {progress && progress.max > 0 && (
                    <div>
                      <LinearGauge value={progress.value} max={progress.max} height={5} color={accent} />
                      <p className="mt-1 text-[10px] tabular-nums text-[var(--ds-muted)]">
                        {progress.nextTier
                          ? `${toGo.toLocaleString()} ${card.pointsLabel ?? 'points'} to ${progress.nextTier}`
                          : `${progress.value.toLocaleString()} / ${progress.max.toLocaleString()}`}
                      </p>
                    </div>
                  )}

                  {card.expiry && <p className="text-[10px] tabular-nums text-[var(--ds-muted)]">Expires {card.expiry}</p>}

                  {card.note && (
                    <p className="flex items-start gap-1.5 text-[11px] italic leading-snug text-[var(--ds-ink)] opacity-80">
                      <Sparkles className="mt-px h-3 w-3 shrink-0" style={{ color: accent }} />
                      <span className="min-w-0">{card.note}</span>
                    </p>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </Surface>
  );
};
