// useStudio — the live message queue, "Up next" (agent-editor plan §3 A1; lead decisions D1, D2).
// A fake server whose streams stay open until the test closes them, so a director turn can be "running".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { StreamRequest, StudioEvent } from '../../shared/comic/events';
import type { Card } from '../../shared/comic/doc';
import { DEFAULT_CAPS, type StudioCaps } from '../../shared/comic/capabilities';
import { makeSampleDoc } from './conversation/testing/fixtures';
import { QUEUE_PREFIX, QUEUE_STORAGE_PREFIX } from './messageQueue';

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

import { StudioApiError } from './studioApi';
import { useStudio, type UseStudioDeps } from './useStudio';

interface FakeStream {
  req: StreamRequest;
  emit: (e: StudioEvent) => void;
  resolve: () => void;
}

let streams: FakeStream[] = [];
let rev = 5;
let msgSeq = 0;

const QUEUE_ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: true, steer: false, conflicts: false } };
const STEER_ON: StudioCaps = { ...DEFAULT_CAPS, liveAgent: { queue: true, steer: true, conflicts: false } };

const setup = async (caps: StudioCaps | null = QUEUE_ON, deps: UseStudioDeps = {}) => {
  api.loadStudioProject.mockResolvedValue({ doc: makeSampleDoc(), urls: {}, ...(caps ? { caps } : {}) });
  const hook = renderHook(({ id }) => useStudio(id, deps), { initialProps: { id: 'proj_1' } });
  await waitFor(() => expect(hook.result.current.doc).not.toBeNull());
  return hook;
};

const messages = () => streams.filter((s) => s.req.kind === 'message');
const lastStream = () => streams[streams.length - 1];
const textOf = (s: FakeStream) => (s.req.kind === 'message' ? s.req.text : undefined);
const emit = (s: FakeStream, e: StudioEvent) => act(() => s.emit(e));
const close = async (s: FakeStream) => {
  emit(s, { type: 'done', rev, spentUsd: 0 });
  await act(async () => s.resolve());
};
/** The server records the user's message, then the director's reply lands (the stream may stay open for renders). */
const reply = (s: FakeStream, text = 'Done.', cards?: Card[]) => {
  rev += 1;
  emit(s, { type: 'ops', rev, ops: [{ op: 'message', msg: { id: `u_${(msgSeq += 1)}`, role: 'user', text: textOf(s) || '', at: rev } }] });
  rev += 1;
  emit(s, { type: 'ops', rev, ops: [{ op: 'message', msg: { id: `a_${(msgSeq += 1)}`, role: 'assistant', text, at: rev, ...(cards ? { cards } : {}) } }] });
};
/** The server refuses in-stream with BUSY (another tab or device holds the turn), then closes. */
const busy = async (s: FakeStream) => {
  emit(s, { type: 'error', code: 'BUSY', message: "I'm still working on your last message — wait for it to finish, or press stop." });
  await act(async () => s.resolve());
};

beforeEach(() => {
  streams = [];
  rev = 5;
  msgSeq = 0;
  window.sessionStorage.clear();
  api.loadStudioProject.mockReset();
  api.signStudioUrls.mockReset().mockResolvedValue({});
  api.cancelStudio.mockReset().mockResolvedValue(undefined);
  api.streamStudio.mockReset().mockImplementation(
    (_id: string, req: StreamRequest, onEvent: (e: StudioEvent) => void, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        streams.push({ req, emit: onEvent, resolve });
        signal?.addEventListener('abort', () => reject(new StudioApiError('aborted', 'Cancelled.')));
      })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('send() while the director works', () => {
  it("returns 'queued' and the queue holds the note — nothing is dropped and no second turn starts", async () => {
    const { result } = await setup();
    let first: unknown;
    await act(async () => {
      first = await result.current.send('draw the rooftop');
    });
    expect(first).toBe('sent');
    expect(result.current.turnLocked).toBe(true);

    let second: unknown;
    await act(async () => {
      second = await result.current.send('  and make it rain  ');
    });
    expect(second).toBe('queued');
    expect(result.current.queue?.map((n) => n.text)).toEqual(['and make it rain']);
    expect(messages()).toHaveLength(1);
  });

  it("with the queue off it is 'refused' and nothing else changes (no queue, no second request)", async () => {
    const { result } = await setup(null);
    act(() => void result.current.send('draw the rooftop'));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send('and make it rain');
    });
    expect(outcome).toBe('refused');
    expect(result.current.queue).toBeUndefined();
    expect(result.current.sendNow).toBeUndefined();
    expect(messages()).toHaveLength(1);
    expect(result.current.notice ?? null).toBeNull();
  });

  it('notes that cannot wait (inline files, a card answer, a full queue) are refused with visible words', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send('', [{ name: 'script.txt', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,SGk=' }]);
    });
    expect(outcome).toBe('refused');
    expect(result.current.notice?.text).toMatch(/can’t wait in Up next/);
    for (let i = 0; i < 10; i += 1) await act(async () => void (await result.current.send(`note ${i}`)));
    await act(async () => {
      outcome = await result.current.send('the eleventh');
    });
    expect(outcome).toBe('refused');
    expect(result.current.notice?.text).toMatch(/Up next is full \(10 notes\)/);
    expect(result.current.queue).toHaveLength(10);
  });
});

