// useStudio (P1-CLIENTSTATE): undo/redo end to end against a fake server that applies patches and
// echoes them like the real one. Acceptance: undoing a director lettering change restores the exact
// previous doc. Also: coalescing, typed "undo" interception, rejected saves, project switch,
// optimistic render_use, caps-based BYOK, variant URLs, reader/share requests, publication refresh.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { StreamRequest, StudioEvent } from '../../shared/comic/events';
import { applyOps, type DocOp } from '../../shared/comic/ops';
import { normalizeDoc, type ComicDoc } from '../../shared/comic/doc';
import { DEFAULT_CAPS, resolveStudioCaps } from '../../shared/comic/capabilities';
import { makeSampleDoc } from './board/__fixtures__/sampleDoc';
import { comparable, mulberry32, randomLetteringOp } from './useUndo.testkit';

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

import { useStudio } from './useStudio';

// ── Fake server ──────────────────────────────────────────────────────────────

let server: ComicDoc;
let requests: StreamRequest[];
/** Director batches the next message turn commits ({ops, label}). */
let directorQueue: { ops: DocOp[]; label?: string }[];
/** The next patch request is refused in-stream with this code. */
let rejectNextPatch: { code: string; message: string } | null;

const T = 1_760_000_200_000;
const patchRequests = () => requests.filter((r) => r.kind === 'action' && r.action.type === 'patch') as Extract<StreamRequest, { kind: 'action' }>[];
const messageRequests = () => requests.filter((r) => r.kind === 'message');
/** Content only: revision and conversation/spend history are not part of an undo. */
const content = (doc: ComicDoc | null | undefined) => comparable({ ...(doc as ComicDoc), rev: 0, conversation: [], spend: { totalUsd: 0, byKind: {}, entries: [] } });

const commit = (ops: DocOp[]) => {
  server = { ...applyOps(server, ops, T), rev: server.rev + 1 };
  return server.rev;
};

