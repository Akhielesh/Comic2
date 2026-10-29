// Cost and model insights (models.md §4.1): progressive disclosure, real data only, nothing new in the header.
//
//   L1 — the Cost card (the breakdown card's Cost view, the one the owner likes): its rows, plus
//        • "Translate" in "Where it went" (the shared spend summary lists every kind with spend);
//        • "Failed attempts: {n} · {$}", only when n > 0;
//        • "Real cost per page: ≈{$} (your last {n}) · list {$}", only when n ≥ 3;
//        • the lock line (§3.6 A) with "Change…" / "Choose model…" (the `open_model_picker` client action);
//        • Easy only: "More details", which opens the tabs in an AdaptiveSheet.
//   L2 — tabs Overview · Pages · Models · Trends: inline for Pro, one tap away for Easy. A tablist with arrow
//        keys, Home/End and a roving tabindex; only the open tab is mounted, so the catalog is fetched when the
//        Models tab opens and the trends when the Trends tab opens — never on a timer.
//
// Every amount is printed for THIS viewer (conversation/cost.ts): governed users read a share of their usage,
// never dollars; admins and own-key comics read dollars. Missing data is the exact §4.6 copy, never a guess.

import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import { Lock, PanelsTopLeft } from 'lucide-react';
import type { ClientAction, ComicDoc, QualityTier } from '../../../shared/comic/doc';
import { estimateJobs, getImageModel, resolveImageJob } from '../../../shared/comic/models';
import { deriveLock } from '../../../shared/comic/modelLock';
import type { BookSummary, quoteRenderPages } from '../../../shared/comic/plan';
import { amountInSentence, compactUsageShare } from '../../../services/costDisplay';
import { LABEL, RADIUS_CONTROL, TRANSITION } from '../../chat/studioDesign';
import type { CostFormat } from '../conversation/cost';
import { cx, plural } from '../conversation/ui';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import {
  CHANGE_MODEL_LINK,
  CHOOSE_MODEL_LINK,
  INSIGHTS_TAB_LABELS,
  LOCK_ICON_LABEL,
  SAVED_BY_SOFTWARE_COPY,
  lockedLine,
  priceListCopy,
  unlockedLine
} from './copy';
import { insightsMoney, pageRealCost, spendSummary, type InsightsMoney } from './insightsModel';
import { ModelsTab } from './ModelsTab';
import { OverviewTab, SpendByKindList } from './OverviewTab';
import { PagesTab } from './PagesTab';
import { TrendsTab } from './TrendsTab';
import { useHeldCatalog } from './useInsights';
import { FOCUS, TextButton, WRAP } from './ui';

export type InsightsTabId = keyof typeof INSIGHTS_TAB_LABELS;
export const INSIGHTS_TABS: readonly InsightsTabId[] = ['overview', 'pages', 'models', 'trends'];

const TIER_LABEL: Record<QualityTier, string> = { draft: 'Draft', standard: 'Standard', pro: 'Pro' };

// ── L2: the tabs ─────────────────────────────────────────────────────────────

export interface InsightsTabsProps {
  doc: ComicDoc;
  money: InsightsMoney;
  byok: boolean;
  pro: boolean;
  openPicker(suggest?: string): void;
  initialTab?: InsightsTabId;
  now?: number;
}

