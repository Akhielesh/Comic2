// useStudio — presence (agent-editor plan §3 A2 "Presence", wave 2 A4) and isUnsignable (PF-2 #7).
// Synthetic stream events stand in for the server: today no server sends activity.where (B-TOOL adds it at
// director.ts's tool activity emits), so these tests are the contract the editor outline and the Layers badge read.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ActivityWhere, StreamRequest, StudioEvent } from '../../shared/comic/events';
import { DEFAULT_CAPS } from '../../shared/comic/capabilities';
import { makeFakeStudio, makeSampleDoc } from './conversation/testing/fixtures';

const api = vi.hoisted(() => ({
  loadStudioProject: vi.fn(),
  streamStudio: vi.fn(),
  signStudioUrls: vi.fn(),
  cancelStudio: vi.fn(),
  steerStudio: vi.fn()
}));

vi.mock('./studioApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./studioApi')>();
  return { ...real, ...api };
});

import { StudioApiError } from './studioApi';
import { useStudio } from './useStudio';

interface FakeStream {
  req: StreamRequest;
  emit: (e: StudioEvent) => void;
  resolve: () => void;
}

let streams: FakeStream[] = [];

/** The sample comic with nothing drawing, so no bounded render poll runs while the studio is idle. */
const idleDoc = () => {
  const doc = makeSampleDoc();
  return { ...doc, style: { ...doc.style, options: doc.style.options.map((o) => ({ ...o, render: { ...o.render, status: 'ready' as const } })) } };
};

const setup = async (urls: Record<string, string> = {}) => {
  api.loadStudioProject.mockResolvedValue({ doc: idleDoc(), urls, caps: DEFAULT_CAPS });
  let renders = 0;
  const hook = renderHook(
    ({ id }) => {
      renders += 1;
      return useStudio(id);
    },
    { initialProps: { id: 'proj_1' } }
  );
  await waitFor(() => expect(hook.result.current.doc).not.toBeNull());
  return { ...hook, renders: () => renders };
};

const emit = (s: FakeStream, e: StudioEvent) => act(() => s.emit(e));
const startTool = (s: FakeStream, id: string, label: string, where?: ActivityWhere) =>
  emit(s, { type: 'activity', id, label, phase: 'start', cost: 'free', ...(where ? { where } : {}) });
const endTool = (s: FakeStream, id: string, label: string) => emit(s, { type: 'activity', id, label, phase: 'end', ok: true, cost: 'free' });
/** A director turn that is running: its stream stays open until the test closes it. */
const runningTurn = async (result: { current: ReturnType<typeof useStudio> }) => {
  act(() => void result.current.send('make her shout'));
  await waitFor(() => expect(streams).toHaveLength(1));
  return streams[0];
};
const apiCalls = () => [api.loadStudioProject, api.streamStudio, api.signStudioUrls, api.cancelStudio, api.steerStudio].map((f) => f.mock.calls.length);

const BALLOON: ActivityWhere = { pageId: 'pg_2', lineIds: ['pg_2_l1'] };

