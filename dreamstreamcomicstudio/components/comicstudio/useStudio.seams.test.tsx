// useStudio v5 members (contract §13.1): caps, Easy/Pro view, selection focus, SendOptions,
// next-step chips, client actions, ref uploads and the lazy publication. Undo/redo flows live in
// useStudio.undo.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { StreamRequest, StudioEvent } from '../../shared/comic/events';
import { DEFAULT_CAPS, resolveStudioCaps } from '../../shared/comic/capabilities';
import { makeSampleDoc } from './conversation/testing/fixtures';

const api = vi.hoisted(() => ({
  loadStudioProject: vi.fn(),
  streamStudio: vi.fn(),
  signStudioUrls: vi.fn(),
  cancelStudio: vi.fn(),
  uploadStudioRef: vi.fn(),
  getPublication: vi.fn()
}));

vi.mock('./studioApi', async (importOriginal) => {
  const real = await importOriginal<typeof import('./studioApi')>();
  return { ...real, ...api };
});

import { StudioApiError } from './studioApi';
import { MODE_STORAGE_KEY, focusFromSelection, resolveStudioMode, useStudio } from './useStudio';

let requests: StreamRequest[] = [];

const setup = async (caps?: ReturnType<typeof resolveStudioCaps>) => {
  api.loadStudioProject.mockResolvedValue({ doc: makeSampleDoc(), urls: {}, ...(caps ? { caps } : {}) });
  const hook = renderHook(({ id }) => useStudio(id), { initialProps: { id: 'proj_1' } });
  await waitFor(() => expect(hook.result.current.doc).not.toBeNull());
  return hook;
};

