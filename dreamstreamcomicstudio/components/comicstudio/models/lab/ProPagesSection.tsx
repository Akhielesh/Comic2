// Admin → Model Lab → P1 · Pro pages A/B, part 1 (plan §7, §10 A6). Three of the owner's golden pages, each drawn with
// the layout guide off and on, every drawing checked once, judged blind. Costs first: the whole set's quote (6 page jobs
// + 6 page checks from the PriceBook) and every drawing's own quote show before anything can run. Until the server-side
// switch (COMIC_LAB_AB_BUDGET_USD) is set — the owner hasn't approved these test drawings yet (PD-8) — the section is a
// calm "not enabled yet" with no Draw buttons, and the server refuses a click unsent anyway. A Draw button only opens the
// shared confirm dialog; nothing is sent from here. No timers.

import React from 'react';
import { Columns2, Info, Lock } from 'lucide-react';
import { TONE_CHIP, TONE_TEXT } from '../../../chat/studioDesign';
import { cx } from '../../conversation/ui';
import { ModelHealthDot } from '../../reliability/ModelHealthDot';
import { ProPagesPairCard } from './ProPagesPairCard';
import { armAsLabItem, formatLabUsd, type LabItem, type ProPagesArmItem, type ProPagesOverview, type ProPagesTally } from './labApi';
import { LAB_PANEL, LAB_PRIMARY_BTN, LAB_WELL, WRAP } from './labStyles';

const ArmRow: React.FC<{ arm: ProPagesArmItem; enabled: boolean; onRun: (item: LabItem) => void }> = ({ arm, enabled, onRun }) => (
  <li className={cx(LAB_WELL, 'min-w-0 p-3')} data-ab-arm={arm.id}>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className={cx('min-w-0 text-[13px] font-semibold text-[var(--ds-ink)]', WRAP)}>{arm.label}</span>
      {arm.health && arm.health.state !== 'unknown' && <ModelHealthDot state={arm.health.state} label={arm.nickname} />}
      {arm.runs.ok + arm.runs.failed + arm.runs.running > 0 && (
        <span className="text-[11.5px] tabular-nums text-[var(--ds-muted)]">
          {[arm.runs.ok ? `drawn ${arm.runs.ok}×` : '', arm.runs.failed ? `failed ${arm.runs.failed}×` : '', arm.runs.running ? 'running' : ''].filter(Boolean).join(' · ')}
        </span>
      )}
    </div>
    {arm.nickname && (
      <p className={cx('mt-0.5 text-[12px] text-[var(--ds-muted)]', WRAP)}>
        {arm.nickname} · {arm.res} · {arm.aspect} · {arm.refsNote}
      </p>
    )}
    {arm.quote && (
      <p className="mt-1 text-[13px] tabular-nums text-[var(--ds-ink)]">
        ≈ {formatLabUsd(arm.quote.usd)}
        <span className="text-[12px] text-[var(--ds-muted)]"> page + check{arm.quote.refsUnpriced ? ' · + reference input (unpublished)' : ''}</span>
      </p>
    )}
    {enabled && arm.canRun && arm.quote ? (
      <button type="button" onClick={() => onRun(armAsLabItem(arm))} className={cx(LAB_PRIMARY_BTN, 'mt-2')} aria-label={`Draw ${arm.title} — ${formatLabUsd(arm.quote.usd)}`}>
        {arm.runs.ok ? 'Draw again' : 'Draw'} · {formatLabUsd(arm.quote.usd)}
      </button>
    ) : !enabled ? (
      <p className="mt-2 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--ds-muted)]">
        <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden /> Not enabled yet
      </p>
    ) : (
      arm.reason && (
        <p className={cx('mt-2 flex min-w-0 items-start gap-1.5 text-[12.5px]', TONE_TEXT.warning, WRAP)}>
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{arm.reason}</span>
        </p>
      )
    )}
  </li>
);

/** "Guide on 6 of 6 · guide off 4 of 6" from the voted pairs' checks. */
const beatsLine = (t: ProPagesTally): string | null => {
  const part = (label: string, b: { matched: number; planned: number }) => (b.planned ? `${label} ${b.matched} of ${b.planned} panels` : null);
  const parts = [part('guide on', t.beats.on), part('guide off', t.beats.off)].filter(Boolean);
  return parts.length ? `Beats matched: ${parts.join(' · ')}.` : null;
};

const TallyLine: React.FC<{ tally: ProPagesTally }> = ({ tally }) => {
  const beats = beatsLine(tally);
  return (
    <div className={cx(LAB_WELL, 'mt-2 min-w-0 p-3 text-[12.5px] text-[var(--ds-ink)]')} data-ab-tally="">
      <p className={cx('tabular-nums', WRAP)}>
        Your votes so far ({tally.voted} of {tally.pairs} pages): guide on {tally.picks.on} · guide off {tally.picks.off} · about the same {tally.picks.tie}.
      </p>
      {beats && <p className={cx('mt-0.5 tabular-nums text-[var(--ds-muted)]', WRAP)}>{beats}</p>}
    </div>
  );
};