const setup = async (opts: { doc?: ComicDoc; caps?: ReturnType<typeof resolveStudioCaps> | null; urls?: Record<string, string> } = {}) => {
  server = opts.doc ?? normalizeDoc(makeSampleDoc());
  api.loadStudioProject.mockImplementation(async () => ({ doc: server, urls: opts.urls ?? {}, ...(opts.caps ? { caps: opts.caps } : {}) }));
  const hook = renderHook(({ id }) => useStudio(id), { initialProps: { id: 'proj_1' } });
  await waitFor(() => expect(hook.result.current.doc).not.toBeNull());
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
  directorQueue = [];
  rejectNextPatch = null;
  window.localStorage.clear();
  api.loadStudioProject.mockReset();
  api.signStudioUrls.mockReset().mockResolvedValue({});
  api.cancelStudio.mockReset().mockResolvedValue(undefined);
  api.uploadStudioRef.mockReset();
  api.getPublication.mockReset();
  api.streamStudio.mockReset().mockImplementation(async (_id: string, req: StreamRequest, onEvent: (e: StudioEvent) => void) => {
    requests.push(req);
    if (req.kind === 'action' && req.action.type === 'patch') {
      if (rejectNextPatch) {
        const { code, message } = rejectNextPatch;
        rejectNextPatch = null;
        onEvent({ type: 'error', message, code });
        return;
      }
      const ops = req.action.ops;
      onEvent({ type: 'ops', rev: commit(ops), ops, origin: 'user' });
    } else if (req.kind === 'message') {
      for (const b of directorQueue.splice(0)) onEvent({ type: 'ops', rev: commit(b.ops), ops: b.ops, origin: 'director', ...(b.label ? { label: b.label } : {}) });
    }
    onEvent({ type: 'done', rev: server.rev, spentUsd: 0 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Acceptance ───────────────────────────────────────────────────────────────

describe('director edits are undoable', () => {
  it('ACCEPTANCE: undo of a director lettering change restores the exact previous doc (random batches)', async () => {
    const { result } = await setup();
    const r = mulberry32(42);
    for (let i = 0; i < 12; i += 1) {
      const before = result.current.doc!;
      const ops = Array.from({ length: 2 + Math.floor(r() * 3) }, () => randomLetteringOp(before, r));
      directorQueue.push({ ops, label: `Restyle the balloons (${i})` });
      await act(async () => {
        await result.current.send('make the lettering pop');
      });
      await waitFor(() => expect(result.current.canUndo).toBe(true));
      expect(result.current.undoLabel).toBe(`restyle the balloons (${i})`);
      expect(content(result.current.doc)).toEqual(content(applyOps(before, ops, T)));

      act(() => result.current.undo());
      // Instant (optimistic) …
      expect(content(result.current.doc)).toEqual(content(before));
      await settle(result);
      // … and saved: the server's doc is the exact previous doc too.
      expect(content(server)).toEqual(content(before));
      expect(content(result.current.doc)).toEqual(content(before));
      expect(result.current.canRedo).toBe(true);
    }
    // The director was asked 12 times; undo never called it.
    expect(messageRequests()).toHaveLength(12);
  });

  it('one "undo" undoes the whole director reply, however many batches it committed', async () => {
    const { result } = await setup();
    const before = result.current.doc!;
    directorQueue.push(
      { ops: [{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { shape: 'burst' } }], label: 'Restyle a balloon' },
      { ops: [{ op: 'letter_style', patch: { presetId: 'manga' } }], label: 'Switch to manga lettering' },
      { ops: [{ op: 'balloon', pageId: 'pg_5', lineId: 'pg_5_l1', patch: { x: 0.5 } }] }
    );
    await act(async () => {
      await result.current.send('make it feel like a manga');
    });
    await waitFor(() => expect(result.current.undoLabel).toBe('restyle a balloon, switch to manga lettering, move a balloon'));
    await act(async () => {
      await result.current.send('undo');
    });
    expect(content(result.current.doc)).toEqual(content(before));
    await settle(result);
    expect(content(server)).toEqual(content(before));
    expect(result.current.canUndo).toBe(false);
  });

  it('redo re-applies a director change; a director batch without editable ops is not undoable', async () => {
    const { result } = await setup();
    const before = result.current.doc!;
    const ops: DocOp[] = [{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { fill: '#e63946', shape: 'jagged' } }];
    directorQueue.push({ ops, label: 'Red shouts' });
    await act(async () => {
      await result.current.send('make the shouting bubbles red');
    });
    await waitFor(() => expect(result.current.canUndo).toBe(true));
    act(() => result.current.undo());
    await settle(result);
    act(() => result.current.redo());
    expect(content(result.current.doc)).toEqual(content(applyOps(before, ops, T)));
    await settle(result);
    expect(content(server)).toEqual(content(applyOps(before, ops, T)));

    directorQueue.push({ ops: [{ op: 'memory', text: 'likes red' }] });
    await act(async () => {
      await result.current.send('remember that I like red');
    });
    expect(result.current.undoLabel).toBe('red shouts'); // unchanged
  });
});

// ── User edits ───────────────────────────────────────────────────────────────

describe('user edits', () => {
  it('a patch is undoable by default; undo/redo re-patch the inverse/forward ops', async () => {
    const { result } = await setup();
    const before = result.current.doc!;
    await act(async () => {
      await result.current.patch([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { text: 'Talk. Now.' } }], { label: 'Edit dialogue' });
    });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.undoLabel).toBe('edit dialogue');
    act(() => result.current.undo());
    expect(content(result.current.doc)).toEqual(content(before));
    await settle(result);
    expect(content(server)).toEqual(content(before));
    expect(result.current.canUndo).toBe(false);
    expect(result.current.redoLabel).toBe('edit dialogue');
    act(() => result.current.redo());
    await settle(result);
    expect(server.pages[0].panels[2].lines[1].text).toBe('Talk. Now.');
    // undo:false edits are never recorded (the timeline's own toast does that).
    await act(async () => {
      await result.current.patch([{ op: 'plan_status', status: 'approved' }], { undo: false });
    });
    expect(result.current.undoLabel).toBe('edit dialogue');
  });

  it('a drag coalesces into one undo entry that restores where it started', async () => {
    const { result } = await setup();
    const before = result.current.doc!;
    act(() => {
      for (let i = 1; i <= 6; i += 1) {
        void result.current.patch([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { x: 0.1 * i, y: 0.05 * i } }], {
          label: 'Move balloon',
          coalesce: 'balloon:pg_1:pg_1_l2'
        });
      }
    });
    await settle(result);
    act(() => result.current.undo());
    expect(content(result.current.doc)).toEqual(content(before));
    await settle(result);
    expect(result.current.canUndo).toBe(false);
    // The undo went out as ONE small patch (compacted), not six.
    expect(patchRequests().at(-1)!.action).toEqual({ type: 'patch', ops: [{ op: 'balloons', pageId: 'pg_1', balloons: before.pages[0].balloons }] });
  });

  it('a typed "undo" is intercepted locally and never sent to the director', async () => {
    const { result } = await setup();
    const before = result.current.doc!;
    await act(async () => {
      await result.current.send('Undo');
    });
    expect(result.current.notice).toMatchObject({ kind: 'info' });
    await act(async () => {
      await result.current.patch([{ op: 'page', id: 'pg_2', patch: { summary: 'A quieter beat' } }], { label: 'Edit page' });
    });
    await act(async () => {
      await result.current.send('  undo that. ');
    });
    expect(messageRequests()).toHaveLength(0);
    expect(content(result.current.doc)).toEqual(content(before));
    expect(result.current.notice).toMatchObject({ kind: 'undo', text: 'Undid: edit page.', action: 'redo' });
    act(() => result.current.clearNotice?.());
    expect(result.current.notice).toBeNull();
    // Anything longer is a real request for the director.
    await act(async () => {
      await result.current.send('undo the last page and make it funnier');
    });
    expect(messageRequests()).toHaveLength(1);
  });

  it('a rejected save drops its undo entry and shows calm copy; a failed undo goes back on the stack', async () => {
    const { result } = await setup();
    rejectNextPatch = { code: 'CONTENT_POLICY', message: 'TypeError: blocked' };
    await act(async () => {
      await result.current.patch([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { text: 'something rude' } }]);
    });
    await waitFor(() => expect(result.current.error).toMatch(/Couldn't save your change/));
    expect(result.current.error).not.toMatch(/TypeError/);
    expect(result.current.errorCode).toBe('CONTENT_POLICY');
    expect(result.current.canUndo).toBe(false);

    await act(async () => {
      await result.current.patch([{ op: 'page', id: 'pg_2', patch: { summary: 'Beat' } }], { label: 'Edit page' });
    });
    rejectNextPatch = { code: 'CONFLICT', message: "That's busy right now — try again once the current drawing finishes." };
    await act(async () => {
      result.current.undo();
    });
    await waitFor(() => expect(result.current.canUndo).toBe(true));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.undoLabel).toBe('edit page');
  });

  it('a project switch clears the stack', async () => {
    const hook = await setup();
    await act(async () => {
      await hook.result.current.patch([{ op: 'plan_status', status: 'approved' }]);
    });
    expect(hook.result.current.canUndo).toBe(true);
    hook.rerender({ id: 'proj_2' });
    expect(hook.result.current.canUndo).toBe(false);
    expect(hook.result.current.canRedo).toBe(false);
  });

  it('restore_render is an instant, undoable render_use patch', async () => {
    const { result } = await setup();
    await act(async () => {
      await result.current.act({ type: 'restore_render', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old' });
    });
    const sent = patchRequests().at(-1)!.action;
    expect(sent).toMatchObject({ type: 'patch', ops: [{ op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old' }] });
    expect(result.current.doc!.pages[0].render.asset?.path).toBe('u/proj/pages/p1.png.old');
    expect(result.current.undoLabel).toBe('switch versions');
    act(() => result.current.undo());
    expect(result.current.doc!.pages[0].render.asset?.path).toBe('u/proj/pages/p1.png');
    await settle(result);
  });
});

// ── Caps, variants, client actions, publication ──────────────────────────────

describe('caps and BYOK', () => {
  it('BYOK comes from caps; the spend heuristic is only the fallback when the server sent no caps', async () => {
    // The sample doc's latest image spend was paid with an own key.
    const withCaps = await setup({ caps: resolveStudioCaps({ planId: 'free', byok: false, isAdmin: false }) });
    expect(withCaps.result.current.byok).toBe(false);
    withCaps.unmount();
    const offline = await setup({ caps: null });
    expect(offline.result.current.caps).toEqual(DEFAULT_CAPS);
    expect(offline.result.current.byok).toBe(true);
  });
});

describe('urlFor variants', () => {
  it('picks the smallest variant ≥ width × min(dpr, 2); no width ⇒ the original', async () => {
    const doc = normalizeDoc(
      makeSampleDoc((d) => {
        d.pages[0].render.asset = {
          ...d.pages[0].render.asset!,
          variants: [
            { path: 'u/proj/pages/p1.480.webp', w: 480, h: 720 },
            { path: 'u/proj/pages/p1.1080.webp', w: 1080, h: 1620 }
          ]
        };
      })
    );
    const urls = { 'u/proj/pages/p1.png': 'https://cdn/p1', 'u/proj/pages/p1.480.webp': 'https://cdn/p1-480', 'u/proj/pages/p1.1080.webp': 'https://cdn/p1-1080' };
    const { result } = await setup({ doc, urls });
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(3);
    const asset = result.current.doc!.pages[0].render.asset!;
    expect(result.current.urlFor(asset)).toBe('https://cdn/p1');
    expect(result.current.urlFor(asset, { width: 200 })).toBe('https://cdn/p1-480'); // 200 × 2 = 400
    expect(result.current.urlFor(asset, { width: 400 })).toBe('https://cdn/p1-1080'); // 800
    expect(result.current.urlFor(asset, { width: 800 })).toBe('https://cdn/p1'); // 1600 > every variant
    // A bare path string finds the asset's variants in the doc.
    expect(result.current.urlFor('u/proj/pages/p1.png', { width: 200 })).toBe('https://cdn/p1-480');
  });

  it('shows the original while a variant signs, and falls back for good when the server will not sign it', async () => {
    const doc = normalizeDoc(
      makeSampleDoc((d) => {
        d.pages[0].render.asset = { ...d.pages[0].render.asset!, variants: [{ path: 'u/proj/pages/p1.480.webp', w: 480, h: 720 }] };
      })
    );
    const { result } = await setup({ doc, urls: { 'u/proj/pages/p1.png': 'https://cdn/p1' } });
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(1);
    const asset = result.current.doc!.pages[0].render.asset!;
    api.signStudioUrls.mockResolvedValueOnce({});
    expect(result.current.urlFor(asset, { width: 300 })).toBe('https://cdn/p1');
    await waitFor(() => expect(api.signStudioUrls).toHaveBeenCalledWith('proj_1', ['u/proj/pages/p1.480.webp']));
    await waitFor(() => expect(result.current.urlFor(asset, { width: 300 })).toBe('https://cdn/p1'));
    expect(api.signStudioUrls).toHaveBeenCalledTimes(1);
  });
});

describe('client actions', () => {
  it('open_reader raises a reader request; open_share asks the Share sheet to open', async () => {
    const { result } = await setup();
    act(() => result.current.runClientAction({ type: 'open_reader', immersive: true }));
    expect(result.current.tab).toBe('read');
    expect(result.current.readerRequest).toEqual({ seq: 1, immersive: true, guided: false });
    act(() => result.current.runClientAction({ type: 'open_reader', guided: true }));
    expect(result.current.readerRequest).toEqual({ seq: 2, immersive: false, guided: true });

    act(() => result.current.setTab('cast'));
    const onOpen = vi.fn((e: Event) => e.preventDefault());
    window.addEventListener('ds:open-share', onOpen);
    act(() => result.current.runClientAction({ type: 'open_share' }));
    window.removeEventListener('ds:open-share', onOpen);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(result.current.tab).toBe('cast'); // handled by the sheet: the board stays put
    act(() => result.current.runClientAction({ type: 'open_share' }));
    expect(result.current.tab).toBe('read'); // nobody listening: the Read tab, where sharing lives
  });
});

describe('publication', () => {
  it('refreshes the owner view when the doc mirror changes, only once it was asked for', async () => {
    const { result } = await setup();
    const view = { visibility: 'unlisted', status: 'live', slug: 'abcdefghijklmnopq', languages: ['en'] };
    api.getPublication.mockResolvedValue(view);
    const mirror = { status: 'live' as const, visibility: 'unlisted' as const, publishedRev: 12, publishedAt: T, languages: ['en'] };

    directorQueue.push({ ops: [{ op: 'publication', value: mirror }] });
    await act(async () => {
      await result.current.send('publish it');
    });
    expect(api.getPublication).not.toHaveBeenCalled(); // nobody asked yet

    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = result.current.refreshPublication();
      second = result.current.refreshPublication();
    });
    expect(second).toBe(first); // one request for concurrent callers
    expect(result.current.publicationLoading).toBe(true);
    await act(async () => {
      await first;
    });
    expect(result.current.publication).toEqual(view);
    expect(result.current.publicationLoading).toBe(false);
    expect(api.getPublication).toHaveBeenCalledTimes(1);

    directorQueue.push({ ops: [{ op: 'publication', value: null }] });
    await act(async () => {
      await result.current.send('unpublish it');
    });
    await waitFor(() => expect(api.getPublication).toHaveBeenCalledTimes(2));
  });
});
