// useStudio — the Comic Studio (v4) controller: mirrored doc, live streams, URL cache.
//
// One hook instance per open project. It loads the doc, runs director turns and UI
// actions as SSE streams (studioApi.streamStudio) and folds every event into the pure
// studioReducer. Rules it enforces:
//   - One director turn at a time; actions (renders, gates, picks) may run alongside it.
//   - Content edits (patch) apply instantly and are saved in order: rapid edits coalesce
//     into one request, and a rejected edit rolls back with a notice.
//   - Signed URLs are cached with their expiry and re-signed lazily (when rendered with
//     < 5 min left, or when an <img> fails to load) — never on an idle timer, so an open
//     tab doesn't keep the backend awake.
//   - When the client may have missed changes (rev gap, broken stream, renders running
//     with no stream attached after a reload) it refetches, bounded and only while needed.
//
// v5 seams (contract §13.1, wave 0 / P0-C): caps, the Easy/Pro view, selection, next-step
// chips, client actions, ref uploads and the lazily fetched publication work minimally here;
// undo/redo are inert (canUndo stays false) until P1-CLIENTSTATE lands useUndo.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { DocOp, StudioAction } from '../../shared/comic/ops';
import type { StreamRequest, StudioFocus } from '../../shared/comic/events';
import type { AssetRef, ClientAction, NextStep, RefOwner, RenderTarget } from '../../shared/comic/doc';
import { DEFAULT_CAPS, type StudioCaps, type StudioMode } from '../../shared/comic/capabilities';
import type { PublicationOwnerView } from '../../shared/comic/publication';
import type {
  BoardTab,
  PatchOptions,
  PendingAttachment,
  RefUploadOptions,
  RefUploadResult,
  SendOptions,
  StudioController,
  StudioSelection
} from './types';
import {
  cancelStudio,
  getPublication,
  isAbortError,
  loadStudioProject,
  signStudioUrls,
  streamStudio,
  toStudioApiError,
  uploadStudioRef
} from './studioApi';
import {
  assetPath,
  initialStudioState,
  isDirectUrl,
  isMessageBusy,
  isTargetRendering,
  needsRefresh,
  renderingCount,
  studioReducer,
  tabForOps,
  urlIsFresh,
  visibleStreams,
  type PendingUserMessage,
  type StreamKind,
  type StudioState
} from './studioReducer';

/** Extra state the conversation pane uses on top of the shared StudioController contract. */
export interface ComicStudioController extends StudioController {
  /** A director turn is streaming (the composer waits; actions may still run). */
  messageBusy: boolean;
  /** The user's message, shown until the server records it (or marked failed). */
  pendingMessage: PendingUserMessage | null;
  retryPendingMessage(): void;
  dismissPendingMessage(): void;
  /** Stop was requested; streams are winding down. */
  cancelling: boolean;
  refreshing: boolean;
  /** USD the last finished turn/job reported. */
  lastSpentUsd: number | null;
  /** Best guess whether images are paid with the user's own key (from the latest image spend). */
  byok: boolean;
  /** Pages + sheets + options + cover currently queued or drawing. */
  renderingTotal: number;
}

/** Don't auto-switch the board tab within this long of the user picking one. */
export const MANUAL_TAB_HOLD_MS = 20_000;
/** Debounce for signing paths the stream hasn't delivered URLs for yet. */
const SIGN_DEBOUNCE_MS = 600;
/** Give up re-signing a path after this many failed attempts (until reload). */
const MAX_SIGN_ATTEMPTS = 3;
/** Coalesce rapid edits (steppers, toggles) into one save. */
const PATCH_DEBOUNCE_MS = 150;
const MAX_PATCH_OPS = 200;
/** A rev gap may be filled by another open stream; wait this long before refetching. */
const GAP_GRACE_MS = 1500;
/** Renders in flight with no stream attached (page reload mid-render): poll the doc. */
const RENDER_WATCH_INTERVAL_MS = 8_000;
const RENDER_WATCH_MAX_POLLS = 45;
/** Safety: clear "Stopping…" if the server never closes the streams. */
const CANCEL_SAFETY_MS = 20_000;

const IMAGE_SPEND_KINDS = new Set(['style', 'sheet', 'page', 'edit', 'cover']);

/** localStorage key of the Easy/Pro view (contract §13.5). */
export const MODE_STORAGE_KEY = 'comicstudio.mode';
/** Inbox paths per message (the server enforces the same cap). */
const MAX_INBOX_ATTACHMENTS = 12;
/** StudioFocus.lineIds cap. */
const MAX_FOCUS_LINES = 80;

