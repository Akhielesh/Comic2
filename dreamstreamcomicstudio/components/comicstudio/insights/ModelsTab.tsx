// Models (models.md §4.2 "Models (this comic)", §4.3 live row, §3.7 Pro "Model" row): every model this comic paid
// for — images, $, failed (spend.byModel; legacy docs rebuilt from entries and labelled "(recent n)") and, per size,
// the real cost per image vs list (observed only at n ≥ 3). Under each, the live catalog row: prices with their
// basis and fetch time, providers and uptime, leaderboard ranks with dates, our own observations — or the exact
// §4.6 copy for whatever is missing. The catalog is fetched when this tab opens (never on a timer); the picker
// opens through the `open_model_picker` client action (changing a model always goes through its confirm).

import React, { useId, useMemo, useState } from 'react';
import { ChevronDown, Lock } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import { resolveImageJob } from '../../../shared/comic/models';
import { deriveLock, drawnModels } from '../../../shared/comic/modelLock';
import { byModel } from '../../../shared/comic/modelInsights';
import type { CatalogPrice, ModelCatalogRow } from '../../../shared/comic/modelCatalog';
import { ModelHealthDot, useModelStatus } from '../reliability';
import { GhostButton, cx, plural } from '../conversation/ui';
import {
  CHANGE_MODEL_LINK,
  CHOOSE_MODEL_LINK,
  LOCK_ICON_LABEL,
  NO_OPENROUTER_PRICE_COPY,
  NO_UPTIME_COPY,
  PRICE_UNPUBLISHED_COPY,
  couldntRefreshCopy,
  lockedLine,
  mixedModelsCopy,
  newerBuildCopy,
  priceListCopy,
  recentLabel,
  unlockedLine
} from './copy';
import {
  RESOLUTION_ORDER,
  catalogSourceLabel,
  clockText,
  dateText,
  nicknameOf,
  observedLines,
  priceView,
  qualityText,
  registryPriceViews,
  reliabilityText,
  rowFor,
  sizeCosts,
  uptimeLines,
  type InsightsMoney,
  type ListPrice,
  type SizeCost
} from './insightsModel';
import { useInsightsCatalog, type Loadable } from './useInsights';
import { Badge, FOCUS, Fact, Section, Source, TextButton, WRAP } from './ui';

export interface ModelsTabProps {
  doc: ComicDoc;
  money: InsightsMoney;
  pro: boolean;
  /** Opens the model picker (`open_model_picker`), optionally highlighting a model. */
  openPicker(suggest?: string): void;
  now?: number;
}

/** The list price beside a size's real cost, labelled with its own source (a registry fallback is never "OpenRouter"). */
const listWords = (list: ListPrice | null, live: CatalogPrice | undefined, money: InsightsMoney): string => {
  if (list?.source === 'recorded') return `list ${money.price(list.usd)} at the time`;
  if (live && typeof live.usd === 'number' && Number.isFinite(live.usd)) return `list ${money.price(live.usd)} (${catalogSourceLabel(live)})`;
  if (list) return `list ${money.price(list.usd)} (${priceListCopy(list.factsAsOf)})`;
  // No list price anywhere: the exact §4.6 copy for the catalog's reason, else "isn't published".
  const unavailable = live ? priceView(live, money) : undefined;
  return unavailable?.unavailable ? unavailable.text : PRICE_UNPUBLISHED_COPY;
};

const sizeLine = (s: SizeCost, row: ModelCatalogRow | undefined, money: InsightsMoney): string => {
  const live = s.res ? row?.price[s.res] : undefined;
  const list = listWords(s.list, live, money);
  const size = s.res ?? 'Size not recorded';
  if (!s.observed) return `${size}: ${plural(s.images, 'image')} · ${list}`;
  const o = s.observed;
  const lo = money.priceShort(o.minUsd);
  const hi = money.priceShort(o.maxUsd);
  return `${size}: real ≈${money.price(o.medianUsd).replace(/^≈/, '')} per image (n = ${o.n}${lo && hi ? `, ${lo}–${hi}` : ''}) · ${list}`;
};

