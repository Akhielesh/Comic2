// Pages (models.md §4.2): one row per drawn target — cover, pages in book order, character sheets, places — with
// what was spent on it (spend.byTarget, else summed from entries), how many versions exist, the model and size it
// was drawn at (asset model, w×h → aspect) and "redraw now on {locked model}: ≈{$}". Mixed sizes and older models
// get a quiet badge. Spend comes from the doc; redraw prices from the catalog rows already held (no request of
// its own), else the registry's dated price list, never under the comic's own observed cost (models.md §2.3).

import React, { useMemo } from 'react';
import type { ComicDoc, Resolution } from '../../../shared/comic/doc';
import { MAX_SPEND_ENTRIES } from '../../../shared/comic/limits';
import { PLATFORM_MARKUP, QC_USD_PER_PAGE, getImageModel, type ImageJobKind } from '../../../shared/comic/models';
import { lockedModelId, redrawResolution, type PriceBook } from '../../../shared/comic/modelLock';
import { byTarget } from '../../../shared/comic/modelInsights';
import type { ModelCatalogRow } from '../../../shared/comic/modelCatalog';
import { cx, plural } from '../conversation/ui';
import { couldntRefreshCopy, priceListCopy, recentLabel } from './copy';
import { OBSERVED_MIN_N, clockText, nicknameOf, observedCost, rowFor, type InsightsMoney } from './insightsModel';
import { Badge, Section, Source, WRAP } from './ui';

const KIND_OF: Record<string, ImageJobKind> = { page: 'page', cover: 'cover', sheet: 'sheet', place: 'place', style_option: 'style_option' };

const priced = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** One new image of `kind` on a model for this comic: its provider price, where it comes from, and the size. */
export interface InsightsUnit {
  /** Provider $ per image (no QC, no markup); null when there is no basis at all ("can't price yet"). */
  usd: number | null;
  /** observed: this comic's own median (n ≥ 3) — used when it is above the list or there is no list;
   *  catalog: a catalog row already held; registry: the dated price list; none: nothing to price with. */
  basis: 'observed' | 'catalog' | 'registry' | 'none';
  /** The size it draws at NOW: `kind` on that model at this comic's tier (redrawResolution) — never the size an
   *  older image happened to be drawn at. */
  res: Resolution;
  /** Calls behind an observed figure. */
  n?: number;
}

/**
 * The server's quote rule on the client (models.md §2.3, AT-6; server/src/comic/models/pricing.ts): the list price is
 * the held catalog row's, else the registry's; this comic's own observed median (n ≥ 3, the last ≤ 20 calls at that
 * size) wins when it is higher or when there is no list — never under what the user really paid.
 */
export const insightsUnit = (doc: ComicDoc, rows: readonly ModelCatalogRow[] | null, modelId: string, kind: ImageJobKind): InsightsUnit => {
  const res = redrawResolution(doc, modelId, kind);
  const live = rowFor(rows, modelId)?.price[res]?.usd;
  const reg = getImageModel(modelId)?.priceUsd[res];
  const list = priced(live) ? live : priced(reg) ? reg : null;
  const obs = observedCost(doc.spend.entries, (e) => KIND_OF[e.kind] === kind && e.model === modelId && e.res === res);
  if (obs && obs.n >= OBSERVED_MIN_N && (list === null || obs.medianUsd >= list)) return { usd: obs.medianUsd, basis: 'observed', res, n: obs.n };
  if (list === null) return { usd: null, basis: 'none', res };
  return { usd: list, basis: priced(live) ? 'catalog' : 'registry', res };
};

/**
 * A client PriceBook for redraw quotes (insightsUnit per image, QC per page). The `res` argument is ignored on
 * purpose: shared byTarget passes the size each image WAS drawn at, but a redraw draws at the size this comic's tier
 * draws now — exactly what redrawQuote and the change-model confirm price (models.md §3.5).
 */
export const insightsPriceBook = (doc: ComicDoc, rows: readonly ModelCatalogRow[] | null): PriceBook => ({
  unit(modelId: string, _drawnAt: Resolution, kind: ImageJobKind) {
    const u = insightsUnit(doc, rows, modelId, kind);
    return { usd: u.usd, basis: u.basis };
  },
  qcUsd: QC_USD_PER_PAGE
});