const readStoredMode = (): StudioMode | null => {
  try {
    const v = typeof window !== 'undefined' ? window.localStorage.getItem(MODE_STORAGE_KEY) : null;
    return v === 'easy' || v === 'pro' ? v : null;
  } catch {
    return null;
  }
};

const writeStoredMode = (mode: StudioMode) => {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* not persisted (private mode, blocked storage) */
  }
};

/** The view a user gets: their pick, else the plan default; Pro needs the proEditor capability. */
export const resolveStudioMode = (stored: StudioMode | null, caps: StudioCaps): StudioMode => {
  const mode = stored ?? caps.defaultMode;
  return mode === 'pro' && !caps.proEditor ? 'easy' : mode;
};

/** The turn focus a selection implies (what the user is looking at when they send). */
export const focusFromSelection = (sel: StudioSelection | null): StudioFocus | undefined => {
  if (!sel || !sel.pageId) return undefined;
  const lineIds = sel.lineIds.filter((id) => typeof id === 'string' && id).slice(0, MAX_FOCUS_LINES);
  return {
    pageId: sel.pageId,
    ...(lineIds.length ? { lineIds } : {}),
    ...(typeof sel.panelN === 'number' ? { panelN: sel.panelN } : {}),
    surface: sel.surface
  };
};