/** The live catalog row for one model, or the registry's dated facts when none could be fetched (§4.6). */
const LiveFacts: React.FC<{ modelId: string; row?: ModelCatalogRow; state: Loadable<ModelCatalogRow[]>; money: InsightsMoney; now?: number }> = ({
  modelId,
  row,
  state,
  money,
  now
}) => {
  if (!row && state.loading) {
    return (
      <p className="text-[11.5px] text-[var(--ds-muted)]" aria-busy="true">
        Loading live prices and uptime…
      </p>
    );
  }
  if (!row) {
    const reg = registryPriceViews(modelId, money);
    return (
      <div className="min-w-0 space-y-1" data-live="registry">
        {reg.length ? (
          <dl className="min-w-0">
            {reg.map(({ res, view }) => (
              <Fact key={res} label={`${res} per image`} value={view.text} note={view.source} />
            ))}
          </dl>
        ) : (
          <p className="text-[11.5px] text-[var(--ds-muted)]">No price list for this model.</p>
        )}
        <p className="text-[11.5px] text-[var(--ds-muted)]">{NO_UPTIME_COPY}</p>
        {state.error && (
          <p className={cx('text-[11px] text-[var(--ds-muted)]', WRAP)}>
            Live data couldn’t load right now.{' '}
            <TextButton onClick={state.refresh}>Try again</TextButton>
          </p>
        )}
      </div>
    );
  }
  const stale = row.stale || state.stale;
  const prices = RESOLUTION_ORDER.map((res) => ({ res, view: priceView(row.price[res], money) })).filter((p) => !!p.view);
  // Only a live price carries OpenRouter's fetch time (the server never dates a registry fallback, catalog.ts
  // pricesFor). Prices that all fell back to the registry name no OpenRouter and no time: each Fact already says
  // "from our price list, {factsAsOf}" (§4.6 "Fetch failed, no cache").
  const fetched = row.fetchedAt.catalog;
  const live = prices.some(({ res }) => row.price[res]?.basis !== 'registry');
  const priceSource = fetched && live ? (stale ? couldntRefreshCopy(clockText(fetched, now)) : `Prices: OpenRouter, ${clockText(fetched, now)}`) : null;
  const uptime = uptimeLines(row.endpoints);
  const observed = observedLines(row.observed, money);
  const reliability = reliabilityText(row.reliability);
  const fit = row.fit ?? [];
  return (
    <div className="min-w-0 space-y-2" data-live="catalog">
      <div className="min-w-0">
        <dl className="min-w-0">
          {prices.map(({ res, view }) => (
            <Fact key={res} label={`${res} per image`} value={view!.text} note={view!.unavailable ? undefined : view!.source} className={view!.unavailable ? 'text-[var(--ds-muted)]' : undefined} />
          ))}
          {!prices.length && <Fact label="Price" value={NO_OPENROUTER_PRICE_COPY} className="text-[var(--ds-muted)]" />}
        </dl>
        {priceSource && <Source>{priceSource}</Source>}
      </div>
      <div className="min-w-0">
        <ul className="min-w-0 space-y-0.5 text-[11.5px] text-[var(--ds-ink)]" aria-label="Providers and uptime">
          {(uptime.length ? uptime : [NO_UPTIME_COPY]).map((l) => (
            <li key={l} className={cx('min-w-0', WRAP, !uptime.length && 'text-[var(--ds-muted)]')}>
              {l}
            </li>
          ))}
        </ul>
        {uptime.length > 0 && row.fetchedAt.uptime && (
          <Source>{stale ? couldntRefreshCopy(clockText(row.fetchedAt.uptime, now)) : `Uptime: OpenRouter, ${clockText(row.fetchedAt.uptime, now)}`}</Source>
        )}
      </div>
      <div className="min-w-0">
        <ul className="min-w-0 space-y-0.5 text-[11.5px] text-[var(--ds-ink)]" aria-label="Leaderboards">
          {qualityText(row.quality).map((l) => (
            <li key={l} className={cx('min-w-0', WRAP, !row.quality.length && 'text-[var(--ds-muted)]')}>
              {l}
            </li>
          ))}
        </ul>
        {row.quality.length > 0 && (
          <Source>
            {row.qualityStale && row.fetchedAt.quality ? couldntRefreshCopy(dateText(row.fetchedAt.quality)) : `Ranks: ${[...new Set(row.quality.map((q) => q.source))].join(' · ')}`}
          </Source>
        )}
      </div>
      {observed.length > 0 && (
        <ul className="min-w-0 space-y-0.5 text-[11.5px] text-[var(--ds-ink)]" aria-label="Observed cost">
          {observed.map((l) => (
            <li key={l} className={cx('min-w-0', WRAP)}>
              {l}
            </li>
          ))}
        </ul>
      )}
      {reliability && <p className={cx('text-[11.5px] text-[var(--ds-ink)]', WRAP)}>{reliability}</p>}
      {fit.length > 0 && (
        <ul className="min-w-0 space-y-0.5 text-[11.5px] text-[var(--ds-muted)]" aria-label="Fit for this comic">
          {fit.map((f) => (
            <li key={`${f.code}:${f.text}`} className={cx('min-w-0', WRAP)}>
              {f.severity === 'block' ? 'Can’t use: ' : ''}
              {f.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const ModelItem: React.FC<{
  doc: ComicDoc;
  modelId: string;
  images: number;
  usd: number;
  failed: number;
  current: boolean;
  defaultOpen: boolean;
  row?: ModelCatalogRow;
  state: Loadable<ModelCatalogRow[]>;
  health?: ReturnType<typeof useModelStatus>['byId'][string];
  /** A quiet notice under the model (the §2.5 "newer build" line for the locked model). */
  notice?: string;
  /** L3 (§4.1): everything known about this model — the picker opened on it (`open_model_picker` with suggest). */
  onDetails(): void;
  money: InsightsMoney;
  now?: number;
}> = ({ doc, modelId, images, usd, failed, current, defaultOpen, row, state, health, notice, onDetails, money, now }) => {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const sizes = useMemo(() => sizeCosts(doc, modelId), [doc, modelId]);
  const nickname = row?.nickname ?? nicknameOf(modelId);
  return (
    <li className="min-w-0 py-2" data-model={modelId} aria-label={nickname}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cx('min-w-0 text-[13px] font-semibold text-[var(--ds-ink)]', WRAP)}>{nickname}</span>
        {current && <Badge title="This comic is drawn with this model">Current</Badge>}
        {health && <ModelHealthDot health={health} label={nickname} className="max-w-full" />}
        <code className={cx('min-w-0 text-[10.5px] text-[var(--ds-muted)]', WRAP)}>{modelId}</code>
      </div>
      <p className={cx('mt-0.5 text-[12px] tabular-nums text-[var(--ds-ink)]', WRAP)}>
        {plural(images, 'image')} · {money.spent(usd)}
        {failed > 0 ? ` · ${failed} failed` : ''}
      </p>
      {notice && <p className={cx('mt-0.5 min-w-0 text-[11.5px] text-[var(--ds-muted)]', WRAP)}>{notice}</p>}
      {sizes.length > 0 && (
        <ul className="mt-0.5 min-w-0 space-y-0.5 text-[11.5px] tabular-nums text-[var(--ds-muted)]" aria-label={`${nickname} by size`}>
          {sizes.map((s) => (
            <li key={s.res ?? 'none'} className={cx('min-w-0', WRAP)}>
              {sizeLine(s, row, money)}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className={cx('inline-flex items-center gap-1 rounded-[var(--ds-radius-control)] px-1 text-[11.5px] font-medium text-[var(--ds-muted)] hover:text-[var(--ds-ink)] coarse:min-h-11 coarse:px-2', FOCUS)}
        >
          <ChevronDown className={cx('h-3.5 w-3.5 shrink-0', open && 'rotate-180')} aria-hidden />
          Live prices, uptime and ranks
        </button>
        <TextButton onClick={onDetails} aria-label={`Details… about ${nickname}`} className="text-[11.5px]">
          Details…
        </TextButton>
      </div>
      {open && (
        <div id={panelId} className="mt-1 min-w-0 rounded-[var(--ds-radius-control)] border border-[var(--ds-hairline-soft)] bg-[var(--ds-surface-soft)] px-2.5 py-2">
          <LiveFacts modelId={modelId} row={row} state={state} money={money} now={now} />
        </div>
      )}
    </li>
  );
};

export const ModelsTab: React.FC<ModelsTabProps> = ({ doc, money, pro, openPicker, now }) => {
  const catalog = useInsightsCatalog(doc.id, true);
  const models = useMemo(() => byModel(doc), [doc]);
  const lock = deriveLock(doc);
  const lockId = lock?.modelId;
  const ids = useMemo(() => {
    const out = models.rows.map((r) => r.modelId);
    if (lockId && !out.includes(lockId)) out.unshift(lockId);
    return out;
  }, [models.rows, lockId]);
  const status = useModelStatus(ids, { poll: false });
  const mixed = drawnModels(doc).length;
  const rows = catalog.data;
  const items = ids.map((id) => {
    const t = models.rows.find((r) => r.modelId === id);
    return { modelId: id, images: t?.images ?? 0, usd: t?.usd ?? 0, failed: t?.failed ?? 0 };
  });
  const lockNick = lockId ? (rowFor(rows, lockId)?.nickname ?? nicknameOf(lockId)) : undefined;
  // models.md §2.5: the lock recorded OpenRouter's dated canonical slug; when the catalog now serves another one,
  // the provider may have updated the model behind the same id — said quietly under the locked model.
  const lockRow = lockId ? rowFor(rows, lockId) : undefined;
  const newerBuild =
    lock?.canonicalSlug && lockRow?.canonicalSlug && lockRow.canonicalSlug !== lock.canonicalSlug && lockNick ? newerBuildCopy(lockNick, lockRow.canonicalSlug) : undefined;
  const pendingNick = resolveImageJob('page', doc.settings.quality, doc.settings.imageModelOverride).spec.nickname;
  return (
    <div className="min-w-0 space-y-3">
      {pro && (
        <div className="divide-y divide-[var(--ds-hairline-soft)]">
          <Fact
            label="Model"
            value={
              <span className="inline-flex min-w-0 items-center gap-1">
                {lockNick ?? pendingNick}
                {lockId && <Lock className="h-3 w-3 shrink-0 text-[var(--ds-muted)]" role="img" aria-label={LOCK_ICON_LABEL} />}
              </span>
            }
            note={
              <>
                {lockNick ? lockedLine(lockNick) : unlockedLine(pendingNick)}{' '}
                <TextButton onClick={() => openPicker()}>{lockId ? CHANGE_MODEL_LINK : CHOOSE_MODEL_LINK}</TextButton>
              </>
            }
          />
        </div>
      )}
      <Section title="Models in this comic" aside={models.exact ? undefined : recentLabel(models.recentN ?? doc.spend.entries.length)}>
        {mixed > 1 && <p className="mb-1 text-[12px] text-[var(--ds-ink)]">{mixedModelsCopy(mixed)}.</p>}
        {items.length ? (
          <ul aria-label="Models in this comic" className="min-w-0 divide-y divide-[var(--ds-hairline-soft)]">
            {items.map((m) => (
              <ModelItem
                key={m.modelId}
                doc={doc}
                {...m}
                current={m.modelId === lockId}
                defaultOpen={items.length === 1}
                row={rowFor(rows, m.modelId)}
                state={catalog}
                health={status.byId[m.modelId]}
                notice={m.modelId === lockId ? newerBuild : undefined}
                onDetails={() => openPicker(m.modelId)}
                money={money}
                now={now}
              />
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-[var(--ds-muted)]">No images drawn yet. The first image locks this comic to one model so every page matches.</p>
        )}
        <Source>
          Images and spend: this comic’s ledger{models.exact ? '' : `, ${recentLabel(models.recentN ?? doc.spend.entries.length)}`}. Real cost needs at least 3 images at a size.
        </Source>
      </Section>
      <GhostButton size="sm" className="tap-target" onClick={() => openPicker()}>
        Compare models
      </GhostButton>
    </div>
  );
};

export default ModelsTab;
