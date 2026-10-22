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
// v5 (contract §13.1, P1-CLIENTSTATE):
//   - caps come from the project load (`byok` from caps; the spend-entry heuristic is only the
//     offline fallback when the server sent no caps); the Easy/Pro view is useStudioMode().
//   - Undo/redo (useUndo + shared inverseOps): every user patch is undoable by default (coalesced
//     drags/scrubs), director batches (`ops.origin === 'director'`) are pushed with the inverse
//     computed against the exact base they applied to, a typed "undo" is intercepted here and
//     never sent to the director (no AI cost), and a project switch clears the stack.
//   - `restore_render` is an optimistic, undoable `render_use` patch (instant, free).
//   - urlFor(asset, {width}) picks the smallest stored variant ≥ width × min(dpr, 2).
//   - uploadRef streams the bytes via XHR with real progress and abort, and applies the
//     server's ref ops directly (no refetch).
//   - The owner's publication view is fetched lazily and refreshed when the doc's mirror changes.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { applyOps, type DocOp, type StudioAction } from '../../shared/comic/ops';
import type { StreamRequest, StudioFocus } from '../../shared/comic/events';
import {
  mapAssetRefs,
  variantFor,
  type AssetRef,
  type ClientAction,
  type ComicDoc,
  type NextStep,
  type RefOwner,
  type RenderTarget
} from '../../shared/comic/doc';
import { DEFAULT_CAPS, type StudioCaps } from '../../shared/comic/capabilities';
import type { PublicationOwnerView } from '../../shared/comic/publication';
import type {
  BoardTab,
  PatchOptions,
  PendingAttachment,
  ReaderRequest,
  RefUploadOptions,
  RefUploadResult,
  SendOptions,
  StudioController,
  StudioNotice,
  StudioSelection
} from './types';
import {
  cancelStudio,
  friendlyErrorMessage,
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
import { useStudioMode } from './useStudioMode';
import { isNoopOn, makeUndoEntry, useUndo, type UndoEntry } from './useUndo';

// Back-compat re-exports (consumers and tests import these from './useStudio').
export { MODE_STORAGE_KEY, resolveStudioMode } from './useStudioMode';

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
  /** USD the software saved in the last turn/job ("Free — done by the editor"), null when none. */
  lastSavedUsd?: number | null;
  /** Images are paid with the user's own key: caps.byok (the latest image spend only when offline). */
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

/** Inbox paths per message (the server enforces the same cap). */
const MAX_INBOX_ATTACHMENTS = 12;
/** StudioFocus.lineIds cap. */
const MAX_FOCUS_LINES = 80;
/** A typed message that is an undo request: handled here, never sent (contract §13.1). */
export const TYPED_UNDO_RE = /^\s*undo( that| it)?\s*[.!]?\s*$/i;
/** Window event the Share sheet listens for (share/ShareButton.tsx OPEN_SHARE_EVENT). */
const OPEN_SHARE_EVENT = 'ds:open-share';

/**
 * Offline fallback only: guess "own key" from the latest image spend. The server's caps.byok is
 * authoritative whenever the project load sent caps.
 */
export const byokFromDoc = (doc: ComicDoc | null | undefined): boolean => {
  const entry = doc?.spend.entries.find((e) => IMAGE_SPEND_KINDS.has(e.kind));
  return !!entry?.byok;
};

const devicePixelRatioNow = (): number => (typeof window !== 'undefined' && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1);

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
  /** Its edit is on the undo stack (a rejected save drops the entry). */
  recorded?: boolean;
  /** Undo/redo application: told whether the save failed and whether trying again could work. */
  onFailed?: (retryable: boolean) => void;
}

/** What a finished stream reported. */
interface StreamOutcome {
  ok: boolean;
  error?: string;
  code?: string;
  aborted: boolean;
  /** Trying the same request again could succeed (network, busy, rate limit, server hiccup). */
  retryable: boolean;
}

/** Server codes that mean "try again later", not "this can never be saved". */
const RETRYABLE_CODES = new Set(['CONFLICT', 'RATE_LIMIT', 'COOLDOWN', 'TIMEOUT', 'INTERNAL', 'NOT_AVAILABLE', 'PROVIDER_ERROR']);

