// useStudio — the Director's turn survives in-app navigation (liveturn LT-2). Leaving the comic (Settings, My comics,
// Chat, another comic) unmounts the studio; its message and action streams are handed to the module-scope registry
// (live/studioStreams.ts) instead of being aborted, and the studio that mounts for the same comic later adopts them:
// the step list, the reply so far and "Thinking…" come back, and the rest streams in, nothing lost or twice.
//
// A fake server: streams stay open until the test closes them, and the doc the GET returns follows every commit, as
// the real session does.

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { StreamRequest, StudioEvent } from '../../shared/comic/events';
import type { ComicDoc } from '../../shared/comic/doc';
import { applyOps, type DocOp } from '../../shared/comic/ops';
import { DEFAULT_CAPS, type StudioCaps } from '../../shared/comic/capabilities';
import { makeSampleDoc } from './conversation/testing/fixtures';

const api = vi.hoisted(() => ({
  loadStudioProject: vi.fn(),
  streamStudio: vi.fn(),
  signStudioUrls: vi.fn(),
  cancelStudio: vi.fn()
}));

vi.mock('./studioApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./studioApi')>();
  return { ...real, ...api };
});

// The signed-in account (read, never changed) and the auth events the page hears.
const auth = vi.hoisted(() => ({
  user: { id: 'acc-a' } as { id: string } | null,
  listeners: [] as Array<(event: string, session: { user?: { id: string } } | null) => void>
}));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: auth.user }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => children
}));

vi.mock('../../services/supabase', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../services/supabase')>();
  const fakeAuth = {
    onAuthStateChange: (cb: (event: string, session: { user?: { id: string } } | null) => void) => {
      auth.listeners.push(cb);
      return { data: { subscription: { unsubscribe: () => undefined } } };
    },
    getSession: async () => ({ data: { session: null } })
  };
  return { ...real, supabase: new Proxy(real.supabase, { get: (target, prop) => (prop === 'auth' ? fakeAuth : Reflect.get(target, prop)) }) };
});

import { StudioApiError } from './studioApi';
import { useStudio, type ComicStudioController } from './useStudio';
import { __resetStudioStreamsForTests, subscribeStudioMoments, type StudioMoment } from './live/studioStreams';

interface FakeStream {
  projectId: string;
  req: StreamRequest;
  emit: (e: StudioEvent) => void;
  signal?: AbortSignal;
  resolve: () => void;
}

let streams: FakeStream[] = [];
/** What the server holds, per comic (the GET answers with it). */
const server = new Map<string, ComicDoc>();
let moments: StudioMoment[] = [];
let stopMoments = () => undefined as void;

const QUEUE_ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: true, steer: false, conflicts: false } };

const docFor = (projectId: string): ComicDoc => {
  let doc = server.get(projectId);
  if (!doc) {
    // No render running, so nothing but the streams under test is in flight.
    const sample = makeSampleDoc({ id: projectId });
    doc = { ...sample, style: { ...sample.style, options: sample.style.options.map((o) => ({ ...o, render: { ...o.render, status: 'ready' as const } })) } };
    server.set(projectId, doc);
  }
  return doc;
};

/** The server commits ops on a comic and every open stream of that comic hears them. */
const commit = (s: FakeStream, ops: DocOp[], extra: Partial<Extract<StudioEvent, { type: 'ops' }>> = {}) => {
  const doc = docFor(s.projectId);
  const rev = doc.rev + 1;
  server.set(s.projectId, { ...applyOps(doc, ops, rev), rev });
  act(() => s.emit({ type: 'ops', rev, ops, ...extra }));
  return rev;
};
const emit = (s: FakeStream, e: StudioEvent) => act(() => s.emit(e));
const userMessage = (s: FakeStream, id = 'u1') => commit(s, [{ op: 'message', msg: { id, role: 'user', text: s.req.kind === 'message' ? s.req.text : '', at: 1 } }]);
const reply = (s: FakeStream, id = 'a1', text = 'Here is the plan: six pages, the chase ends on the roof.') =>
  commit(s, [{ op: 'message', msg: { id, role: 'assistant', text, at: 2 } }]);
