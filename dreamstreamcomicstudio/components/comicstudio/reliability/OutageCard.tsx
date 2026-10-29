// The `model_outage` conversation card (reliability.md §3; models.md §3.6 G/H wording). A provider outage the
// money-safe preflight caught becomes this calm card instead of a red error: who isn't serving the model, that
// nothing was started or charged, that the comic stays on its model, a live status line with source and time,
// and the real ways out as buttons (OptionButtons.tsx). The card renders LIVE state: the status comes from
// useModelStatus, the retry intent from retryIntents.ts.
//
// Wait and retry: arms a one-shot intent; when a status received after the click says the model is back, the
// blocked action is re-sent ONCE (useAutoRetry), only while this page is open and visible — the card says that a
// closed page runs nothing later. Switching models only ever opens the picker (its confirm says consistency can
// be affected); this card never changes the model.

import React, { useSyncExternalStore } from 'react';
import { CheckCircle2, PauseCircle, RefreshCw } from 'lucide-react';
import type { CardProps } from '../extensions';
import { useCostFormat } from '../conversation/cost';
import { CardShell, GhostButton, cx } from '../conversation/ui';
import { armRetry, cancelRetry, getRetry, retriesVersion, subscribeRetries } from './retryIntents';
import { ModelHealthDot } from './ModelHealthDot';
import { OptionButton, type OptionHandlers } from './OptionButtons';
import { blockedWhat, clockTime, modelName, outageSentence, sourceLine } from './copy';
import { cleanOptions, type OutageCardData, type SwitchOption } from './options';
import { isBack, useAutoRetry, useModelStatus } from './useModelStatus';

export const OutageCard: React.FC<CardProps<OutageCardData>> = ({ card, studio }) => {
  useSyncExternalStore(subscribeRetries, retriesVersion, retriesVersion);
  const status = useModelStatus([card.modelId]);
  useAutoRetry(studio);
  const cost = useCostFormat(studio);
  const doc = studio.doc;
  if (!card?.modelId) return null;

  const now = Date.now();
  const health = status.byId[card.modelId];
  const name = modelName(card.modelId);
  const intent = getRetry(card.id);
  const action = card.blockedAction;
  const pageNumber = (id: string) => doc?.pages.find((p) => p.id === id)?.n;
  const what = blockedWhat(action, pageNumber);
  // Wait / other route re-send the blocked action: without one there is nothing to re-send, so they are left out.
  const options = cleanOptions(card.options).filter((o) => !!action || (o.kind !== 'wait_and_retry' && o.kind !== 'other_route'));
  const back = !!health && isBack(health.state);
  const waiting = intent?.state === 'waiting' || intent?.state === 'sending';

  const handlers: OptionHandlers = {
    blockedAction: action,
    onWait: action ? () => armRetry(card.id, card.modelId, action) : undefined,
    onRetryNow: action ? () => void studio.act(action) : undefined,
    onSwitch: (option: SwitchOption) => studio.runClientAction({ type: 'open_model_picker', suggest: option.modelId })
  };

  let state: React.ReactNode;
  if (intent?.state === 'sent') {
    state = (
      <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--ds-ink)]">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-success-text)]" aria-hidden />
        <span>
          {name} answered again{intent.sentAt ? ` at ${clockTime(intent.sentAt, now)}` : ''}, so {what.label.charAt(0).toLowerCase() + what.label.slice(1)} {what.plural ? 'were' : 'was'} started once.
        </span>
      </p>
    );
  } else if (intent?.state === 'failed') {
    state = <p className="text-[12.5px] leading-snug text-[var(--ds-ink)]">{name} answered again, but the retry didn't go through. You can try again below.</p>;
  } else if (waiting) {
    state = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--ds-ink)]">
          {intent?.state === 'sending'
            ? `${name} is back — starting ${what.label.charAt(0).toLowerCase() + what.label.slice(1)} again…`
            : `Waiting for ${name}. ${what.label} will start once, automatically, when it's back — only while this page stays open. If you close it, nothing runs later.`}
        </p>
        {intent?.state === 'waiting' && (
          <GhostButton size="sm" onClick={() => cancelRetry(card.id)} className="coarse:min-h-11">
            Don't retry
          </GhostButton>
        )}
      </div>
    );
  }

  return (
    <CardShell
      title={back ? `${name} is answering again` : `${name} is paused`}
      icon={back ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : <PauseCircle className="h-4 w-4" aria-hidden />}
      right={health ? <ModelHealthDot health={health} label={name} now={now} /> : undefined}
      aria-label={`${name} status`}
      className="min-w-0"
    >
      <div className="min-w-0 space-y-3" data-card="model_outage">
        <p className="text-[13.5px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]">
          {back
            ? `${name} is answering again. ${what.label} ${what.plural ? "weren't" : "wasn't"} started while it was paused, and nothing was charged. Your comic stays on ${name}.`
            : outageSentence({ modelId: card.modelId, health, action, pageNumber })}
        </p>
        <p className="text-[11.5px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">
          Status: {sourceLine(health, now)}
          {status.watching ? ' · checking again every minute while this page is open' : ''}
          {status.expired ? ' · stopped checking after 30 minutes' : ''}
        </p>

        <div role="status" aria-live="polite" className="min-w-0">
          {state}
        </div>

        {back && action && !waiting && intent?.state !== 'sent' && (
          <GhostButton size="sm" onClick={() => void studio.act(action)} className="coarse:min-h-11">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Try again now
          </GhostButton>
        )}

        {!back && options.length > 0 && intent?.state !== 'sent' && (
          <div className={cx('flex min-w-0 flex-wrap gap-2', waiting && 'opacity-90')} role="group" aria-label="Ways to continue">
            {options
              .filter((o) => !(waiting && o.kind === 'wait_and_retry'))
              .map((option, i) => (
                <OptionButton key={`${option.kind}-${i}`} option={option} cost={cost} handlers={handlers} />
              ))}
          </div>
        )}

        {status.expired && (
          <GhostButton size="sm" onClick={status.refresh} className="coarse:min-h-11">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Check again
          </GhostButton>
        )}
      </div>
    </CardShell>
  );
};

export default OutageCard;