describe('the drain (D1)', () => {
  it('when the reply lands, exactly one request goes out with the combined text', async () => {
    const { result } = await setup();
    act(() => void result.current.send('draw the rooftop'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('make it rain')));
    await act(async () => void (await result.current.send('add a cat')));
    expect(messages()).toHaveLength(1);

    reply(s1, 'Drawing the rooftop.');
    await waitFor(() => expect(messages()).toHaveLength(2));
    expect(lastStream().req).toEqual({ kind: 'message', text: `${QUEUE_PREFIX}\n1. make it rain\n2. add a cat` });
    expect(result.current.queue).toEqual([]);
    // The first stream still carries its renders; still one drained request, not one per note.
    await close(s1);
    expect(messages()).toHaveLength(2);
  });

  it('notes about different pages drain as separate turns, in order, each with its own focus', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('darker sky', { focus: { pageId: 'pg_2' } })));
    await act(async () => void (await result.current.send('bigger title', { focus: { pageId: 'pg_1' } })));
    reply(s1);
    await waitFor(() => expect(messages()).toHaveLength(2));
    const s2 = lastStream();
    expect(s2.req).toEqual({ kind: 'message', text: `${QUEUE_PREFIX} darker sky`, focus: { pageId: 'pg_2' } });
    expect(result.current.queue?.map((n) => n.text)).toEqual(['bigger title']);
    reply(s2);
    await waitFor(() => expect(messages()).toHaveLength(3));
    expect(lastStream().req).toEqual({ kind: 'message', text: `${QUEUE_PREFIX} bigger title`, focus: { pageId: 'pg_1' } });
  });

  it('BUSY on a drained note puts it back at the head of Up next — never a failed bubble — and "Try again" re-sends it', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('make it rain')));
    reply(s1);
    await waitFor(() => expect(messages()).toHaveLength(2));
    // Meanwhile another note is queued behind the drained one.
    await act(async () => void (await result.current.send('add a cat')));

    await busy(lastStream());
    expect(result.current.pendingMessage).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.queue?.map((n) => n.text)).toEqual(['make it rain', 'add a cat']);
    expect(result.current.queueHold).toBe('elsewhere');
    expect(messages()).toHaveLength(2);

    act(() => result.current.releaseQueue?.());
    await waitFor(() => expect(messages()).toHaveLength(3));
    expect(textOf(lastStream())).toBe(`${QUEUE_PREFIX}\n1. make it rain\n2. add a cat`);
  });

  it('after BUSY it retries on its own a few times, spaced out, then waits for a tap', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('make it rain')));
    vi.useFakeTimers();
    reply(s1);
    await act(async () => undefined);
    expect(messages()).toHaveLength(2);
    for (const [i, wait] of [8_000, 20_000, 45_000].entries()) {
      await busy(lastStream());
      expect(result.current.queueRetriesLeft).toBe(true);
      await act(async () => void vi.advanceTimersByTime(wait - 1));
      expect(messages()).toHaveLength(2 + i);
      await act(async () => void vi.advanceTimersByTime(1));
      expect(messages()).toHaveLength(3 + i);
    }
    await busy(lastStream());
    expect(result.current.queueRetriesLeft).toBe(false);
    await act(async () => void vi.advanceTimersByTime(120_000));
    expect(messages()).toHaveLength(5);
    expect(result.current.queue?.map((n) => n.text)).toEqual(['make it rain']);
  });

  it('a message sent straight from the composer that meets BUSY (another tab) waits in Up next instead of failing', async () => {
    const { result } = await setup();
    act(() => void result.current.send('hello from this tab'));
    await busy(lastStream());
    expect(result.current.pendingMessage).toBeNull();
    expect(result.current.queue?.map((n) => n.text)).toEqual(['hello from this tab']);
    expect(result.current.queueHold).toBe('elsewhere');
  });
});