export interface PagesTabProps {
  doc: ComicDoc;
  money: InsightsMoney;
  byok: boolean;
  /** Catalog rows already held for this comic (the Models tab fetched them), or null. */
  rows?: readonly ModelCatalogRow[] | null;
  now?: number;
}

export const PagesTab: React.FC<PagesTabProps> = ({ doc, money, byok, rows = null, now }) => {
  const prices = useMemo(() => insightsPriceBook(doc, rows), [doc, rows]);
  const targets = useMemo(() => byTarget(doc, prices), [doc, prices]);
  const locked = lockedModelId(doc);
  const lockedRow = locked ? rowFor(rows, locked) : undefined;
  const spec = locked ? getImageModel(locked) : undefined;
  const capped = !doc.spend.byTarget && doc.spend.entries.length >= MAX_SPEND_ENTRIES;
  if (!targets.length) return <p className="text-[12.5px] text-[var(--ds-muted)]">Nothing drawn yet. Each page, sheet and the cover get a row here once they are.</p>;
  // OpenRouter and its fetch time only for a live price at the size a page redraws at; a registry fallback is the
  // dated price list, and a row whose refresh failed says so (§4.6 "as of {time} · couldn't refresh").
  const livePrice = lockedRow && locked ? lockedRow.price[redrawResolution(doc, locked, 'page')] : undefined;
  const liveAt = livePrice && typeof livePrice.usd === 'number' && livePrice.basis !== 'registry' ? lockedRow?.fetchedAt.catalog : undefined;
  const priceSource = liveAt
    ? lockedRow?.stale
      ? couldntRefreshCopy(clockText(liveAt, now))
      : `OpenRouter, ${clockText(liveAt, now)}`
    : spec
      ? priceListCopy(spec.factsAsOf)
      : 'no price list for this model';
  return (
    <Section title="Every drawn image" aside={capped ? `Spent ${recentLabel(doc.spend.entries.length)}` : undefined}>
      <ul aria-label="Spend per page" className="min-w-0 divide-y divide-[var(--ds-hairline-soft)]">
        {targets.map((r) => {
          const meta = [
            r.nickname ?? (r.model ? nicknameOf(r.model) : undefined),
            r.res && !r.badges.includes(r.res) ? r.res : undefined,
            r.w && r.h ? `${r.w}×${r.h}${r.aspect ? ` (${r.aspect})` : ''}` : undefined,
            r.versions > 0 ? plural(r.versions, 'version') : 'not drawn now'
          ].filter(Boolean);
          const redraw = typeof r.redrawUsd === 'number' ? money.quote(r.redrawUsd * (byok ? 1 : PLATFORM_MARKUP)) : r.redrawUsd === null ? 'can’t price yet' : undefined;
          return (
            <li key={r.key} data-target={r.key} aria-label={r.label} className="grid min-w-0 gap-x-3 gap-y-0.5 py-2 min-[480px]:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className={cx('min-w-0 text-[12.5px] font-medium text-[var(--ds-ink)]', WRAP)}>{r.label}</span>
                  {r.badges.map((b) => (
                    <Badge key={b} title={b === 'older model' ? 'Drawn with a different model than this comic is locked to' : 'The size this image was drawn at'}>
                      {b}
                    </Badge>
                  ))}
                </div>
                <div className={cx('text-[11px] text-[var(--ds-muted)]', WRAP)}>{meta.join(' · ')}</div>
              </div>
              <div className="min-w-0 min-[480px]:text-right">
                <div className={cx('text-[12.5px] font-semibold tabular-nums text-[var(--ds-ink)]', WRAP)}>
                  {r.spentUsd > 0 ? money.spent(r.spentUsd) : '—'} <span className="font-normal text-[var(--ds-muted)]">spent</span>
                </div>
                {redraw && spec && (
                  <div className={cx('text-[11px] tabular-nums text-[var(--ds-muted)]', WRAP)}>
                    Redraw now on {spec.nickname}: {redraw}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Source>
        Spent: this comic’s ledger — every version of the image and its quality checks.
        {spec ? ` Redraw: one new version on ${spec.nickname} at this comic’s quality${byok ? ', on your own key' : ''} · ${priceSource}.` : ''}
      </Source>
    </Section>
  );
};

export default PagesTab;
