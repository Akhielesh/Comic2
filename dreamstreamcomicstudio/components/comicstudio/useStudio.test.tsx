import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { StreamRequest, StudioEvent } from '../../shared/comic/events';
import type { DocOp } from '../../shared/comic/ops';
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

import { StudioApiError } from './studioApi';
import { actOutcomeOf, useStudio } from './useStudio';
import { stopsSequence } from './conversation/cards/useAction';

interface FakeStream {
  id: string;
  req: StreamRequest;
  emit: (e: StudioEvent) => void;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (err: unknown) => void;
}

let streams: FakeStream[] = [];

const setup = async (doc = makeSampleDoc()) => {
  api.loadStudioProject.mockResolvedValue({ doc, urls: { 'u/x/p/pg_1.webp': 'https://cdn.test/pg_1' } });
  const hook = renderHook(({ id }) => useStudio(id), { initialProps: { id: 'proj_1' } });
  await waitFor(() => expect(hook.result.current.doc).not.toBeNull());
  return hook;
};

const lastStream = () => streams[streams.length - 1];
const emit = (s: FakeStream, e: StudioEvent) => act(() => s.emit(e));
const finish = async (s: FakeStream, rev: number) => {
  emit(s, { type: 'done', rev, spentUsd: 0 });
  await act(async () => s.resolve());
};

