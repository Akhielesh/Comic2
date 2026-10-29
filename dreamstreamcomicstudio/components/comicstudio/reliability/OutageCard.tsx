// The `model_outage` conversation card (reliability.md §3; models.md §3.6 G/H wording). A provider outage the
// money-safe preflight caught, or a run that failed part-way on an upstream outage, becomes this calm card instead
// of a red error: who isn't serving the model, what wasn't drawn, that the comic stays on its model, a live status
// line with source and time, and the real ways out as buttons (OptionButtons.tsx). Money is mentioned only when
// known: a preflight card ran nothing ("nothing was charged"); a mid-run card says "you weren't charged for it"
// only when the provider reported $0; a card without an origin makes no money claim (options.ts outageFacts).
//
// Live state: the status comes from useModelStatus, the retry intent from retryIntents.ts.
//   ok       → "{Model} is answering again" + Try again now
//   degraded → "{Model} is unsteady" (maybe a half-open probe): the options + Try again now
//   unknown  → "{Model}: no live status right now" (never "answering again"): the options + Try again now
//   down     → "{Model} is paused": the options
// Wait and retry: arms a one-shot intent; when a status received after the click says the model is ok, the
// blocked action is re-sent ONCE (useAutoRetry), only while this page is open and visible — the card says that a
// closed page runs nothing later. Switching models only ever opens the picker (its confirm says consistency can
// be affected); this card never changes the model.

import React, { useSyncExternalStore } from 'react';
import { CheckCircle2, HelpCircle, PauseCircle, RefreshCw } from 'lucide-react';
import type { CardProps } from '../extensions';
import { useCostFormat } from '../conversation/cost';
import { CardShell, GhostButton, cx } from '../conversation/ui';
import { armRetry, cancelRetry, getRetry, retriesVersion, subscribeRetries } from './retryIntents';
import { ModelHealthDot } from './ModelHealthDot';
import { OptionButton, type OptionHandlers } from './OptionButtons';
import { blockedWhat, clockTime, modelName, noLiveStatusSentence, outageSentence, recoveredSentence, sourceLine } from './copy';
import { cleanOptions, outageFacts, type OutageCardData, type SwitchOption } from './options';
import { isBack, useAutoRetry, useModelStatus } from './useModelStatus';

export const OutageCard: React.FC<CardProps<OutageCardData>> = ({ card, studio }) => {
  useSyncExternalStore(subscribeRetries, retriesVersion, retriesVersion);
  const status = useModelStatus([card.modelId]);
  const retryWatch = useAutoRetry(studio);
  const cost = useCostFormat(studio);
  const doc = studio.doc;
  if (!card?.modelId) return null;

  const now = Date.now();
  const health = status.byId[card.modelId];
  const name = modelName(card.modelId);
  const intent = getRetry(card.id);
  const action = card.blockedAction;
  const facts = outageFacts(card);
  const pageNumber = (id: string) => doc?.pages.find((p) => p.id === id)?.n;
  const what = blockedWhat(action, pageNumber);
  const lowerWhat = what.label.charAt(0).toLowerCase() + what.label.slice(1);
  // Wait / other route re-send the blocked action: without one there is nothing to re-send, so they are left out.
  const options = cleanOptions(card.options).filter((o) => !!action || (o.kind !== 'wait_and_retry' && o.kind !== 'other_route'));
  const state = health?.state;
  const back = isBack(state);
  const noLive = state === 'unknown';
  const unsteady = state === 'degraded';
  const waiting = intent?.state === 'waiting' || intent?.state === 'sending';
  const watching = status.watching || (intent?.state === 'waiting' && retryWatch.watching);
  const expired = status.expired || (intent?.state === 'waiting' && retryWatch.expired);

  const handlers: OptionHandlers = {
    blockedAction: action,
    onWait: action ? () => armRetry(card.id, card.modelId, action) : undefined,
    onRetryNow: action ? () => void studio.act(action) : undefined,
    onSwitch: (option: SwitchOption) => studio.runClientAction({ type: 'open_model_picker', suggest: option.modelId })
  };

  let live: React.ReactNode;
  if (intent?.state === 'sent') {
    live = (
      <p className="flex items-start gap-1.5 text-[12.5px] leading-snug text-[var(--ds-ink)]">
        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--ds-success-text)]" aria-hidden />
        <span>
          {name} answered again{intent.sentAt ? ` at ${clockTime(intent.sentAt, now)}` : ''}, so {lowerWhat} {what.plural ? 'were' : 'was'} started once.
        </span>
      </p>
    );
  } else if (intent?.state === 'failed') {
    live = <p className="text-[12.5px] leading-snug text-[var(--ds-ink)]">{name} answered again, but the retry didn't go through. You can try again below.</p>;
  } else if (waiting) {
    live = (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--ds-ink)]">
          {intent?.state === 'sending'
            ? `${name} is back — starting ${lowerWhat} again…`
            : `Waiting for ${name}. ${what.label} will start once, automatically, when it's working again — only while this page stays open. If you close it, nothing runs later.`}
        </p>
        {intent?.state === 'waiting' && (
          <GhostButton size="sm" onClick={() => cancelRetry(card.id)} className="coarse:min-h-11">
            Don't retry
          </GhostButton>
        )}
      </div>
    );
  }

  const title = back ? `${name} is answering again` : noLive ? `${name}: no live status right now` : unsteady ? `${name} is unsteady` : `${name} is paused`;
  const icon = back ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : noLive ? <HelpCircle className="h-4 w-4" aria-hidden /> : <PauseCircle className="h-4 w-4" aria-hidden />;
  const sentence = back
    ? recoveredSentence({ modelId: card.modelId, action, pageNumber, ...facts })
    : noLive
      ? noLiveStatusSentence({ modelId: card.modelId, action, pageNumber, ...facts })
      : outageSentence({ modelId: card.modelId, health, action, pageNumber, doc, ...facts });
  // A run may go now when the model is ok, unsteady (the server lets it through, one probe at a time) or there is
  // no data; never offered while it is paused (the preflight would refuse it again).
  const canTryNow = !!action && !!state && state !== 'down' && !waiting && intent?.state !== 'sent';

  return (
    <CardShell title={title} icon={icon} right={health ? <ModelHealthDot health={health} label={name} now={now} /> : undefined} aria-label={`${name} status`} className="min-w-0">
      <div className="min-w-0 space-y-3" data-card="model_outage">
        <p className="text-[13.5px] leading-relaxed text-[var(--ds-ink)] [overflow-wrap:anywhere]">{sentence}</p>
        <p className="text-[11.5px] text-[var(--ds-muted)] [overflow-wrap:anywhere]">
          Status: {sourceLine(health, now)}
          {watching ? ' · checking again every minute while this page is open' : ''}
          {expired ? ' · stopped checking after 30 minutes' : ''}
        </p>

        <div role="status" aria-live="polite" className="min-w-0">
          {live}
        </div>

        {canTryNow && (
          <GhostButton size="sm" onClick={() => void studio.act(action!)} className="coarse:min-h-11">
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

        {expired && (
          <GhostButton
            size="sm"
            onClick={() => {
              status.refresh();
              if (intent?.state === 'waiting') retryWatch.refresh();
            }}
            className="coarse:min-h-11"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Check again
          </GhostButton>
        )}
      </div>
    </CardShell>
  );
};

export default OutageCard;
