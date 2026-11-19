import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../../shared/comic/events';
import type { ComicDoc } from '../../../shared/comic/doc';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import type { StudioReducerAction } from '../studioReducer';
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
    expect(outcomeOf((k) => { event(k, 's', { type: 'error', message: 'Stopped.', code: 'CANCELLED' }); end(k, 's', {}); })?.outcome).toBe('stopped');
    expect(outcomeOf((k) => end(k, 's', { error: 'Connection lost.', lost: true }))?.outcome).toBe('lost');
    expect(outcomeOf((k) => end(k, 's', { error: 'Busy.', code: 'BUSY' }))?.outcome).toBe('busy');
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
    expect(__studioStreamsStatsForTests()).toEqual({ entries: 1, streams: 1, mirrors: 1, detached: 1 });
    event(KEY_A, 's1', replyMsg(7));
    end(KEY_A, 's1', {});
    expect(__studioStreamsStatsForTests()).toEqual({ entries: 0, streams: 0, mirrors: 0, detached: 0 });
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
    expect(__studioStreamsStatsForTests()).toEqual({ entries: 1, streams: 0, mirrors: 0, detached: 0 });
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
