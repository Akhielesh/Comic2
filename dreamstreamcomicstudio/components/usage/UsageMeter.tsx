// "Usage left" meter (P1-LIMITS). One calm pill — a small gauge and the percent left — that opens
// the details: how much is left in friendly units ("about 150 standard comic pages left"), that it
// is shared across every studio, that the user's own keys never use it, and — when it runs out —
// the honest hard stop with the two real ways forward (a top-up, or their own key).
//
// Users never see dollars here. Admins and exempt accounts have no limit, so nothing renders.
// Calm-studio glass: --ds-* tokens, tabular numbers, 44 px touch targets on coarse pointers,
// no motion when the user prefers reduced motion.

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gauge, KeyRound } from 'lucide-react';
import {
  USAGE_EXHAUSTED_COPY,
  formatPctLeft,
  resetsLabel,
  showsUsageMeter,
  usageTone,
  type AllowanceStatus
} from '../../services/usageAllowance';
import { useUsageAllowance } from './useUsageAllowance';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/** Deep link into Settings → API keys (App.tsx restores ?view=settings&tab=settings). */
export const API_KEYS_HREF = '/?view=settings&tab=settings';

const TONE_STROKE: Record<ReturnType<typeof usageTone>, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  low: 'text-amber-500',
  critical: 'text-rose-500'
};
const TONE_FILL: Record<ReturnType<typeof usageTone>, string> = {
  ok: 'bg-emerald-500',
  low: 'bg-amber-500',
  critical: 'bg-rose-500'
};

/** Screen-reader sentence for the meter. */
export const usageAriaLabel = (status: AllowanceStatus): string =>
  status.exhausted
    ? 'Usage left: none. Open for your options.'
    : `Usage left: ${formatPctLeft(status.pctLeft)}${status.friendlyUnits ? ` — ${status.friendlyUnits.label}` : ''}. Open for details.`;

/** A tiny circular gauge (fills with usage LEFT). */
export const UsageGauge: React.FC<{ pctLeft: number; tone: ReturnType<typeof usageTone>; size?: number; showNumber?: boolean }> = ({
  pctLeft,
  tone,
  size = 18,
  showNumber = false
}) => {
  const r = size / 2 - 2;
  const c = 2 * Math.PI * r;
  const left = Math.max(0, Math.min(100, pctLeft));
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }} aria-hidden>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={2.5} className="stroke-[var(--ds-hairline)]" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={2.5}
          strokeLinecap="round"
          stroke="currentColor"
          strokeDasharray={`${(left / 100) * c} ${c}`}
          className={cx(TONE_STROKE[tone], 'motion-safe:transition-[stroke-dasharray] motion-safe:duration-500')}
        />
      </svg>
      {showNumber && (
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold tabular-nums text-[var(--ds-ink)]">
          {Math.floor(left)}
        </span>
      )}
    </span>
  );
};

/** A slim horizontal bar (fills with usage LEFT). */
export const UsageBar: React.FC<{ pctLeft: number; tone: ReturnType<typeof usageTone>; className?: string }> = ({ pctLeft, tone, className }) => (
  <div
    className={cx('relative h-2 w-full overflow-hidden rounded-full bg-[var(--ds-well)]', className)}
    role="meter"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(pctLeft)}
    aria-label="Usage left"
  >
    <div
      className={cx('h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500', TONE_FILL[tone])}
      style={{ width: `${pctLeft > 0 ? Math.max(2, Math.min(100, pctLeft)) : 0}%` }}
    />
  </div>
);

/** The pill. `compact` (phones / tight headers): a 44 px gauge with the number inside. */
export const UsageMeterPill = React.forwardRef<
  HTMLButtonElement,
  { status: AllowanceStatus; compact?: boolean; open?: boolean; onClick?: () => void; controls?: string }
>(({ status, compact = false, open = false, onClick, controls }, ref) => {
  const tone = usageTone(status);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={usageAriaLabel(status)}
      title={status.friendlyUnits?.label || 'Usage left'}
      className={cx(
        'inline-flex shrink-0 items-center rounded-full border text-[12px] font-medium tabular-nums transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40',
        status.exhausted
          ? 'border-rose-500/30 bg-rose-500/[0.07] text-rose-700 hover:bg-rose-500/[0.12] dark:text-rose-300'
          : 'border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] text-[var(--ds-ink)] hover:bg-[var(--ds-hover)]',
        compact ? 'h-11 w-11 justify-center' : 'h-8 gap-1.5 px-2.5 coarse:h-11 coarse:px-3'
      )}
    >
      <UsageGauge pctLeft={status.exhausted ? 0 : status.pctLeft} tone={tone} size={compact ? 26 : 16} showNumber={compact} />
      {!compact && <span className="whitespace-nowrap">{status.exhausted ? 'Usage used up' : `${formatPctLeft(status.pctLeft)} left`}</span>}
    </button>
  );
});
UsageMeterPill.displayName = 'UsageMeterPill';

