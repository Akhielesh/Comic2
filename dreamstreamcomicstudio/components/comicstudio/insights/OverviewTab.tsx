// Overview (models.md §4.2): where this comic's money went, exactly — spend.totalUsd, byKind (Translate included;
// a kind at 0 is hidden), "saved by software" shown quietly (decisions-final #6), failed attempts, the own-key vs
// DreamStream split (entries.byok) and how many amounts are list-price estimates. All from the doc; nothing
// fetched. Also home of SpendByKindList, the one "spend by kind" list every Spending view renders.

import React, { useMemo } from 'react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { cx, plural } from '../conversation/ui';
import { SAVED_BY_SOFTWARE_COPY, recentLabel } from './copy';
import { spendSummary, type InsightsMoney, type SpendSummaryKind } from './insightsModel';
import { Fact, Section, Source, WRAP } from './ui';

export interface SpendByKindListProps {
  rows: readonly SpendSummaryKind[];
  /** The amount in this viewer's words; undefined (a governed share not known yet) prints "—", never dollars. */
  format(usd: number): string | undefined;
  /** Accessible name of the list (default "Spend by kind"). */
  label?: string;
  /** Proportional bars between the name and the amount. */
  bars?: boolean;
  className?: string;
}

/** Spend by kind, in the shared display order. Shared by the header's Spending sheet, the Story tab and the cost card. */
export const SpendByKindList: React.FC<SpendByKindListProps> = ({ rows, format, label = 'Spend by kind', bars = false, className }) => {
  const max = Math.max(0, ...rows.map((r) => r.usd)) || 1;
  return (
    <ul aria-label={label} className={cx('min-w-0 space-y-1', className)}>
      {rows.map((r) => (
        <li
          key={r.kind}
          className={cx(
            'min-w-0 items-center gap-2 text-[12px]',
            bars ? 'grid grid-cols-[minmax(0,7rem)_minmax(1.5rem,1fr)_auto]' : 'flex justify-between'
          )}
        >
          <span className="min-w-0 truncate text-[var(--ds-muted)]" title={r.label}>
            {r.label}
          </span>
          {bars && (
            <span className="h-1.5 min-w-0 overflow-hidden rounded-[var(--ds-radius-chip)] bg-[var(--ds-well-strong)]" aria-hidden>
              <span className="block h-full rounded-[var(--ds-radius-chip)] bg-[var(--ds-accent)]" style={{ width: `${Math.max(4, Math.round((r.usd / max) * 100))}%` }} />
            </span>
          )}
          <span className={cx('min-w-0 max-w-[10rem] text-right tabular-nums text-[var(--ds-ink)]', WRAP)}>{format(r.usd) ?? '—'}</span>
        </li>
      ))}
    </ul>
  );
};

export interface OverviewTabProps {
  doc: ComicDoc;
  money: InsightsMoney;
}

export const OverviewTab: React.FC<OverviewTabProps> = ({ doc, money }) => {
  const s = useMemo(() => spendSummary(doc), [doc]);
  const recent = s.exact ? '' : ` ${recentLabel(s.recentN ?? doc.spend.entries.length)}`;
  if (!(s.totalUsd > 0) && !s.kinds.length && !s.savedUsd && !s.failed.count) {
    return <p className="text-[12.5px] text-[var(--ds-muted)]">Nothing spent on this comic yet. Every paid step shows its price first and lands here with its real cost.</p>;
  }
  // Dollar viewers also see each kind's part of the total (a governed amount is already a percentage).
  const share = (usd: number) => (!money.governed && s.totalUsd > 0 ? ` · ${Math.round((usd / s.totalUsd) * 100)}%` : '');
  return (
    <div className="min-w-0 space-y-3">
      <div className="divide-y divide-[var(--ds-hairline-soft)]">
        <Fact label="Spent on this comic" value={money.spent(s.totalUsd)} />
        {(s.byok.usd > 0 || s.byok.images > 0) && (
          <Fact
            label={`Paid by your own key${recent}`}
            value={money.governed ? plural(s.byok.images, 'image') : money.spent(s.byok.usd)}
            note={money.governed ? 'Not taken from your usage — your key pays the provider.' : `${plural(s.byok.images, 'image')} · billed by the provider to your key, not by DreamStream`}
          />
        )}
        {(s.platform.usd > 0 || s.platform.images > 0) && (
          <Fact label={`Through DreamStream${recent}`} value={money.spent(s.platform.usd)} note={plural(s.platform.images, 'image')} />
        )}
        {s.failed.count > 0 && (
          <Fact
            label="Failed attempts"
            value={`${s.failed.count} · ${money.spent(s.failed.usd)}`}
            note={s.failed.usd > 0 ? 'What the provider charged for attempts that didn’t come back.' : 'Nothing was charged for them.'}
          />
        )}
        {s.savedUsd > 0 && (
          <Fact label="Saved by software" value={money.spent(s.savedUsd)} note={SAVED_BY_SOFTWARE_COPY} className="text-[var(--ds-muted)]" />
        )}
      </div>
      {s.kinds.length > 0 && (
        <Section title="By kind">
          <SpendByKindList rows={s.kinds} format={(usd) => `${money.spent(usd)}${share(usd)}`} />
        </Section>
      )}
      {s.estimated > 0 && (
        <Source>
          {s.estimated === 1 ? '1 amount is a list-price estimate' : `${s.estimated} amounts are list-price estimates`} — the provider didn’t report a cost{recent}.
        </Source>
      )}
      <Source>From this comic’s spend ledger{s.exact ? '' : `; the own-key split covers the last ${s.recentN} entries`}.</Source>
    </div>
  );
};

export default OverviewTab;
