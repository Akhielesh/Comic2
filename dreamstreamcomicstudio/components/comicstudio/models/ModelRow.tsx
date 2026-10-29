// One model in the picker (models.md §3.6 B; Pro table §3.7): name and badges (Default · Experimental · Current,
// plus Suggested when a chip or the outage card pointed here), "≈{$} per page at {res}", "Holds {k} characters per
// image", "{p} provider(s) · {u}% up (24 h)" with its source and time, the edit leaderboards, the live health dot,
// and — when it cannot be picked — the reasons, in words. Prices are worded for this user (no "$" for a governed
// user; never a number when there is no basis: the §4.6 copy instead).
//
// The row is one button (pick → the confirm) plus a Details button (the L3 sheet). A row that cannot be picked
// stays focusable (aria-disabled) so its reasons are reachable by keyboard and screen reader; the current model
// is not offered again.

import React, { useId } from 'react';
import { AlertTriangle, Ban, Info } from 'lucide-react';
import type { ModelHealth } from '../../../shared/comic/modelHealth';
import { formatUsd, PLATFORM_MARKUP } from '../../../shared/comic/models';
import { TONE_TEXT } from '../../chat/studioDesign';
import type { CostFormat } from '../conversation/cost';
import { ModelHealthDot } from '../reliability';
import {
  BADGE,
  CURRENT_ROW_HINT,
  NOT_RANKED,
  NO_OPENROUTER_PRICE,
  PRICE_UNPUBLISHED,
  aaEdit,
  ago,
  asOfCouldntRefresh,
  detailsFor,
  holdsCharacters,
  leaderboardsLine,
  lmarenaEdit,
  observedLine,
  observedPlatformLine,
  perPage,
  pricesByRes,
  providersLine,
  providersNoUptime,
  reliabilityLine,
  uptimeText
} from './copy';
import type { PickerRowModel } from './pickerRows';
import type { ClientPriceBook } from './priceBook';
import { BTN_ICON, Badge, FOCUS, cx } from './ui';
import { RADIUS_CONTROL, TRANSITION, HAIRLINE, ACCENT_SOFT_BG } from '../../chat/studioDesign';
import type { Resolution } from '../../../shared/comic/doc';

export interface ModelRowProps {
  model: PickerRowModel;
  cost: CostFormat;
  byok: boolean;
  /** Pro table / "Compare all": prices per resolution, real cost, our reliability. */
  detailed: boolean;
  /** Live data could not be loaded: registry facts, no uptime, the registry's dated board citations. */
  live: boolean;
  prices: ClientPriceBook;
  health?: ModelHealth;
  now: number;
  onPick(id: string): void;
  onDetails(id: string): void;
}

/** The price line: a worded price, or the §4.6 copy (never a "$" when there is no basis). */
export const priceText = (model: PickerRowModel, cost: CostFormat): string => {
  if (model.pageUsd === null) return model.row.price[model.pageRes]?.note === NO_OPENROUTER_PRICE ? NO_OPENROUTER_PRICE : PRICE_UNPUBLISHED;
  return perPage(cost.badge(model.pageUsd), model.pageRes);
};

/** "1 provider · 97.7% up (24 h)" (or the §4.6 copy) — the source and time are added by the caller. */
export const uptimeLine = (model: PickerRowModel): string =>
  model.uptime1d === null ? providersNoUptime(model.providers) : providersLine(Math.max(1, model.providers), uptimeText(model.uptime1d));

export const leaderboardText = (model: PickerRowModel, live: boolean): string => {
  const parts = [...(model.lmarenaEdit?.rank ? [lmarenaEdit(model.lmarenaEdit.rank)] : []), ...(model.aaEdit?.rank ? [aaEdit(model.aaEdit.rank)] : [])];
  if (parts.length) return leaderboardsLine(parts);
  // Live data missing: the registry's own dated citation (a fact with its date), never "not ranked".
  const cited = !live ? model.spec?.gradeSources?.edit : undefined;
  return cited && /#\d/.test(cited) ? leaderboardsLine([cited]) : NOT_RANKED;
};

const LINE = 'block min-w-0 text-[12px] leading-snug text-[var(--ds-muted)] [overflow-wrap:anywhere]';