describe('holds', () => {
  it('holds while the last reply has an unanswered options card; "Send anyway" sends it', async () => {
    const { result } = await setup();
    act(() => void result.current.send('make a cover'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('and a back cover')));
    reply(s1, 'Which mood?', [{ type: 'options', id: 'card_mood', question: 'Which mood?', choices: [{ id: 'm1', label: 'Moody' }] }]);
    await close(s1);
    expect(messages()).toHaveLength(1);
    expect(result.current.queueHold).toBe('question');
    expect(result.current.queue).toHaveLength(1);

    act(() => result.current.releaseQueue?.());
    await waitFor(() => expect(messages()).toHaveLength(2));
    expect(textOf(lastStream())).toBe(`${QUEUE_PREFIX} and a back cover`);
  });

  it('holds while a spend gate is open', async () => {
    const { result } = await setup();
    act(() => void result.current.send('draw it'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('then a cat')));
    rev += 1;
    const gate = { id: 'g1', action: { type: 'render_cover' as const }, title: 'Draw the cover', summary: '', estimateUsd: 0.07, imageCount: 1, model: 'm', createdAt: 1, status: 'open' as const, reason: 'policy' as const };
    emit(s1, { type: 'ops', rev, ops: [{ op: 'gate', gate }] });
    reply(s1, 'Approve the cover?');
    await close(s1);
    expect(result.current.queueHold).toBe('gate');
    expect(messages()).toHaveLength(1);
  });

  it('Stop holds the notes ("Stopped. 1 note is waiting") until the creator sends them', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('make it rain')));
    await act(async () => result.current.cancel());
    expect(api.cancelStudio).toHaveBeenCalled();
    reply(s1, 'Stopped.');
    await close(s1);
    expect(result.current.queueHold).toBe('stopped');
    expect(messages()).toHaveLength(1);

    act(() => result.current.releaseQueue?.());
    await waitFor(() => expect(messages()).toHaveLength(2));
    expect(result.current.queue).toEqual([]);
  });

  it('plan_pages holds the turn lock: a message queues instead of meeting BUSY, and goes once the plan is in', async () => {
    const { result } = await setup();
    act(() => void result.current.act({ type: 'plan_pages' } as never));
    const plan = lastStream();
    expect(result.current.turnLocked).toBe(true);
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.send('use six pages');
    });
    expect(outcome).toBe('queued');
    expect(result.current.queueHold).toBe('plan_pages');
    expect(messages()).toHaveLength(0);
    await close(plan);
    await waitFor(() => expect(messages()).toHaveLength(1));
    expect(textOf(lastStream())).toBe(`${QUEUE_PREFIX} use six pages`);
  });

  it('a reload brings saved notes back held — never sent on their own — and "Send" sends them', async () => {
    window.sessionStorage.setItem(QUEUE_STORAGE_PREFIX + 'proj_1', JSON.stringify({ v: 1, notes: [{ id: 'n1', text: 'make it rain', at: 1 }, { id: 'n2', text: 'add a cat', at: 2 }] }));
    const { result } = await setup();
    await waitFor(() => expect(result.current.queue).toHaveLength(2));
    expect(result.current.queueHold).toBe('restored');
    expect(messages()).toHaveLength(0);
    act(() => result.current.releaseQueue?.());
    await waitFor(() => expect(messages()).toHaveLength(1));
    expect(textOf(lastStream())).toBe(`${QUEUE_PREFIX}\n1. make it rain\n2. add a cat`);
  });

  it('the queue is saved per project in sessionStorage as it changes', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    await act(async () => void (await result.current.send('make it rain')));
    const saved = JSON.parse(window.sessionStorage.getItem(QUEUE_STORAGE_PREFIX + 'proj_1') || '{}');
    expect(saved.notes.map((n: { text: string }) => n.text)).toEqual(['make it rain']);
    act(() => result.current.clearQueue?.());
    expect(window.sessionStorage.getItem(QUEUE_STORAGE_PREFIX + 'proj_1')).toBeNull();
  });
});

