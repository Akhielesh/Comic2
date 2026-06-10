import React, { useEffect, useRef, useState } from 'react';
import type { DebtClockArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, compactNumber, shortDate, useCompact } from './kit';

// National debt clock — the live odometer. The reported level plus the recent
// per-second drift, extrapolated from the moment the card mounted with a 1s tick.
//  • detailed — the full dollar figure (thousands separators, last four digits in
//    the warm accent so the motion reads without per-digit animation), a muted
//    "+$X / second" chip, and a "Δ +$31B since {prev}" line from the prior record.
//  • compact — "$37.21T" via compactNumber plus the "/s" chip as a one-liner.
// The tick skips hidden tabs and never starts under prefers-reduced-motion (the
// reported amount renders statically instead); the interval clears on unmount.

/** Split a formatted integer so the last four DIGITS (commas included) can be tinted. */
const splitTail = (str: string): [string, string] => {
  let i = str.length;
  let digits = 0;
  while (i > 0 && digits < 4) {
    i -= 1;
    if (/\d/.test(str[i])) digits += 1;
  }
  return [str.slice(0, i), str.slice(i)];
};

const signedCompact = (n: number): string => `${n < 0 ? '-' : '+'}$${compactNumber(Math.abs(n))}`;

export const DebtClock: React.FC<{ data: DebtClockArtifact }> = ({ data }) => {
  const compact = useCompact();
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());
  const perSecond = typeof data.perSecond === 'number' && Number.isFinite(data.perSecond) ? data.perSecond : 0;

  useEffect(() => {
    if (!perSecond) return;
    // Reduced motion: no ticking — the reported amount stays static.
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => {
      // Don't churn re-renders for a tab nobody is looking at.
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [perSecond]);

  if (typeof data.amount !== 'number' || !Number.isFinite(data.amount)) return null;

  const current = data.amount + perSecond * ((now - mountedAt.current) / 1000);
  const delta = data.previous && Number.isFinite(data.previous.amount) ? data.amount - data.previous.amount : undefined;

  const header = (
    <>
      <SurfaceTitle>{data.label ?? 'US national debt'}</SurfaceTitle>
      <SurfaceSubtitle>
        as of {shortDate(data.asOf)}
        {data.source ? ` · ${data.source}` : ''}
      </SurfaceSubtitle>
    </>
  );

  const perSecondChip = perSecond !== 0 && (
    <span className="inline-flex items-center rounded-full bg-[var(--ds-well)] px-2 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--ds-muted)]">
      {signedCompact(perSecond)}{compact ? '/s' : ' / second'}
    </span>
  );

  // ── Compact: the compacted figure + per-second chip as a one-liner. ──────────
  if (compact) {
    return (
      <Surface header={header}>
        <div className="flex items-center gap-2 px-3 pb-3">
          <span className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--ds-ink)]">
            ${compactNumber(current)}
          </span>
          {perSecondChip}
        </div>
      </Surface>
    );
  }

  // ── Detailed: the full odometer line + drift chip + prior-record delta. ──────
  const [head, tail] = splitTail(Math.round(current).toLocaleString('en-US'));
  return (
    <Surface header={header}>
      <div className="px-3 pb-3">
        <div className="text-2xl font-semibold tabular-nums tracking-tight text-[var(--ds-ink)] sm:text-3xl">
          ${head}
          <span className="text-[var(--ds-accent)]">{tail}</span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {perSecondChip}
          {delta !== undefined && data.previous && (
            <span className="text-[10px] tabular-nums text-[var(--ds-muted)]">
              Δ {signedCompact(delta)} since {shortDate(data.previous.date)}
            </span>
          )}
        </div>
      </div>
    </Surface>
  );
};