const close = async (s: FakeStream) => {
  emit(s, { type: 'done', rev: docFor(s.projectId).rev, spentUsd: 0 });
  await act(async () => s.resolve());
};

const mount = async (projectId = 'proj_1', caps: StudioCaps | null = null) => {
  api.loadStudioProject.mockImplementation(async (id: string) => ({ doc: docFor(id), urls: {}, ...(caps ? { caps } : {}) }));
  const hook = renderHook(({ id }) => useStudio(id), { initialProps: { id: projectId } });
  await waitFor(() => expect(hook.result.current.doc?.id).toBe(projectId));
  return hook;
};

/** Send, and let the server take the message and start working (two steps; the second is still running). */
const startTurn = (result: { current: ComicStudioController }, projectId = 'proj_1') => {
  act(() => void result.current.send('Plan a rooftop chase'));
  const s = streams[streams.length - 1];
  expect(s.projectId).toBe(projectId);
  emit(s, { type: 'hello', rev: docFor(projectId).rev, turnId: `turn_${projectId}` });
  userMessage(s);
  emit(s, { type: 'activity', id: 'read', label: 'Reading your brief', phase: 'start' });
  emit(s, { type: 'activity', id: 'read', label: 'Reading your brief', phase: 'end', ok: true });
  emit(s, { type: 'activity', id: 'plan', label: 'Planning the pages', phase: 'start' });
  return s;
};

beforeEach(() => {
  __resetStudioStreamsForTests();
  streams = [];
  server.clear();
  auth.user = { id: 'acc-a' };
  moments = [];
  stopMoments = subscribeStudioMoments((m) => void moments.push(m));
  api.loadStudioProject.mockReset();
  api.signStudioUrls.mockReset().mockResolvedValue({});
  api.cancelStudio.mockReset().mockResolvedValue(undefined);
  api.streamStudio.mockReset().mockImplementation(
    (projectId: string, req: StreamRequest, onEvent: (e: StudioEvent) => void, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        streams.push({ projectId, req, emit: onEvent, signal, resolve });
        signal?.addEventListener('abort', () => reject(new StudioApiError('aborted', 'Cancelled.')));
      })
  );
});

afterEach(() => {
  stopMoments();
  vi.restoreAllMocks();
});

