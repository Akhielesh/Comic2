// studioReducer — the live queue slice (agent-editor plan §3 A1): the turn lock, BUSY putting notes back without a
// failed bubble, the bounded BUSY retries, holds and "Send now".

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from './conversation/testing/fixtures';
import { initialStudioState, isPlanning, isTurnLocked, queueOf, studioReducer, type StudioReducerAction, type StudioState } from './studioReducer';
import type { QueuedNote } from './messageQueue';

const NOW = 1_760_000_000_000;
const note = (id: string, text = id): QueuedNote => ({ id, text, at: 1 });
const run = (state: StudioState, ...actions: StudioReducerAction[]) => actions.reduce(studioReducer, state);
const loaded = () => run(initialStudioState(), { type: 'load_success', doc: makeSampleDoc(), now: NOW });

/** A message stream carrying queued notes (a drain), started. */
const drained = (state: StudioState, notes: QueuedNote[], streamId = 's1') =>
  run(
    state,
    { type: 'queue_take', ids: notes.map((n) => n.id) },
    { type: 'message_pending', message: { id: 'p1', text: 'x', attachments: [], at: NOW, status: 'sending', streamId, requeue: { notes, at: 'head' } } },
    { type: 'stream_start', streamId, kind: 'message', now: NOW }
  );

const busyEnd = (state: StudioState, streamId = 's1') =>
  run(
    state,
    { type: 'stream_event', streamId, event: { type: 'error', code: 'BUSY', message: "I'm still working on your last message." }, now: NOW },
    { type: 'stream_end', streamId, now: NOW }
  );

describe('the turn lock', () => {
  it('is held by a director turn until its reply, and by a plan_pages action', () => {
    let s = loaded();
    expect(isTurnLocked(s)).toBe(false);
    s = run(s, { type: 'stream_start', streamId: 'a1', kind: 'action', actionType: 'plan_pages', now: NOW });
    expect(isPlanning(s)).toBe(true);
    expect(isTurnLocked(s)).toBe(true);
    s = run(s, { type: 'stream_end', streamId: 'a1', now: NOW }, { type: 'stream_start', streamId: 'a2', kind: 'action', actionType: 'render_cover', now: NOW });
    expect(isTurnLocked(s)).toBe(false);
    s = run(s, { type: 'stream_start', streamId: 'm1', kind: 'message', now: NOW });
    expect(isTurnLocked(s)).toBe(true);
  });
});

describe('BUSY on a queued message', () => {
  it('puts the notes back at the head, holds the queue "elsewhere", and shows no failed bubble or error', () => {
    let s = run(loaded(), { type: 'queue_add', note: note('a') }, { type: 'queue_add', note: note('b') });
    s = drained(s, [note('a')]);
    expect(queueOf(s).notes.map((n) => n.id)).toEqual(['b']);
    s = run(s, { type: 'queue_add', note: note('c') });
    s = busyEnd(s);
    expect(s.pendingMessage).toBeNull();
    expect(s.error).toBeNull();
    expect(s.errorCode).toBeNull();
    expect(queueOf(s)).toMatchObject({ held: 'elsewhere', busyRetries: 1 });
    expect(queueOf(s).notes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
  });

  it('a message without queued notes still fails visibly (with Try again)', () => {
    let s = run(
      loaded(),
      { type: 'message_pending', message: { id: 'p1', text: 'hi', attachments: [], at: NOW, status: 'sending', streamId: 's1' } },
      { type: 'stream_start', streamId: 's1', kind: 'message', now: NOW }
    );
    s = busyEnd(s);
    expect(s.pendingMessage).toMatchObject({ status: 'failed', code: 'BUSY' });
    expect(s.queue).toBeUndefined();
  });

  it('the retry count survives a drain that empties the queue, and resets once the server records the message', () => {
    let s = run(loaded(), { type: 'queue_add', note: note('a') });
    s = busyEnd(drained(s, [note('a')]));
    s = run(s, { type: 'queue_retry' });
    expect(queueOf(s).held).toBeNull();
    s = drained(s, [note('a')], 's2');
    expect(queueOf(s).busyRetries).toBe(1);
    s = busyEnd(s, 's2');
    expect(queueOf(s).busyRetries).toBe(2);
    s = run(s, { type: 'queue_retry' });
    s = drained(s, [note('a')], 's3');
    s = run(s, { type: 'stream_event', streamId: 's3', event: { type: 'ops', rev: 6, ops: [{ op: 'message', msg: { id: 'u_srv', role: 'user', text: 'a', at: 1 } }] }, now: NOW });
    expect(s.pendingMessage).toBeNull();
    expect(queueOf(s).busyRetries).toBe(0);
  });
});

describe('holds and Send now', () => {
  it('a Stop hold set on an empty queue holds notes typed while stopping; Clear forgets it', () => {
    let s = run(loaded(), { type: 'queue_hold', held: 'stopped' });
    expect(queueOf(s).held).toBe('stopped');
    s = run(s, { type: 'queue_add', note: note('a') });
    expect(queueOf(s)).toMatchObject({ held: 'stopped', notes: [note('a')] });
    s = run(s, { type: 'queue_clear' });
    expect(queueOf(s)).toMatchObject({ held: null, notes: [] });
  });

  it('release lifts the hold and lets one drain pass a question; a take ends it', () => {
    let s = run(loaded(), { type: 'queue_add', note: note('a') }, { type: 'queue_hold', held: 'restored' }, { type: 'queue_release' });
    expect(queueOf(s)).toMatchObject({ held: null, force: true });
    s = run(s, { type: 'queue_take', ids: ['a'] });
    expect(queueOf(s).force).toBe(false);
  });

  it('express moves the note to the head and marks it; removing it clears the mark', () => {
    let s = run(loaded(), { type: 'queue_add', note: note('a') }, { type: 'queue_add', note: note('b') }, { type: 'queue_hold', held: 'stopped' }, { type: 'queue_express', id: 'b' });
    expect(queueOf(s)).toMatchObject({ express: 'b', held: null });
    expect(queueOf(s).notes.map((n) => n.id)).toEqual(['b', 'a']);
    s = run(s, { type: 'queue_remove', id: 'b' });
    expect(queueOf(s).express).toBeNull();
    expect(run(s, { type: 'queue_express', id: 'missing' })).toBe(s);
  });

  it('restore brings saved notes back held, and load_start forgets the queue (a project switch)', () => {
    let s = run(loaded(), { type: 'queue_restore', notes: [note('a'), note('b')] });
    expect(queueOf(s)).toMatchObject({ held: 'restored' });
    s = run(s, { type: 'load_start' });
    expect(queueOf(s).notes).toEqual([]);
  });
});