describe('editing the queue', () => {
  it('edit, move and remove change Up next', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    for (const t of ['one', 'two', 'three']) await act(async () => void (await result.current.send(t)));
    const [a, b, c] = result.current.queue!.map((n) => n.id);
    act(() => result.current.editQueued?.(b, 'two, louder'));
    act(() => result.current.moveQueued?.(c, -1));
    expect(result.current.queue?.map((n) => n.text)).toEqual(['one', 'three', 'two, louder']);
    act(() => result.current.moveQueuedTo?.(a, 2));
    act(() => result.current.removeQueued?.(c));
    expect(result.current.queue?.map((n) => n.text)).toEqual(['two, louder', 'one']);
  });
});

describe('Send now', () => {
  it('steering off (D2): Stop the director, then send that note alone', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('first')));
    await act(async () => void (await result.current.send('second')));
    const second = result.current.queue![1].id;
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.sendNow!(second);
    });
    expect(outcome).toBe('queued');
    expect(api.cancelStudio).toHaveBeenCalledTimes(1);
    expect(result.current.queueSendingNow).toBe(second);
    // This Stop is "Send now"'s: it does not hold the rest of Up next.
    expect(result.current.queueHold).toBeNull();
    expect(result.current.queue?.[0].text).toBe('second');
    // The stopped turn ends: that one note goes, alone; the other keeps waiting for the next turn.
    reply(s1, 'Stopped.');
    await waitFor(() => expect(messages()).toHaveLength(2));
    expect(textOf(lastStream())).toBe(`${QUEUE_PREFIX} second`);
    expect(result.current.queue?.map((n) => n.text)).toEqual(['first']);
    expect(result.current.queueHold).toBeNull();
  });

  it('steering on: the note joins the running turn through the steer call and leaves Up next', async () => {
    const steerStudio = vi.fn(async () => ({ ok: true as const, msgId: 'msg_steer' }));
    const { result } = await setup(STEER_ON, { steerStudio });
    act(() => void result.current.send('go'));
    await act(async () => void (await result.current.send('make it rain', { focus: { pageId: 'pg_2' } })));
    const id = result.current.queue![0].id;
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.sendNow!(id);
    });
    expect(outcome).toBe('sent');
    expect(steerStudio).toHaveBeenCalledWith('proj_1', { text: 'make it rain', focus: { pageId: 'pg_2' } });
    expect(api.cancelStudio).not.toHaveBeenCalled();
    expect(result.current.queue).toEqual([]);
  });

  it('steering on but the turn already ended (NOT_RUNNING): the note stays and goes next', async () => {
    const steerStudio = vi.fn(async () => {
      throw new StudioApiError('conflict', 'Nothing is running.', { status: 409, code: 'NOT_RUNNING' });
    });
    const { result } = await setup(STEER_ON, { steerStudio });
    act(() => void result.current.send('go'));
    const s1 = lastStream();
    await act(async () => void (await result.current.send('make it rain')));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.sendNow!(result.current.queue![0].id);
    });
    expect(outcome).toBe('queued');
    expect(result.current.queue).toHaveLength(1);
    expect(result.current.error).toBeNull();
    reply(s1, 'Done.', [{ type: 'options', id: 'q', question: 'More?', choices: [{ id: 'y', label: 'Yes' }] }]);
    // "Send now" goes even past the new reply's question.
    await waitFor(() => expect(messages()).toHaveLength(2));
    expect(textOf(lastStream())).toBe(`${QUEUE_PREFIX} make it rain`);
  });

  it('when only a hold keeps the queue (the turn is free), Send now sends at once', async () => {
    window.sessionStorage.setItem(QUEUE_STORAGE_PREFIX + 'proj_1', JSON.stringify({ v: 1, notes: [{ id: 'n1', text: 'make it rain', at: 1 }] }));
    const { result } = await setup();
    await waitFor(() => expect(result.current.queue).toHaveLength(1));
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.sendNow!('n1');
    });
    expect(outcome).toBe('sent');
    expect(messages()).toHaveLength(1);
    expect(api.cancelStudio).not.toHaveBeenCalled();
  });
});