describe('useStudio — leaving a comic mid-turn and coming back', () => {
  it('keeps the turn running, then restores busy, the steps and the reply so far; the rest streams in once, in order', async () => {
    const first = await mount();
    const s = startTurn(first.result);
    emit(s, { type: 'delta', msgId: 'a1', text: 'Here is ' });
    expect(first.result.current.drafts.a1).toBe('Here is ');
    first.unmount();
    expect(s.signal?.aborted).toBe(false);

    // While away: one step finishes, another starts, the reply keeps streaming.
    emit(s, { type: 'activity', id: 'plan', label: 'Planning the pages', phase: 'end', ok: true });
    emit(s, { type: 'activity', id: 'cast', label: 'Checking the cast', phase: 'start' });
    emit(s, { type: 'delta', msgId: 'a1', text: 'the plan: ' });

    const back = await mount();
    const studio = back.result;
    await waitFor(() => expect(studio.current.messageBusy).toBe(true));
    expect(studio.current.busy).toBe(true);
    expect(studio.current.drafts).toEqual({ a1: 'Here is the plan: ' });
    expect(studio.current.activity.map((a) => [a.id, a.phase])).toEqual([
      ['read', 'end'],
      ['plan', 'end'],
      ['cast', 'start']
    ]);
    expect(studio.current.doc?.conversation.map((m) => m.id)).toEqual(['u1']);

    emit(s, { type: 'delta', msgId: 'a1', text: 'six pages.' });
    expect(studio.current.drafts.a1).toBe('Here is the plan: six pages.');
    reply(s);
    await close(s);
    expect(studio.current.messageBusy).toBe(false);
    expect(studio.current.busy).toBe(false);
    expect(studio.current.drafts).toEqual({});
    expect(studio.current.activity).toEqual([]);
    expect(studio.current.doc?.conversation.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(moments.map((m) => [m.projectId, m.phase])).toEqual([
      ['proj_1', 'replied'],
      ['proj_1', 'settled']
    ]);
  });

  it('shows the reply that landed while the comic was loading again, without a refetch', async () => {
    const first = await mount();
    const s = startTurn(first.result);
    first.unmount();
    // The GET for the comic opening again is answered before the reply lands; the reply arrives before it resolves.
    let resolveLoad: (v: unknown) => void = () => undefined;
    const stale = docFor('proj_1');
    api.loadStudioProject.mockImplementation(() => new Promise((r) => (resolveLoad = r)));
    const back = renderHook(() => useStudio('proj_1'));
    reply(s);
    await act(async () => resolveLoad({ doc: stale, urls: {} }));
    await waitFor(() => expect(back.result.current.doc).not.toBeNull());
    expect(back.result.current.doc?.conversation.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(back.result.current.messageBusy).toBe(false);
    await close(s);
    expect(api.loadStudioProject).toHaveBeenCalledTimes(2);
  });

  it('comic → Settings → Back: the same turn, still live', async () => {
    api.loadStudioProject.mockImplementation(async (id: string) => ({ doc: docFor(id), urls: {} }));
    let studio: ComicStudioController | null = null;
    const Studio = () => {
      studio = useStudio('proj_1');
      return null;
    };
    const Shell = ({ view }: { view: 'comic' | 'settings' }) => (view === 'comic' ? <Studio /> : <p>Settings</p>);
    const app = render(<Shell view="comic" />);
    await waitFor(() => expect(studio?.doc).not.toBeNull());
    const s = startTurn({ get current() { return studio!; } });
    app.rerender(<Shell view="settings" />);
    expect(s.signal?.aborted).toBe(false);
    emit(s, { type: 'activity', id: 'plan', label: 'Planning the pages', phase: 'end', ok: true });
    studio = null;
    app.rerender(<Shell view="comic" />);
    await waitFor(() => expect(studio?.messageBusy).toBe(true));
    expect(studio!.activity.map((a) => a.phase)).toEqual(['end', 'end']);
    reply(s);
    await close(s);
    expect(studio!.messageBusy).toBe(false);
    expect(studio!.doc?.conversation.map((m) => m.id)).toEqual(['u1', 'a1']);
  });

  it('Stop after coming back stops the adopted turn on the server and ends "Stopping…" when it closes', async () => {
    const first = await mount();
    const s = startTurn(first.result);
    first.unmount();
    const back = await mount();
    await waitFor(() => expect(back.result.current.messageBusy).toBe(true));
    await act(async () => back.result.current.cancel());
    expect(api.cancelStudio).toHaveBeenCalledWith('proj_1');
    expect(back.result.current.cancelling).toBe(true);
    emit(s, { type: 'error', code: 'CANCELLED', message: 'Stopped.' });
    await act(async () => s.resolve());
    expect(back.result.current.cancelling).toBe(false);
    expect(back.result.current.messageBusy).toBe(false);
  });

  it('a note typed while the adopted turn runs waits in Up next as turn-locked, never as another device', async () => {
    const first = await mount('proj_1', QUEUE_ON);
    startTurn(first.result);
    first.unmount();
    const back = await mount('proj_1', QUEUE_ON);
    await waitFor(() => expect(back.result.current.messageBusy).toBe(true));
    let outcome: unknown;
    await act(async () => {
      outcome = await back.result.current.send('And make it rain');
    });
    expect(outcome).toBe('queued');
    expect(back.result.current.queue?.map((n) => n.text)).toEqual(['And make it rain']);
    expect(back.result.current.queueHold).toBeNull();
    // Nothing else was sent: the adopted turn holds the server's turn lock.
    expect(api.streamStudio).toHaveBeenCalledTimes(1);
  });

  it('with the queue off, a send while the adopted turn runs is refused instead of racing it', async () => {
    const first = await mount();
    startTurn(first.result);
    first.unmount();
    const back = await mount();
    await waitFor(() => expect(back.result.current.messageBusy).toBe(true));
    let outcome: unknown;
    await act(async () => {
      outcome = await back.result.current.send('One more thing');
    });
    expect(outcome).toBe('refused');
    expect(api.streamStudio).toHaveBeenCalledTimes(1);
  });
});

describe('useStudio — several comics', () => {
  it('leaving for another comic: the first keeps working and still says when it replied and settled', async () => {
    const first = await mount('proj_1');
    const s1 = startTurn(first.result, 'proj_1');
    first.unmount();
    const second = await mount('proj_2');
    expect(second.result.current.messageBusy).toBe(false);
    expect(second.result.current.drafts).toEqual({});
    reply(s1);
    await close(s1);
    expect(moments.map((m) => [m.projectId, m.phase, m.streamKind])).toEqual([
      ['proj_1', 'replied', 'message'],
      ['proj_1', 'settled', 'message']
    ]);
    expect(moments[1].after?.conversation.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(second.result.current.doc?.conversation).toEqual([]);
  });

  it('two comics streaming at once stay apart', async () => {
    const first = await mount('proj_1');
    const s1 = startTurn(first.result, 'proj_1');
    emit(s1, { type: 'delta', msgId: 'a1', text: 'Roof chase. ' });
    first.unmount();
    const second = await mount('proj_2');
    const s2 = startTurn(second.result, 'proj_2');
    emit(s2, { type: 'delta', msgId: 'a1', text: 'Lake mystery. ' });
    emit(s1, { type: 'delta', msgId: 'a1', text: 'Six pages.' });
    expect(second.result.current.drafts).toEqual({ a1: 'Lake mystery. ' });
    second.unmount();
    const again = await mount('proj_1');
    await waitFor(() => expect(again.result.current.messageBusy).toBe(true));
    expect(again.result.current.drafts).toEqual({ a1: 'Roof chase. Six pages.' });
    expect(again.result.current.activity.map((a) => a.id)).toEqual(['read', 'plan']);
    expect(s2.signal?.aborted).toBe(false);
  });

  it('a fourth comic left mid-turn aborts the oldest one (the server keeps working on it)', async () => {
    const started: FakeStream[] = [];
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      const hook = await mount(id);
      started.push(startTurn(hook.result, id));
      hook.unmount();
    }
    expect(started.map((s) => s.signal?.aborted)).toEqual([true, false, false, false]);
  });

  it('signing out aborts the turns left running', async () => {
    for (const cb of auth.listeners) cb('SIGNED_IN', { user: { id: 'acc-a' } });
    const first = await mount();
    const s = startTurn(first.result);
    first.unmount();
    expect(s.signal?.aborted).toBe(false);
    for (const cb of auth.listeners) cb('SIGNED_OUT', null);
    expect(s.signal?.aborted).toBe(true);
  });

  it('another account opening a comic on this device never sees the first account’s turn', async () => {
    const first = await mount();
    const s = startTurn(first.result);
    emit(s, { type: 'delta', msgId: 'a1', text: 'Private words' });
    first.unmount();
    auth.user = { id: 'acc-b' };
    const other = await mount();
    expect(s.signal?.aborted).toBe(true);
    expect(other.result.current.messageBusy).toBe(false);
    expect(other.result.current.drafts).toEqual({});
  });
});