/** The details (popover / sheet body). */
export const UsageDetails: React.FC<{ status: AllowanceStatus; onClose?: () => void }> = ({ status }) => {
  const tone = usageTone(status);
  const reset = resetsLabel(status.resetsAt);
  return (
    <div className="w-[min(20rem,calc(100vw-2rem))] p-4 text-[var(--ds-ink)]">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">
        <Gauge className="h-3.5 w-3.5 text-[var(--ds-accent)]" aria-hidden /> Usage left
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cx('text-[26px] font-semibold tracking-tight tabular-nums', status.exhausted && 'text-rose-600 dark:text-rose-400')}>
          {status.exhausted ? '0%' : formatPctLeft(status.pctLeft)}
        </span>
        {status.friendlyUnits && !status.exhausted && (
          <span className="min-w-0 text-[12.5px] leading-snug text-[var(--ds-muted)]">{status.friendlyUnits.label}</span>
        )}
      </div>
      <UsageBar pctLeft={status.exhausted ? 0 : status.pctLeft} tone={tone} className="mt-2" />

      {status.exhausted ? (
        <div className="mt-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] p-3" role="status">
          <p className="text-[13px] leading-snug">
            {reset
              ? `You've used all of this month's DreamStream usage. It comes back on ${reset} — or add your own API key in Settings → API keys to keep going now.`
              : USAGE_EXHAUSTED_COPY}
          </p>
          <p className="mt-1.5 text-[12px] text-[var(--ds-muted)]">Nothing more is spent until you choose one of these.</p>
          <a
            href={API_KEYS_HREF}
            className="mt-2.5 inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-accent)] px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D97757]/40 coarse:h-11"
          >
            <KeyRound className="h-4 w-4" aria-hidden /> Add your own key
          </a>
        </div>
      ) : (
        <p className="mt-3 text-[12.5px] leading-snug text-[var(--ds-muted)]">
          Shared across every studio — chat, comics and more. Work done on your own API keys never uses it.
          {reset ? ` It comes back on ${reset}.` : ' It doesn’t reset on its own; ask us for a top-up any time.'}
          {status.pctLeft < 30 && ' Draft quality and the editor’s free tools stretch it furthest.'}
        </p>
      )}
    </div>
  );
};

/** Viewport-clamped position for a popover under an anchor (right-aligned, 16 px gutters). */
export const clampPopover = (anchor: { left: number; right: number; bottom: number }, width: number, viewportW: number) => {
  const gutter = 16;
  const w = Math.min(width, viewportW - gutter * 2);
  const left = Math.max(gutter, Math.min(anchor.right - w, viewportW - gutter - w));
  return { left, top: anchor.bottom + 8, width: w };
};

/**
 * Self-contained meter: pill + popover. Reads the shared status (or uses `status` when given).
 * Renders nothing for admins / exempt accounts / while the meter is unavailable.
 */
export const UsageMeter: React.FC<{ status?: AllowanceStatus | null; compact?: boolean; refreshKey?: unknown; className?: string }> = ({
  status: given,
  compact = false,
  refreshKey,
  className
}) => {
  const live = useUsageAllowance({ refreshKey });
  const status = given === undefined ? live : given;
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback(() => {
    setOpen(false);
    btnRef.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const place = () => {
      const r = btnRef.current!.getBoundingClientRect();
      setPos(clampPopover(r, 320, window.innerWidth));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    popRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, close]);

  if (!showsUsageMeter(status)) return null;

  return (
    <span className={cx('relative inline-flex shrink-0', className)}>
      <UsageMeterPill ref={btnRef} status={status} compact={compact} open={open} controls={id} onClick={() => setOpen((o) => !o)} />
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popRef}
            id={id}
            role="dialog"
            aria-label="Usage left"
            tabIndex={-1}
            className="fixed z-[80] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] shadow-[0_8px_30px_rgba(0,0,0,0.14)] backdrop-blur-xl focus:outline-none"
            style={pos ? { left: pos.left, top: pos.top, width: pos.width } : { right: 16, top: 64 }}
          >
            <UsageDetails status={status} onClose={close} />
          </div>,
          document.body
        )}
    </span>
  );
};

export default UsageMeter;