beforeEach(() => {
  streams = [];
  api.loadStudioProject.mockReset();
  api.signStudioUrls.mockReset().mockResolvedValue({});
  api.cancelStudio.mockReset().mockResolvedValue(undefined);
  api.streamStudio.mockReset().mockImplementation(
    (id: string, req: StreamRequest, onEvent: (e: StudioEvent) => void, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        streams.push({ id, req, emit: onEvent, signal, resolve, reject });
        signal?.addEventListener('abort', () => reject(new StudioApiError('aborted', 'Cancelled.')));
      })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useStudio — load', () => {
  it('loads the project, opens on the most useful board tab, and resolves urls', async () => {
    const { result } = await setup();
    expect(api.loadStudioProject).toHaveBeenCalledWith('proj_1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result.current.loading).toBe(false);
    expect(result.current.tab).toBe('pages');
    expect(result.current.urlFor({ path: 'u/x/p/pg_1.webp', source: 'generated', at: 1 })).toBe('https://cdn.test/pg_1');
    expect(result.current.urlFor('data:image/png;base64,x')).toBe('data:image/png;base64,x');
    expect(result.current.urlFor(null)).toBeUndefined();
  });

  it('reports a fatal load error', async () => {
    api.loadStudioProject.mockRejectedValue(new StudioApiError('not_found', "This comic doesn't exist or you don't have access to it.", { status: 404 }));
    const { result } = renderHook(() => useStudio('missing'));
    await waitFor(() => expect(result.current.loadError).toMatch(/doesn't exist/));
    expect(result.current.doc).toBeNull();
  });

  it('reloads when the project changes and ignores the old project', async () => {
    const hook = await setup();
    api.loadStudioProject.mockResolvedValue({ doc: makeSampleDoc({ id: 'proj_2', brief: { title: 'Second', notes: [] } }), urls: {} });
    hook.rerender({ id: 'proj_2' });
    await waitFor(() => expect(hook.result.current.doc?.brief.title).toBe('Second'));
  });
});

describe('useStudio — director turns', () => {
  it('shows the message at once, streams the turn and lands the server copy', async () => {
    const { result } = await setup();
    act(() => void result.current.send('  A rooftop heist  '));
    expect(result.current.pendingMessage?.text).toBe('A rooftop heist');
    expect(result.current.messageBusy).toBe(true);
    expect(result.current.busy).toBe(true);
    const s = lastStream();
    expect(s.req).toEqual({ kind: 'message', text: 'A rooftop heist' });

    emit(s, { type: 'hello', rev: 5, turnId: 't1' });
    emit(s, { type: 'ops', rev: 6, ops: [{ op: 'message', msg: { id: 'u1', role: 'user', text: 'A rooftop heist', at: 1 } }] });
    expect(result.current.pendingMessage).toBeNull();
    emit(s, { type: 'delta', msgId: 'a1', text: 'Love it' });
    expect(result.current.drafts.a1).toBe('Love it');
    emit(s, { type: 'activity', id: 'act1', label: 'Writing the brief', phase: 'start' });
    expect(result.current.activity).toHaveLength(1);
    emit(s, { type: 'ops', rev: 7, ops: [{ op: 'message', msg: { id: 'a1', role: 'assistant', text: 'Love it — a heist!', at: 2 } }] });
    await finish(s, 7);

    expect(result.current.messageBusy).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.drafts).toEqual({});
    expect(result.current.activity).toEqual([]);
    expect(result.current.doc?.conversation.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(result.current.doc?.rev).toBe(7);
  });

  it('runs one director turn at a time', async () => {
    const { result } = await setup();
    act(() => void result.current.send('one'));
    act(() => void result.current.send('two'));
    expect(api.streamStudio).toHaveBeenCalledTimes(1);
  });

  it('sends images as attachments', async () => {
    const { result } = await setup();
    const att = { name: 'maya.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAA' };
    act(() => void result.current.send('', [att]));
    expect(lastStream().req).toEqual({ kind: 'message', text: '', attachments: [att] });
  });

  it('a turn that fails before the server recorded it keeps the text with retry', async () => {
    const { result } = await setup();
    act(() => void result.current.send('Draw it'));
    await act(async () => lastStream().reject(new StudioApiError('billing', 'Out of credit.', { status: 402 })));
    expect(result.current.pendingMessage).toMatchObject({ status: 'failed', error: 'Out of credit.' });
    expect(result.current.error).toBeNull();

    act(() => result.current.retryPendingMessage());
    expect(api.streamStudio).toHaveBeenCalledTimes(2);
    expect(lastStream().req).toEqual({ kind: 'message', text: 'Draw it' });
  });
});

describe('useStudio — actions', () => {
  it('runs actions alongside a turn, and never runs the same action twice at once', async () => {
    const { result } = await setup();
    act(() => void result.current.send('hi'));
    act(() => void result.current.act({ type: 'approve_gate', gateId: 'g1' }));
    act(() => void result.current.act({ type: 'approve_gate', gateId: 'g1' }));
    act(() => void result.current.act({ type: 'render_cover' }));
    expect(streams.map((s) => s.req)).toEqual([
      { kind: 'message', text: 'hi' },
      { kind: 'action', action: { type: 'approve_gate', gateId: 'g1' } },
      { kind: 'action', action: { type: 'render_cover' } }
    ]);
    expect(result.current.messageBusy).toBe(true);
  });

  it('every stream applies each op batch once', async () => {
    const { result } = await setup();
    act(() => void result.current.act({ type: 'render_cover' }));
    act(() => void result.current.act({ type: 'render_pages' }));
    const [a, b] = streams;
    const batch: DocOp[] = [{ op: 'note_add', text: 'once' }];
    emit(a, { type: 'ops', rev: 6, ops: batch });
    emit(b, { type: 'ops', rev: 6, ops: batch });
    expect(result.current.doc?.brief.notes).toEqual(['once']);
    expect(result.current.doc?.rev).toBe(6);
  });

  it('a stream error surfaces as a dismissible error', async () => {
    const { result } = await setup();
    act(() => void result.current.act({ type: 'render_cover' }));
    emit(lastStream(), { type: 'error', message: 'Connect a Gemini or OpenRouter key.' });
    expect(result.current.error).toBe('Connect a Gemini or OpenRouter key.');
    act(() => result.current.clearError());
    expect(result.current.error).toBeNull();
  });

  it('isRendering reflects live render status', async () => {
    const { result } = await setup();
    act(() => void result.current.act({ type: 'render_pages' }));
    emit(lastStream(), { type: 'ops', rev: 6, ops: [{ op: 'render', target: { kind: 'page', id: 'pg_2' }, patch: { status: 'rendering' } }] });
    expect(result.current.isRendering({ kind: 'page', id: 'pg_2' })).toBe(true);
    expect(result.current.renderingTotal).toBe(2); // + the style option already drawing
  });
});

describe('useStudio — act() resolves its outcome (P2-STUDIO-CORE)', () => {
  const gate = {
    id: 'g9',
    action: { type: 'render_pages' as const },
    title: 'Draw 3 pages',
    summary: '3 pages',
    estimateUsd: 0.2,
    imageCount: 3,
    model: 'nano-banana',
    createdAt: 1,
    status: 'open' as const,
    reason: 'policy' as const
  };

  it('a clean stream resolves ok and not gated', async () => {
    const { result } = await setup();
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.act({ type: 'render_cover' });
    });
    await finish(lastStream(), 6);
    await expect(p).resolves.toMatchObject({ ok: true, gated: false, aborted: false });
    expect(stopsSequence(await p)).toBe(false);
  });

  it('a stream that commits an open gate resolves gated (sequences stop)', async () => {
    const { result } = await setup();
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.act({ type: 'render_pages' });
    });
    emit(lastStream(), { type: 'ops', rev: 6, ops: [{ op: 'gate', gate }] });
    await finish(lastStream(), 6);
    const out = actOutcomeOf(await p);
    expect(out).toMatchObject({ ok: true, gated: true });
    expect(stopsSequence(out)).toBe(true);
  });

  it('closing a gate (status approved / null) is not "gated"', async () => {
    const { result } = await setup();
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.act({ type: 'approve_gate', gateId: 'g9' });
    });
    emit(lastStream(), { type: 'ops', rev: 6, ops: [{ op: 'gate', gate: { ...gate, status: 'approved' } }, { op: 'gate', gate: null }] });
    await finish(lastStream(), 6);
    expect(actOutcomeOf(await p)).toMatchObject({ ok: true, gated: false });
  });

  it('a refusal inside the stream resolves ok:false with its code', async () => {
    const { result } = await setup();
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.act({ type: 'render_pages' });
    });
    emit(lastStream(), { type: 'error', message: 'x', code: 'COOLDOWN' });
    await act(async () => lastStream().resolve());
    const out = actOutcomeOf(await p);
    expect(out).toMatchObject({ ok: false, code: 'COOLDOWN', gated: false });
    expect(stopsSequence(out)).toBe(true);
  });

  it('a transport failure resolves ok:false (never throws to the card)', async () => {
    const { result } = await setup();
    let p!: Promise<unknown>;
    act(() => {
      p = result.current.act({ type: 'render_cover' });
    });
    await act(async () => lastStream().reject(new StudioApiError('billing', 'Out of credit.', { status: 402 })));
    expect(actOutcomeOf(await p)).toMatchObject({ ok: false, error: 'Out of credit.' });
  });

  it('a duplicate click resolves skipped (no second stream); local edits resolve ok', async () => {
    const { result } = await setup();
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.act({ type: 'render_cover' });
      second = result.current.act({ type: 'render_cover' });
    });
    expect(streams).toHaveLength(1);
    expect(actOutcomeOf(await second)).toMatchObject({ ok: false, skipped: true });
    await finish(lastStream(), 6);
    expect(actOutcomeOf(await first)).toMatchObject({ ok: true });
    let local!: Promise<unknown>;
    act(() => {
      local = result.current.act({ type: 'patch', ops: [{ op: 'note_add', text: 'n' }] });
    });
    await waitFor(() => expect(streams).toHaveLength(2));
    await finish(lastStream(), 7);
    expect(actOutcomeOf(await local)).toMatchObject({ ok: true, gated: false });
  });

  it('void call sites keep working: actOutcomeOf(undefined) is null', () => {
    expect(actOutcomeOf(undefined)).toBeNull();
    expect(actOutcomeOf({ ok: true })).toBeNull();
  });
});

