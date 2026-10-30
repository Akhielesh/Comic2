// "Wait and retry automatically" (reliability.md §3): the user's intent lives in THIS page's memory only, so
// a closed page never runs anything later (the card says so). An intent re-sends its blocked action exactly
// ONCE: `claimRetry` hands it to the first caller and never again, whichever component notices the model is
// back first (the banner runner or the card itself).

import type { StudioAction } from '../../../shared/comic/ops';

export type RetryState = 'waiting' | 'sending' | 'sent' | 'failed';

export interface RetryIntent {
  cardId: string;
  modelId: string;
  action: StudioAction;
  armedAt: number;
  state: RetryState;
  /** When the action was re-sent. */
  sentAt?: number;
}

const intents = new Map<string, RetryIntent>();
const listeners = new Set<() => void>();
let version = 0;

const notify = () => {
  version += 1;
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
};

export const subscribeRetries = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

export const retriesVersion = (): number => version;

export const getRetry = (cardId: string): RetryIntent | undefined => intents.get(cardId);

/** Every intent still waiting for its model. */
export const waitingRetries = (): RetryIntent[] => [...intents.values()].filter((i) => i.state === 'waiting');

/** Arm (or re-arm after a failed send) the intent for one outage card. A sent intent is never re-armed. */
export const armRetry = (cardId: string, modelId: string, action: StudioAction, now: number = Date.now()): RetryIntent | undefined => {
  const cur = intents.get(cardId);
  if (cur && (cur.state === 'sending' || cur.state === 'sent')) return cur;
  const intent: RetryIntent = { cardId, modelId, action, armedAt: now, state: 'waiting' };
  intents.set(cardId, intent);
  notify();
  return intent;
};

/** The user changed their mind (only a waiting intent can be dropped). */
export const cancelRetry = (cardId: string): void => {
  const cur = intents.get(cardId);
  if (cur?.state !== 'waiting') return;
  intents.delete(cardId);
  notify();
};

/** Hand the intent to exactly one sender: true once, then false forever (state moves to `sending`). */
export const claimRetry = (cardId: string): RetryIntent | undefined => {
  const cur = intents.get(cardId);
  if (!cur || cur.state !== 'waiting') return undefined;
  const next: RetryIntent = { ...cur, state: 'sending' };
  intents.set(cardId, next);
  notify();
  return next;
};

/** Record how the single send went. */
export const settleRetry = (cardId: string, ok: boolean, now: number = Date.now()): void => {
  const cur = intents.get(cardId);
  if (!cur || cur.state !== 'sending') return;
  intents.set(cardId, { ...cur, state: ok ? 'sent' : 'failed', sentAt: now });
  notify();
};

export const __resetRetries = (): void => {
  intents.clear();
  notify();
};
