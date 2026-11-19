// studioReducer — `streams_adopt` (liveturn LT-2): a studio opening a comic takes over the message and action streams
// that kept running while no studio showed it (live/studioStreams.ts hands it the snapshot). What it may take and what
// it must leave alone: the streams' doc only when it is newer and the same comic, no draft whose reply already landed,
// nothing twice, its own pending bubble and error first, and a reply the GET already holds unlocks the composer.

import { describe, expect, it } from 'vitest';
import type { ComicDoc } from '../../shared/comic/doc';
import type { ActivityItem } from './types';
import { makeSampleDoc } from './conversation/testing/fixtures';
import {
  initialStudioState,
  isMessageBusy,
  replyLandedBeyond,
  studioReducer,
  type PendingUserMessage,
  type PresenceEntry,
  type StreamInfo,
  type StudioReducerAction,
  type StudioState
} from './studioReducer';

const NOW = 1_760_000_000_000;
const run = (state: StudioState, ...actions: StudioReducerAction[]) => actions.reduce(studioReducer, state);

const withMessages = (doc: ComicDoc, rev: number, ...msgs: Array<{ id: string; role: 'user' | 'assistant'; text: string }>): ComicDoc => ({
  ...doc,
  rev,
  conversation: msgs.map((m, i) => ({ ...m, at: NOW + i }))
});

const DOC = makeSampleDoc();
/** What the GET returned: the user's message is in, the reply is not. */
const GET = withMessages(DOC, 6, { id: 'u1', role: 'user', text: 'Plan it' });
const loaded = (doc: ComicDoc = GET) => run(initialStudioState(), { type: 'load_success', doc, urls: {}, now: NOW });

const turn: StreamInfo = { id: 's1', kind: 'message', startedAt: NOW };
const render: StreamInfo = { id: 's2', kind: 'action', actionType: 'render_pages', startedAt: NOW };
const step = (id: string, phase: 'start' | 'end' = 'start'): ActivityItem => ({ id, label: `Step ${id}`, phase, at: NOW });
const place = (activityId: string, streamId = 's1'): PresenceEntry => ({ activityId, streamIds: [streamId], presence: { pageId: 'pg_1', lineIds: [], label: 'Lettering', at: NOW } });
const bubble = (over: Partial<PendingUserMessage> = {}): PendingUserMessage => ({ id: 'pending_1', text: 'Plan it', attachments: [], at: NOW, status: 'sending', streamId: 's1', ...over });

const adopt = (over: Partial<Extract<StudioReducerAction, { type: 'streams_adopt' }>> = {}): StudioReducerAction => ({
  type: 'streams_adopt',
  streams: [turn],
  drafts: {},
  activity: [],
  presence: [],
  doc: null,
  urls: {},
  pendingMessage: null,
  now: NOW + 5,
  ...over
});

