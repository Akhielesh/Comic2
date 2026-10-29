// ModelStatusBanner (reliability.md §3): one calm line under the studio header (header-slot banner tier,
// order ≥ 1000) when the comic's image model — or the style-test model — is unsteady or paused. It says what
// is affected, since when it has been seen ("Seen since 16:52": the earliest evidence — the server's own failure
// time or the public data's time — never just when this page opened), the source and age of the data, that
// nothing is charged while new images are paused,
// and offers up to 3 real options with real prices. Dismissable per incident (it comes back if the trouble
// gets worse, or after the model has been fine and fails again). No red: warning tokens, a word next to every
// colour, aria-live polite, wraps cleanly from 320 px.
//
// It also mounts the "wait and retry" runner (useAutoRetry), so an armed retry fires even when its card has
// scrolled out of the conversation — still once, still only while the page is open and visible.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, PauseCircle, X } from 'lucide-react';
import type { ComicDoc } from '../../../shared/comic/doc';
import type { HealthState } from '../../../shared/comic/modelHealth';
import { pickableImageModels, resolveImageJob, type ImageJobKind } from '../../../shared/comic/models';
import { deriveLock } from '../../../shared/comic/modelLock';
import { TONE_SURFACE, TONE_TEXT } from '../../chat/studioDesign';
import type { StudioController } from '../types';
import { useCostFormat } from '../conversation/cost';
import { cx } from '../conversation/ui';
import { armRetry } from './retryIntents';
import { OptionButton, type OptionHandlers } from './OptionButtons';
import { clockTime, modelName, sourceLine, troubleReason, whoServes } from './copy';
import { bannerOptions, latestOutageCard, type SwitchOption } from './options';
import { isTrouble } from './statusStore';
import { useAutoRetry, useModelStatus } from './useModelStatus';

/** Banner tier position (mobile/headerSlots.ts HEADER_SLOT_ORDER.statusBanner). */
export const MODEL_STATUS_BANNER_ORDER = 1000;

const KINDS: ImageJobKind[] = ['page', 'cover', 'sheet', 'style_option'];

/** The models this comic draws with right now: the lock for every kind, else each kind's tier model (+ style tests). */
export const watchedModelIds = (doc: ComicDoc | null | undefined): string[] => {
  if (!doc) return [];
  const lock = deriveLock(doc);
  const ids = KINDS.map((kind) => resolveImageJob(kind, doc.settings.quality, doc.settings.imageModelOverride, lock).spec.id);
  return [...new Set(ids)];
};

// ── Per-incident dismiss (this tab only) ─────────────────────────────────────

const DISMISS_KEY = 'comicstudio.modelStatus.dismissed';
const RANK: Record<HealthState, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

const readDismissed = (): Record<string, HealthState> => {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(DISMISS_KEY) : null;
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, HealthState> = {};
    for (const [id, state] of Object.entries(parsed as Record<string, unknown>)) if (state === 'degraded' || state === 'down') out[id] = state;
    return out;
  } catch {
    return {};
  }
};

