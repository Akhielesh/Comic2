import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the transport so we can drive a stalled stream without a real server/supabase env.
const { postStreamMock, postMock } = vi.hoisted(() => ({ postStreamMock: vi.fn(), postMock: vi.fn() }));
vi.mock('./apiClient', () => {
  class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  return {
    postStream: (...args: unknown[]) => postStreamMock(...args),
    post: (...args: unknown[]) => postMock(...args),
    get: vi.fn(),
    ApiError
  };
});

import { sendChatMessageStream } from './chatApi';

const encoder = new TextEncoder();
const sseStream = (records: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const r of records) controller.enqueue(encoder.encode(r));
      controller.close();
    }
  });

describe('sendChatMessageStream', () => {
  beforeEach(() => {
    postStreamMock.mockReset();
    postMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('streams deltas and resolves with the final payload (happy path)', async () => {
    postStreamMock.mockResolvedValue({
      ok: true,
      body: sseStream([
        'event: delta\ndata: {"content":"Hello "}\n\n',
        'event: delta\ndata: {"content":"world"}\n\n',
        'event: final\ndata: {"text":"Hello world","model":"m"}\n\n'
      ])
    });
    const deltas: string[] = [];
    const res = await sendChatMessageStream({ messages: [{ role: 'user', content: 'hi' }] } as never, {
      onDelta: (c) => deltas.push(c)
    });
    expect(deltas.join('')).toBe('Hello world');
    expect(res.text).toBe('Hello world');
    expect(postMock).not.toHaveBeenCalled(); // no fallback needed
  });

  it('falls back to the buffered endpoint when the stream stalls silently (the "loading forever" fix)', async () => {
    vi.useFakeTimers();
    // A body that never emits a byte → read() pends forever, simulating a proxy that
    // buffers/withholds the SSE stream. Previously this hung the UI indefinitely.
    const stalled = new ReadableStream<Uint8Array>({ start() {} });
    postStreamMock.mockResolvedValue({ ok: true, body: stalled });
    postMock.mockResolvedValue({ text: 'buffered answer', model: 'm' });

    const deltas: string[] = [];
    const promise = sendChatMessageStream({ messages: [{ role: 'user', content: 'hi' }] } as never, {
      onDelta: (c) => deltas.push(c)
    });
    // Advance past the idle watchdog window to trip the stall detector.
    await vi.advanceTimersByTimeAsync(46_000);
    const res = await promise;

    expect(postMock).toHaveBeenCalledTimes(1); // recovered via the buffered endpoint
    expect(res.text).toBe('buffered answer');
    expect(deltas).toContain('buffered answer'); // surfaced to the UI like a streamed answer
  });

  it('recovers a high-reasoning turn that streams only "thinking" and never answers (no-response fix)', async () => {
    // Exact production failure: reasoning streams, then the stream closes with NO content
    // and NO `final` event. Previously the reasoning made receivedAny=true, which SKIPPED
    // the recovery, so the turn died with "The model returned no response."
    postStreamMock.mockResolvedValue({
      ok: true,
      body: sseStream(['event: reasoning\ndata: {"reasoning":"let me think…"}\n\n'])
    });
    postMock.mockResolvedValue({ text: 'real answer', model: 'm' });

    const deltas: string[] = [];
    const res = await sendChatMessageStream(
      { messages: [{ role: 'user', content: 'hi' }], reasoningLevel: 'high' } as never,
      { onDelta: (c) => deltas.push(c), onReasoning: () => {} }
    );

    expect(postMock).toHaveBeenCalledTimes(1); // recovered via the buffered endpoint
    // Reasoning is downgraded on the retry so the model spends its budget answering.
    // sendChatMessage calls post('/api/chat', req, …) → the request body is arg index 1.
    const retryReq = postMock.mock.calls[0][1] as { reasoningLevel?: string };
    expect(retryReq.reasoningLevel).toBe('low');
    expect(res.text).toBe('real answer');
    expect(deltas).toContain('real answer');
  });

  it('recovers a high-reasoning turn that TIMES OUT by retrying with light reasoning', async () => {
    // Production case: reasoning:high on the auto model exceeds the request timeout (90s).
    // Recovery must drop heavy reasoning so the buffered retry answers fast instead of
    // timing out again.
    postStreamMock.mockRejectedValue(new Error('The model took too long to respond (timed out after 90s).'));
    postMock.mockResolvedValue({ text: 'fast answer', model: 'm' });

    const res = await sendChatMessageStream(
      { messages: [{ role: 'user', content: 'hi' }], reasoningLevel: 'high' } as never,
      { onDelta: () => {} }
    );

    expect(postMock).toHaveBeenCalledTimes(1);
    const retryReq = postMock.mock.calls[0][1] as { reasoningLevel?: string };
    expect(retryReq.reasoningLevel).toBe('low');
    expect(res.text).toBe('fast answer');
  });
});
