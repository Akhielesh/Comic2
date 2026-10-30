// Admin → Model Lab (models.md §2.6 D1–D4; wm-plan M1-MODEL-LAB). The owner's approved paid checks, each listed with
// its quoted cost and where the number comes from; a check runs only from its confirm dialog (one paid call per
// click, no retries) and never past the $2-a-day cap the server enforces. D4 is judged blind: pairs show A and B
// with the names hidden until the vote. One request on open and one per Refresh — never a timer (the container
// sleeps after 15 idle minutes). The server re-checks requireAdmin on every lab path.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlaskConical, Info, RefreshCw } from 'lucide-react';
import { TONE_CHIP, TONE_TEXT } from '../../../chat/studioDesign';
import { cx } from '../../conversation/ui';
import { ModelHealthDot } from '../../reliability/ModelHealthDot';
import { BlindPairCard } from './BlindPairCard';
import { LabResultCard } from './LabResultCard';
import { ProPagesSection } from './ProPagesSection';
import { RunConfirmDialog } from './RunConfirmDialog';
import { fetchLabOverview, formatLabUsd, type LabCheck, type LabItem, type LabOverview, type LabRun } from './labApi';
import { LAB_PANEL, LAB_PRIMARY_BTN, LAB_SECONDARY_BTN, LAB_WELL, WRAP } from './labStyles';

const ItemRow: React.FC<{ item: LabItem; onRun: (item: LabItem) => void; compact?: boolean }> = ({ item, onRun, compact }) => (
  <li className={cx(LAB_WELL, 'min-w-0 p-3')} data-lab-item={item.id}>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className={cx('min-w-0 text-[13px] font-semibold text-[var(--ds-ink)]', WRAP)}>{compact ? item.nickname : item.title}</span>
      {item.health && item.health.state !== 'unknown' && <ModelHealthDot state={item.health.state} label={item.nickname} />}
      {item.runs.ok + item.runs.failed + item.runs.running > 0 && (
        <span className="text-[11.5px] tabular-nums text-[var(--ds-muted)]">
          {item.runs.ok ? `drawn ${item.runs.ok}×` : ''}
          {item.runs.ok && item.runs.failed ? ' · ' : ''}
          {item.runs.failed ? `failed ${item.runs.failed}×` : ''}
          {item.runs.running ? `${item.runs.ok || item.runs.failed ? ' · ' : ''}running` : ''}
        </span>
      )}
    </div>
    {!compact && (
      <p className={cx('mt-0.5 text-[12px] text-[var(--ds-muted)]', WRAP)}>
        {item.res} · {item.aspect} · {item.refsNote}
      </p>
    )}
    {compact && item.kind === 'page' && <p className={cx('mt-0.5 text-[12px] text-[var(--ds-muted)]', WRAP)}>{item.refsNote}</p>}
    {item.quote && (
      <p className="mt-1 text-[13px] tabular-nums text-[var(--ds-ink)]">
        ≈ {formatLabUsd(item.quote.usd)}
        {item.quote.refsUnpriced && <span className="text-[12px] text-[var(--ds-muted)]"> + reference input (unpublished)</span>}
        {!compact && <span className={cx('block text-[11.5px] text-[var(--ds-muted)]', WRAP)}>{item.quote.basis}</span>}
      </p>
    )}
    {item.note && <p className={cx('mt-1 text-[12px] text-[var(--ds-muted)]', WRAP)}>{item.note}</p>}
    {item.canRun && item.quote ? (
      <button type="button" onClick={() => onRun(item)} className={cx(LAB_PRIMARY_BTN, 'mt-2')} aria-label={`Run ${item.title} — ${formatLabUsd(item.quote.usd)}`}>
        {item.runs.ok ? 'Run again' : 'Run'} · {formatLabUsd(item.quote.usd)}
      </button>
    ) : (
      item.reason && (
        <p className={cx('mt-2 flex min-w-0 items-start gap-1.5 text-[12.5px]', TONE_TEXT.warning, WRAP)}>
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{item.reason}</span>
        </p>
      )
    )}
  </li>
);