describe('useStudio — send() object form (the composer)', () => {
  it('sends inline photos, inbox paths, targets and an explicit focus in one turn', async () => {
    const { result } = await setup();
    const att = { name: 'a.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA' };
    act(() =>
      void result.current.send('These are Maya', {
        attachments: [att],
        inboxPaths: ['u/x/p/ref/b.webp'],
        attachmentTargets: [{ kind: 'character', id: 'c_maya' }, { kind: 'character', id: 'c_maya' }],
        focus: { pageId: 'pg_1' }
      })
    );
    expect(lastStream().req).toEqual({
      kind: 'message',
      text: 'These are Maya',
      attachments: [att, { inboxPath: 'u/x/p/ref/b.webp' }],
      attachmentTargets: [{ kind: 'character', id: 'c_maya' }, { kind: 'character', id: 'c_maya' }],
      focus: { pageId: 'pg_1' }
    });
  });
});

describe('useStudio — patches', () => {
  it('applies edits instantly and saves rapid edits as one ordered request', async () => {
    const { result } = await setup();
    act(() => {
      void result.current.patch([{ op: 'format', patch: { pageCount: 7 } }]);
      void result.current.patch([{ op: 'format', patch: { pageCount: 8 } }]);
    });
    expect(result.current.doc?.format.pageCount).toBe(8);
    await waitFor(() => expect(api.streamStudio).toHaveBeenCalledTimes(1));
    expect(lastStream().req).toEqual({
      kind: 'action',
      action: {
        type: 'patch',
        ops: [
          { op: 'format', patch: { pageCount: 7 } },
          { op: 'format', patch: { pageCount: 8 } }
        ]
      }
    });
    expect(result.current.busy).toBe(false); // saves are silent
    const s = lastStream();
    emit(s, { type: 'ops', rev: 6, ops: (s.req as { action: { ops: DocOp[] } }).action.ops });
    await finish(s, 6);
    expect(result.current.doc?.format.pageCount).toBe(8);
  });

  it('rolls back a rejected edit with a notice', async () => {
    const { result } = await setup();
    act(() => void result.current.patch([{ op: 'brief', patch: { title: 'Rejected' } }]));
    expect(result.current.doc?.brief.title).toBe('Rejected');
    await waitFor(() => expect(api.streamStudio).toHaveBeenCalledTimes(1));
    await act(async () => lastStream().reject(new StudioApiError('bad_request', 'That page is no longer in the plan.', { status: 400 })));
    expect(result.current.doc?.brief.title).toBe('Rooftop Heist');
    expect(result.current.error).toBe("Couldn't save your change. That page is no longer in the plan.");
  });

  it('a save refused inside the stream rolls back too', async () => {
    const { result } = await setup();
    act(() => void result.current.patch([{ op: 'brief', patch: { title: 'Nope' } }]));
    await waitFor(() => expect(api.streamStudio).toHaveBeenCalledTimes(1));
    emit(lastStream(), { type: 'error', message: 'Too many changes at once.' });
    await act(async () => lastStream().resolve());
    expect(result.current.doc?.brief.title).toBe('Rooftop Heist');
    expect(result.current.error).toBe("Couldn't save your change. Too many changes at once.");
  });

  it('act({type:"patch"}) goes through the same path', async () => {
    const { result } = await setup();
    act(() => void result.current.act({ type: 'patch', ops: [{ op: 'note_add', text: 'no gore' }] }));
    expect(result.current.doc?.brief.notes).toEqual(['no gore']);
  });
});

