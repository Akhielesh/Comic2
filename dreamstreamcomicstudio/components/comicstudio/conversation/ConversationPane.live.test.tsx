// The cards that stay live however old, through the pane's own wiring (PROGRAM3 SETTLE-UI; collisions C-6; settle.md
// §5.4): ConversationPane hands buildSettleIndex the outage cards whose "wait and retry" is waiting (the retry store,
// subscribed so arming or cancelling rebuilds the index) and whether the director is working. A waiting retry keeps its
// outage card — and "Don't retry", the only cancel for an armed re-send that will spend — live after the creator moves
// on; a translation keeps its live progress while the director writes the edition. Fails without the `retrying` or
// `working` inputs (the card settles to its line and the cancel is gone).

import React from 'react';
import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Card, ComicDoc, Msg } from '../../../shared/comic/doc';
import { DEFAULT_CAPS } from '../../../shared/comic/capabilities';
import { editionProgress } from '../../../shared/comic/i18n';
import { __resetStatusStore, __setStatusFetcherForTests } from '../reliability/statusStore';
import { __resetRetries, armRetry, getRetry } from '../reliability/retryIntents';
import { makeQaDoc } from '../testing/qaFixtures';
import { ConversationPane } from './ConversationPane';
import { __resetEntrances } from './MessageItem';
import { makeFakeStudio, makeSampleDoc, resetUsageStatus, showDollarPrices } from './testing/fixtures';

const ADMIN = { ...DEFAULT_CAPS, admin: true };
type OutageCard = Extract<Card, { type: 'model_outage' }>;
const OUTAGE = {
  type: 'model_outage',
  id: 'out_1',
  modelId: 'nano-banana-2.1',
  options: [{ kind: 'wait_and_retry' }],
  blockedAction: { type: 'render_pages', pageIds: ['pg_2', 'pg_3'], quotedUsd: 0.14 }
} as unknown as OutageCard;

// The model is down: the live card offers "Wait and retry automatically". Fake: no request leaves the test.
const fetcher = vi.fn(async (ids: readonly string[]) => ids.map((modelId) => ({ modelId, state: 'down' as const, checkedAt: Date.now(), routes: [] })));

beforeEach(() => {
  // Any watch the live card starts runs on fake clocks only (no /api call on a timer).
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  showDollarPrices();
  __resetEntrances();
  __resetRetries();
  __resetStatusStore();
  fetcher.mockClear();
  __setStatusFetcherForTests(fetcher);
});
afterEach(() => {
  __setStatusFetcherForTests(null);
  resetUsageStatus();
  vi.useRealTimers();
});

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

const slotOf = (container: HTMLElement, id: string) => container.querySelector(`[data-card-slot="${id}"]`) as HTMLElement;
const user = (id: string, text: string, at: number): Msg => ({ id, role: 'user', text, at });

