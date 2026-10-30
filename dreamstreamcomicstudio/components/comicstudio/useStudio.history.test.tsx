// useStudio × Comic History seams (versions plan §8, §6.1; H0): an incoming `history_restore` clears the undo stack;
// the time zone travels only while caps.history is on; typed history intents and the typed-undo fallback go through
// the (H5-owned) intents module only while history is on — with it off nothing changes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { StreamRequest, StudioEvent } from '../../shared/comic/events';
import { applyOps, type DocOp } from '../../shared/comic/ops';
import { normalizeDoc, type ComicDoc } from '../../shared/comic/doc';
import { DEFAULT_CAPS, resolveStudioCaps, withHistoryCaps, type StudioCaps } from '../../shared/comic/capabilities';
import { makeSampleDoc } from './board/__fixtures__/sampleDoc';

const api = vi.hoisted(() => ({
  loadStudioProject: vi.fn(),
  streamStudio: vi.fn(),
  signStudioUrls: vi.fn(),
  cancelStudio: vi.fn(),
  uploadStudioRef: vi.fn(),
  getPublication: vi.fn()
}));
vi.mock('./studioApi', async (importOriginal) => ({ ...(await importOriginal<typeof import('./studioApi')>()), ...api }));

const intents = vi.hoisted(() => ({
  matchHistoryIntent: vi.fn(() => null as unknown),
  handleHistoryIntent: vi.fn(() => false),
  historyUndoFallback: vi.fn(() => false)
}));
vi.mock('./history/intents', async (importOriginal) => ({ ...(await importOriginal<typeof import('./history/intents')>()), ...intents }));

import { useStudio } from './useStudio';

const T = 1_760_000_300_000;
let server: ComicDoc;
let requests: StreamRequest[];
/** Server batches the next message commits. */
let queue: { ops: DocOp[]; origin: 'user' | 'director' | 'job' }[];

const commit = (ops: DocOp[]) => {
  server = { ...applyOps(server, ops, T), rev: server.rev + 1 };
  return server.rev;
};

const setup = async (caps: StudioCaps) => {
  server = normalizeDoc(makeSampleDoc());
  api.loadStudioProject.mockImplementation(async () => ({ doc: server, urls: {}, caps }));
  const hook = renderHook(() => useStudio('proj_1'));
  await waitFor(() => expect(hook.result.current.doc).not.toBeNull());
  await waitFor(() => expect(hook.result.current.caps).toEqual(caps));
  return hook;
};

/** Wait until every queued save reached the fake server (saves are debounced by 150 ms). */
const settle = async (result: { current: ReturnType<typeof useStudio> }) => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 220));
  });
  await waitFor(() => expect(result.current.doc?.rev).toBe(server.rev));
};

beforeEach(() => {
  requests = [];
  queue = [];
  for (const fn of Object.values(intents)) fn.mockClear();
  intents.matchHistoryIntent.mockImplementation(() => null);
  intents.handleHistoryIntent.mockImplementation(() => false);
  intents.historyUndoFallback.mockImplementation(() => false);
  api.loadStudioProject.mockReset();
  api.signStudioUrls.mockReset().mockResolvedValue({});
  api.cancelStudio.mockReset().mockResolvedValue(undefined);
  api.streamStudio.mockReset().mockImplementation(async (_id: string, req: StreamRequest, onEvent: (e: StudioEvent) => void) => {
    requests.push(req);
    if (req.kind === 'action' && req.action.type === 'patch') onEvent({ type: 'ops', rev: commit(req.action.ops), ops: req.action.ops, origin: 'user' });
    else for (const b of queue.splice(0)) onEvent({ type: 'ops', rev: commit(b.ops), ops: b.ops, origin: b.origin });
    onEvent({ type: 'done', rev: server.rev, spentUsd: 0 });
  });
});
afterEach(() => vi.restoreAllMocks());

const OFF = resolveStudioCaps({ byok: false, isAdmin: false });
const ON = withHistoryCaps(OFF, true);

describe('an incoming history_restore clears the undo stack', () => {
  it('local undo entries are dropped when a restore lands (their inverses were computed against the old doc)', async () => {
    const { result } = await setup(OFF);
    await act(async () => {
      await result.current.patch([{ op: 'brief', patch: { logline: 'my edit' } }], { label: 'Edit logline' });
    });
    await settle(result);
    expect(result.current.canUndo).toBe(true);
    const restore: DocOp = { op: 'history_restore', set: { brief: { ...server.brief, logline: 'then' } }, mode: 'merge', versionId: 'ver_1', at: T };
    queue.push({ ops: [restore], origin: 'user' });
    await act(async () => {
      await result.current.send('restore it');
    });
    await waitFor(() => expect(result.current.doc!.brief.logline).toBe('then'));
    expect(result.current.canUndo).toBe(false);
  });
});