export const InsightsTabs: React.FC<InsightsTabsProps> = ({ doc, money, byok, pro, openPicker, initialTab = 'overview', now }) => {
  const [active, setActive] = useState<InsightsTabId>(initialTab);
  const base = useId();
  const refs = useRef(new Map<InsightsTabId, HTMLButtonElement>());
  const held = useHeldCatalog(doc.id);
  const select = (id: InsightsTabId, focus: boolean) => {
    setActive(id);
    if (focus) refs.current.get(id)?.focus();
  };
  // WAI-ARIA tabs: ←/→ move (wrapping) and select; Home/End jump to the ends; one Tab stop (roving tabindex).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = INSIGHTS_TABS.indexOf(active);
    let next = i;
    if (e.key === 'ArrowRight') next = (i + 1) % INSIGHTS_TABS.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + INSIGHTS_TABS.length) % INSIGHTS_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = INSIGHTS_TABS.length - 1;
    else return;
    e.preventDefault();
    select(INSIGHTS_TABS[next], true);
  };
  const tabId = (id: InsightsTabId) => `${base}-tab-${id}`;
  const panelId = (id: InsightsTabId) => `${base}-panel-${id}`;
  return (
    <div className="min-w-0" data-insights-tabs="">
      <div
        role="tablist"
        aria-label="Cost details"
        onKeyDown={onKeyDown}
        className={cx('grid min-w-0 grid-cols-4 gap-0.5 bg-[var(--ds-well-strong)] p-0.5', RADIUS_CONTROL)}
      >
        {INSIGHTS_TABS.map((id) => {
          const on = id === active;
          return (
            <button
              key={id}
              ref={(el) => {
                if (el) refs.current.set(id, el);
                else refs.current.delete(id);
              }}
              type="button"
              role="tab"
              id={tabId(id)}
              aria-selected={on}
              aria-controls={panelId(id)}
              tabIndex={on ? 0 : -1}
              onClick={() => select(id, false)}
              className={cx(
                `min-w-0 truncate rounded-[var(--ds-radius-sm)] px-1 py-1.5 text-[12px] font-medium ${TRANSITION} ${FOCUS} coarse:min-h-11`,
                on ? 'bg-[var(--ds-raised)] text-[var(--ds-ink)] shadow-[shadow:var(--ds-shadow-soft)]' : 'text-[var(--ds-muted)] hover:text-[var(--ds-ink)]'
              )}
            >
              {INSIGHTS_TAB_LABELS[id]}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId(active)} aria-labelledby={tabId(active)} tabIndex={0} className={cx('mt-2 min-w-0', RADIUS_CONTROL, FOCUS)}>
        {active === 'overview' && <OverviewTab doc={doc} money={money} />}
        {active === 'pages' && <PagesTab doc={doc} money={money} byok={byok} rows={held} now={now} />}
        {active === 'models' && <ModelsTab doc={doc} money={money} pro={pro} openPicker={openPicker} now={now} />}
        {active === 'trends' && <TrendsTab doc={doc} money={money} pro={pro} now={now} />}
      </div>
    </div>
  );
};

// ── L1: the cost card ────────────────────────────────────────────────────────

const CostRow: React.FC<{ label: React.ReactNode; value: React.ReactNode; note?: React.ReactNode }> = ({ label, value, note }) => (
  <div className="flex min-w-0 items-baseline justify-between gap-3 py-1">
    <span className="min-w-0">
      <span className={cx('block text-[12px] text-[var(--ds-ink)]', WRAP)}>{label}</span>
      {note && <span className={cx('block text-[11px] text-[var(--ds-muted)]', WRAP)}>{note}</span>}
    </span>
    <span className="shrink-0 text-[12.5px] font-semibold tabular-nums text-[var(--ds-ink)]">{value}</span>
  </div>
);

/** "3 pages $0.21" / "1 character sheet ≈1% of your usage" from an estimate line. */
const lineText = (l: { label: string; count: number; usd: number }, cost: CostFormat) =>
  `${l.count} ${l.count === 1 ? l.label.replace(/s$/, '') : l.label} ${amountInSentence(cost.exact(l.usd))}`;

export interface CostInsightsProps {
  doc: ComicDoc;
  book: BookSummary;
  quote: ReturnType<typeof quoteRenderPages>;
  byok: boolean;
  pro: boolean;
  cost: CostFormat;
  /** The cover's figure in this viewer's words (what it cost, its quote, or its status). */
  coverLine: string;
  /** The studio's client actions (the picker opens through `open_model_picker`). */
  runClientAction(action: ClientAction): void;
  now?: number;
}

export const CostInsights: React.FC<CostInsightsProps> = ({ doc, book, quote, byok, pro, cost, coverLine, runClientAction, now }) => {
  const money = useMemo(() => insightsMoney(cost), [cost]);
  const summary = useMemo(() => spendSummary(doc), [doc]);
  const real = useMemo(() => pageRealCost(doc), [doc]);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const openPicker = useCallback(
    (suggest?: string) => {
      setMoreOpen(false);
      runClientAction(suggest ? { type: 'open_model_picker', suggest } : { type: 'open_model_picker' });
    },
    [runClientAction]
  );

  /** A narrow cell: "$0.12" / "≈1%"; undefined while a governed share isn't known (the cell then shows "—"). */
  const cell = (usd: number) => (cost.governed ? compactUsageShare(cost.exact(usd)) : cost.exact(usd));
  const quoteCell = (usd: number) => (cost.governed ? compactUsageShare(cost.badge(usd)) : cost.badge(usd));

  // The lock line (§3.6 A) and what the next page costs on the comic's model, at its quality.
  const lock = deriveLock(doc);
  const tier = doc.settings.quality;
  const override = doc.settings.imageModelOverride;
  const lockedSpec = lock ? getImageModel(lock.modelId) : undefined;
  const next = resolveImageJob('page', tier, override, lock);
  const modelName = lock ? (lockedSpec?.nickname ?? lock.modelId) : next.spec.nickname;
  const priced = !lock || !!lockedSpec;
  const pageUsd = estimateJobs([{ kind: 'page', count: 1 }], tier, { override, byok, lock }).usd;
  const coverUsd = estimateJobs([{ kind: 'cover', count: 1 }], tier, { override, byok, lock }).usd;
  const realList = real?.list ? `${money.price(real.list.usd)}${real.list.source === 'registry' ? ` (${priceListCopy(real.list.factsAsOf)})` : ''}` : 'not published';
  const realRange = real ? [money.priceShort(real.minUsd), money.priceShort(real.maxUsd)] : [];
  const realValue = real ? money.price(real.medianUsd) : '';

  return (
    <>
      <section aria-label="Cost breakdown" className={cx('mt-3 min-w-0 border border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-soft)] px-3 py-2', RADIUS_CONTROL)}>
        <div className="divide-y divide-[var(--ds-hairline-soft)]">
          <CostRow
            label="Spent on this comic"
            value={doc.spend.totalUsd > 0 ? amountInSentence(cost.exact(doc.spend.totalUsd), 'Some of your usage') : 'Nothing yet'}
            note={byok ? 'Images on your own key — tracked so you see the real cost.' : cost.governed ? 'Shown as a share of your usage.' : undefined}
          />
          {summary.savedUsd > 0 && <CostRow label="Saved by software" value={cost.exact(summary.savedUsd)} note={SAVED_BY_SOFTWARE_COPY} />}
          {summary.failed.count > 0 && (
            <CostRow
              label="Failed attempts"
              value={`${summary.failed.count} · ${money.spent(summary.failed.usd)}`}
              note={summary.failed.usd > 0 ? 'What the provider charged for attempts that didn’t come back.' : 'Nothing was charged for them.'}
            />
          )}
          <CostRow
            label="To draw now"
            value={quote.nothing ? 'Nothing' : cost.badge(quote.usd)}
            note={quote.nothing ? 'Every page here is drawn and up to date.' : quote.lines.map((l) => lineText(l, cost)).join(' · ')}
          />
          <CostRow label="Cover" value={coverLine} />
          <CostRow
            label={
              <span className="inline-flex max-w-full items-center gap-1">
                <span className={cx('min-w-0', WRAP)}>{lock ? lockedLine(modelName) : unlockedLine(modelName)}</span>
                {lock && <Lock className="h-3 w-3 shrink-0 text-[var(--ds-muted)]" role="img" aria-label={LOCK_ICON_LABEL} />}
              </span>
            }
            value={priced ? `${quoteCell(pageUsd) ?? 'a little'}/page` : '—'}
            note={
              <>
                {priced
                  ? `${TIER_LABEL[tier] ?? tier} quality · ${next.resolution} · a page ${cost.badge(pageUsd)} · cover ${cost.badge(coverUsd)} · prices from the model price list${byok ? ', no markup on your key' : ''} `
                  : 'This model is no longer in our price list, so it can’t be priced here. '}
                <TextButton onClick={() => openPicker()}>{lock ? CHANGE_MODEL_LINK : CHOOSE_MODEL_LINK}</TextButton>
              </>
            }
          />
          {real && (
            <CostRow
              label="Real cost per page"
              value={realValue.startsWith('≈') ? realValue : `≈${realValue}`}
              note={`(your last ${real.n}${realRange[0] && realRange[1] ? `: ${realRange[0]}–${realRange[1]}` : ''}) · list ${realList} · ${real.nickname} at ${real.res}`}
            />
          )}
        </div>
        {summary.kinds.length > 0 && (
          <div className="mt-2">
            <div className={cx(LABEL, 'mb-1 text-[10.5px]')}>Where it went{cost.governed ? ' · share of your usage' : ''}</div>
            <SpendByKindList rows={summary.kinds} format={cell} label="Where it went" bars />
          </div>
        )}
        {!pro && (
          <div className="mt-2">
            <button
              ref={moreRef}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
              className={cx(
                `inline-flex items-center gap-1.5 ${RADIUS_CONTROL} border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[12px] font-medium text-[var(--ds-ink)] hover:bg-[var(--ds-hover)] ${TRANSITION} ${FOCUS} coarse:min-h-11 coarse:px-3.5`
              )}
            >
              <PanelsTopLeft className="h-3.5 w-3.5" aria-hidden />
              More details
            </button>
          </div>
        )}
      </section>
      {pro && (
        <div className="mt-3 min-w-0">
          <InsightsTabs doc={doc} money={money} byok={byok} pro={pro} openPicker={openPicker} now={now} />
        </div>
      )}
      {!pro && (
        <AdaptiveSheet
          open={moreOpen}
          onClose={() => setMoreOpen(false)}
          label="Cost details"
          title="Cost details"
          anchorRef={moreRef}
          placement="above"
          align="end"
          panel
          detents={['half', 'full']}
        >
          <div className="w-[min(32rem,calc(100vw-2rem))] max-w-full p-3">
            <p className={cx('mb-2 text-[11.5px] text-[var(--ds-muted)]', WRAP)}>
              {plural(doc.pages.length, 'page')} · everything here comes from this comic’s ledger and live model data, with its source.
            </p>
            <InsightsTabs doc={doc} money={money} byok={byok} pro={pro} openPicker={openPicker} now={now} />
          </div>
        </AdaptiveSheet>
      )}
    </>
  );
};

export default CostInsights;
