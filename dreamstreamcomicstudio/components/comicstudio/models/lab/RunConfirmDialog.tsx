// The confirm before a paid lab call (costs first): the quote and its source, what will be sent, today's budget
// after this run, and that exactly one call is made with no retries. Only its Run button ever sends a request, and
// that request carries ack + the quote shown here + this click's id. "Try again" after a lost answer re-sends the
// SAME id, so the server returns the stored result instead of calling twice. No timers.

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { FlaskConical, Loader2 } from 'lucide-react';
import { TONE_TEXT } from '../../../chat/studioDesign';
import { cx } from '../../conversation/ui';
import { LabResultCard, costLine } from './LabResultCard';
import { LabApiError, formatLabUsd, newClickId, runLabCheck, type LabItem, type LabQuote, type LabRun, type LabRunAnswer } from './labApi';
import { LAB_PANEL, LAB_PRIMARY_BTN, LAB_SECONDARY_BTN, WRAP } from './labStyles';

export interface RunConfirmDialogProps {
  item: LabItem;
  spentUsd: number;
  capUsd: number;
  onClose(): void;
  /** A run finished (or was replayed): the section re-reads the overview. */
  onDone?(answer: LabRunAnswer): void;
}

type Phase = 'confirm' | 'running' | 'done' | 'error';

const isBlindRun = (run: LabRunAnswer['run']): run is Exclude<LabRunAnswer['run'], LabRun> => run.checkId === 'D4' && !('facts' in run);

