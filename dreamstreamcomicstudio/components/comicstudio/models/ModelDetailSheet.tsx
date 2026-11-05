// The model detail (models.md §4.1 L3): everything we know about one model, each figure with its source and
// time — prices per resolution and their basis, providers and their uptime, every public leaderboard entry we
// hold, this user's real costs (n ≥ 3 only), our own 24 h reliability, the registry facts and the price changes
// we recorded. Missing data reads as missing (§4.6), never as a guess. Reached from a picker row (shown in place,
// with Back) and, for M1-INSIGHTS-UI's Models tab, as a standalone sheet (ModelDetailSheet).
//
// Network: one GET /api/comic/models/:id when the view opens (cached, single-flight; useModelDetail). The row the
// picker already holds is shown meanwhile, so nothing waits on the request.

import React from 'react';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import type { ComicDoc, Resolution } from '../../../shared/comic/doc';
import type { ModelCatalogRow, QualityBoard, QualityEntry } from '../../../shared/comic/modelCatalog';
import { PLATFORM_MARKUP, formatUsd, getImageModel } from '../../../shared/comic/models';
import { HEADING, OVERLINE } from '../../chat/studioDesign';
import { AdaptiveSheet } from '../mobile/sheets/AdaptiveSheet';
import { useCostFormat, type CostFormat } from '../conversation/cost';
import type { StudioCaps } from '../../../shared/comic/capabilities';
import {
  NOT_ENOUGH_DATA,
  NOT_RANKED,
  NO_UPTIME,
  PRICE_UNPUBLISHED,
  TRY_AGAIN,
  ago,
  asOfCouldntRefresh,
  dateLabel,
  fromPriceList,
  holdsCharacters,
  reliabilityLine,
  uptimeText
} from './copy';
import { useModelDetail } from './useModelCatalog';
import { BTN_ICON, BTN_SECONDARY, cx } from './ui';

export const BOARD_NAME: Record<QualityBoard, string> = {
  lmarena_t2i: 'LMArena text-to-image',
  lmarena_edit: 'LMArena edit',
  lmarena_multi_image: 'LMArena multi-image edit',
  aa_t2i: 'Artificial Analysis text-to-image',
  aa_edit: 'Artificial Analysis edit',
  design_arena: 'Design Arena'
};

const RESOLUTION_ORDER: readonly Resolution[] = ['512', '1K', '2K', '4K'];
const SECTION = 'min-w-0 space-y-1';
const ROW = 'min-w-0 text-[12.5px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]';
const MUTED = 'min-w-0 text-[11.5px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]';

/** A server note shown to this user: a governed user never sees one that names dollars. */
const safeNote = (note: string | undefined, cost: CostFormat) => (note && !(cost.governed && note.includes('$')) ? note : undefined);

const qualityText = (q: QualityEntry) =>
  `${BOARD_NAME[q.board]}${q.rank ? ` #${q.rank}${q.of ? ` of ${q.of}` : ''}` : ''} · score ${Math.round(q.score)}${q.ci ? ` (${Math.round(q.ci[0])}–${Math.round(q.ci[1])})` : ''} · ${dateLabel(q.asOf)}`;

export interface ModelDetailViewProps {
  modelId: string;
  /** The comic (prices are quoted per page of THIS comic; the detail is fetched with its id). */
  doc: ComicDoc;
  caps: StudioCaps;
  byok: boolean;
  /** The row the picker already holds (shown while the detail loads, and if it fails). */
  row?: ModelCatalogRow;
  onBack?: () => void;
  now?: number;
}