describe('streams_adopt — the doc', () => {
  it('takes the streams’ doc only when it is newer and the same comic', () => {
    const newer = withMessages(DOC, 7, { id: 'u1', role: 'user', text: 'Plan it' }, { id: 'a1', role: 'assistant', text: 'Six pages.' });
    expect(run(loaded(), adopt({ doc: newer })).base?.rev).toBe(7);

    const older = withMessages(DOC, 5);
    const keptOlder = run(loaded(), adopt({ doc: older }));
    expect(keptOlder.base?.rev).toBe(6);
    expect(keptOlder.base?.conversation.map((m) => m.id)).toEqual(['u1']);

    const otherComic = { ...newer, id: 'proj_other', rev: 99 };
    const keptOther = run(loaded(), adopt({ doc: otherComic }));
    expect(keptOther.base?.id).toBe('proj_1');
    expect(keptOther.base?.rev).toBe(6);
  });

  it('a reply the GET already holds, which the streams have not delivered yet, unlocks the composer', () => {
    // The streams' copy stops at the user's message; the GET answered after the reply was committed.
    const streamsDoc = GET;
    const fresh = withMessages(DOC, 7, { id: 'u1', role: 'user', text: 'Plan it' }, { id: 'a1', role: 'assistant', text: 'Six pages.' });
    const s = run(loaded(fresh), adopt({ doc: streamsDoc, streams: [turn, render] }));
    expect(s.streams.s1.replied).toBe(true);
    expect(isMessageBusy(s)).toBe(false);
    // The action stream is untouched; only message streams wait for a reply.
    expect(s.streams.s2.replied).toBeUndefined();
    // The same ops arriving later on the stream change nothing (already applied).
    const later = run(s, { type: 'stream_event', streamId: 's1', event: { type: 'ops', rev: 7, ops: [{ op: 'message', msg: { id: 'a1', role: 'assistant', text: 'Six pages.', at: NOW } }] }, now: NOW + 9 });
    expect(later.base?.conversation.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(isMessageBusy(later)).toBe(false);
  });

  it('a GET with no new reply keeps the adopted turn waiting', () => {
    const s = run(loaded(), adopt({ doc: GET }));
    expect(isMessageBusy(s)).toBe(true);
    // Nothing to compare against: still waiting.
    expect(isMessageBusy(run(loaded(), adopt({ doc: null })))).toBe(true);
  });
});

describe('streams_adopt — drafts, steps, presence, streams', () => {
  it('drops a draft whose reply has landed in the doc it keeps, and keeps the others', () => {
    const fresh = withMessages(DOC, 7, { id: 'u1', role: 'user', text: 'Plan it' }, { id: 'a1', role: 'assistant', text: 'Six pages.' });
    const s = run(loaded(fresh), adopt({ doc: GET, drafts: { a1: 'Six pa', a2: 'And the cover' } }));
    expect(s.drafts).toEqual({ a2: 'And the cover' });
  });

  it('adds nothing twice: streams, steps and presence already here are kept as they are', () => {
    let s = run(
      loaded(),
      { type: 'stream_start', streamId: 's1', kind: 'message', now: NOW },
      { type: 'stream_event', streamId: 's1', event: { type: 'activity', id: 'read', label: 'Reading your brief', phase: 'start', where: { pageId: 'pg_1' } }, now: NOW + 1 }
    );
    const mine = s.streams.s1;
    const presenceBefore = s.presence;
    expect(presenceBefore).toHaveLength(1);
    s = run(
      s,
      adopt({
        streams: [{ ...turn, startedAt: NOW - 100, replied: true }, render],
        activity: [step('read', 'end'), step('plan')],
        presence: [place('read'), place('plan', 's2')]
      })
    );
    expect(s.streams.s1).toBe(mine);
    expect(Object.keys(s.streams).sort()).toEqual(['s1', 's2']);
    expect(s.activity.map((a) => [a.id, a.phase])).toEqual([
      ['read', 'start'],
      ['plan', 'start']
    ]);
    expect(s.presence?.map((p) => p.activityId)).toEqual(['read', 'plan']);
    expect(s.presence?.[0]).toBe(presenceBefore?.[0]);
  });

  it('keeps the longer draft of a message it already streams', () => {
    const s = run(
      loaded(),
      { type: 'stream_start', streamId: 's1', kind: 'message', now: NOW },
      { type: 'stream_event', streamId: 's1', event: { type: 'delta', msgId: 'a1', text: 'Six pages, ' }, now: NOW + 1 },
      adopt({ drafts: { a1: 'Six' } })
    );
    expect(s.drafts.a1).toBe('Six pages, ');
  });
});

describe('streams_adopt — the bubble and the error', () => {
  it('its own pending bubble wins over the adopted one', () => {
    const own = bubble({ id: 'pending_own', text: 'Mine', streamId: 's9' });
    const s = run(loaded(), { type: 'message_pending', message: own }, adopt({ pendingMessage: bubble({ status: 'failed', error: 'Not sent.' }) }));
    expect(s.pendingMessage).toBe(own);
  });

  it('takes the adopted bubble when it has none', () => {
    const failed = bubble({ status: 'failed', error: 'Wait a moment before sending again.', code: 'COOLDOWN' });
    expect(run(loaded(), adopt({ streams: [], pendingMessage: failed })).pendingMessage).toEqual(failed);
  });

  it('shows the error the work hit while nobody watched, never over its own', () => {
    const s = run(loaded(), adopt({ streams: [], error: { message: 'The model is busy.', code: 'PROVIDER_ERROR' } }));
    expect(s.error).toBe('The model is busy.');
    expect(s.errorCode).toBe('PROVIDER_ERROR');
    const own = run(loaded(), { type: 'set_error', message: 'Couldn’t save your change.' }, adopt({ streams: [], error: { message: 'The model is busy.' } }));
    expect(own.error).toBe('Couldn’t save your change.');
  });
});

describe('replyLandedBeyond', () => {
  const fresh = withMessages(DOC, 7, { id: 'u1', role: 'user', text: 'Plan it' }, { id: 'a1', role: 'assistant', text: 'Six pages.' });
  it('is true only for a new assistant message with text in a newer copy of the same comic', () => {
    expect(replyLandedBeyond(fresh, GET)).toBe(true);
    expect(replyLandedBeyond(GET, fresh)).toBe(false);
    expect(replyLandedBeyond(fresh, fresh)).toBe(false);
    expect(replyLandedBeyond({ ...fresh, id: 'proj_other' }, GET)).toBe(false);
    expect(replyLandedBeyond(fresh, null)).toBe(false);
    expect(replyLandedBeyond(withMessages(DOC, 7, { id: 'u1', role: 'user', text: 'Plan it' }, { id: 'u2', role: 'user', text: 'More' }), GET)).toBe(false);
    expect(replyLandedBeyond(withMessages(DOC, 7, { id: 'u1', role: 'user', text: 'Plan it' }, { id: 'a1', role: 'assistant', text: '  ' }), GET)).toBe(false);
  });
});