export const RunConfirmDialog: React.FC<RunConfirmDialogProps> = ({ item, spentUsd, capUsd, onClose, onDone }) => {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [clickId, setClickId] = useState(newClickId);
  const [quote, setQuote] = useState<LabQuote | null>(item.quote);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [answer, setAnswer] = useState<LabRunAnswer | null>(null);
  const [error, setError] = useState<LabApiError | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    if (phase !== 'running') onClose();
  }, [phase, onClose]);

  // Escape closes (never while the call is out); Tab stays inside the dialog.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const focusables = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled])')];
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const run = async (id: string, q: LabQuote) => {
    setPhase('running');
    setError(null);
    try {
      const a = await runLabCheck({ itemId: item.id, idempotencyKey: id, quotedUsd: q.usd });
      setAnswer(a);
      setPhase('done');
      onDone?.(a);
    } catch (err) {
      const e = err instanceof LabApiError ? err : new LabApiError(String((err as Error)?.message || err), 0);
      if (e.code === 'QUOTE_CHANGED') {
        const fresh = (e.details?.quote ?? null) as LabQuote | null;
        if (fresh && typeof fresh.usd === 'number' && fresh.usd > 0) {
          setQuote(fresh);
          setClickId(newClickId()); // a new price is a new confirmation
        }
      }
      setError(e);
      setPhase('error');
    }
  };

  const after = quote ? spentUsd + quote.usd : spentUsd;
  const sameClickRetry = phase === 'error' && !!error?.unreached && !!quote;
  const newPriceConfirm = phase === 'error' && error?.code === 'QUOTE_CHANGED' && !!quote;

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-4" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-[color:color-mix(in_srgb,var(--ds-ink)_35%,transparent)]" aria-hidden onClick={close} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-lab-confirm={item.id}
        className={cx(LAB_PANEL, 'relative flex max-h-[min(92dvh,860px)] w-full min-w-0 flex-col overflow-hidden sm:max-w-[560px]')}
      >
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          <h2 id={titleId} className={cx('flex items-start gap-2 text-[15px] font-semibold tracking-tight text-[var(--ds-ink)]', WRAP)}>
            <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ds-accent)]" aria-hidden />
            <span className="min-w-0">
              {item.check} · {item.title}
            </span>
          </h2>

          {(phase === 'confirm' || phase === 'running' || newPriceConfirm || sameClickRetry) && quote && (
            <div className="mt-3 space-y-2 text-[13px] text-[var(--ds-ink)]">
              <p className="text-[22px] font-semibold tabular-nums tracking-tight" data-lab-quote>
                ≈ {formatLabUsd(quote.usd)}
                {quote.refsUnpriced && <span className="ml-1 text-[13px] font-normal text-[var(--ds-muted)]">+ reference input (price unpublished)</span>}
              </p>
              <p className={cx('text-[12px] text-[var(--ds-muted)]', WRAP)}>{quote.basis}</p>
              <p className={WRAP}>
                One paid call to {item.nickname} on the platform key: {item.res} · {item.aspect} · {item.refsNote}. No retries — if it fails, the failure is recorded and nothing is sent again.
              </p>
              <p className="tabular-nums">
                Today (UTC): {formatLabUsd(spentUsd)} of {formatLabUsd(capUsd)} used → about {formatLabUsd(after)} after this run.
              </p>
            </div>
          )}

          {phase === 'running' && (
            <p role="status" aria-live="polite" className="mt-3 flex items-center gap-2 text-[13px] text-[var(--ds-ink)]">
              <Loader2 className="h-4 w-4 shrink-0 motion-safe:animate-spin" aria-hidden />
              One call is out. Big pages can take a minute or two — keep this open.
            </p>
          )}

          {phase === 'error' && error && (
            <div role="status" aria-live="polite" className="mt-3 space-y-1">
              <p className={cx('text-[13px]', TONE_TEXT.warning, WRAP)}>{error.message}</p>
              {sameClickRetry && <p className="text-[12px] text-[var(--ds-muted)]">Trying again sends the same click: if the first one got through, you get its stored result and nothing is charged twice.</p>}
            </div>
          )}

          {phase === 'done' && answer && (
            <div role="status" aria-live="polite" className="mt-3 space-y-2">
              {answer.replayed && <p className="text-[12.5px] text-[var(--ds-muted)]">This click had already run — here is its stored result. No second call was made.</p>}
              {isBlindRun(answer.run) ? (
                <div className="space-y-1 text-[13px] text-[var(--ds-ink)]">
                  <p className={WRAP}>
                    {answer.run.status === 'ok'
                      ? `Drawn. It joins the blind comparison for ${answer.run.pair.label} once both models have drawn it — the image stays hidden until then.`
                      : answer.run.message || 'It did not draw.'}
                  </p>
                  <p className="tabular-nums text-[12.5px]">{costLine({ ...answer.run, facts: { callMade: answer.run.callMade, costReported: answer.run.costReported } })}</p>
                </div>
              ) : (
                <LabResultCard run={answer.run} headingLevel="h3" />
              )}
              <p className="tabular-nums text-[12.5px] text-[var(--ds-muted)]">
                Today: {formatLabUsd(answer.spentUsd)} used · {formatLabUsd(answer.remainingUsd)} left.
              </p>
            </div>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-[var(--ds-hairline-soft)] px-4 py-3">
          {phase === 'done' || (phase === 'error' && !sameClickRetry && !newPriceConfirm) ? (
            <button type="button" ref={cancelRef} onClick={onClose} className={LAB_SECONDARY_BTN}>
              Close
            </button>
          ) : (
            <>
              <button type="button" ref={cancelRef} onClick={close} disabled={phase === 'running'} className={LAB_SECONDARY_BTN}>
                Cancel
              </button>
              {quote && (
                <button
                  type="button"
                  onClick={() => void run(clickId, quote)}
                  disabled={phase === 'running' || !item.canRun}
                  className={LAB_PRIMARY_BTN}
                  data-lab-run-confirm
                >
                  {phase === 'running' ? 'Running…' : sameClickRetry ? 'Try again (same click)' : newPriceConfirm ? `Run at the new price — ${formatLabUsd(quote.usd)}` : `Run — ${formatLabUsd(quote.usd)}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