let noticeSeq = 0;


export function useStudio(projectId: string): ComicStudioController {
  const [state, dispatch] = useReducer(studioReducer, undefined, initialStudioState);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** The doc the user sees, including edits queued earlier in this same tick (undo baselines). */
  const viewRef = useRef<ComicDoc | null>(state.doc);
  viewRef.current = state.doc;

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
  /** The server sent caps at least once (else byok falls back to the doc heuristic). */
  const [capsFromServer, setCapsFromServer] = useState(false);
  const { mode, setMode } = useStudioMode(caps);
  const undoApi = useUndo(projectId);
  const undoRef = useRef(undoApi);
  undoRef.current = undoApi;
  const [selection, setSelectionState] = useState<StudioSelection | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [publication, setPublication] = useState<PublicationOwnerView | null>(null);
  const [publicationLoading, setPublicationLoading] = useState(false);
  const publicationRequestedRef = useRef(false);
  const publicationPromiseRef = useRef<Promise<void> | null>(null);
  const [notice, setNotice] = useState<StudioNotice | null>(null);
  const [readerRequest, setReaderRequest] = useState<ReaderRequest | null>(null);
  const manualTabAtRef = useRef(0);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const focusedRef = useRef(focusedPageId);
  focusedRef.current = focusedPageId;
  /** The project whose load has started. A render where it differs is a project switch. */
  const loadedProjectRef = useRef<string | null>(null);
  const switching = loadedProjectRef.current !== projectId;

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

  const say = useCallback((n: Omit<StudioNotice, 'id' | 'at'>) => {
    noticeSeq = (noticeSeq + 1) % 1e9;
    setNotice({ ...n, id: `notice_${noticeSeq}`, at: Date.now() });
  }, []);
  const clearNotice = useCallback(() => setNotice(null), []);

  // ── Load ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    mountedRef.current = true;
    projectRef.current = projectId;
    loadedProjectRef.current = projectId;
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
    publicationRequestedRef.current = false;
    publicationPromiseRef.current = null;
    setFocusedPageId(null);
    setSelectionState(null);
    setPublication(null);
    setPublicationLoading(false);
    setNotice(null);
    setReaderRequest(null);
    dispatch({ type: 'load_start' });

    loadStudioProject(projectId, { signal: ctrl.signal })
      .then(({ doc, urls, caps: loadedCaps }) => {
        if (loadedCaps && mountedRef.current && generation === generationRef.current) {
          setCaps(loadedCaps);
          setCapsFromServer(true);
        }
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
        if (loadedCaps && mountedRef.current && generation === generationRef.current) {
          setCaps(loadedCaps);
          setCapsFromServer(true);
        }
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
    async (kind: StreamKind, request: StreamRequest, opts: { streamId?: string; actionType?: string } = {}): Promise<StreamOutcome> => {
      const generation = generationRef.current;
      const d = guarded(generation);
      const streamId = opts.streamId || localId('stream');
      const ctrl = new AbortController();
      controllersRef.current.set(streamId, { ctrl, kind });
      d({ type: 'stream_start', streamId, kind, ...(opts.actionType ? { actionType: opts.actionType } : {}), now: Date.now() });
      let error: string | undefined;
      let code: string | undefined;
      let retryable = false;
      let reported: string | undefined;
      let reportedCode: string | undefined;
      let aborted = false;
      try {
        await streamStudio(
          projectRef.current,
          request,
          (raw) => {
            let event = raw;
            // The server can refuse inside the stream (an `error` event, then close). Its text is
            // shown only when it is calm, human copy (defence in depth over the stream parser).
            if (event.type === 'error') {
              event = { ...event, message: friendlyErrorMessage(event.code, event.message) };
              reported = event.message;
              reportedCode = event.code;
            }
            d({ type: 'stream_event', streamId, event, now: Date.now() });
          },
          ctrl.signal
        );
      } catch (err) {
        if (isAbortError(err)) aborted = true;
        else {
          const e = toStudioApiError(err, 'project');
          error = e.message;
          code = e.code;
          retryable = e.retryable;
        }
      } finally {
        controllersRef.current.delete(streamId);
        d({ type: 'stream_end', streamId, ...(error ? { error } : {}), ...(code ? { code } : {}), aborted, now: Date.now() });
      }
      const finalCode = error ? code : reportedCode;
      return {
        ok: !error && !aborted && !reported,
        ...(error || reported ? { error: error || reported } : {}),
        ...(finalCode ? { code: finalCode } : {}),
        aborted,
        retryable: aborted || (error ? retryable : reported ? !reportedCode || RETRYABLE_CODES.has(reportedCode) : false)
      };
    },
    [guarded]
  );

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
      ...(result.error ? { error: `Couldn't save your change. ${result.error}`, ...(result.code ? { code: result.code } : {}) } : {}),
      now: Date.now()
    });
    if (!result.ok && mountedRef.current) {
      // A rejected edit never happened: drop its undo entry. (An aborted save is unknown — the
      // resync below tells, and a stale entry is skipped when undone.)
      if (!result.aborted) undoRef.current.forget(batch.filter((b) => b.recorded).map((b) => b.id));
      batch.forEach((b) => b.onFailed?.(result.retryable));
    }
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

  /**
   * Queue a free content edit: applied optimistically now, saved in order (debounced, ≤ 200 ops per
   * request). `record` puts it on the undo stack with the inverse computed against what the user
   * sees right now; `onFailed` hears about a failed save (undo/redo bookkeeping).
   */
  const enqueuePatch = useCallback(
    (
      ops: DocOp[],
      opts: { record?: { label?: string; coalesce?: string } | null; onFailed?: (retryable: boolean) => void } = {}
    ): Promise<void> => {
      const list = (Array.isArray(ops) ? ops : []).filter((op) => op && typeof op === 'object' && typeof op.op === 'string');
      if (!list.length || !stateRef.current.base) return Promise.resolve();
      const chunks: DocOp[][] = [];
      for (let i = 0; i < list.length; i += MAX_PATCH_OPS) chunks.push(list.slice(i, i + MAX_PATCH_OPS));
      const ids = chunks.map(() => localId('patch'));
      const before = viewRef.current ?? stateRef.current.doc;
      const now = Date.now();
      let recorded = false;
      if (opts.record && before) {
        const entry = makeUndoEntry(before, list, { origin: 'user', label: opts.record.label, coalesce: opts.record.coalesce, at: now });
        if (entry) {
          entry.patchIds = ids;
          undoRef.current.record(entry);
          recorded = true;
        }
      }
      // Same-tick follow-up edits must see this one (React applies the dispatch on the next render).
      if (before) viewRef.current = applyOps(before, list, before.updatedAt);
      const settled = chunks.map(
        (chunk, i) =>
          new Promise<void>((resolve) => {
            dispatch({ type: 'patch_local', patch: { id: ids[i], ops: chunk }, now });
            patchQueueRef.current.push({
              id: ids[i],
              ops: chunk,
              resolve,
              ...(recorded ? { recorded: true } : {}),
              ...(opts.onFailed ? { onFailed: opts.onFailed } : {})
            });
          })
      );
      if (patchTimerRef.current) clearTimeout(patchTimerRef.current);
      patchTimerRef.current = setTimeout(() => void flushPatches(), PATCH_DEBOUNCE_MS);
      return Promise.all(settled).then(() => undefined);
    },
    [flushPatches]
  );

  /** User content edit (contract §13.1): undoable unless `undo: false`; drags/scrubs coalesce by key. */
  const patch = useCallback(
    (ops: DocOp[], opts: PatchOptions = {}): Promise<void> =>
      enqueuePatch(ops, { record: opts?.undo === false ? null : { label: opts?.label, coalesce: opts?.coalesce } }),
    [enqueuePatch]
  );

  // ── Undo / redo ────────────────────────────────────────────────────────────

  /**
   * Re-apply an entry's inverse (undo) or forward ops (redo) as a free patch. Entries whose target is
   * gone or that would change nothing are skipped. A failed save puts the entry back when trying again
   * could work, else drops it. `announce` (typed "undo", chat chips) leaves a calm notice either way.
   */
  const historyStep = useCallback(
    (dir: 'undo' | 'redo', announce: boolean): boolean => {
      const doc = viewRef.current;
      if (!doc || !stateRef.current.base) return false;
      const api = undoRef.current;
      const usable = (e: UndoEntry) => !isNoopOn(doc, dir === 'undo' ? e.inverse : e.forward);
      const entry = dir === 'undo' ? api.takeUndo(usable) : api.takeRedo(usable);
      if (!entry) {
        if (announce) say({ kind: 'info', text: dir === 'undo' ? 'Nothing to undo yet — free edits from this session can be undone here.' : 'Nothing to redo.' });
        return false;
      }
      void enqueuePatch(dir === 'undo' ? entry.inverse : entry.forward, {
        record: null,
        onFailed: (retryable) => {
          if (retryable) undoRef.current.putBack(entry, dir);
          else undoRef.current.discard(entry.id);
        }
      });
      if (announce) {
        say(
          dir === 'undo'
            ? { kind: 'undo', text: `Undid: ${entry.label}.`, action: 'redo' }
            : { kind: 'redo', text: `Redid: ${entry.label}.`, action: 'undo' }
        );
      }
      return true;
    },
    [enqueuePatch, say]
  );

  const undo = useCallback(() => void historyStep('undo', false), [historyStep]);
  const redo = useCallback(() => void historyStep('redo', false), [historyStep]);

  // Director edits (ops.origin === 'director') become undo entries, inverse computed against the
  // exact base each batch applied to; the batches of one reply merge, so "undo" undoes the reply.
  // Skipped on the render of a project switch (load_start clears the inbox).
  const undoInbox = state.undoInbox;
  useEffect(() => {
    if (!undoInbox.length || switching) return;
    for (const b of undoInbox) {
      const group = b.streamId ? `reply:${b.streamId}` : undefined;
      undoRef.current.record(makeUndoEntry(b.before, b.ops, { origin: 'director', label: b.label, rev: b.rev, at: b.at, ...(group ? { group } : {}) }));
    }
    dispatch({ type: 'undo_inbox_drain', upToRev: undoInbox[undoInbox.length - 1].rev });
  }, [undoInbox, switching]);

  // ── Messages ───────────────────────────────────────────────────────────────

  const send = useCallback(
    async (text: string, opts?: SendOptions | PendingAttachment[]) => {
      // Overloaded: the legacy (text, PendingAttachment[]) form stays valid.
      const o: SendOptions = Array.isArray(opts) ? { attachments: opts } : opts || {};
      const clean = (typeof text === 'string' ? text : '').trim();
      const files = (o.attachments || []).filter((a) => a && typeof a.dataUrl === 'string' && a.dataUrl);
      const inbox = [...new Set((o.inboxPaths || []).filter((p) => typeof p === 'string' && p))].slice(0, MAX_INBOX_ATTACHMENTS);
      if (!clean && !files.length && !inbox.length) return;
      // A typed "undo" is the editor's job: instant, free, never sent to the director (contract §13.1).
      if (!files.length && !inbox.length && TYPED_UNDO_RE.test(clean)) {
        historyStep('undo', true);
        return;
      }
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
    [runStream, historyStep]
  );

  const retryPendingMessage = useCallback(() => {
    const pending = stateRef.current.pendingMessage;
    if (!pending || pending.status !== 'failed' || messageInFlightRef.current) return;
    dispatch({ type: 'message_dismiss' });
    void send(pending.text, pending.attachments);
  }, [send]);

  const dismissPendingMessage = useCallback(() => dispatch({ type: 'message_dismiss' }), []);

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
      // Switching to another version is a free, instant, undoable edit (timeline.md §3): the
      // optimistic `render_use` patch replaces the old round-trip action.
      if (action.type === 'restore_render') {
        if (!action.target || typeof action.target !== 'object' || typeof action.path !== 'string' || !action.path) return;
        return patch([{ op: 'render_use', target: action.target, path: action.path, at: Date.now() }], { label: 'switch versions' });
      }
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
  /** Paths the server declined to sign (not allow-listed / missing): a variant falls back to its original. */
  const unsignableRef = useRef(new Set<string>());
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
      if (generation !== generationRef.current) return;
      guarded(generation)({ type: 'urls_merge', urls: signed, now: Date.now() });
      Object.keys(signed).forEach((p) => signAttemptsRef.current.delete(p));
      paths.forEach((p) => {
        if (!signed[p]) unsignableRef.current.add(p);
      });
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
    unsignableRef.current.clear();
  }, [projectId]);

  /** Path → AssetRef with variants, rebuilt lazily once per doc (for urlFor(pathString, {width})). */
  const variantIndexRef = useRef<{ doc: ComicDoc | null; map: Map<string, AssetRef> }>({ doc: null, map: new Map() });
  const assetWithVariants = useCallback((path: string): AssetRef | undefined => {
    const d = stateRef.current.doc;
    if (!d) return undefined;
    if (variantIndexRef.current.doc !== d) {
      const map = new Map<string, AssetRef>();
      mapAssetRefs(d, (a) => {
        if (a && typeof a.path === 'string' && a.variants?.length) map.set(a.path, a);
        return a;
      });
      variantIndexRef.current = { doc: d, map };
    }
    return variantIndexRef.current.map.get(path);
  }, []);

  const urls = state.urls;
  const urlFor = useCallback(
    (asset?: AssetRef | string | null, opts?: { width?: number }): string | undefined => {
      if (typeof asset === 'string' && isDirectUrl(asset)) return asset;
      const path = assetPath(asset);
      if (!path) return undefined;
      if (isDirectUrl(path)) return path;
      const now = Date.now();
      const width = opts?.width;
      // Side effects are limited to scheduling (refs + a timer) — safe during render.
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        const ref = typeof asset === 'object' && asset?.variants?.length ? asset : assetWithVariants(path);
        const pick = ref ? variantFor(ref, width, devicePixelRatioNow()).path : path;
        if (pick !== path && !unsignableRef.current.has(pick) && (signAttemptsRef.current.get(pick) || 0) < MAX_SIGN_ATTEMPTS) {
          const v = urls[pick];
          if (!urlIsFresh(v, now)) requestSign(pick);
          if (v?.url) return v.url;
          // The smaller file is still being signed: show the original if it is already here
          // (never fetch both while waiting).
          return urls[path]?.url;
        }
      }
      const entry = urls[path];
      if (!urlIsFresh(entry, now)) requestSign(path);
      // A stale URL is still returned: the browser has it cached, and the re-signed one
      // replaces it as soon as it arrives.
      return entry?.url;
    },
    [urls, requestSign, assetWithVariants]
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

  // ── v5: selection, next steps, uploads, publication ─────────────────────────

  const setSelection = useCallback((sel: StudioSelection | null) => setSelectionState(sel), []);

  const runClientAction = useCallback(
    (action: ClientAction) => {
      if (!action || typeof action !== 'object') return;
      switch (action.type) {
        case 'open_reader':
          setTab('read');
          // The Read tab host opens the immersive reader (or Guided View) on a new request.
          setReaderRequest((prev) => ({ seq: (prev?.seq ?? 0) + 1, immersive: !!action.immersive, guided: !!action.guided }));
          return;
        case 'open_page':
          if (typeof action.pageId === 'string' && action.pageId) openPage(action.pageId);
          return;
        case 'open_tab':
          if (typeof action.tab === 'string') setTab(action.tab);
          return;
        case 'open_share': {
          // The mounted Share button opens its sheet on this event (and may preventDefault to say
          // so); otherwise fall back to the Read tab, where sharing lives.
          let handled = false;
          if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
            handled = !window.dispatchEvent(new CustomEvent(OPEN_SHARE_EVENT, { cancelable: true }));
          }
          if (!handled) setTab('read');
          return;
        }
        case 'undo':
          historyStep('undo', true);
          return;
        case 'set_mode':
          setMode(action.mode);
          return;
        default:
          return;
      }
    },
    [setTab, openPage, historyStep, setMode]
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
          ...(typeof opts.index === 'number' ? { index: opts.index } : {}),
          ...(opts.hash ? { hash: opts.hash } : {})
        },
        { signal: opts.signal, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) }
      );
      opts.onProgress?.(1);
      if (mountedRef.current && generation === generationRef.current) {
        if (Object.keys(res.urls).length) dispatch({ type: 'urls_merge', urls: res.urls, now: Date.now() });
        // The server committed `ref_add` outside a stream: apply its ops (revision-guarded; a gap
        // refetches), or resync once when it sent none.
        if (typeof res.rev === 'number' && res.ops.length) dispatch({ type: 'server_ops', rev: res.rev, ops: res.ops, origin: 'user', now: Date.now() });
        else if (res.ref) void refresh();
      }
      return {
        ...(res.ref ? { ref: res.ref } : {}),
        ...(res.duplicateOf ? { duplicateOf: res.duplicateOf } : {}),
        ...(res.notice ? { notice: res.notice } : {})
      };
    },
    [refresh]
  );

  /** Owner view of the publication. Concurrent calls share one request; "not published" is null. */
  const refreshPublication = useCallback((): Promise<void> => {
    if (publicationPromiseRef.current) return publicationPromiseRef.current;
    publicationRequestedRef.current = true;
    const generation = generationRef.current;
    const live = () => mountedRef.current && generation === generationRef.current;
    setPublicationLoading(true);
    const work: Promise<void> = getPublication(projectRef.current)
      .then((view) => {
        if (live()) setPublication(view);
      })
      .catch((err) => {
        const e = toStudioApiError(err, 'project');
        // Not published / not available yet ⇒ "no publication", not an error.
        if (e.kind === 'not_available' || e.kind === 'not_found') {
          if (live()) setPublication(null);
          return;
        }
        throw e;
      })
      .finally(() => {
        if (publicationPromiseRef.current === work) publicationPromiseRef.current = null;
        if (live()) setPublicationLoading(false);
      });
    publicationPromiseRef.current = work;
    return work;
  }, []);

  // The doc's publication mirror changed (published, unpublished, link regenerated, edits since):
  // refresh the owner view — only once something has asked for it (no request otherwise).
  const pubMirror = state.doc?.publication;
  const pubKey = useMemo(() => (pubMirror ? JSON.stringify(pubMirror) : ''), [pubMirror]);
  const pubKeyRef = useRef(pubKey);
  useEffect(() => {
    if (pubKeyRef.current === pubKey) return;
    pubKeyRef.current = pubKey;
    if (!publicationRequestedRef.current || switching) return;
    refreshPublication().catch(() => undefined);
  }, [pubKey, switching, refreshPublication]);

  // ── Controller ─────────────────────────────────────────────────────────────

  const doc = state.doc;
  const isRendering = useCallback((target: RenderTarget) => isTargetRendering(doc, target), [doc]);
  const clearError = useCallback(() => dispatch({ type: 'set_error', message: null }), []);

  const spendEntries = doc?.spend.entries;
  const byok = useMemo(() => (capsFromServer ? caps.byok : byokFromDoc(doc)), [capsFromServer, caps.byok, spendEntries]);

  const busy = visibleStreams(state).length > 0;
  const messageBusy = isMessageBusy(state);
  const { canUndo, canRedo, undoLabel, redoLabel } = undoApi;

  return useMemo(
    () => ({
      doc,
      loading: state.loading,
      loadError: state.loadError,
      busy,
      drafts: state.drafts,
      activity: state.activity,
      error: state.error,
      errorCode: state.errorCode,
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
      lastSavedUsd: state.lastSavedUsd,
      byok,
      renderingTotal: rendering,
      caps,
      mode,
      setMode,
      undo,
      redo,
      canUndo,
      canRedo,
      ...(undoLabel ? { undoLabel } : {}),
      ...(redoLabel ? { redoLabel } : {}),
      notice,
      clearNotice,
      selection,
      setSelection,
      runNextStep,
      runClientAction,
      uploadRef,
      publication,
      publicationLoading,
      refreshPublication,
      readerRequest
    }),
    [
      doc,
      state.loading,
      state.loadError,
      busy,
      state.drafts,
      state.activity,
      state.error,
      state.errorCode,
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
      state.lastSavedUsd,
      byok,
      rendering,
      caps,
      mode,
      setMode,
      undo,
      redo,
      canUndo,
      canRedo,
      undoLabel,
      redoLabel,
      notice,
      clearNotice,
      selection,
      setSelection,
      runNextStep,
      runClientAction,
      uploadRef,
      publication,
      publicationLoading,
      refreshPublication,
      readerRequest
    ]
  );
}