describe('useStudio — staying in sync', () => {
  it('refetches when a revision gap is not filled', async () => {
    const { result } = await setup();
    act(() => void result.current.act({ type: 'render_cover' }));
    const s = lastStream();
    emit(s, { type: 'ops', rev: 8, ops: [{ op: 'note_add', text: 'from the future' }] });
    expect(result.current.doc?.brief.notes).toEqual([]);
    api.loadStudioProject.mockResolvedValue({ doc: makeSampleDoc({ rev: 9, brief: { title: 'Synced', notes: [] } }), urls: {} });
    await finish(s, 9);
    await waitFor(() => expect(result.current.doc?.brief.title).toBe('Synced'));
    expect(api.loadStudioProject).toHaveBeenCalledTimes(2);
  });

  it('a lost connection says so and resyncs', async () => {
    const { result } = await setup();
    act(() => void result.current.act({ type: 'render_cover' }));
    api.loadStudioProject.mockResolvedValue({ doc: makeSampleDoc({ rev: 6 }), urls: {} });
    await act(async () => lastStream().reject(new StudioApiError('connection_lost', 'Connection lost — resyncing.')));
    expect(result.current.error).toBe('Connection lost — resyncing.');
    await waitFor(() => expect(api.loadStudioProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.doc?.rev).toBe(6));
  });

  it('follows the work on the board unless the user just picked a tab', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    const { result } = await setup();
    act(() => void result.current.act({ type: 'render_sheets' }));
    const s = lastStream();
    emit(s, { type: 'ops', rev: 6, ops: [{ op: 'render', target: { kind: 'sheet', id: 'c_arjun' }, patch: { status: 'queued' } }] });
    expect(result.current.tab).toBe('cast');

    act(() => result.current.setTab('story'));
    emit(s, { type: 'ops', rev: 7, ops: [{ op: 'style', patch: { name: 'X' } }] });
    expect(result.current.tab).toBe('story');

    now.mockReturnValue(1_000_000 + 21_000);
    emit(s, { type: 'ops', rev: 8, ops: [{ op: 'style', patch: { name: 'Y' } }] });
    expect(result.current.tab).toBe('style');

    act(() => result.current.openPage('pg_1'));
    expect(result.current.tab).toBe('pages');
    expect(result.current.focusedPageId).toBe('pg_1');
    now.mockReturnValue(1_000_000 + 60_000);
    emit(s, { type: 'ops', rev: 9, ops: [{ op: 'character', id: 'c_new', patch: { name: 'New' } }] });
    expect(result.current.tab).toBe('pages'); // a page is open: don't yank the user away
  });

  it('signs paths the stream has not delivered urls for yet', async () => {
    const { result } = await setup();
    api.signStudioUrls.mockResolvedValue({ 'u/x/p/new.webp': 'https://cdn.test/new' });
    expect(result.current.urlFor('u/x/p/new.webp')).toBeUndefined();
    await waitFor(() => expect(api.signStudioUrls).toHaveBeenCalledWith('proj_1', ['u/x/p/new.webp']));
    await waitFor(() => expect(result.current.urlFor('u/x/p/new.webp')).toBe('https://cdn.test/new'));
  });

  it('re-signs when an image fails to load', async () => {
    const { result } = await setup();
    api.signStudioUrls.mockResolvedValue({ 'u/x/p/pg_1.webp': 'https://cdn.test/pg_1?v=2' });
    const img = document.createElement('img');
    img.src = 'https://cdn.test/pg_1';
    document.body.appendChild(img);
    act(() => {
      img.dispatchEvent(new Event('error'));
    });
    await waitFor(() => expect(api.signStudioUrls).toHaveBeenCalledWith('proj_1', ['u/x/p/pg_1.webp']));
    await waitFor(() => expect(result.current.urlFor('u/x/p/pg_1.webp')).toBe('https://cdn.test/pg_1?v=2'));
    img.remove();
  });
});

