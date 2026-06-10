import React from 'react';
import type { CentralBankWatchArtifact, CentralBank } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, relativeTime, shortDate, useCompact, BEAR, PALETTES } from './kit';

// Central bank watch — policy rates and meeting countdowns, one divided section
// per bank (Fed, ECB, BoJ, …).
//  • detailed — per bank: code avatar chip + name/rateName/lastChange on the left,
//    the current rate huge in the middle, a "next meeting · in 23d" stat on the
//    right (red-tinted when ≤3d), then the market-implied rate path as a tiny
//    step-line SVG with first→last labels and the agent's one-line summary.
//  • compact — one glance row per bank: code chip, name, rate, "in Nd".

const ACCENT = PALETTES.brand.accent;
const DAY_MS = 86_400_000;

const daysUntil = (iso?: string): number | undefined => {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return undefined;
  return Math.ceil((t - Date.now()) / DAY_MS);
};

const codeFor = (bank: CentralBank): string =>
  bank.code ?? bank.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/** The market-implied rate path as a hand-rolled step line (percent x, pixel y). */
const ImpliedPath: React.FC<{ path: NonNullable<CentralBank['impliedPath']> }> = ({ path }) => {
  const pts = path.filter((p) => typeof p?.ratePct === 'number' && Number.isFinite(p.ratePct));
  if (pts.length < 2) return null;
  const H = 32;
  const PAD = 5;
  const rates = pts.map((p) => p.ratePct);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const span = max - min || 1;
  const x = (i: number): string => `${2 + (i / (pts.length - 1)) * 96}%`;
  const y = (r: number): number => PAD + (1 - (r - min) / span) * (H - PAD * 2);
  const first = pts[0];
  const last = pts[pts.length - 1];
  return (
    <div className="mt-2">
      <svg className="block h-8 w-full" role="img" aria-label="Implied rate path">
        {pts.slice(0, -1).map((p, i) => {
          const next = pts[i + 1];
          return (
            <g key={i}>
              {/* step-after: hold this rate to the next meeting, then jump */}
              <line x1={x(i)} y1={y(p.ratePct)} x2={x(i + 1)} y2={y(p.ratePct)} stroke={ACCENT} strokeWidth="1.75" strokeLinecap="round" />
              <line x1={x(i + 1)} y1={y(p.ratePct)} x2={x(i + 1)} y2={y(next.ratePct)} stroke={ACCENT} strokeWidth="1.75" strokeLinecap="round" />
            </g>
          );
        })}
        <circle cx={x(0)} cy={y(first.ratePct)} r="2.5" fill={ACCENT} />
        <circle cx={x(pts.length - 1)} cy={y(last.ratePct)} r="2.5" fill={ACCENT} />
      </svg>
      <div className="flex items-center justify-between text-[10px] tabular-nums text-[var(--ds-muted)]">
        <span>{first.ratePct.toFixed(2)}{first.label ? ` · ${first.label}` : ''}</span>
        <span>→ {last.ratePct.toFixed(2)}{last.label ? ` by ${last.label}` : ''}</span>
      </div>
    </div>
  );
};

const BankSection: React.FC<{ bank: CentralBank }> = ({ bank }) => {
  const days = daysUntil(bank.nextMeeting);
  const urgent = typeof days === 'number' && days <= 3;
  return (
    <section className="px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--ds-well)] text-[11px] font-semibold text-[var(--ds-ink)]">
          {codeFor(bank)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-[var(--ds-ink)]">{bank.name}</div>
          {bank.rateName && <div className="truncate text-[11px] text-[var(--ds-muted)]">{bank.rateName}</div>}
          {bank.lastChange && <div className="truncate text-[10px] text-[var(--ds-muted)]">last change {bank.lastChange}</div>}
        </div>
        <div className="shrink-0 text-right">
          <span className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--ds-ink)]">
            {Number.isFinite(bank.ratePct) ? bank.ratePct.toFixed(2) : '—'}
          </span>
          <span className="text-xs font-medium text-[var(--ds-muted)]">%</span>
        </div>
        {typeof days === 'number' && (
          <div className="shrink-0 text-right">
            <div className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
              next meeting
            </div>
            <div className="text-sm font-semibold tabular-nums text-[var(--ds-ink)]" style={urgent ? { color: BEAR } : undefined}>
              {days <= 0 ? 'today' : `in ${days}d`}
            </div>
            {bank.nextMeeting && <div className="text-[10px] tabular-nums text-[var(--ds-muted)]">{shortDate(bank.nextMeeting)}</div>}
          </div>
        )}
      </div>
      {bank.impliedPath && bank.impliedPath.length > 1 && <ImpliedPath path={bank.impliedPath} />}
      {bank.summary && <p className="mt-1.5 text-[11px] leading-snug text-[var(--ds-muted)]">{bank.summary}</p>}
    </section>
  );
};

export const CentralBankWatch: React.FC<{ data: CentralBankWatchArtifact }> = ({ data }) => {
  const compact = useCompact();
  const banks = (data.banks ?? []).filter((b) => b?.name);
  if (!banks.length) return null;

  const asOf = relativeTime(data.asOf);
  const header = (
    <>
      <SurfaceTitle>{data.title ?? 'Central bank watch'}</SurfaceTitle>
      <SurfaceSubtitle>Policy rates & next meetings</SurfaceSubtitle>
    </>
  );
  const headerRight = asOf ? <SurfaceSubtitle>as of {asOf}</SurfaceSubtitle> : undefined;

  // ── Compact: one glance row per bank. ────────────────────────────────────────
  if (compact) {
    return (
      <Surface header={header} right={headerRight}>
        <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
          {banks.map((bank, i) => {
            const days = daysUntil(bank.nextMeeting);
            return (
              <div key={`${bank.name}-${i}`} className="flex items-center gap-2 px-3 py-1.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-well)] text-[10px] font-semibold text-[var(--ds-ink)]">
                  {codeFor(bank)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--ds-ink)]">{bank.name}</span>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--ds-ink)]">
                  {Number.isFinite(bank.ratePct) ? `${bank.ratePct.toFixed(2)}%` : '—'}
                </span>
                {typeof days === 'number' && (
                  <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-[var(--ds-muted)]">
                    {days <= 0 ? 'today' : `in ${days}d`}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Surface>
    );
  }

  // ── Detailed: one full section per bank. ─────────────────────────────────────
  return (
    <Surface header={header} right={headerRight}>
      <div className="divide-y divide-[var(--ds-hairline-soft)] border-t border-[var(--ds-hairline-soft)]">
        {banks.map((bank, i) => (
          <BankSection key={`${bank.name}-${i}`} bank={bank} />
        ))}
      </div>
    </Surface>
  );
};