describe('a waiting "wait and retry"', () => {
  const conversation: Msg[] = [
    user('u1', 'Draw pages 2 and 3', 1),
    { id: 'a1', role: 'assistant', text: 'Nano Banana 2.1 is paused right now.', at: 2, cards: [OUTAGE] },
    user('u2', 'Meanwhile, make Maya a bit taller', 3)
  ];

  it('keeps its passed outage card live with "Don’t retry"; cancelled, the card settles to its line', async () => {
    const doc = makeSampleDoc({ conversation });
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc, caps: ADMIN })} />);
    await flush();
    // Passed, nothing waiting: one quiet line, no control.
    expect(slotOf(container, 'out_1').querySelector('[data-settled]')).not.toBeNull();
    expect(slotOf(container, 'out_1').querySelectorAll('button')).toHaveLength(0);
    // A retry is armed (the outage banner, or this card before the creator moved on): the store tells the pane.
    await act(async () => {
      armRetry(OUTAGE.id, OUTAGE.modelId, OUTAGE.blockedAction!);
    });
    await flush();
    const slot = slotOf(container, 'out_1');
    expect(slot.querySelector('[data-settled]')).toBeNull();
    expect(slot.textContent).toMatch(/Don.t retry/);
    // The one cancel for a re-send that would spend: still reachable, and it works.
    fireEvent.click(within(slot).getByRole('button', { name: /Don.t retry/ }));
    await flush();
    expect(getRetry(OUTAGE.id)).toBeUndefined();
    expect(slotOf(container, 'out_1').querySelector('[data-settled]')).not.toBeNull();
    expect(slotOf(container, 'out_1').textContent).toBe('Nano Banana 2.1 was paused · 2 pages waited');
  });

  it('the real flow: tap "Wait and retry" on the live card, then send something else — the card and its cancel stay', async () => {
    const latest = makeSampleDoc({ conversation: conversation.slice(0, 2) });
    const studio = makeFakeStudio({ doc: latest, caps: ADMIN });
    const { container, rerender } = render(<ConversationPane studio={studio} />);
    await flush();
    fireEvent.click(within(slotOf(container, 'out_1')).getByRole('button', { name: /Wait and retry automatically/ }));
    await flush();
    expect(getRetry(OUTAGE.id)?.state).toBe('waiting');
    // The creator moves on: their next message is committed after the outage reply.
    rerender(<ConversationPane studio={{ ...studio, doc: makeSampleDoc({ conversation }) }} />);
    await flush();
    const slot = slotOf(container, 'out_1');
    expect(slot.querySelector('[data-settled]')).toBeNull();
    expect(within(slot).getByRole('button', { name: /Don.t retry/ })).toBeEnabled();
  });

  it('a non-admin gets the same rule (R00 SF-1): passed and not retrying, the card settles to its line', async () => {
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation }), caps: DEFAULT_CAPS })} />);
    await flush();
    expect(slotOf(container, 'out_1').querySelector('[data-settled]')).not.toBeNull();
    expect(within(slotOf(container, 'out_1')).queryByRole('button', { name: /Wait and retry/ })).toBeNull();
  });

  it('a non-admin’s waiting retry keeps the card live with "Don’t retry", as for an admin', async () => {
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc: makeSampleDoc({ conversation }), caps: DEFAULT_CAPS })} />);
    await flush();
    await act(async () => {
      armRetry(OUTAGE.id, OUTAGE.modelId, OUTAGE.blockedAction!);
    });
    await flush();
    const slot = slotOf(container, 'out_1');
    expect(slot.querySelector('[data-settled]')).toBeNull();
    expect(within(slot).getByRole('button', { name: /Don.t retry/ })).toBeEnabled();
  });

  it('a non-admin sees the heist question "Not answered — you moved on" (R00 SF-1)', async () => {
    const { container } = render(<ConversationPane studio={makeFakeStudio({ doc: makeQaDoc('heist-12p'), caps: DEFAULT_CAPS })} />);
    await flush();
    expect(slotOf(container, 'o1').textContent).toBe('Not answered — you moved on');
  });
});

describe('a translation the director is still writing', () => {
  const translationDoc = (): ComicDoc => {
    const base = makeQaDoc('heist-12p');
    return {
      ...base,
      conversation: [
        user('u1', 'Make a Spanish edition', 1),
        { id: 'a1', role: 'assistant', text: 'Writing the Spanish edition.', at: 2, cards: [{ type: 'translation', id: 't_es', languages: ['es'] }] },
        user('u2', 'and make the title bigger', 3)
      ]
    };
  };

  it('keeps its live progress while the director works, then settles to its line once it stops', async () => {
    const doc = translationDoc();
    const p = editionProgress(doc, 'es');
    expect(p.done).toBeLessThan(p.total); // the edition is not finished
    const studio = makeFakeStudio({ doc, caps: ADMIN, busy: true });
    const { container, rerender } = render(<ConversationPane studio={studio} />);
    await flush();
    const slot = slotOf(container, 't_es');
    expect(slot.querySelector('[data-settled]')).toBeNull();
    expect(within(slot).getByRole('progressbar', { name: /Spanish/ })).toBeInTheDocument();
    rerender(<ConversationPane studio={{ ...studio, busy: false }} />);
    await flush();
    expect(slotOf(container, 't_es').querySelector('[data-settled]')).not.toBeNull();
    expect(slotOf(container, 't_es').textContent).toBe('Spanish edition · not finished');
  });
});