beforeEach(() => {
  requests = [];
  window.localStorage.clear();
  api.loadStudioProject.mockReset();
  api.signStudioUrls.mockReset().mockResolvedValue({});
  api.cancelStudio.mockReset().mockResolvedValue(undefined);
  api.uploadStudioRef.mockReset();
  api.getPublication.mockReset();
  api.streamStudio.mockReset().mockImplementation(async (_id: string, req: StreamRequest, onEvent: (e: StudioEvent) => void) => {
    requests.push(req);
    onEvent({ type: 'done', rev: 5, spentUsd: 0 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('caps and mode', () => {
  it('starts from DEFAULT_CAPS and adopts the caps the project load returns', async () => {
    const { result } = await setup(resolveStudioCaps({ planId: 'creator', byok: false, isAdmin: false }));
    expect(result.current.caps.plan).toBe('paid');
    expect(result.current.mode).toBe('pro'); // paid default
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it('keeps DEFAULT_CAPS when the server sends none; the mode persists in localStorage', async () => {
    const { result } = await setup();
    expect(result.current.caps).toEqual(DEFAULT_CAPS);
    expect(result.current.mode).toBe('easy');
    act(() => result.current.setMode('pro'));
    expect(result.current.mode).toBe('pro');
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe('pro');
  });

  it('resolveStudioMode honours the pick but never shows Pro without proEditor', () => {
    expect(resolveStudioMode(null, DEFAULT_CAPS)).toBe('easy');
    expect(resolveStudioMode('pro', DEFAULT_CAPS)).toBe('pro');
    expect(resolveStudioMode('pro', { ...DEFAULT_CAPS, proEditor: false })).toBe('easy');
    expect(resolveStudioMode(null, { ...DEFAULT_CAPS, defaultMode: 'pro' })).toBe('pro');
  });
});

describe('send with SendOptions', () => {
  it('sends inbox paths, quick-assign targets and the selection focus', async () => {
    const { result } = await setup();
    act(() => result.current.setSelection({ pageId: 'pg_1', lineIds: ['pg_1_l1'], panelN: 2, surface: 'page_editor' }));
    await act(async () => {
      await result.current.send('make her the hero', {
        inboxPaths: ['u/x/p/ref/a.webp', 'u/x/p/ref/a.webp', 'u/x/p/ref/b.webp'],
        attachmentTargets: [{ kind: 'character', id: 'c_maya' }, null],
        focus: 'selection'
      });
    });
    expect(requests.at(-1)).toEqual({
      kind: 'message',
      text: 'make her the hero',
      attachments: [{ inboxPath: 'u/x/p/ref/a.webp' }, { inboxPath: 'u/x/p/ref/b.webp' }],
      attachmentTargets: [{ kind: 'character', id: 'c_maya' }, null],
      focus: { pageId: 'pg_1', lineIds: ['pg_1_l1'], panelN: 2, surface: 'page_editor' }
    });
  });

  it('keeps the legacy (text, attachments[]) form', async () => {
    const { result } = await setup();
    const att = { name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAA' };
    await act(async () => {
      await result.current.send('', [att]);
    });
    expect(requests.at(-1)).toEqual({ kind: 'message', text: '', attachments: [att] });
  });

  it('focusFromSelection caps line ids and drops an empty selection', () => {
    expect(focusFromSelection(null)).toBeUndefined();
    const many = Array.from({ length: 100 }, (_, i) => `l${i}`);
    expect(focusFromSelection({ pageId: 'p', lineIds: many, surface: 'board' })?.lineIds).toHaveLength(80);
  });
});

describe('next steps and client actions', () => {
  it('routes a chip by kind: action → act, client → board, say → message', async () => {
    const { result } = await setup();
    await act(async () => {
      await result.current.runNextStep({ label: 'Draw page 2', action: { type: 'show_breakdown' }, usd: 0 });
    });
    expect(requests.at(-1)).toEqual({ kind: 'action', action: { type: 'show_breakdown' } });

    await act(async () => {
      await result.current.runNextStep({ label: 'See the cast', client: { type: 'open_tab', tab: 'cast' } });
    });
    expect(result.current.tab).toBe('cast');

    await act(async () => {
      await result.current.runNextStep({ label: 'Make it funnier', say: 'Make page 2 funnier' });
    });
    expect(requests.at(-1)).toEqual({ kind: 'message', text: 'Make page 2 funnier' });

    await act(async () => {
      await result.current.runNextStep({ label: 'Add a dog' });
    });
    expect(requests.at(-1)).toEqual({ kind: 'message', text: 'Add a dog' });
  });

  it('runs client actions locally', async () => {
    const { result } = await setup();
    act(() => result.current.runClientAction({ type: 'open_page', pageId: 'pg_2' }));
    expect(result.current.focusedPageId).toBe('pg_2');
    act(() => result.current.runClientAction({ type: 'open_reader', immersive: true }));
    expect(result.current.tab).toBe('read');
    act(() => result.current.runClientAction({ type: 'set_mode', mode: 'pro' }));
    expect(result.current.mode).toBe('pro');
    act(() => result.current.runClientAction({ type: 'undo' })); // nothing to undo yet: a calm notice, no request
    expect(requests).toHaveLength(0);
    expect(result.current.notice).toMatchObject({ kind: 'info', text: expect.stringMatching(/Nothing to undo/) });
  });
});

describe('uploads and publication', () => {
  it('uploadRef posts the file (progress + abort), merges urls and applies the server ops without a refetch', async () => {
    const { result } = await setup();
    const ref = { path: 'u/x/p/ref/r1.webp', source: 'upload' as const, at: 1 };
    api.uploadStudioRef.mockResolvedValue({ ref, ops: [{ op: 'ref_add', owner: { kind: 'inbox' }, ref }], rev: 6, urls: { [ref.path]: 'https://cdn.test/r1' } });
    const progress = vi.fn();
    const ctrl = new AbortController();
    const file = new Blob(['x'], { type: 'image/png' });
    let out: unknown;
    await act(async () => {
      out = await result.current.uploadRef(file, { kind: 'inbox' }, { name: 'r1.png', onProgress: progress, signal: ctrl.signal });
    });
    expect(api.uploadStudioRef).toHaveBeenCalledWith('proj_1', file, { to: { kind: 'inbox' }, name: 'r1.png' }, { signal: ctrl.signal, onProgress: progress });
    expect(out).toEqual({ ref });
    expect(progress).toHaveBeenNthCalledWith(1, 0);
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(result.current.urlFor(ref.path)).toBe('https://cdn.test/r1');
    // rev 5 → 6 applies directly (no GET).
    expect(result.current.doc?.rev).toBe(6);
    expect(result.current.doc?.refInbox?.map((r) => r.path)).toEqual([ref.path]);
    expect(api.loadStudioProject).toHaveBeenCalledTimes(1);
  });

  it('uploadRef resyncs once when the server committed a ref but sent no ops', async () => {
    const { result } = await setup();
    const ref = { path: 'u/x/p/ref/r2.webp', source: 'upload' as const, at: 1 };
    api.uploadStudioRef.mockResolvedValue({ ref, ops: [], urls: {} });
    await act(async () => {
      await result.current.uploadRef(new Blob(['x']), { kind: 'inbox' });
    });
    await waitFor(() => expect(api.loadStudioProject).toHaveBeenCalledTimes(2));
  });

  it('uploadRef surfaces a duplicate without resyncing, and rethrows failures', async () => {
    const { result } = await setup();
    api.uploadStudioRef.mockResolvedValueOnce({ duplicateOf: 'u/x/p/ref/old.webp', ops: [], urls: {} });
    await expect(result.current.uploadRef(new Blob(['x']), { kind: 'style' })).resolves.toEqual({ duplicateOf: 'u/x/p/ref/old.webp' });
    expect(api.loadStudioProject).toHaveBeenCalledTimes(1);

    api.uploadStudioRef.mockRejectedValueOnce(new StudioApiError('bad_request', 'That image is too large.', { status: 413 }));
    await expect(result.current.uploadRef(new Blob(['x']), { kind: 'style' })).rejects.toThrow('That image is too large.');
  });

  it('refreshPublication loads lazily; "not available yet" means no publication', async () => {
    const { result } = await setup();
    expect(result.current.publication).toBeNull();
    expect(api.getPublication).not.toHaveBeenCalled();

    api.getPublication.mockRejectedValueOnce(new StudioApiError('not_available', "That isn't available yet.", { status: 501 }));
    await act(async () => {
      await result.current.refreshPublication();
    });
    expect(result.current.publication).toBeNull();

    const view = { visibility: 'unlisted', status: 'live', slug: 'abcdefghijklmnopq', languages: ['en'] };
    api.getPublication.mockResolvedValueOnce(view);
    await act(async () => {
      await result.current.refreshPublication();
    });
    expect(result.current.publication).toEqual(view);

    api.getPublication.mockRejectedValueOnce(new StudioApiError('server', 'The studio server hit a problem.', { status: 500 }));
    await expect(result.current.refreshPublication()).rejects.toThrow('The studio server hit a problem.');
  });
});
