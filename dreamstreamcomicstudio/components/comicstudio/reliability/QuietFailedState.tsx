// The quiet failed-tile state (reliability.md §3): a style option, page, sheet or cover that a provider refused
// reads "Paused — provider busy · Details · Retry" instead of red text. Details reveals exactly what happened:
// who refused (the sanitized `errorDetail.provider` + code), the provider's own words, and when. Failures that are
// not the provider's (a safety hold, a usage limit, a stop) keep an honest "Didn't finish — …" line instead of
// "Paused", because waiting would not fix them.
//
// Tile owners (board/ui.tsx, conversation/cards/renderTile.tsx, CastTab, StyleTab) render this inside their
// tile frame for `render.status === 'failed'`; it fills its container and never overflows it.

import React, { useId, useState } from 'react';
import { ChevronDown, PauseCircle, RotateCcw } from 'lucide-react';
import { failureFacts, failureKind, failureReason, formatFailedAt, type FailureKind } from '../conversation/cards/failure';
import { cx } from '../conversation/ui';

/** Failure kinds that are the provider's (waiting and retrying fixes them). */
const PROVIDER_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>(['rate_limited', 'busy', 'timeout', 'network']);

export interface FailedRenderLike {
  error?: string;
  updatedAt?: number;
  attempts?: number;
  errorDetail?: unknown;
}

/** The render failed because its provider was busy / throttling / unreachable (not safety, limits or a stop). */
export const isProviderPause = (render: FailedRenderLike | null | undefined): boolean => {
  if (!render) return false;
  const facts = failureFacts(render);
  return PROVIDER_KINDS.has(failureKind(facts.error));
};

/** "Paused — provider busy" for provider failures; "Didn't finish — held by the safety check" otherwise. */
export const quietCaption = (render: FailedRenderLike | null | undefined): string => {
  const facts = failureFacts(render);
  const reason = failureReason(facts.error);
  return isProviderPause(render) ? `Paused — ${reason}` : `Didn't finish — ${reason}`;
};

export interface QuietFailedStateProps {
  render: FailedRenderLike;
  /** "Page 3", "Cover", "MAYA sheet", "Style option 2" (for the accessible names). */
  label: string;
  onRetry?: () => void;
  retryBusy?: boolean;
  /** Small tiles: icon + one short line; Details still available. */
  compact?: boolean;
  now?: number;
  className?: string;
}

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]';
const CHIP = `inline-flex min-h-7 items-center gap-1 rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-2.5 text-[11.5px] font-semibold text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] coarse:min-h-11 disabled:opacity-50 ${FOCUS}`;

export const QuietFailedState: React.FC<QuietFailedStateProps> = ({ render, label, onRetry, retryBusy, compact, now, className }) => {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const facts = failureFacts(render);
  const caption = quietCaption(render);
  const detail = render.errorDetail && typeof render.errorDetail === 'object' ? (render.errorDetail as { provider?: unknown; code?: unknown; text?: unknown }) : undefined;
  const who = typeof detail?.provider === 'string' && detail.provider ? detail.provider : 'The image provider';
  const code = typeof detail?.code === 'string' && detail.code ? detail.code : undefined;
  const words = (typeof detail?.text === 'string' && detail.text) || render.error || '';
  const when = formatFailedAt(facts.at, now ?? Date.now());
  const hasDetails = !!(words || detail || when);

  return (
    <div
      role="group"
      aria-label={`${label}: ${caption}`}
      data-quiet-failed={isProviderPause(render) ? 'provider' : 'other'}
      className={cx(
        'flex h-full w-full min-w-0 flex-col items-center justify-[safe_center] gap-1.5 overflow-y-auto overscroll-contain bg-[var(--ds-surface-soft)] text-center',
        compact ? 'p-1.5' : 'p-3',
        className
      )}
    >
      <PauseCircle className={cx('shrink-0 text-[var(--ds-warning-text)]', compact ? 'h-4 w-4' : 'h-5 w-5')} aria-hidden />
      <p className={cx('min-w-0 max-w-[28ch] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]', compact ? 'text-[11px]' : 'text-[12.5px]')}>{caption}</p>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {hasDetails && (
          <button type="button" className={CHIP} aria-expanded={open} aria-controls={detailsId} onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
          >
            Details <ChevronDown className={cx('h-3 w-3 transition-transform duration-[var(--ds-motion-fast)] motion-reduce:transition-none', open && 'rotate-180')} aria-hidden />
          </button>
        )}
        {onRetry && (
          <button
            type="button"
            className={CHIP}
            disabled={retryBusy}
            aria-label={`Retry ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onRetry();
            }}
          >
            <RotateCcw className={cx('h-3 w-3', retryBusy && 'motion-safe:animate-spin')} aria-hidden /> Retry
          </button>
        )}
      </div>
      {open && hasDetails && (
        <dl
          id={detailsId}
          className="w-full min-w-0 max-w-[34ch] space-y-1 rounded-[var(--ds-radius-sm)] border border-[var(--ds-hairline)] bg-[var(--ds-raised)] px-2.5 py-2 text-left text-[11.5px] leading-snug"
        >
          <div className="flex min-w-0 gap-1.5">
            <dt className="shrink-0 text-[var(--ds-muted)]">Who refused</dt>
            <dd className="min-w-0 text-[var(--ds-ink)] [overflow-wrap:anywhere]">{code ? `${who} · ${code}` : who}</dd>
          </div>
          {words && (
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 text-[var(--ds-muted)]">They said</dt>
              <dd className="min-w-0 text-[var(--ds-ink)] [overflow-wrap:anywhere]">“{words}”</dd>
            </div>
          )}
          {when && (
            <div className="flex min-w-0 gap-1.5">
              <dt className="shrink-0 text-[var(--ds-muted)]">When</dt>
              <dd className="min-w-0 tabular-nums text-[var(--ds-ink)]">{when}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
};

export default QuietFailedState;