let localSeq = 0;
const localId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(localSeq = (localSeq + 1) % 1e6).toString(36)}`;

/** Clearing an optional field (null) doesn't survive the JSON ops echo — resync after such saves. */
const hasClearIntent = (ops: DocOp[]) =>
  ops.some((op) => {
    const patch = (op as { patch?: unknown }).patch;
    return !!patch && typeof patch === 'object' && Object.values(patch as Record<string, unknown>).some((v) => v === null);
  });

const initialTabFor = (state: StudioState): BoardTab => {
  const doc = state.base;
  if (!doc) return 'story';
  if (doc.pages.length) return 'pages';
  if (doc.style.options.length && doc.style.status !== 'locked') return 'style';
  if (doc.cast.length) return 'cast';
  return 'story';
};

interface QueuedPatch {
  id: string;
  ops: DocOp[];
  resolve: () => void;
}

export function useStudio(projectId: string): ComicStudioController {
  const [state, dispatch] = useReducer(studioReducer, undefined, initialStudioState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const projectRef = useRef(projectId);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const controllersRef = useRef(new Map<string, { ctrl: AbortController; kind: StreamKind }>());
  const messageInFlightRef = useRef(false);
  const actionsInFlightRef = useRef(new Set<string>());
  const patchQueueRef = useRef<QueuedPatch[]>([]);
  const patchInFlightRef = useRef(false);
  const patchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshPromiseRef = useRef<Promise<void> | null>(null);
  const cancelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [tab, setTabState] = useState<BoardTab>('story');
  const [focusedPageId, setFocusedPageId] = useState<string | null>(null);
  const [caps, setCaps] = useState<StudioCaps>(DEFAULT_CAPS);
  const [storedMode, setStoredMode] = useState<StudioMode | null>(readStoredMode);
  const [selection, setSelectionState] = useState<StudioSelection | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [publication, setPublication] = useState<PublicationOwnerView | null>(null);
  const manualTabAtRef = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const focusedRef = useRef(focusedPageId);
  focusedRef.current = focusedPageId;

  /** Dispatch only while this hook instance still shows the same project load. */
  const guarded = useCallback((generation: number) => {
    return (action: Parameters<typeof dispatch>[0]) => {
      if (mountedRef.current && generation === generationRef.current) dispatch(action);
    };
  }, []);

  const abortStreams = useCallback((filter?: (kind: StreamKind) => boolean) => {
    for (const [id, entry] of [...controllersRef.current]) {
      if (filter && !filter(entry.kind)) continue;
      entry.ctrl.abort();
      controllersRef.current.delete(id);
    }
  }, []);

  // ── Load ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    projectRef.current = projectId;
    const generation = ++generationRef.current;
    const d = guarded(generation);
    const ctrl = new AbortController();
    abortStreams();
    messageInFlightRef.current = false;
    actionsInFlightRef.current.clear();
    patchQueueRef.current.splice(0).forEach((p) => p.resolve());
    patchInFlightRef.current = false;
    refreshPromiseRef.current = null;
    manualTabAtRef.current = 0;
    setFocusedPageId(null);
    setSelectionState(null);
    setPublication(null);
    dispatch({ type: 'load_start' });

    loadStudioProject(projectId, { signal: ctrl.signal })
      .then(({ doc, urls, caps: loadedCaps }) => {
        if (loadedCaps && mountedRef.current && generation === generationRef.current) setCaps(loadedCaps);
        d({ type: 'load_success', doc, urls, now: Date.now() });
      })
      .catch((err) => {
        if (isAbortError(err)) return;
        d({ type: 'load_error', message: toStudioApiError(err, 'project').message });
      });

    return () => {
      ctrl.abort();
    };
  }, [projectId, guarded, abortStreams]);

  // Pick a sensible board tab once the doc first arrives.
  const loadedDocId = state.base?.id;
  useEffect(() => {
    if (!loadedDocId) return;
    setTabState(initialTabFor(stateRef.current));
  }, [loadedDocId]);

  // ── Refresh ────────────────────────────────────────────────────────────────

  const refresh = useCallback((): Promise<void> => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    const id = projectRef.current;
    const d = guarded(generationRef.current);
    d({ type: 'refresh_start' });
    const generation = generationRef.current;
    const work = loadStudioProject(id)
      .then(({ doc, urls, caps: loadedCaps }) => {
        if (loadedCaps && mountedRef.current && generation === generationRef.current) setCaps(loadedCaps);
        d({ type: 'refresh_success', doc, urls, now: Date.now() });
      })
      .catch((err) => {
        const e = toStudioApiError(err, 'project');
        d({ type: 'refresh_error', message: stateRef.current.base ? `Couldn't resync the comic. ${e.message}` : e.message });
      })
      .finally(() => {
        if (refreshPromiseRef.current === work) refreshPromiseRef.current = null;
      });
    refreshPromiseRef.current = work;
    return work;
  }, [guarded]);

  // ── Streams ────────────────────────────────────────────────────────────────

  const runStream = useCallback(
    async (kind: StreamKind, request: StreamRequest, opts: { streamId?: string; actionType?: string } = {}) => {
      const generation = generationRef.current;
      const d = guarded(generation);
      const streamId = opts.streamId || localId('stream');
      const ctrl = new AbortController();
      controllersRef.current.set(streamId, { ctrl, kind });
      d({ type: 'stream_start', streamId, kind, ...(opts.actionType ? { actionType: opts.actionType } : {}), now: Date.now() });
      let error: string | undefined;
      let reported: string | undefined;
      let aborted = false;
      try {
        await streamStudio(
          projectRef.current,
          request,
          (event) => {
            // The server can refuse inside the stream (an `error` event, then close).
            if (event.type === 'error') reported = event.message;
            d({ type: 'stream_event', streamId, event, now: Date.now() });
          },
          ctrl.signal
        );
      } catch (err) {
        if (isAbortError(err)) aborted = true;
        else error = toStudioApiError(err, 'project').message;
      } finally {
        controllersRef.current.delete(streamId);
        d({ type: 'stream_end', streamId, ...(error ? { error } : {}), aborted, now: Date.now() });
      }
      return { ok: !error && !aborted && !reported, error: error || reported, aborted };
    },
    [guarded]
  );

  const send = useCallback(
    async (text: string, opts?: SendOptions | PendingAttachment[]) => {
      // Overloaded: the legacy (text, PendingAttachment[]) form stays valid.
      const o: SendOptions = Array.isArray(opts) ? { attachments: opts } : opts || {};
      const clean = (text || '').trim();
      const files = (o.attachments || []).filter((a) => a && typeof a.dataUrl === 'string' && a.dataUrl);
      const inbox = [...new Set((o.inboxPaths || []).filter((p) => typeof p === 'string' && p))].slice(0, MAX_INBOX_ATTACHMENTS);
      if (!clean && !files.length && !inbox.length) return;
      if (messageInFlightRef.current || !stateRef.current.base) return;
      messageInFlightRef.current = true;
      const streamId = localId('stream');
      dispatch({
        type: 'message_pending',
        message: { id: localId('pending'), text: clean, attachments: files, at: Date.now(), status: 'sending', streamId }
      });
      const attachments = [...files, ...inbox.map((inboxPath) => ({ inboxPath }))];
      const targets = Array.isArray(o.attachmentTargets) && o.attachmentTargets.length ? o.attachmentTargets : undefined;
      const focus = o.focus === 'selection' ? focusFromSelection(selectionRef.current) : o.focus;
      const generation = generationRef.current;
      try {
        await runStream(
          'message',
          {
            kind: 'message',
            text: clean,
            ...(attachments.length ? { attachments } : {}),
            ...(targets ? { attachmentTargets: targets } : {}),
            ...(focus ? { focus } : {})
          },
          { streamId }
        );
      } finally {
        if (generation === generationRef.current) messageInFlightRef.current = false;
      }
    },
    [runStream]
  );

  const retryPendingMessage = useCallback(() => {
    const pending = stateRef.current.pendingMessage;
    if (!pending || pending.status !== 'failed' || messageInFlightRef.current) return;
    dispatch({ type: 'message_dismiss' });
    void send(pending.text, pending.attachments);
  }, [send]);

  const dismissPendingMessage = useCallback(() => dispatch({ type: 'message_dismiss' }), []);

  // ── Patches ────────────────────────────────────────────────────────────────

  const flushPatches = useCallback(async (): Promise<void> => {
    if (patchTimerRef.current) {
      clearTimeout(patchTimerRef.current);
      patchTimerRef.current = null;
    }
    if (patchInFlightRef.current || !patchQueueRef.current.length) return;
    const generation = generationRef.current;
    // Take queued edits in order, up to the server's per-request op limit.
    const batch: QueuedPatch[] = [];
    let count = 0;
    while (patchQueueRef.current.length) {
      const next = patchQueueRef.current[0];
      if (batch.length && count + next.ops.length > MAX_PATCH_OPS) break;
      batch.push(patchQueueRef.current.shift()!);
      count += next.ops.length;
    }
    const ops = batch.flatMap((b) => b.ops);
    patchInFlightRef.current = true;
    const result = await runStream('patch', { kind: 'action', action: { type: 'patch', ops } }, { actionType: 'patch' });
    if (generation !== generationRef.current) return; // project switched; queue already reset
    patchInFlightRef.current = false;
    guarded(generation)({
      type: 'patch_settled',
      ids: batch.map((b) => b.id),
      ...(result.error ? { error: `Couldn't save your change. ${result.error}` } : {}),
      now: Date.now()
    });
    batch.forEach((b) => b.resolve());
    // Don't fire a resync GET after the component is gone (unmount flushes a final batch).
    if (mountedRef.current && (result.ok ? hasClearIntent(ops) : result.aborted)) void refresh();
    if (patchQueueRef.current.length) void flushPatches();
  }, [guarded, refresh, runStream]);

  // Unmount: stop everything, but flush pending edits instead of dropping them. A rename
  // (or any blur-commit) followed immediately by Back queues an edit behind the 150 ms
  // debounce; discarding it silently lost the user's change. flushPatches clears the timer
  // and sends the queue now. An in-flight save is left running (abort everything but patch)
  // so it finishes; its completion chains the remaining batch. Dispatches are guarded no-ops
  // once unmounted, so the folded-in state updates are harmless — only the network save matters.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
      abortStreams((kind) => kind !== 'patch');
      void flushPatches();
    };
  }, [abortStreams, flushPatches]);

  // PatchOptions (undo/coalesce/label) feed the undo stack, which P1-CLIENTSTATE adds.
  const patch = useCallback(
    (ops: DocOp[], _opts?: PatchOptions): Promise<void> => {
      const list = (ops || []).filter((op) => op && typeof op.op === 'string');
      if (!list.length || !stateRef.current.base) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const id = localId('patch');
        dispatch({ type: 'patch_local', patch: { id, ops: list }, now: Date.now() });
        patchQueueRef.current.push({ id, ops: list, resolve });
        if (patchTimerRef.current) clearTimeout(patchTimerRef.current);
        patchTimerRef.current = setTimeout(() => void flushPatches(), PATCH_DEBOUNCE_MS);
      });
    },
    [flushPatches]
  );

  // ── Cancel ─────────────────────────────────────────────────────────────────

  const cancel = useCallback(async () => {
    if (stateRef.current.cancelling) return;
    const generation = generationRef.current;
    const d = guarded(generation);
    d({ type: 'cancel_start' });
    if (cancelTimerRef.current) clearTimeout(cancelTimerRef.current);
    // The server stops the director and queued renders; images already drawing finish
    // (they are paid) and the streams close once they land.
    cancelTimerRef.current = setTimeout(() => d({ type: 'cancel_end' }), CANCEL_SAFETY_MS);
    try {
      await cancelStudio(projectRef.current);
      if (!controllersRef.current.size) d({ type: 'cancel_end' });
    } catch (err) {
      // Couldn't reach the server: stop listening locally and resync what really happened.
      abortStreams((kind) => kind !== 'patch');
      d({ type: 'cancel_end' });
      d({ type: 'set_error', message: `Couldn't stop the studio cleanly. ${toStudioApiError(err, 'project').message}` });
      void refresh();
    }
  }, [abortStreams, guarded, refresh]);

  const act = useCallback(
    async (action: StudioAction) => {
      if (!action || typeof action !== 'object') return;
      if (action.type === 'patch') return patch(action.ops);
      if (action.type === 'cancel') return cancel();
      if (!stateRef.current.base) return;
      // A double click must not run (and bill) the same action twice.
      const key = JSON.stringify(action);
      if (actionsInFlightRef.current.has(key)) return;
      actionsInFlightRef.current.add(key);
      const generation = generationRef.current;
      try {
        await runStream('action', { kind: 'action', action }, { actionType: action.type });
      } finally {
        if (generation === generationRef.current) actionsInFlightRef.current.delete(key);
      }
    },
    [cancel, patch, runStream]
  );

  // ── Resync ─────────────────────────────────────────────────────────────────

  const streamCount = Object.keys(state.streams).length;
  const stale = needsRefresh(state);
  useEffect(() => {
    if (!stale || state.refreshing || state.loading) return;
    // A gap may be filled by another stream that saw those ops; give it a moment.
    const delay = state.hardRefresh || streamCount === 0 ? 0 : GAP_GRACE_MS;
    const timer = setTimeout(() => {
      const s = stateRef.current;
      if (needsRefresh(s) && !s.refreshing) void refresh();
    }, delay);
    return () => clearTimeout(timer);
  }, [stale, state.refreshing, state.loading, state.hardRefresh, streamCount, refresh]);

  // Renders running with no stream attached (the page was reloaded mid-render, or a
  // stream dropped): poll the doc, bounded, until they settle.
  const rendering = renderingCount(state.doc);
  const watchPollsRef = useRef(0);
  useEffect(() => {
    if (rendering === 0 || streamCount > 0) {
      watchPollsRef.current = 0;
      return;
    }
    if (state.loading || state.refreshing || watchPollsRef.current >= RENDER_WATCH_MAX_POLLS) return;
    const timer = setTimeout(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      watchPollsRef.current += 1;
      void refresh();
    }, RENDER_WATCH_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [rendering, streamCount, state.loading, state.refreshing, state.base?.rev, refresh]);

  // ── Signed URLs ────────────────────────────────────────────────────────────

  const wantedRef = useRef(new Set<string>());
  const signingRef = useRef(new Set<string>());
  const signAttemptsRef = useRef(new Map<string, number>());
  const signTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushSigning = useCallback(async () => {
    signTimerRef.current = null;
    const now = Date.now();
    const urls = stateRef.current.urls;
    const paths = [...wantedRef.current].filter((p) => !signingRef.current.has(p) && !urlIsFresh(urls[p], now));
    wantedRef.current.clear();
    if (!paths.length || !stateRef.current.base) return;
    const generation = generationRef.current;
    paths.forEach((p) => {
      signingRef.current.add(p);
      signAttemptsRef.current.set(p, (signAttemptsRef.current.get(p) || 0) + 1);
    });
    try {
      const signed = await signStudioUrls(projectRef.current, paths);
      guarded(generation)({ type: 'urls_merge', urls: signed, now: Date.now() });
      Object.keys(signed).forEach((p) => signAttemptsRef.current.delete(p));
    } catch {
      /* the placeholder stays; the next render or image error asks again (bounded) */
    } finally {
      paths.forEach((p) => signingRef.current.delete(p));
    }
  }, [guarded]);

  const requestSign = useCallback(
    (path: string) => {
      if (signingRef.current.has(path) || (signAttemptsRef.current.get(path) || 0) >= MAX_SIGN_ATTEMPTS) return;
      wantedRef.current.add(path);
      if (!signTimerRef.current) signTimerRef.current = setTimeout(() => void flushSigning(), SIGN_DEBOUNCE_MS);
    },
    [flushSigning]
  );

  useEffect(
    () => () => {
      if (signTimerRef.current) clearTimeout(signTimerRef.current);
    },
    []
  );

  // Project switch: forget per-path bookkeeping.
  useEffect(() => {
    wantedRef.current.clear();
    signingRef.current.clear();
    signAttemptsRef.current.clear();
  }, [projectId]);

  const urls = state.urls;
  // opts.width (variant pick) is honored once P1-CLIENTSTATE lands variants; until then: the original.
  const urlFor = useCallback(
    (asset?: AssetRef | string | null, _opts?: { width?: number }): string | undefined => {
      if (typeof asset === 'string' && isDirectUrl(asset)) return asset;
      const path = assetPath(asset);
      if (!path) return undefined;
      if (isDirectUrl(path)) return path;
      const entry = urls[path];
      // Side effect is limited to scheduling (refs + a timer) — safe during render.
      if (!urlIsFresh(entry, Date.now())) requestSign(path);
      // A stale URL is still returned: the browser has it cached, and the re-signed one
      // replaces it as soon as it arrives.
      return entry?.url;
    },
    [urls, requestSign]
  );

  // An <img> anywhere in the studio failed to load one of our URLs: it expired or was
  // revoked — re-sign that path (capture phase: image errors don't bubble).
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onError = (e: Event) => {
      const el = e.target as HTMLImageElement | null;
      if (!el || el.tagName !== 'IMG') return;
      const src = el.currentSrc || el.src;
      if (!src) return;
      const entries = stateRef.current.urls;
      const path = Object.keys(entries).find((p) => entries[p].url === src);
      if (!path) return;
      dispatch({ type: 'urls_invalidate', paths: [path] });
      requestSign(path);
    };
    document.addEventListener('error', onError, true);
    return () => document.removeEventListener('error', onError, true);
  }, [requestSign]);

  // ── Board navigation ───────────────────────────────────────────────────────

  const setTab = useCallback((next: BoardTab) => {
    manualTabAtRef.current = Date.now();
    setTabState(next);
  }, []);

  const openPage = useCallback((pageId: string | null) => {
    setFocusedPageId(pageId);
    if (pageId) {
      manualTabAtRef.current = Date.now();
      setTabState('pages');
    }
  }, []);

  // Follow the work: show the board area the latest server ops touched, unless the user
  // picked a tab recently, is reading, or has a page open.
  const lastOps = state.lastOps;
  useEffect(() => {
    if (!lastOps || lastOps.echo) return;
    const target = tabForOps(lastOps.ops);
    if (!target || target === tabRef.current) return;
    if (Date.now() - manualTabAtRef.current < MANUAL_TAB_HOLD_MS) return;
    if (tabRef.current === 'read' || focusedRef.current) return;
    setTabState(target);
  }, [lastOps]);

  // A focused page that disappeared from the plan closes.
  const pageIds = state.doc?.pages.map((p) => p.id).join('|');
  useEffect(() => {
    if (focusedPageId && pageIds !== undefined && !pageIds.split('|').includes(focusedPageId)) setFocusedPageId(null);
  }, [focusedPageId, pageIds]);

  // ── v5 seams: mode, selection, next steps, uploads, publication ─────────────

  const mode = resolveStudioMode(storedMode, caps);
  const setMode = useCallback((next: StudioMode) => {
    if (next !== 'easy' && next !== 'pro') return;
    writeStoredMode(next);
    setStoredMode(next);
  }, []);

  const setSelection = useCallback((sel: StudioSelection | null) => setSelectionState(sel), []);

  // Undo/redo: inert until P1-CLIENTSTATE (useUndo + inverseOps). canUndo stays false so no UI offers it.
  const undo = useCallback(() => undefined, []);
  const redo = useCallback(() => undefined, []);

  const runClientAction = useCallback(
    (action: ClientAction) => {
      if (!action || typeof action !== 'object') return;
      switch (action.type) {
        case 'open_reader':
          setTab('read');
          return;
        case 'open_page':
          if (typeof action.pageId === 'string' && action.pageId) openPage(action.pageId);
          return;
        case 'open_tab':
          if (typeof action.tab === 'string') setTab(action.tab);
          return;
        case 'open_share':
          // The Share sheet (P1-PUBLISH) hangs off the reader; until then, the Read tab.
          setTab('read');
          return;
        case 'undo':
          undo();
          return;
        case 'set_mode':
          setMode(action.mode);
          return;
        default:
          return;
      }
    },
    [setTab, openPage, undo, setMode]
  );

  const runNextStep = useCallback(
    async (step: NextStep): Promise<void> => {
      if (!step || typeof step !== 'object') return;
      if (step.action) return act(step.action);
      if (step.client) return runClientAction(step.client);
      const text = (typeof step.say === 'string' && step.say.trim() ? step.say : step.label || '').trim();
      if (text) return send(text);
    },
    [act, runClientAction, send]
  );

  const uploadRef = useCallback(
    async (file: Blob, target: RefOwner, opts: RefUploadOptions = {}): Promise<RefUploadResult> => {
      const generation = generationRef.current;
      opts.onProgress?.(0);
      const res = await uploadStudioRef(
        projectRef.current,
        file,
        {
          to: target,
          ...(opts.label ? { label: opts.label } : {}),
          ...(opts.name ? { name: opts.name } : {}),
          ...(typeof opts.index === 'number' ? { index: opts.index } : {})
        },
        { signal: opts.signal }
      );
      opts.onProgress?.(1);
      if (mountedRef.current && generation === generationRef.current) {
        if (Object.keys(res.urls).length) dispatch({ type: 'urls_merge', urls: res.urls, now: Date.now() });
        // The server committed `ref_add` outside a stream: resync once to pick it up.
        if (res.ref || res.ops.length) void refresh();
      }
      return {
        ...(res.ref ? { ref: res.ref } : {}),
        ...(res.duplicateOf ? { duplicateOf: res.duplicateOf } : {}),
        ...(res.notice ? { notice: res.notice } : {})
      };
    },
    [refresh]
  );

  const refreshPublication = useCallback(async (): Promise<void> => {
    const generation = generationRef.current;
    try {
      const view = await getPublication(projectRef.current);
      if (mountedRef.current && generation === generationRef.current) setPublication(view);
    } catch (err) {
      const e = toStudioApiError(err, 'project');
      // Not published / not available yet ⇒ "no publication", not an error.
      if (e.kind === 'not_available' || e.kind === 'not_found') {
        if (mountedRef.current && generation === generationRef.current) setPublication(null);
        return;
      }
      throw e;
    }
  }, []);

  // ── Controller ─────────────────────────────────────────────────────────────

  const doc = state.doc;
  const isRendering = useCallback((target: RenderTarget) => isTargetRendering(doc, target), [doc]);
  const clearError = useCallback(() => dispatch({ type: 'set_error', message: null }), []);

  const byok = useMemo(() => {
    const entry = doc?.spend.entries.find((e) => IMAGE_SPEND_KINDS.has(e.kind));
    return !!entry?.byok;
  }, [doc?.spend.entries]);

  const busy = visibleStreams(state).length > 0;
  const messageBusy = isMessageBusy(state);

  return useMemo(
    () => ({
      doc,
      loading: state.loading,
      loadError: state.loadError,
      busy,
      drafts: state.drafts,
      activity: state.activity,
      error: state.error,
      clearError,
      urlFor,
      send,
      act,
      patch,
      cancel,
      refresh,
      tab,
      setTab,
      focusedPageId,
      openPage,
      isRendering,
      messageBusy,
      pendingMessage: state.pendingMessage,
      retryPendingMessage,
      dismissPendingMessage,
      cancelling: state.cancelling,
      refreshing: state.refreshing,
      lastSpentUsd: state.lastSpentUsd,
      byok,
      renderingTotal: rendering,
      caps,
      mode,
      setMode,
      undo,
      redo,
      canUndo: false,
      canRedo: false,
      selection,
      setSelection,
      runNextStep,
      runClientAction,
      uploadRef,
      publication,
      refreshPublication
    }),
    [
      doc,
      state.loading,
      state.loadError,
      busy,
      state.drafts,
      state.activity,
      state.error,
      clearError,
      urlFor,
      send,
      act,
      patch,
      cancel,
      refresh,
      tab,
      setTab,
      focusedPageId,
      openPage,
      isRendering,
      messageBusy,
      state.pendingMessage,
      retryPendingMessage,
      dismissPendingMessage,
      state.cancelling,
      state.refreshing,
      state.lastSpentUsd,
      byok,
      rendering,
      caps,
      mode,
      setMode,
      undo,
      redo,
      selection,
      setSelection,
      runNextStep,
      runClientAction,
      uploadRef,
      publication,
      refreshPublication
    ]
  );
}
