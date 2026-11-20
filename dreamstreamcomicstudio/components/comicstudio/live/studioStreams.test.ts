import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../../shared/comic/events';
import type { ComicDoc } from '../../../shared/comic/doc';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import type { PendingUserMessage, StudioReducerAction } from '../studioReducer';
import {
  LIVE_LIMITS,
  __resetStudioStreamsForTests,
  __studioStreamsStatsForTests,
  abortAllStudioStreams,
  begin,
  claim,
  detach,
  end,
  event,
  noteStop,
  noteStudioAccount,
  studioStreamKey,
  subscribe,
  subscribeStudioMoments,
  subscribeStudioStreams,
  workingKeys,
  type StudioMoment
} from './studioStreams';
import { workingProjectIds } from './useStudioWorking';

const KEY_A = studioStreamKey('acc-a', 'proj_1');

const userMsg = (rev: number, id = 'u1'): StudioEvent => ({ type: 'ops', rev, ops: [{ op: 'message', msg: { id, role: 'user', text: 'Plan it', at: 1 } }] });
const replyMsg = (rev: number, id = 'a1', text = 'Here is the plan.'): StudioEvent => ({ type: 'ops', rev, ops: [{ op: 'message', msg: { id, role: 'assistant', text, at: 2 } }] });

/** A sink that records what a mounted view would have been dispatched. */
const recorder = () => {
  const actions: StudioReducerAction[] = [];
  const sink = (a: StudioReducerAction) => void actions.push(a);
  return { actions, sink, events: () => actions.flatMap((a) => (a.type === 'stream_event' ? [a.event] : [])) };
};

const moments: StudioMoment[] = [];
let stopMoments: () => void = () => undefined;

const startMessage = (key: string, streamId = 's1', doc: ComicDoc = makeSampleDoc(), sink?: (a: StudioReducerAction) => void) => {
  const ctrl = new AbortController();
  begin(key, { streamId, kind: 'message', ctrl, before: doc, ...(sink ? { sink } : {}) });
  return ctrl;
};

beforeEach(() => {
  __resetStudioStreamsForTests();
  moments.length = 0;
  stopMoments = subscribeStudioMoments((m) => void moments.push(m));
});

afterEach(() => {
  stopMoments();
  vi.useRealTimers();
});

describe('studioStreams — the mirror', () => {
  it('folds ops, deltas and steps, and keeps drafts and steps within their caps (tail kept, live steps kept)', () => {
    const doc = makeSampleDoc();
    startMessage(KEY_A, 's1', doc);
    event(KEY_A, 's1', { type: 'hello', rev: 5, turnId: 't1' });
    event(KEY_A, 's1', userMsg(6));
    event(KEY_A, 's1', { type: 'activity', id: 'plan', label: 'Planning the pages', phase: 'start' });
    for (let i = 0; i < 20; i += 1) {
      event(KEY_A, 's1', { type: 'activity', id: `step${i}`, label: `Step ${i}`, phase: 'start' });
      event(KEY_A, 's1', { type: 'activity', id: `step${i}`, label: `Step ${i}`, phase: 'end', ok: true });
    }
    const chunk = 'x'.repeat(1_000);
    for (let i = 0; i < 9; i += 1) event(KEY_A, 's1', { type: 'delta', msgId: 'a1', text: chunk });
    event(KEY_A, 's1', { type: 'delta', msgId: 'a1', text: 'THE END' });

    claim(KEY_A);
    const snap = subscribe(KEY_A, recorder().sink);
    expect(snap).not.toBeNull();
    expect(snap!.doc?.rev).toBe(6);
    expect(snap!.doc?.conversation.map((m) => m.id)).toContain('u1');
    expect(snap!.streams.map((s) => s.id)).toEqual(['s1']);
    expect(snap!.awaitingReply).toBe('s1');
    const draft = snap!.drafts.a1;
    expect(draft.length).toBe(LIVE_LIMITS.draftChars);
    expect(draft.endsWith('THE END')).toBe(true);
    expect(snap!.activity.length).toBeLessThanOrEqual(LIVE_LIMITS.activity);
    // The long-running step that is still in progress is never the one dropped.
    expect(snap!.activity.find((a) => a.id === 'plan')?.phase).toBe('start');
    expect(snap!.activity.at(-1)?.id).toBe('step19');
  });

  it('hands a later view what arrived while nobody watched, then forwards the rest to it, in order and once', () => {
    const origin = recorder();
    claim(KEY_A);
    subscribe(KEY_A, origin.sink);
    startMessage(KEY_A, 's1', makeSampleDoc(), origin.sink);
    event(KEY_A, 's1', { type: 'hello', rev: 5, turnId: 't1' });
    event(KEY_A, 's1', userMsg(6));
    event(KEY_A, 's1', { type: 'delta', msgId: 'a1', text: 'Here ' });
    expect(origin.events().map((e) => e.type)).toEqual(['hello', 'ops', 'delta']);

    // The comic unmounts mid-turn: the stream is not aborted, the events keep folding.
    detach(KEY_A, origin.sink);
    event(KEY_A, 's1', { type: 'delta', msgId: 'a1', text: 'is ' });
    event(KEY_A, 's1', { type: 'activity', id: 'act1', label: 'Writing the reply', phase: 'start' });
    expect(origin.events()).toHaveLength(3);

    // Back in the comic: the snapshot carries what was missed; later events reach the new view only.
    const back = recorder();
    claim(KEY_A);
    const snap = subscribe(KEY_A, back.sink);
    expect(snap!.drafts.a1).toBe('Here is ');
    expect(snap!.activity.map((a) => a.id)).toEqual(['act1']);
    expect(snap!.controllers.map((c) => c.id)).toEqual(['s1']);
    event(KEY_A, 's1', { type: 'delta', msgId: 'a1', text: 'the plan.' });
    event(KEY_A, 's1', replyMsg(7));
    end(KEY_A, 's1', {});
    expect(back.events().map((e) => e.type)).toEqual(['delta', 'ops']);
    expect(back.actions.at(-1)).toMatchObject({ type: 'stream_end', streamId: 's1', aborted: false });
    expect(origin.events()).toHaveLength(3);
  });
});