export const ProPagesSection: React.FC<{ view: ProPagesOverview; onRun: (item: LabItem) => void }> = ({ view, onRun }) => {
  const total = view.quote;
  const allSix = total.arms > 0 && total.arms === view.pages.length * 2;
  const pct = view.budget.limitUsd && view.budget.spentUsd !== null ? Math.min(100, Math.round((view.budget.spentUsd / Math.max(0.0001, view.budget.limitUsd)) * 100)) : 0;
  return (
    <section aria-label={`${view.id} · ${view.title}`} className={cx(LAB_PANEL, 'min-w-0 p-3')} data-lab-check={view.id} data-ab-enabled={view.enabled ? 'true' : 'false'}>
      <header className="min-w-0">
        <h3 className={cx('flex min-w-0 items-start gap-2 text-[14.5px] font-semibold tracking-tight text-[var(--ds-ink)]', WRAP)}>
          <Columns2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ds-accent)]" aria-hidden />
          <span className="min-w-0">
            {view.id} · {view.title}
          </span>
        </h3>
        <p className={cx('mt-0.5 text-[12.5px] text-[var(--ds-ink)]', WRAP)}>{view.decision}</p>
        <p className={cx('mt-0.5 text-[12px] text-[var(--ds-muted)]', WRAP)}>Records: {view.answers}</p>
        {view.note && <p className={cx('mt-0.5 text-[12px] text-[var(--ds-muted)]', WRAP)}>{view.note}</p>}
      </header>

      {!view.enabled ? (
        <div role="status" className={cx('mt-2 flex min-w-0 items-start gap-2 rounded-[var(--ds-radius-control)] border px-3 py-2 text-[12.5px]', TONE_CHIP.info, WRAP)} data-ab-not-enabled="">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p>{view.notice || 'Not enabled yet.'}</p>
            <p className="mt-0.5 text-[11.5px]">
              Server switch: <code className={cx('font-mono', WRAP)}>{view.switchName}</code>
            </p>
          </div>
        </div>
      ) : (
        view.budget.limitUsd !== null && (
          <div className="mt-2 min-w-0" data-ab-budget="">
            <p className={cx('text-[13px] tabular-nums text-[var(--ds-ink)]', WRAP)}>
              A/B budget: <strong className="font-semibold">{formatLabUsd(view.budget.spentUsd)}</strong> of {formatLabUsd(view.budget.limitUsd)} used
              {view.budget.remainingUsd !== null ? ` · ${formatLabUsd(view.budget.remainingUsd)} left` : ''} · every day, shared with part 2 (hard cap {formatLabUsd(view.budget.capUsd)})
            </p>
            <div
              role="progressbar"
              aria-label="A/B budget used"
              aria-valuemin={0}
              aria-valuemax={view.budget.limitUsd}
              aria-valuenow={view.budget.spentUsd ?? 0}
              aria-valuetext={`${formatLabUsd(view.budget.spentUsd)} of ${formatLabUsd(view.budget.limitUsd)}`}
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-well-strong)]"
            >
              <div className="h-full rounded-full bg-[var(--ds-accent)]" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      )}

      <div className="mt-2 min-w-0" data-ab-quote="">
        {total.usd !== null ? (
          <p className="text-[13px] tabular-nums text-[var(--ds-ink)]">
            {allSix ? 'All six drawings' : `The ${total.arms} drawings that can be quoted`}: <strong className="font-semibold">≈ {formatLabUsd(total.usd)}</strong>
            <span className="text-[12px] text-[var(--ds-muted)]">
              {' '}
              ({total.pages} page{total.pages === 1 ? '' : 's'} + {total.checks} page check{total.checks === 1 ? '' : 's'}, provider price)
              {total.refsUnpriced ? ' + reference input (unpublished)' : ''}
            </span>
          </p>
        ) : (
          <p className={cx('text-[12.5px]', TONE_TEXT.warning, WRAP)}>There's no quote for these drawings right now, so none of them can run.</p>
        )}
        {total.basis.length > 0 && <p className={cx('text-[11.5px] text-[var(--ds-muted)]', WRAP)}>Quote basis: {total.basis.join(' · ')}</p>}
      </div>

      <ul className="mt-3 space-y-3" aria-label="Golden pages">
        {view.pages.map((page) => (
          <li key={page.key} className="min-w-0" data-ab-page={page.key}>
            <p className={cx('text-[13px] font-semibold text-[var(--ds-ink)]', WRAP)}>{page.label}</p>
            <p className={cx('text-[12px] text-[var(--ds-muted)]', WRAP)}>{page.why}</p>
            {page.available && page.arms.length ? (
              <ul className="mt-1.5 grid min-w-0 gap-2 sm:grid-cols-2">
                {page.arms.map((arm) => (
                  <ArmRow key={arm.id} arm={arm} enabled={view.enabled} onRun={onRun} />
                ))}
              </ul>
            ) : (
              <p className={cx('mt-1 flex min-w-0 items-start gap-1.5 text-[12.5px]', TONE_TEXT.warning, WRAP)}>
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0">{page.reason || "This page can't be drawn here."}</span>
              </p>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 min-w-0">
        <h4 className="text-[13.5px] font-semibold text-[var(--ds-ink)]">Side by side</h4>
        <p className={cx('text-[12px] text-[var(--ds-muted)]', WRAP)}>
          A and B are shuffled per page. Which one had the guide, its cost and its page check appear only after your vote, and a vote is final. While a page waits for your vote,
          neither drawing can be redrawn.
        </p>
        {view.tally && <TallyLine tally={view.tally} />}
        <ul className="mt-2 space-y-2" aria-label="A/B pairs">
          {view.pairs.map((pair) => (
            <ProPagesPairCard key={pair.id} pair={pair} />
          ))}
        </ul>
      </div>
    </section>
  );
};

export default ProPagesSection;