const writeDismissed = (value: Record<string, HealthState>) => {
  try {
    if (typeof sessionStorage === 'undefined') return;
    if (Object.keys(value).length) sessionStorage.setItem(DISMISS_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(DISMISS_KEY);
  } catch {
    /* private mode: the dismiss lasts until reload */
  }
};

const useIncidentDismiss = () => {
  const [dismissed, setDismissed] = useState<Record<string, HealthState>>(readDismissed);
  const update = useCallback((next: Record<string, HealthState>) => {
    setDismissed(next);
    writeDismissed(next);
  }, []);
  return { dismissed, update };
};

export const ModelStatusBanner: React.FC<{ studio: StudioController; compact: boolean }> = ({ studio, compact }) => {
  useAutoRetry(studio);
  const doc = studio.doc;
  const cost = useCostFormat(studio);
  const watchedKey = watchedModelIds(doc).join(',');
  const watched = useMemo(() => (watchedKey ? watchedKey.split(',') : []), [watchedKey]);
  const status = useModelStatus(watched);
  const worst = status.worst;
  const card = worst ? latestOutageCard(doc, worst.modelId) : undefined;
  // Switch candidates' health, read once (never polled) and only while there is trouble and no server-built card.
  const candidateIds = useMemo(() => (worst ? pickableImageModels().map((m) => m.id).filter((id) => id !== worst.modelId) : []), [worst?.modelId]);
  const candidates = useModelStatus(candidateIds, { enabled: !!worst && !card, poll: false });
  const { dismissed, update } = useIncidentDismiss();

  // An incident ends when its model reads fine again: a later failure is a new incident (the banner returns).
  useEffect(() => {
    let changed = false;
    const next = { ...dismissed };
    for (const id of Object.keys(next)) {
      const h = status.byId[id];
      if (h && !isTrouble(h.state)) {
        delete next[id];
        changed = true;
      }
    }
    if (changed) update(next);
  }, [status.byId, dismissed, update]);

  const hidden = !doc || !worst || (dismissed[worst.modelId] !== undefined && RANK[dismissed[worst.modelId]] >= RANK[worst.state]);

  let body: React.ReactNode = null;
  if (!hidden && doc && worst) {
    const now = Date.now();
    const id = worst.modelId;
    const name = modelName(id);
    const who = whoServes(worst, id);
    const reason = troubleReason(worst);
    const since = clockTime(status.since[id], now);
    const down = worst.state === 'down';
    const { options } = bannerOptions({ doc, modelId: id, caps: studio.caps, health: { ...candidates.byId } });
    const action = card?.blockedAction;
    const handlers: OptionHandlers = {
      blockedAction: action,
      onWait: action && card ? () => armRetry(card.id, card.modelId, action) : undefined,
      onRetryNow: action ? () => void studio.act(action) : undefined,
      onSwitch: (option: SwitchOption) => studio.runClientAction({ type: 'open_model_picker', suggest: option.modelId })
    };
    body = (
      <div
        data-model-status-banner={worst.state}
        className={cx('border-b px-3 py-2 sm:px-4', TONE_SURFACE.warning)}
      >
        <div className="mx-auto flex min-w-0 max-w-5xl flex-wrap items-start gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 basis-[16rem] text-[12.5px] leading-snug text-[var(--ds-ink)] [overflow-wrap:anywhere]">
            {down ? (
              <PauseCircle className={cx('mr-1.5 inline h-3.5 w-3.5 -translate-y-px', TONE_TEXT.warning)} aria-hidden />
            ) : (
              <AlertTriangle className={cx('mr-1.5 inline h-3.5 w-3.5 -translate-y-px', TONE_TEXT.warning)} aria-hidden />
            )}
            <strong className="font-semibold">{down ? `${name} is paused` : `${name} is unsteady`}</strong>
            {down
              ? ` — ${who} isn't serving it right now${reason ? ` (${reason})` : ''}. New images wait, so nothing is charged.`
              : ` — ${who} is answering slowly or failing sometimes${reason ? ` (${reason})` : ''}. Images may take longer or need a retry.`}{' '}
            <span className="text-[var(--ds-muted)]">
              {since ? `Seen since ${since} · ` : ''}
              {sourceLine(worst, now)}
            </span>
            {!compact && status.watching && <span className="text-[var(--ds-muted)]"> · checking every minute while this page is open</span>}
          </p>
          {options.length > 0 && (
            <div className="flex min-w-0 max-w-full flex-wrap gap-1.5" role="group" aria-label={`Ways to continue without ${name}`}>
              {options.map((option, i) => (
                <OptionButton key={`${option.kind}-${i}`} option={option} cost={cost} handlers={handlers} compact />
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => update({ ...dismissed, [id]: worst.state })}
            aria-label={`Hide the ${name} status notice`}
            className="-my-1 ml-auto grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--ds-muted)] hover:bg-[var(--ds-hover)] hover:text-[var(--ds-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] coarse:h-11 coarse:w-11"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  // The live region stays mounted (empty and zero-height when all is well) so the first trouble is announced.
  return (
    <div role="status" aria-live="polite" aria-atomic="false" className="min-w-0">
      {body}
    </div>
  );
};

export default ModelStatusBanner;