beforeEach(() => {
  streams = [];
  api.loadStudioProject.mockReset();
  api.signStudioUrls.mockReset().mockResolvedValue({});
  api.cancelStudio.mockReset().mockResolvedValue(undefined);
  api.steerStudio.mockReset().mockResolvedValue({ ok: true, msgId: 'msg_steer' });
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

describe('StudioController.presence', () => {
  it('is null until a step names where it works, then names it — and clears on that step’s end', async () => {
    const { result } = await setup();
    expect(result.current.presence).toBeNull();
    const s = await runningTurn(result);
    startTool(s, 'act_1', 'Moving a balloon', BALLOON);
    expect(result.current.presence).toMatchObject({ pageId: 'pg_2', lineIds: ['pg_2_l1'], label: 'Moving a balloon' });
    expect(typeof result.current.presence?.at).toBe('number');
    endTool(s, 'act_1', 'Moving a balloon');
    expect(result.current.presence).toBeNull();
    expect(result.current.messageBusy).toBe(true);
  });

  it('clears on the stream’s done', async () => {
    const { result } = await setup();
    const s = await runningTurn(result);
    startTool(s, 'act_1', 'Moving a balloon', BALLOON);
    emit(s, { type: 'done', rev: 5, spentUsd: 0 });
    expect(result.current.presence).toBeNull();
  });

  it('clears on the stream’s error', async () => {
    const { result } = await setup();
    const s = await runningTurn(result);
    startTool(s, 'act_1', 'Moving a balloon', BALLOON);
    emit(s, { type: 'error', code: 'INTERNAL', message: 'Something went wrong. Please try again.' });
    expect(result.current.presence).toBeNull();
  });

  it('clears the moment Stop is pressed', async () => {
    const { result } = await setup();
    const s = await runningTurn(result);
    startTool(s, 'act_1', 'Moving a balloon', BALLOON);
    await act(async () => void (await result.current.cancel()));
    expect(api.cancelStudio).toHaveBeenCalledTimes(1);
    expect(result.current.presence).toBeNull();
    expect(streams).toHaveLength(1);
  });

  it('stays null when no event carries where (what every server sends today)', async () => {
    const { result } = await setup();
    const s = await runningTurn(result);
    startTool(s, 'act_1', 'Moving a balloon');
    expect(result.current.activity.map((a) => a.label)).toEqual(['Moving a balloon']);
    expect(result.current.presence).toBeNull();
    endTool(s, 'act_1', 'Moving a balloon');
    expect(result.current.presence).toBeNull();
  });

  it('no /api call on a timer: presence starts, lives and ends without a fetch (fake timers)', async () => {
    const { result } = await setup();
    const s = await runningTurn(result);
    vi.useFakeTimers();
    const before = apiCalls();
    startTool(s, 'act_1', 'Moving a balloon', BALLOON);
    await act(async () => void (await vi.advanceTimersByTimeAsync(30 * 60_000)));
    expect(result.current.presence?.pageId).toBe('pg_2');
    expect(apiCalls()).toEqual(before);
    emit(s, { type: 'done', rev: 5, spentUsd: 0 });
    await act(async () => s.resolve());
    expect(result.current.presence).toBeNull();
    await act(async () => void (await vi.advanceTimersByTimeAsync(30 * 60_000)));
    expect(apiCalls()).toEqual(before);
  });
});

describe('StudioController.isUnsignable (PF-2 #7)', () => {
  const PATH = 'u/x/p/pg_9.webp';

  it('is false before MAX_SIGN_ATTEMPTS failed tries and true after — and the panes render again when it turns', async () => {
    const { result, renders } = await setup();
    vi.useFakeTimers();
    api.signStudioUrls.mockRejectedValue(new StudioApiError('network', 'Offline.'));
    const tryOnce = async () => {
      act(() => void result.current.urlFor(PATH));
      await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    };
    await tryOnce();
    await tryOnce();
    expect(api.signStudioUrls).toHaveBeenCalledTimes(2);
    expect(result.current.isUnsignable(PATH)).toBe(false);
    const rendered = renders();
    await tryOnce();
    expect(api.signStudioUrls).toHaveBeenCalledTimes(3);
    // The third failure gives the path up: the controller says so and renders again (a failed try dispatches nothing
    // else, so without the bump a tile would keep its shimmer until something unrelated re-rendered).
    expect(renders()).toBeGreaterThan(rendered);
    expect(result.current.isUnsignable(PATH)).toBe(true);
    // Given up for good (until reload): no fourth try.
    await tryOnce();
    expect(api.signStudioUrls).toHaveBeenCalledTimes(3);
    expect(result.current.isUnsignable('u/x/p/other.webp')).toBe(false);
  });

  it('a path the server declines to sign is unsignable at once — and the panes reading it render again', async () => {
    const { result } = await setup();
    vi.useFakeTimers();
    api.signStudioUrls.mockResolvedValue({});
    act(() => void result.current.urlFor(PATH));
    expect(result.current.isUnsignable(PATH)).toBe(false);
    const before = result.current.isUnsignable;
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    expect(api.signStudioUrls).toHaveBeenCalledTimes(1);
    expect(result.current.isUnsignable(PATH)).toBe(true);
    // A new identity, so a memoised tile reading it renders "Preview unavailable" instead of keeping its shimmer.
    expect(result.current.isUnsignable).not.toBe(before);
  });

  describe('the last allowed try, still in flight', () => {
    /** Two failed tries, then a third whose answer the test holds. */
    const thirdTryHeld = async () => {
      const ctx = await setup();
      vi.useFakeTimers();
      const offline = new StudioApiError('network', 'Offline.');
      let settle: { resolve: (v: Record<string, string>) => void; reject: (e: unknown) => void } | null = null;
      api.signStudioUrls
        .mockRejectedValueOnce(offline)
        .mockRejectedValueOnce(offline)
        .mockImplementationOnce(() => new Promise<Record<string, string>>((resolve, reject) => (settle = { resolve, reject })));
      for (let i = 0; i < 3; i += 1) {
        act(() => void ctx.result.current.urlFor(PATH));
        await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
      }
      expect(api.signStudioUrls).toHaveBeenCalledTimes(3);
      return { ...ctx, settle: () => settle! };
    };

    it('is not given up on while it is in flight, and is once it fails', async () => {
      const { result, settle } = await thirdTryHeld();
      // It may still come back signed: the tile keeps its shimmer, it does not flash "Preview unavailable".
      expect(result.current.isUnsignable(PATH)).toBe(false);
      const before = result.current.isUnsignable;
      await act(async () => settle().reject(new StudioApiError('network', 'Offline.')));
      expect(result.current.isUnsignable(PATH)).toBe(true);
      expect(result.current.isUnsignable).not.toBe(before);
    });

    it('is not given up on when it comes back signed', async () => {
      const { result, settle } = await thirdTryHeld();
      expect(result.current.isUnsignable(PATH)).toBe(false);
      await act(async () => settle().resolve({ [PATH]: 'https://cdn.test/late.webp' }));
      expect(result.current.isUnsignable(PATH)).toBe(false);
      expect(result.current.urlFor(PATH)).toBe('https://cdn.test/late.webp');
    });
  });

  it('a file that keeps failing to load is given up on once, and the panes render again exactly then', async () => {
    const SIGNED = 'https://cdn.test/signed.webp';
    const MAX_SIGN_ATTEMPTS = 3; // useStudio.ts
    const { result } = await setup({ [PATH]: SIGNED });
    vi.useFakeTimers();
    api.signStudioUrls.mockResolvedValue({ [PATH]: SIGNED });
    expect(result.current.urlFor(PATH)).toBe(SIGNED);
    const img = document.createElement('img');
    img.src = SIGNED;
    document.body.appendChild(img);
    const seen = new Set([result.current.isUnsignable]);
    try {
      for (let i = 1; i <= MAX_SIGN_ATTEMPTS + 2; i += 1) {
        act(() => void img.dispatchEvent(new Event('error')));
        seen.add(result.current.isUnsignable);
        // Up to MAX_SIGN_ATTEMPTS failures it is an expired link (re-signed); one more and the file is broken.
        expect(result.current.isUnsignable(PATH)).toBe(i > MAX_SIGN_ATTEMPTS);
        expect(seen.size).toBe(i > MAX_SIGN_ATTEMPTS ? 2 : 1);
      }
      await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
      expect(result.current.isUnsignable(PATH)).toBe(true);
      expect(seen.add(result.current.isUnsignable).size).toBe(2);
    } finally {
      img.remove();
    }
  });

  it('a signed path is not', async () => {
    const { result } = await setup();
    vi.useFakeTimers();
    api.signStudioUrls.mockResolvedValue({ [PATH]: 'https://cdn.test/signed.webp' });
    act(() => void result.current.urlFor(PATH));
    await act(async () => void (await vi.advanceTimersByTimeAsync(1_000)));
    expect(result.current.urlFor(PATH)).toBe('https://cdn.test/signed.webp');
    expect(result.current.isUnsignable(PATH)).toBe(false);
  });

  it('the fake studio has it too (never given up on)', () => {
    expect(makeFakeStudio().isUnsignable(PATH)).toBe(false);
  });
});