describe('the request time zone', () => {
  it('is sent only while caps.history is on (off: requests are unchanged)', async () => {
    const off = await setup(OFF);
    await act(async () => {
      await off.result.current.send('hello');
    });
    expect(requests.at(-1)).toEqual({ kind: 'message', text: 'hello' });
    off.unmount();
    const on = await setup(ON);
    await act(async () => {
      await on.result.current.send('show me yesterday');
    });
    expect(requests.at(-1)).toEqual({ kind: 'message', text: 'show me yesterday', tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });
});

describe('typed history intents', () => {
  it('while on, a matched intent is handled locally (never sent); while off the intents module is never asked', async () => {
    intents.matchHistoryIntent.mockImplementation(() => ({ kind: 'open' }));
    intents.handleHistoryIntent.mockImplementation(() => true);
    const off = await setup(OFF);
    await act(async () => {
      await off.result.current.send('show history');
    });
    expect(intents.matchHistoryIntent).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    off.unmount();
    requests = [];
    const on = await setup(ON);
    await act(async () => {
      await on.result.current.send('show history');
    });
    expect(intents.matchHistoryIntent).toHaveBeenCalledWith('show history');
    expect(intents.handleHistoryIntent).toHaveBeenCalledWith({ kind: 'open' }, expect.objectContaining({ caps: ON, act: expect.any(Function), openHistory: expect.any(Function) }));
    expect(requests).toEqual([]);
  });
});

describe('the typed-undo fallback (history_undo_ai)', () => {
  it('while on and nothing is left to undo locally, the fallback is offered instead of the dead end', async () => {
    intents.historyUndoFallback.mockImplementation(() => true);
    const { result } = await setup(ON);
    await act(async () => {
      await result.current.send('undo');
    });
    expect(intents.historyUndoFallback).toHaveBeenCalledTimes(1);
    expect(result.current.notice).toBeNull(); // no "Nothing to undo yet" dead end
    expect(requests).toEqual([]); // never sent to the director
  });

  it('while on, a newer AI change the stack cannot invert is offered first — an older local edit is not silently undone', async () => {
    intents.historyUndoFallback.mockImplementation(() => true);
    const { result } = await setup(ON);
    await act(async () => {
      await result.current.patch([{ op: 'brief', patch: { logline: 'older edit' } }], { label: 'Edit logline' });
    });
    await settle(result);
    queue.push({ ops: [{ op: 'render', target: { kind: 'page', id: 'pg_2' }, patch: { status: 'ready', asset: { path: 'ai/new.webp', source: 'generated', at: T }, origin: 'render' } }], origin: 'job' });
    await act(async () => {
      await result.current.send('draw page 2');
    });
    await waitFor(() => expect(result.current.doc!.pages[1].render.asset?.path).toBe('ai/new.webp'));
    await act(async () => {
      await result.current.send('undo');
    });
    expect(intents.historyUndoFallback).toHaveBeenCalledTimes(1);
    expect(result.current.doc!.brief.logline).toBe('older edit');
    expect(result.current.canUndo).toBe(true);
  });

  it('while off, a typed undo with nothing to undo is the same dead-end notice as before (the fallback is never asked)', async () => {
    const { result } = await setup({ ...DEFAULT_CAPS });
    await act(async () => {
      await result.current.send('undo');
    });
    expect(intents.historyUndoFallback).not.toHaveBeenCalled();
    expect(result.current.notice?.text).toBe('Nothing to undo yet — free edits from this session can be undone here.');
  });
});

describe('the history event reaches an open History panel', () => {
  it('the controller exposes the latest saved moment (absent until one arrives)', async () => {
    const { result } = await setup(ON);
    expect('lastHistoryVersion' in result.current).toBe(false);
    const version = { id: 'ver_9', kind: 'edits', actor: 'you', label: 'You edited page 2', pinned: false, rev: 3, contentAt: T, createdAt: T, codec: 'v5', changes: [], thumbs: [], stats: { pages: 6, drawn: 1, lines: 9, langs: [], models: [] } };
    api.streamStudio.mockImplementationOnce(async (_id: string, req: StreamRequest, onEvent: (e: StudioEvent) => void) => {
      requests.push(req);
      onEvent({ type: 'history', version } as StudioEvent);
      onEvent({ type: 'done', rev: server.rev, spentUsd: 0 });
    });
    await act(async () => {
      await result.current.send('hello');
    });
    expect(result.current.lastHistoryVersion).toEqual(version);
  });
});
