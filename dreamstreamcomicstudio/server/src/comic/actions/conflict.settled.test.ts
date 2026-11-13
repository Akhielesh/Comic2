// @vitest-environment node
// Settled cards (D3) on the server (S2b ship security review): a conflict card the chat has moved past is SETTLED ("left": the
// creator's edit stands; settled.ts outcome 'left', and the director model is told so). The UI shows no controls, but
// the server must refuse a late or replayed resolve_conflict too, or a stale tab / a replayed POST rewrites the
// creator's words with the director's version after the model was told "your edit stands".
// Fails without the isPassed() check in actions/conflict.ts resolveConflict.

import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS, type StudioCaps } from '../../../../shared/comic/capabilities.js';
import type { ComicDoc, ConflictCard, Msg } from '../../../../shared/comic/doc.js';
import { cardSettle, settledCardsOn } from '../../../../shared/comic/settle.js';
import { startAction } from '../jobs.js';
import { SETTLED_TEXT } from './conflict.js';
import { newSession, plannedDoc, testContext } from '../orchestrator.fakes.js';

const ADMIN_ON: StudioCaps = { ...DEFAULT_CAPS, admin: true, liveAgent: { queue: false, steer: false, conflicts: true } } as StudioCaps;

const NON_ADMIN: StudioCaps = { ...ADMIN_ON, admin: false } as StudioCaps;

function passedConflict() {
  const doc: ComicDoc = plannedDoc();
  doc.pages[0].panels[1].lines = [{ id: 'ln_a', kind: 'speech', speakerId: 'c_maya', text: 'We have to go' }];
  const card: ConflictCard = {
    type: 'conflict',
    id: 'card_cf',
    items: [
      {
        id: 'cf_1',
        where: { pageId: 'pg_1', panelId: 'pn_1_2', lineId: 'ln_a', label: 'page 1 · panel 2 · line 1' },
        mine: 'We have to go',
        theirs: 'Run!',
        proposed: [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_a', patch: { text: 'Run!' } }]
      }
    ]
  };
  const reply: Msg = { id: 'msg_reply', role: 'assistant', text: 'Done.', at: 1, cards: [card] };
  const later: Msg = { id: 'msg_later', role: 'user', text: 'Now make page 2 darker.', at: 2 };
  doc.conversation = [...doc.conversation, reply, later];
  const idx = doc.conversation.findIndex((m) => m.id === 'msg_reply');
  expect(cardSettle(doc, idx, card)).toMatchObject({ state: 'settled', outcome: 'left' });
  return doc;
}

describe('resolve_conflict on a settled (passed) card', () => {
  it('is refused once a later user message has committed: the creator\'s edit stands', async () => {
    expect(settledCardsOn(true)).toBe(true);
    const session = newSession(passedConflict());
    const ctx = testContext(session, { caps: ADMIN_ON });
    const started = await startAction(
      ctx,
      { type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_1'], choice: 'theirs' },
      { confirmed: false, origin: 'user', caps: ADMIN_ON }
    );
    expect(started.outcome?.status).toBe('blocked');
    expect(started.outcome?.message).toBe(SETTLED_TEXT);
    expect(session.doc.pages[0].panels[1].lines[0].text).toBe('We have to go');
    const stored = session.doc.conversation.find((m) => m.id === 'msg_reply')?.cards?.[0] as ConflictCard;
    expect(stored.items[0].resolved).toBeUndefined();
  });

  it('is refused for a non-admin too, now that settled cards are on for everyone (R00 SF-1)', async () => {
    expect(settledCardsOn(false)).toBe(true);
    const session = newSession(passedConflict());
    const ctx = testContext(session, { caps: NON_ADMIN });
    const started = await startAction(
      ctx,
      { type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_1'], choice: 'theirs' },
      { confirmed: false, origin: 'user', caps: NON_ADMIN }
    );
    expect(started.outcome?.status).toBe('blocked');
    expect(started.outcome?.message).toBe(SETTLED_TEXT);
    expect(session.doc.pages[0].panels[1].lines[0].text).toBe('We have to go');
  });

  it('control: before the chat moves on, a non-admin\'s answer still applies', async () => {
    const doc = passedConflict();
    doc.conversation = doc.conversation.filter((m) => m.id !== 'msg_later');
    const session = newSession(doc);
    const ctx = testContext(session, { caps: NON_ADMIN });
    const started = await startAction(
      ctx,
      { type: 'resolve_conflict', cardId: 'card_cf', itemIds: ['cf_1'], choice: 'theirs' },
      { confirmed: false, origin: 'user', caps: NON_ADMIN }
    );
    expect(started.outcome?.status).toBe('done');
    expect(session.doc.pages[0].panels[1].lines[0].text).toBe('Run!');
  });
});