export const ModelDetailView: React.FC<ModelDetailViewProps> = ({ modelId, doc, caps, byok, row, onBack, now: nowProp }) => {
  const now = nowProp ?? Date.now();
  const cost = useCostFormat({ byok, caps });
  const view = useModelDetail(modelId, doc.id);
  const data = view.detail ?? row;
  const spec = getImageModel(modelId);
  const nickname = data?.nickname || spec?.nickname || modelId;
  const markup = byok ? 1 : PLATFORM_MARKUP;
  const facts = view.detail?.facts;

  const priceRows = data
    ? RESOLUTION_ORDER.filter((r) => data.price[r]).map((r) => {
        const p = data.price[r]!;
        const note = safeNote(p.note, cost);
        return {
          res: r,
          text: p.usd === null ? note || PRICE_UNPUBLISHED : `${cost.badge(p.usd * markup)} per image`,
          source:
            p.usd === null
              ? ''
              : p.basis === 'registry'
                ? spec
                  ? fromPriceList(spec.factsAsOf)
                  : note || ''
                : `OpenRouter${data.fetchedAt?.catalog ? `, ${data.stale ? asOfCouldntRefresh(ago(data.fetchedAt.catalog, now)) : ago(data.fetchedAt.catalog, now)}` : ''}`
        };
      })
    : [];
  const observed = (data?.observed ?? []).filter((o) => o.n >= 3);

  return (
    <div className="min-w-0 space-y-4" data-model-detail={modelId}>
      {/* In the picker the view replaces the list (Back returns to it); as a sheet, the sheet's title names it. */}
      {onBack && (
        <div className="flex min-w-0 items-center gap-2">
          <button type="button" onClick={onBack} aria-label="Back to the models" className={BTN_ICON} data-autofocus>
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </button>
          <h3 className={cx(HEADING, 'min-w-0 text-[15px] [overflow-wrap:anywhere]')}>{nickname}</h3>
        </div>
      )}
      {spec?.blurb && <p className={ROW}>{spec.blurb}</p>}
      {view.loading && !view.detail && (
        <p role="status" className={MUTED}>
          Loading what we know about {nickname}…
        </p>
      )}
      {view.error && !view.detail && (
        <div role="status" className="flex min-w-0 flex-wrap items-center gap-2">
          <p className={MUTED}>Couldn't load more details right now. {data ? 'Showing what the picker already has.' : ''}</p>
          <button type="button" onClick={view.refresh} className={BTN_SECONDARY}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {TRY_AGAIN}
          </button>
        </div>
      )}

      <section className={SECTION} aria-label="Prices">
        <h4 className={OVERLINE}>Prices{byok ? ' (your own key)' : ''}</h4>
        {priceRows.length ? (
          <ul className="space-y-0.5">
            {priceRows.map((p) => (
              <li key={p.res} className={cx(ROW, 'tabular-nums')}>
                {p.res}: {p.text}
                {p.source && <span className="text-[var(--ds-muted)]"> · {p.source}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className={MUTED}>{PRICE_UNPUBLISHED}</p>
        )}
        {typeof data?.perRefUsd === 'number' && <p className={MUTED}>Each reference image adds {cost.badge(data.perRefUsd * markup)}.</p>}
      </section>

      <section className={SECTION} aria-label="Providers">
        <h4 className={OVERLINE}>Providers</h4>
        {data && data.endpoints.length ? (
          <>
            <ul className="space-y-0.5">
              {data.endpoints.map((e, i) => (
                <li key={`${e.provider}-${i}`} className={cx(ROW, 'tabular-nums')}>
                  {e.provider}: {e.uptime1d === null ? NO_UPTIME : `${uptimeText(e.uptime1d)}% up (24 h)`}
                  {e.uptime30m !== null && <span className="text-[var(--ds-muted)]"> · {uptimeText(e.uptime30m)}% (30 min)</span>}
                </li>
              ))}
            </ul>
            <p className={MUTED}>
              Source: OpenRouter{data.fetchedAt?.uptime ? `, ${data.stale ? asOfCouldntRefresh(ago(data.fetchedAt.uptime, now)) : ago(data.fetchedAt.uptime, now)}` : ''}
            </p>
          </>
        ) : (
          <p className={MUTED}>{NO_UPTIME}</p>
        )}
        {data?.reliability && <p className={cx(ROW, 'tabular-nums')}>{reliabilityLine(data.reliability.calls, data.reliability.failed, data.reliability.rateLimited, data.reliability.scope)}</p>}
      </section>

      <section className={SECTION} aria-label="Leaderboards">
        <h4 className={OVERLINE}>Leaderboards</h4>
        {data && data.quality.length ? (
          <ul className="space-y-1">
            {data.quality.map((q, i) => (
              <li key={`${q.board}-${i}`} className="min-w-0">
                <span className={cx(ROW, 'block tabular-nums')}>{qualityText(q)}</span>
                <span className={cx(MUTED, 'block')}>{q.source}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={MUTED}>{view.detail?.qualityNote || NOT_RANKED}</p>
        )}
        {data?.qualityStale && data.fetchedAt?.quality && <p className={MUTED}>{asOfCouldntRefresh(dateLabel(data.fetchedAt.quality))}</p>}
      </section>

      <section className={SECTION} aria-label="Real cost">
        <h4 className={OVERLINE}>Real cost</h4>
        {observed.length ? (
          <ul className="space-y-0.5">
            {observed.map((o, i) => (
              <li key={`${o.kind}-${o.res}-${o.scope}-${i}`} className={cx(ROW, 'tabular-nums')}>
                {o.scope === 'you' ? 'Your' : "DreamStream creators'"} last {o.n} {o.kind === 'sheet' ? 'character sheets' : `${o.kind}s`} at {o.res}: {cost.badge(o.medianUsd * markup)}
                {!cost.governed && (
                  <span className="text-[var(--ds-muted)]">
                    {' '}
                    ({formatUsd(o.minUsd * markup)}–{formatUsd(o.maxUsd * markup)})
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className={MUTED}>{NOT_ENOUGH_DATA}</p>
        )}
      </section>

      {(facts || spec) && (
        <section className={SECTION} aria-label="Facts">
          <h4 className={OVERLINE}>Facts</h4>
          <ul className="space-y-0.5">
            <li className={ROW}>
              {holdsCharacters((facts?.refs ?? spec?.refs)?.characters ?? 0)} · up to {(facts?.refs ?? spec?.refs)?.total ?? 0} reference images
            </li>
            {(facts?.resolutions ?? spec?.resolutions) && (
              <li className={ROW}>Sizes: {(facts?.resolutions ?? spec!.resolutions).length ? (facts?.resolutions ?? spec!.resolutions).join(' · ') : 'one fixed size'}</li>
            )}
            <li className={ROW}>Page shapes: {(facts?.aspects ?? spec?.aspects ?? []).join(' · ')}</li>
            {(facts?.fixedQuality ?? spec?.fixedQuality) && <li className={ROW}>Always drawn at "{facts?.fixedQuality ?? spec?.fixedQuality}" quality</li>}
            {Object.entries(facts?.gradeSources ?? spec?.gradeSources ?? {}).map(([k, v]) => (
              <li key={k} className={MUTED}>
                {k === 'text' ? 'Lettering' : k === 'pages' ? 'Page composition' : 'Editing'}: {v}
              </li>
            ))}
            <li className={MUTED}>Registry facts checked {dateLabel(facts?.factsAsOf ?? spec?.factsAsOf)}</li>
          </ul>
        </section>
      )}

      {view.detail && view.detail.priceHistory.length > 0 && (
        <section className={SECTION} aria-label="Price changes">
          <h4 className={OVERLINE}>Price changes we recorded</h4>
          <ul className="space-y-0.5">
            {view.detail.priceHistory.slice(0, 8).map((h, i) => (
              <li key={`${h.at}-${h.res}-${i}`} className={cx(ROW, 'tabular-nums')}>
                {dateLabel(h.at)} · {h.res}: {h.usd === null ? safeNote(h.note, cost) || PRICE_UNPUBLISHED : `${cost.badge(h.usd * markup)} per image`}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};

export interface ModelDetailSheetProps extends Omit<ModelDetailViewProps, 'onBack'> {
  open: boolean;
  onClose: () => void;
}

/** The L3 sheet on its own (M1-INSIGHTS-UI's Models tab): side sheet on tablets/desktop, bottom sheet on phones. */
export const ModelDetailSheet: React.FC<ModelDetailSheetProps> = ({ open, onClose, ...view }) => {
  const name = getImageModel(view.modelId)?.nickname || view.row?.nickname || view.modelId;
  return (
    <AdaptiveSheet open={open} onClose={onClose} label={`${name} details`} title={name} presentation="side" modal panel sideWidth={480}>
      <div className="p-4">{open && <ModelDetailView {...view} />}</div>
    </AdaptiveSheet>
  );
};

export default ModelDetailSheet;