const CheckHeader: React.FC<{ check: LabCheck }> = ({ check }) => (
  <header className="min-w-0">
    <h3 className={cx('text-[14.5px] font-semibold tracking-tight text-[var(--ds-ink)]', WRAP)}>
      {check.id} · {check.title}
    </h3>
    <p className={cx('mt-0.5 text-[12.5px] text-[var(--ds-ink)]', WRAP)}>{check.decision}</p>
    <p className={cx('mt-0.5 text-[12px] text-[var(--ds-muted)]', WRAP)}>Records: {check.answers}</p>
    {check.note && <p className={cx('mt-0.5 text-[12px] text-[var(--ds-muted)]', WRAP)}>{check.note}</p>}
  </header>
);

/** D4: the runnable items grouped by blind pair (two models per row), then anything not runnable. */
const BakeOff: React.FC<{ check: LabCheck; overview: LabOverview; onRun: (item: LabItem) => void }> = ({ check, overview, onRun }) => {
  const pairs: { id: string; label: string; items: LabItem[] }[] = [];
  for (const item of check.items) {
    if (!item.pair) continue;
    const found = pairs.find((p) => p.id === item.pair!.id);
    if (found) found.items.push(item);
    else pairs.push({ id: item.pair.id, label: item.pair.label, items: [item] });
  }
  const others = check.items.filter((i) => !i.pair);
  return (
    <>
      <ul className="mt-2 space-y-2" aria-label="Bake-off drawings">
        {pairs.map((p) => (
          <li key={p.id} className="min-w-0">
            <p className={cx('text-[12.5px] font-semibold text-[var(--ds-ink)]', WRAP)}>{p.label}</p>
            <ul className="mt-1 grid min-w-0 gap-2 sm:grid-cols-2">
              {p.items.map((item) => (
                <ItemRow key={item.id} item={item} onRun={onRun} compact />
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <ul className="mt-2 space-y-2">
          {others.map((item) => (
            <ItemRow key={item.id} item={item} onRun={onRun} />
          ))}
        </ul>
      )}
      <div className="mt-3 min-w-0">
        <h4 className="text-[13.5px] font-semibold text-[var(--ds-ink)]">Blind comparison</h4>
        <p className={cx('text-[12px] text-[var(--ds-muted)]', WRAP)}>A and B are shuffled per pair. The names, costs and sizes appear only after your vote, and a vote is final.</p>
        <ul className="mt-2 space-y-2" aria-label="Blind pairs">
          {overview.blind.map((pair) => (
            <BlindPairCard key={pair.id} pair={pair} />
          ))}
        </ul>
      </div>
    </>
  );
};

export const ModelLabSection: React.FC = () => {
  const [overview, setOverview] = useState<LabOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState<LabItem | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    fetchLabOverview({ signal: ctrl.signal })
      .then((o) => {
        if (ctrl.signal.aborted) return;
        setOverview(o);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError((err as Error)?.message || "Couldn't open the Model Lab.");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const replaceResult = (run: LabRun) => setOverview((o) => (o ? { ...o, results: o.results.map((r) => (r.id === run.id ? run : r)) } : o));
  const pct = overview ? Math.min(100, Math.round((overview.spentUsd / Math.max(0.0001, overview.capUsd)) * 100)) : 0;

  return (
    <section aria-labelledby="model-lab-title" className="min-w-0 space-y-4" data-model-lab="">
      <header className="flex min-w-0 flex-wrap items-center gap-3">
        <h2 id="model-lab-title" className="flex items-center gap-2 text-[16px] font-semibold tracking-tight text-[var(--ds-ink)]">
          <FlaskConical className="h-4 w-4 text-[var(--ds-accent)]" aria-hidden /> Model Lab
        </h2>
        <button type="button" onClick={load} disabled={loading} className={cx(LAB_SECONDARY_BTN, 'ml-auto')}>
          <RefreshCw className={cx('h-3.5 w-3.5', loading && 'motion-safe:animate-spin')} aria-hidden /> Refresh
        </button>
        <p className={cx('w-full text-[12.5px] text-[var(--ds-muted)]', WRAP)}>
          The paid checks you approved (models.md §2.6). Each run is one call on the platform key after a confirm that shows its cost — never a retry, never on a timer.
        </p>
      </header>

      <div role="status" aria-live="polite" className={cx('text-[12.5px] text-[var(--ds-muted)]', WRAP)}>
        {error ? `Couldn't open the Model Lab: ${error}` : !overview && loading ? 'Reading the checks and today’s budget…' : ''}
      </div>

      {overview && (
        <>
          <div className={cx(LAB_PANEL, 'min-w-0 p-3')}>
            <p className="text-[13px] tabular-nums text-[var(--ds-ink)]">
              Today (UTC {overview.day}): <strong className="font-semibold">{formatLabUsd(overview.spentUsd)}</strong> of {formatLabUsd(overview.capUsd)} used ·{' '}
              {formatLabUsd(overview.remainingUsd)} left
            </p>
            <div
              role="progressbar"
              aria-label="Today's lab spend"
              aria-valuemin={0}
              aria-valuemax={overview.capUsd}
              aria-valuenow={overview.spentUsd}
              aria-valuetext={`${formatLabUsd(overview.spentUsd)} of ${formatLabUsd(overview.capUsd)}`}
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-well-strong)]"
            >
              <div className="h-full rounded-full bg-[var(--ds-accent)]" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-[11.5px] text-[var(--ds-muted)]">Hard cap, enforced on the server before any call. A running check holds its quote; a finished one counts what the provider reported.</p>
            {(!overview.ready.platformKey || !overview.ready.storage) && (
              <p className={cx('mt-2 rounded-[var(--ds-radius-control)] border px-2.5 py-1.5 text-[12.5px]', TONE_CHIP.warning, WRAP)}>
                {!overview.ready.platformKey
                  ? "The platform OpenRouter key isn't set on this server, so nothing here can run. Nothing was charged."
                  : "Results can't be saved on this server (storage isn't configured), so nothing here will run. Nothing was charged."}
              </p>
            )}
          </div>

          {overview.checks.map((check) => (
            <section key={check.id} aria-label={`${check.id} · ${check.title}`} className={cx(LAB_PANEL, 'min-w-0 p-3')} data-lab-check={check.id}>
              <CheckHeader check={check} />
              {check.id === 'D4' ? (
                <BakeOff check={check} overview={overview} onRun={setConfirming} />
              ) : (
                <ul className="mt-2 space-y-2">
                  {check.items.map((item) => (
                    <ItemRow key={item.id} item={item} onRun={setConfirming} />
                  ))}
                </ul>
              )}
            </section>
          ))}

          {overview.proPages && <ProPagesSection view={overview.proPages} onRun={setConfirming} onVoted={load} />}

          <section aria-labelledby="model-lab-results" className={cx(LAB_PANEL, 'min-w-0 p-3')}>
            <h3 id="model-lab-results" className="text-[14.5px] font-semibold tracking-tight text-[var(--ds-ink)]">
              Results (D1–D3)
            </h3>
            {overview.results.length === 0 ? (
              <p className="mt-1 text-[12.5px] text-[var(--ds-muted)]">Nothing has run yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {overview.results.map((run) => (
                  <li key={run.id} className="min-w-0">
                    <LabResultCard run={run} onChange={replaceResult} headingLevel="h4" />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {confirming && overview && (
        <RunConfirmDialog
          item={confirming}
          spentUsd={overview.spentUsd}
          capUsd={overview.capUsd}
          onClose={() => setConfirming(null)}
          onDone={() => load()}
          {...((confirming.check === 'P1' || confirming.check === 'P2') && overview.proPages ? { abBudget: overview.proPages.budget } : {})}
        />
      )}
    </section>
  );
};

export default ModelLabSection;