describe('studioStreams — moments (NOTIFY §7)', () => {
  it('says "replied" once per message stream and "settled" once at its end', () => {
    startMessage(KEY_A);
    event(KEY_A, 's1', { type: 'hello', rev: 5, turnId: 'turn_9' });
    event(KEY_A, 's1', userMsg(6));
    expect(moments).toHaveLength(0);
    event(KEY_A, 's1', replyMsg(7));
    // A later batch with another assistant message (a job notice) is not a second reply.
    event(KEY_A, 's1', replyMsg(8, 'a2', 'Page 1 is drawing.'));
    event(KEY_A, 's1', { type: 'done', rev: 8, spentUsd: 0 });
    end(KEY_A, 's1', {});
    end(KEY_A, 's1', {});
    expect(moments.map((m) => m.phase)).toEqual(['replied', 'settled']);
    const [replied, settled] = moments;
    expect(replied).toMatchObject({ accountId: 'acc-a', projectId: 'proj_1', streamId: 's1', streamKind: 'message', turnId: 'turn_9' });
    expect(replied.before?.rev).toBe(5);
    expect(replied.after?.conversation.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(settled).toMatchObject({ phase: 'settled', outcome: 'done', turnId: 'turn_9' });
    expect(settled.after?.rev).toBe(8);
    expect(settled.error).toBeUndefined();
  });

  it('gives the same moments whether a view watched the stream or not', () => {
    const run = (key: string, watch: boolean) => {
      const view = recorder();
      if (watch) {
        claim(key);
        subscribe(key, view.sink);
      }
      begin(key, { streamId: 's', kind: 'message', ctrl: new AbortController(), before: makeSampleDoc(), ...(watch ? { sink: view.sink } : {}) });
      event(key, 's', { type: 'hello', rev: 5, turnId: 't' });
      event(key, 's', userMsg(6));
      event(key, 's', { type: 'activity', id: 'x', label: 'Thinking it over', phase: 'start' });
      event(key, 's', replyMsg(7));
      event(key, 's', { type: 'done', rev: 7, spentUsd: 0 });
      end(key, 's', {});
      if (watch) detach(key, view.sink);
    };
    run(studioStreamKey('acc-a', 'mounted'), true);
    run(studioStreamKey('acc-a', 'away'), false);
    const strip = ({ projectId: _p, before: _b, after, ...rest }: StudioMoment) => ({ ...rest, afterIds: after?.conversation.map((m) => m.id), afterRev: after?.rev });
    const mounted = moments.filter((m) => m.projectId === 'mounted').map(strip);
    const away = moments.filter((m) => m.projectId === 'away').map(strip);
    expect(mounted.map((m) => m.phase)).toEqual(['replied', 'settled']);
    expect(away).toEqual(mounted);
  });

  it('names how the work ended: failed, stopped, lost or busy', () => {
    const outcomeOf = (setup: (key: string) => void) => {
      const key = studioStreamKey('acc-a', `p${moments.length}`);
      begin(key, { streamId: 's', kind: 'action', actionType: 'render_pages', ctrl: new AbortController(), before: makeSampleDoc() });
      setup(key);
      return moments.at(-1);
    };
    expect(outcomeOf((k) => { event(k, 's', { type: 'error', message: 'The model is busy.', code: 'PROVIDER_ERROR' }); end(k, 's', {}); })).toMatchObject({
      phase: 'settled', streamKind: 'action', actionType: 'render_pages', outcome: 'failed', error: { message: 'The model is busy.', code: 'PROVIDER_ERROR' }
    });
    expect(outcomeOf((k) => end(k, 's', { aborted: true }))?.outcome).toBe('stopped');
    // The server never sends an error for a Stop: the stream ends with `done`, as any other. The studio said Stop.
    expect(outcomeOf((k) => { noteStop(k, 'drawing'); event(k, 's', { type: 'done', rev: 5, spentUsd: 0 }); end(k, 's', {}); })?.outcome).toBe('stopped');
    expect(outcomeOf((k) => end(k, 's', { error: 'Connection lost.', lost: true }))?.outcome).toBe('lost');
    expect(outcomeOf((k) => end(k, 's', { error: 'Busy.', code: 'BUSY' }))?.outcome).toBe('busy');
  });

  it('Stop of the director marks only the turn still waiting for its reply; Stop of drawing marks every stream', () => {
    const doc = makeSampleDoc();
    begin(KEY_A, { streamId: 'turn', kind: 'message', ctrl: new AbortController(), before: doc });
    begin(KEY_A, { streamId: 'earlier', kind: 'action', actionType: 'render_pages', ctrl: new AbortController(), before: doc });
    noteStop(KEY_A, 'turn');
    event(KEY_A, 'turn', userMsg(6));
    // A turn that commits its "Stopped." line is not "the Director replied".
    event(KEY_A, 'turn', replyMsg(7, 'a1', 'Stopped.'));
    end(KEY_A, 'turn', {});
    end(KEY_A, 'earlier', {});
    expect(moments.map((m) => [m.streamId, m.phase, m.outcome])).toEqual([
      ['turn', 'settled', 'stopped'],
      ['earlier', 'settled', 'done']
    ]);

    moments.length = 0;
    const key = studioStreamKey('acc-a', 'proj_2');
    begin(key, { streamId: 'replied', kind: 'message', ctrl: new AbortController(), before: doc });
    event(key, 'replied', userMsg(6));
    event(key, 'replied', replyMsg(7));
    begin(key, { streamId: 'render', kind: 'action', actionType: 'render_pages', ctrl: new AbortController(), before: doc });
    noteStop(key, 'drawing');
    end(key, 'replied', {});
    end(key, 'render', {});
    expect(moments.map((m) => [m.streamId, m.phase, m.outcome])).toEqual([
      ['replied', 'replied', undefined],
      ['replied', 'settled', 'stopped'],
      ['render', 'settled', 'stopped']
    ]);
    // A real error after a Stop is still a failure, and a stream begun after the Stop is not stopped.
    begin(key, { streamId: 'late', kind: 'action', ctrl: new AbortController(), before: doc });
    end(key, 'late', {});
    expect(moments.at(-1)).toMatchObject({ streamId: 'late', outcome: 'done' });
  });

  it('a moment listener that throws never breaks the stream', () => {
    const bad = subscribeStudioMoments(() => {
      throw new Error('listener bug');
    });
    const view = recorder();
    startMessage(KEY_A, 's1', makeSampleDoc(), view.sink);
    event(KEY_A, 's1', userMsg(6));
    expect(() => event(KEY_A, 's1', replyMsg(7))).not.toThrow();
    expect(view.events()).toHaveLength(2);
    bad();
  });
});

describe('studioStreams — lifetime', () => {
  it('releases a finished stream: no entry, no mirror, nothing working', () => {
    const view = recorder();
    claim(KEY_A);
    subscribe(KEY_A, view.sink);
    startMessage(KEY_A, 's1', makeSampleDoc(), view.sink);
    expect(workingKeys().has(KEY_A)).toBe(true);
    event(KEY_A, 's1', userMsg(6));
    detach(KEY_A, view.sink);
    expect(__studioStreamsStatsForTests()).toEqual({ entries: 1, streams: 1, mirrors: 1, detached: 1, leftovers: 0 });
    event(KEY_A, 's1', replyMsg(7));
    end(KEY_A, 's1', {});
    expect(__studioStreamsStatsForTests()).toEqual({ entries: 0, streams: 0, mirrors: 0, detached: 0, leftovers: 0 });
    expect(workingKeys().size).toBe(0);
    // Late events for a released stream change nothing.
    event(KEY_A, 's1', replyMsg(8));
    expect(__studioStreamsStatsForTests().entries).toBe(0);
  });

  it('drops the mirror once the last stream ends while a view holds the comic', () => {
    const view = recorder();
    claim(KEY_A);
    subscribe(KEY_A, view.sink);
    startMessage(KEY_A, 's1', makeSampleDoc(), view.sink);
    end(KEY_A, 's1', {});
    expect(__studioStreamsStatsForTests()).toEqual({ entries: 1, streams: 0, mirrors: 0, detached: 0, leftovers: 0 });
    detach(KEY_A, view.sink);
    expect(__studioStreamsStatsForTests().entries).toBe(0);
  });

  it('keeps the newest doc for a view that is still loading when the work ends', () => {
    startMessage(KEY_A);
    event(KEY_A, 's1', userMsg(6));
    claim(KEY_A); // a view mounted and is loading the comic
    event(KEY_A, 's1', replyMsg(7));
    end(KEY_A, 's1', {});
    const snap = subscribe(KEY_A, recorder().sink);
    expect(snap?.streams).toEqual([]);
    expect(snap?.doc?.rev).toBe(7);
  });

  it('holds at most three detached comics: a fourth aborts the oldest', () => {
    const ctrls = ['p1', 'p2', 'p3', 'p4'].map((p) => {
      const key = studioStreamKey('acc-a', p);
      const view = recorder();
      claim(key);
      subscribe(key, view.sink);
      const ctrl = startMessage(key, `s_${p}`, makeSampleDoc(), view.sink);
      detach(key, view.sink);
      return ctrl;
    });
    expect(ctrls.map((c) => c.signal.aborted)).toEqual([true, false, false, false]);
    expect(workingKeys()).toEqual(new Set(['p2', 'p3', 'p4'].map((p) => studioStreamKey('acc-a', p))));
    // The work nobody follows any more still settles, as a lost connection does (the server may finish it).
    expect(moments.map((m) => [m.projectId, m.streamId, m.phase, m.outcome])).toEqual([['p1', 's_p1', 'settled', 'lost']]);
  });

  it('a stream begun while no view holds the comic counts toward the cap', () => {
    const ctrls = ['p1', 'p2', 'p3', 'p4'].map((p) => startMessage(studioStreamKey('acc-a', p), `s_${p}`));
    expect(ctrls.map((c) => c.signal.aborted)).toEqual([true, false, false, false]);
    expect(__studioStreamsStatsForTests().detached).toBe(3);
  });

  it('a comic that is open again is not counted as detached', () => {
    const ctrls = ['p1', 'p2', 'p3', 'p4'].map((p) => {
      const key = studioStreamKey('acc-a', p);
      const view = recorder();
      claim(key);
      subscribe(key, view.sink);
      const ctrl = startMessage(key, `s_${p}`, makeSampleDoc(), view.sink);
      if (p !== 'p1') detach(key, view.sink);
      return ctrl;
    });
    expect(ctrls.some((c) => c.signal.aborted)).toBe(false);
  });

  it('keeps two comics apart', () => {
    const k1 = studioStreamKey('acc-a', 'proj_1');
    const k2 = studioStreamKey('acc-a', 'proj_2');
    startMessage(k1, 's1', makeSampleDoc());
    startMessage(k2, 's2', makeSampleDoc({ id: 'proj_2' }));
    event(k1, 's1', { type: 'delta', msgId: 'a1', text: 'one' });
    event(k2, 's2', { type: 'delta', msgId: 'b1', text: 'two' });
    // An id from one comic never folds into the other.
    event(k1, 's2', { type: 'delta', msgId: 'b1', text: 'stray' });
    claim(k1);
    const one = subscribe(k1, recorder().sink);
    claim(k2);
    const two = subscribe(k2, recorder().sink);
    expect(one?.drafts).toEqual({ a1: 'one' });
    expect(two?.drafts).toEqual({ b1: 'two' });
    expect(one?.streams.map((s) => s.id)).toEqual(['s1']);
    expect(two?.streams.map((s) => s.id)).toEqual(['s2']);
  });

  it('tells subscribers when the set of comics with work changes (useSyncExternalStore)', () => {
    const seen: number[] = [];
    const stop = subscribeStudioStreams(() => void seen.push(workingKeys().size));
    const before = workingKeys();
    startMessage(KEY_A);
    const during = workingKeys();
    expect(during).not.toBe(before);
    expect(workingKeys()).toBe(during); // the same Set until something changes
    end(KEY_A, 's1', {});
    expect(seen).toContain(1);
    expect(seen.at(-1)).toBe(0);
    stop();
  });

  it('lists the comics with work for one account only (the sidebar reads it)', () => {
    startMessage(KEY_A);
    startMessage(studioStreamKey('acc-a', 'proj_2'), 's2');
    startMessage(studioStreamKey('acc-b', 'proj_3'), 's3');
    expect(workingProjectIds(workingKeys(), 'ACC-A')).toEqual(new Set(['proj_1', 'proj_2']));
    expect(workingProjectIds(workingKeys(), 'acc-c').size).toBe(0);
    end(KEY_A, 's1', {});
    expect(workingProjectIds(workingKeys(), 'acc-a')).toEqual(new Set(['proj_2']));
  });

  it('schedules no timer, ever', () => {
    vi.useFakeTimers();
    const view = recorder();
    claim(KEY_A);
    subscribe(KEY_A, view.sink);
    startMessage(KEY_A, 's1', makeSampleDoc(), view.sink);
    event(KEY_A, 's1', userMsg(6));
    detach(KEY_A, view.sink);
    event(KEY_A, 's1', replyMsg(7));
    claim(KEY_A);
    subscribe(KEY_A, recorder().sink);
    end(KEY_A, 's1', {});
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('studioStreams — what a turn leaves when it ends with nobody watching', () => {
  const note = (id: string, text: string) => ({ id, text, at: 1 });
  /** A view sends a message, leaves, and the stream ends while no view holds the comic. */
  const sendAndLeave = (pending: PendingUserMessage, ending: (key: string) => void, key = KEY_A) => {
    const view = recorder();
    claim(key);
    subscribe(key, view.sink);
    begin(key, { streamId: 's1', kind: 'message', ctrl: new AbortController(), before: makeSampleDoc(), sink: view.sink, pending });
    detach(key, view.sink);
    ending(key);
  };
  const bubble = (over: Partial<PendingUserMessage> = {}): PendingUserMessage => ({
    id: 'pending_1',
    text: 'Plan a rooftop chase',
    attachments: [],
    at: 1,
    status: 'sending',
    streamId: 's1',
    ...over
  });

  it('keeps the failed bubble with the creator’s words for the next view, once', () => {
    sendAndLeave(bubble(), (k) => {
      event(k, 's1', { type: 'error', message: 'Wait a moment before sending again.', code: 'COOLDOWN' });
      event(k, 's1', { type: 'done', rev: 5, spentUsd: 0 });
      end(k, 's1', {});
    });
    expect(workingKeys().size).toBe(0);
    expect(__studioStreamsStatsForTests()).toMatchObject({ entries: 1, streams: 0, mirrors: 0, leftovers: 1 });
    claim(KEY_A);
    const snap = subscribe(KEY_A, recorder().sink);
    expect(snap?.pendingMessage).toMatchObject({ text: 'Plan a rooftop chase', status: 'failed', code: 'COOLDOWN' });
    expect(snap?.streams).toEqual([]);
    // Handed over once: the view that shows it owns it now.
    detach(KEY_A);
    expect(__studioStreamsStatsForTests().entries).toBe(0);
    claim(KEY_A);
    expect(subscribe(KEY_A, recorder().sink)).toBeNull();
  });

  it('keeps the notes a BUSY answer put back, never a failed bubble', () => {
    const notes = [note('n1', 'Make it rain'), note('n2', 'And a cat')];
    sendAndLeave(bubble({ requeue: { notes, at: 'head' } }), (k) => {
      event(k, 's1', { type: 'error', message: 'Another tab is working on this comic.', code: 'BUSY' });
      end(k, 's1', {});
    });
    expect(moments.at(-1)?.outcome).toBe('busy');
    claim(KEY_A);
    const snap = subscribe(KEY_A, recorder().sink);
    expect(snap?.notes.map((n) => n.text)).toEqual(['Make it rain', 'And a cat']);
    expect(snap?.pendingMessage).toBeNull();
    detach(KEY_A);
    claim(KEY_A);
    const again = subscribe(KEY_A, recorder().sink);
    expect(again?.notes ?? []).toEqual([]);
    expect(again?.pendingMessage ?? null).toBeNull();
  });

  it('hands the notes, the failed bubble and the error over once, also while other work keeps running', () => {
    const notes = [note('n1', 'Make it rain')];
    sendAndLeave(bubble({ requeue: { notes, at: 'tail' } }), (k) => {
      begin(k, { streamId: 'r1', kind: 'action', actionType: 'render_pages', ctrl: new AbortController(), before: makeSampleDoc() });
      event(k, 's1', { type: 'error', message: 'Another tab is working on this comic.', code: 'BUSY' });
      end(k, 's1', {});
      event(k, 'r1', { type: 'error', message: 'The image model is busy.', code: 'PROVIDER_ERROR' });
    });
    const second = studioStreamKey('acc-a', 'proj_2');
    sendAndLeave(bubble(), (k) => {
      begin(k, { streamId: 'r2', kind: 'action', ctrl: new AbortController(), before: makeSampleDoc() });
      event(k, 's1', { type: 'error', message: 'Wait a moment.', code: 'COOLDOWN' });
      end(k, 's1', {});
    }, second);
    claim(KEY_A);
    const first = subscribe(KEY_A, recorder().sink);
    expect(first?.notes.map((n) => n.id)).toEqual(['n1']);
    expect(first?.error?.code).toBe('PROVIDER_ERROR');
    expect(first?.streams.map((s) => s.id)).toEqual(['r1']);
    claim(second);
    expect(subscribe(second, recorder().sink)?.pendingMessage?.status).toBe('failed');
    // Leave both again (their drawings still run) and come back: nothing is offered twice.
    detach(KEY_A);
    detach(second);
    claim(KEY_A);
    const again = subscribe(KEY_A, recorder().sink);
    expect(again?.streams.map((s) => s.id)).toEqual(['r1']);
    expect(again?.notes).toEqual([]);
    expect(again?.error).toBeNull();
    claim(second);
    expect(subscribe(second, recorder().sink)?.pendingMessage).toBeNull();
  });

  it('keeps the error a drawing hit while nobody watched', () => {
    claim(KEY_A);
    const view = recorder();
    subscribe(KEY_A, view.sink);
    begin(KEY_A, { streamId: 'r1', kind: 'action', actionType: 'render_pages', ctrl: new AbortController(), before: makeSampleDoc(), sink: view.sink });
    detach(KEY_A, view.sink);
    event(KEY_A, 'r1', { type: 'error', message: 'The image model is busy.', code: 'PROVIDER_ERROR' });
    end(KEY_A, 'r1', {});
    claim(KEY_A);
    expect(subscribe(KEY_A, recorder().sink)?.error).toEqual({ message: 'The image model is busy.', code: 'PROVIDER_ERROR' });
  });

  it('an error the view already showed is not shown again by the next one', () => {
    const view = recorder();
    claim(KEY_A);
    subscribe(KEY_A, view.sink);
    begin(KEY_A, { streamId: 'r1', kind: 'action', ctrl: new AbortController(), before: makeSampleDoc(), sink: view.sink });
    begin(KEY_A, { streamId: 'r2', kind: 'action', ctrl: new AbortController(), before: makeSampleDoc(), sink: view.sink });
    // An error event the view was handed (its stream still open)…
    event(KEY_A, 'r1', { type: 'error', message: 'The image model is busy.', code: 'PROVIDER_ERROR' });
    expect(view.actions.some((a) => a.type === 'stream_event' && a.event.type === 'error')).toBe(true);
    detach(KEY_A, view.sink);
    const next = recorder();
    claim(KEY_A);
    expect(subscribe(KEY_A, next.sink)?.error ?? null).toBeNull();
    // …and a stream that ended with an error while a view held it.
    end(KEY_A, 'r1', { error: 'The connection dropped.', code: 'connection_lost', lost: true });
    expect(next.actions.at(-1)).toMatchObject({ type: 'stream_end', streamId: 'r1', error: 'The connection dropped.' });
    detach(KEY_A, next.sink);
    claim(KEY_A);
    expect(subscribe(KEY_A, recorder().sink)?.error ?? null).toBeNull();
  });

  it('a successful turn leaves nothing behind', () => {
    sendAndLeave(bubble(), (k) => {
      event(k, 's1', userMsg(6));
      event(k, 's1', replyMsg(7));
      end(k, 's1', {});
    });
    expect(__studioStreamsStatsForTests().entries).toBe(0);
  });

  it('what is left counts toward the three comics held, and goes with the account', () => {
    for (const p of ['p1', 'p2', 'p3']) {
      sendAndLeave(bubble(), (k) => {
        event(k, 's1', { type: 'error', message: 'Wait a moment.', code: 'COOLDOWN' });
        end(k, 's1', {});
      }, studioStreamKey('acc-a', p));
    }
    expect(__studioStreamsStatsForTests().leftovers).toBe(3);
    const live = startMessage(studioStreamKey('acc-a', 'p4'), 's4');
    expect(live.signal.aborted).toBe(false);
    expect(__studioStreamsStatsForTests().leftovers).toBe(2);
    claim(studioStreamKey('acc-a', 'p1'));
    expect(subscribe(studioStreamKey('acc-a', 'p1'), recorder().sink)).toBeNull();
    noteStudioAccount('acc-a');
    noteStudioAccount('acc-b');
    expect(__studioStreamsStatsForTests()).toMatchObject({ entries: 0, leftovers: 0 });
  });
});

describe('studioStreams — accounts (shared devices)', () => {
  it('a claim under another account aborts and drops every entry of the old one', () => {
    const view = recorder();
    const ctrl = startMessage(KEY_A, 's1', makeSampleDoc(), view.sink);
    event(KEY_A, 's1', userMsg(6));
    claim(studioStreamKey('acc-b', 'proj_9'));
    expect(ctrl.signal.aborted).toBe(true);
    // A view of the old account still mounted is told its stream ended.
    expect(view.actions.at(-1)).toMatchObject({ type: 'stream_end', streamId: 's1', aborted: true });
    expect(workingKeys().size).toBe(0);
    // The old account's events never reach anyone again.
    event(KEY_A, 's1', replyMsg(7));
    expect(moments.filter((m) => m.accountId === 'acc-a')).toEqual([]);
  });

  it('signing out aborts every stream; a token refresh of the same account changes nothing', () => {
    noteStudioAccount('ACC-A');
    const a = startMessage(KEY_A);
    noteStudioAccount('acc-a');
    expect(a.signal.aborted).toBe(false);
    noteStudioAccount(null);
    expect(a.signal.aborted).toBe(true);
    expect(__studioStreamsStatsForTests().entries).toBe(0);
  });

  it('another account signing in on this tab aborts the old account only', () => {
    noteStudioAccount('acc-a');
    const a = startMessage(KEY_A);
    const b = startMessage(studioStreamKey('acc-b', 'proj_2'), 's2');
    noteStudioAccount('acc-b');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
  });

  it('abortAllStudioStreams stops everything', () => {
    const a = startMessage(KEY_A);
    const b = startMessage(studioStreamKey('acc-a', 'proj_2'), 's2');
    abortAllStudioStreams();
    expect([a.signal.aborted, b.signal.aborted]).toEqual([true, true]);
    expect(__studioStreamsStatsForTests().entries).toBe(0);
  });
});