export const ModelRow: React.FC<ModelRowProps> = ({ model, cost, byok, detailed, live, prices, health, now, onPick, onDetails }) => {
  const nameId = useId();
  const linesId = useId();
  const reasonsId = useId();
  const actionable = !model.disabled && !model.current;
  const markup = byok ? 1 : PLATFORM_MARKUP;
  // When the price line's basis differs from the footer's (OpenRouter), say which one it is.
  const basisNote = model.pageUsd !== null && (model.quote.source === 'observed' || model.quote.source === 'registry') ? model.quote.label : '';
  const uptimeAt = model.row.fetchedAt?.uptime;
  const uptimeSource =
    model.uptime1d === null || !live ? '' : model.row.stale ? `OpenRouter ${asOfCouldntRefresh(ago(uptimeAt, now))}` : `OpenRouter, ${ago(uptimeAt, now)}`;
  // §4.6: an unpublished price is said once (the price line), not again as a warning.
  const warns = model.warns.filter((w) => !(model.pageUsd === null && w.code === 'price_unverified'));
  const reasons = [...(model.current ? [] : model.blocks), ...warns];

  const perRes: string[] = [];
  if (detailed && model.spec) {
    for (const res of (model.spec.resolutions.length ? model.spec.resolutions : ['1K']) as Resolution[]) {
      const usd = prices.pagePrice(model.id, res, byok);
      perRes.push(`${res} ${usd === null ? 'not published' : cost.badge(usd)}`);
    }
  }
  const obs = detailed ? model.quote.observed : undefined;
  const obsText = obs
    ? (obs.scope === 'you' ? observedLine : observedPlatformLine)(
        obs.n,
        obs.kind,
        cost.badge(obs.medianUsd * markup),
        cost.governed ? undefined : `${formatUsd(obs.minUsd * markup)}–${formatUsd(obs.maxUsd * markup)}`
      )
    : '';
  const rel = detailed ? model.row.reliability : undefined;

  return (
    <li
      className="min-w-0"
      data-model={model.id}
      data-disabled={model.disabled || undefined}
      data-current={model.current || undefined}
      data-suggested={model.suggested || undefined}
    >
      <div
        className={cx(
          'flex min-w-0 items-start gap-1',
          RADIUS_CONTROL,
          HAIRLINE,
          TRANSITION,
          model.current ? ACCENT_SOFT_BG : 'bg-[var(--ds-surface-soft)]',
          model.suggested && 'ring-2 ring-[var(--ds-ring)]',
          actionable && 'hover:bg-[var(--ds-hover)]'
        )}
      >
        <button
          type="button"
          aria-labelledby={nameId}
          aria-describedby={`${linesId}${reasons.length || model.current ? ` ${reasonsId}` : ''}`}
          aria-disabled={actionable ? undefined : true}
          data-autofocus={model.suggested || undefined}
          onClick={() => {
            if (actionable) onPick(model.id);
          }}
          className={cx(
            'min-h-11 min-w-0 flex-1 px-3 py-2.5 text-left',
            RADIUS_CONTROL,
            FOCUS,
            actionable ? 'cursor-pointer' : 'cursor-default',
            model.disabled && 'opacity-80'
          )}
        >
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span id={nameId} className="min-w-0 text-[13.5px] font-semibold text-[var(--ds-ink)] [overflow-wrap:anywhere]">
              {model.nickname}
            </span>
            {model.current && <Badge tone="current">{BADGE.current}</Badge>}
            {model.isDefault && <Badge tone="default">{BADGE.default}</Badge>}
            {model.experimental && <Badge tone="experimental">{BADGE.experimental}</Badge>}
            {model.suggested && <Badge tone="suggested">{BADGE.suggested}</Badge>}
            {health && <ModelHealthDot health={health} label={model.nickname} hideLabel={health.state === 'ok' || health.state === 'unknown'} now={now} className="ml-auto" />}
          </span>
          <span id={linesId} className="mt-1 block min-w-0 space-y-0.5">
            <span className={cx(LINE, 'text-[12.5px] font-medium tabular-nums text-[var(--ds-ink)]')} data-line="price">
              {priceText(model, cost)}
              {basisNote && <span className="font-normal text-[var(--ds-muted)]"> · {basisNote}</span>}
            </span>
            {perRes.length > 0 && (
              <span className={cx(LINE, 'tabular-nums')} data-line="prices">
                {pricesByRes(perRes)}
              </span>
            )}
            {model.characters > 0 && (
              <span className={LINE} data-line="characters">
                {holdsCharacters(model.characters)}
              </span>
            )}
            <span className={cx(LINE, 'tabular-nums')} data-line="uptime">
              {uptimeLine(model)}
              {uptimeSource && <span> · {uptimeSource}</span>}
            </span>
            <span className={LINE} data-line="leaderboards">
              {leaderboardText(model, live)}
            </span>
            {obsText && (
              <span className={cx(LINE, 'tabular-nums')} data-line="observed">
                {obsText}
              </span>
            )}
            {rel && (
              <span className={cx(LINE, 'tabular-nums')} data-line="reliability">
                {reliabilityLine(rel.calls, rel.failed, rel.rateLimited, rel.scope)}
              </span>
            )}
          </span>
        </button>
        <button type="button" onClick={() => onDetails(model.id)} aria-label={detailsFor(model.nickname)} className={cx(BTN_ICON, 'mr-0.5 mt-0.5')}>
          <Info className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {(reasons.length > 0 || model.current) && (
        <ul id={reasonsId} className="mt-1 min-w-0 space-y-0.5 px-3" data-reasons>
          {model.current && <li className={LINE}>{CURRENT_ROW_HINT}</li>}
          {reasons.map((r, i) => (
            <li
              key={`${r.code}-${i}`}
              data-reason={r.code}
              data-severity={r.severity}
              className={cx('flex min-w-0 items-start gap-1.5 text-[12px] leading-snug [overflow-wrap:anywhere]', r.severity === 'block' ? TONE_TEXT.warning : 'text-[var(--ds-muted)]')}
            >
              {r.severity === 'block' ? <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
              <span className="min-w-0">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

export default ModelRow;