describe('useStudio — cancel and cleanup', () => {
  it('cancel asks the server to stop and shows stopping until streams end', async () => {
    const { result } = await setup();
    act(() => void result.current.send('go'));
    await act(async () => result.current.cancel());
    expect(api.cancelStudio).toHaveBeenCalledWith('proj_1');
    expect(result.current.cancelling).toBe(true);
    await finish(lastStream(), 5);
    expect(result.current.cancelling).toBe(false);
  });

  it('if the server cannot be reached, stop listening locally and resync', async () => {
    const { result } = await setup();
    act(() => void result.current.act({ type: 'render_pages' }));
    const s = lastStream();
    api.cancelStudio.mockRejectedValue(new StudioApiError('network', "Couldn't reach the studio server."));
    await act(async () => result.current.cancel());
    expect(s.signal?.aborted).toBe(true);
    expect(result.current.error).toMatch(/Couldn't stop the studio cleanly/);
    await waitFor(() => expect(api.loadStudioProject).toHaveBeenCalledTimes(2));
  });

  it('unmounting aborts open streams', async () => {
    const hook = await setup();
    act(() => void hook.result.current.send('bye'));
    const s = lastStream();
    hook.unmount();
    expect(s.signal?.aborted).toBe(true);
  });

  it('flushes a pending edit on unmount instead of dropping it', async () => {
    const hook = await setup();
    // A rename queued behind the debounce (e.g. blur-then-Back): nothing sent yet.
    act(() => void hook.result.current.patch([{ op: 'brief', patch: { title: 'Saved on exit' } }]));
    expect(api.streamStudio).not.toHaveBeenCalled();
    hook.unmount();
    // Unmount sends the queued edit to the server rather than discarding it.
    await waitFor(() => expect(api.streamStudio).toHaveBeenCalledTimes(1));
    expect(lastStream().req).toEqual({
      kind: 'action',
      action: { type: 'patch', ops: [{ op: 'brief', patch: { title: 'Saved on exit' } }] }
    });
  });

  it('lets an in-flight save finish when unmounting instead of aborting it', async () => {
    const hook = await setup();
    act(() => void hook.result.current.patch([{ op: 'brief', patch: { title: 'In flight' } }]));
    await waitFor(() => expect(api.streamStudio).toHaveBeenCalledTimes(1));
    const s = lastStream();
    hook.unmount();
    expect(s.signal?.aborted).toBe(false);
  });
});
