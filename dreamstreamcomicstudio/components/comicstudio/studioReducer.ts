// Pure state machine behind useStudio (Comic Studio v4).
//
// The server owns the ComicDoc. The client keeps the last server-confirmed copy (`base`)
// and applies the same DocOps the server streams, guarded by revision numbers:
//   - ops.rev === base.rev + 1  → apply, base.rev = ops.rev
//   - ops.rev <= base.rev       → duplicate (every open stream receives every op batch of
//                                 the session, so concurrent streams deliver each batch
//                                 more than once) → ignore
//   - ops.rev  > base.rev + 1   → a gap; remember how far behind we are (`behindRev`) and
//                                 let the hook refetch if no other stream fills it.
// Local edits are applied optimistically on top of `base` (`optimistic`) and dropped when
// their patch request settles, so a rejected edit simply disappears. `doc` is always the
// view the UI renders: base + optimistic patches.
//
// Everything here is deterministic (time comes in on the action) and unit-tested.
//
// v5 (P1-CLIENTSTATE): ops batches carry `origin` ('user' | 'director' | 'job') and an undo
// `label`. A director batch is queued in `undoInbox` together with the exact base it applied to,
// so useStudio can push its inverse (computed BEFORE apply) onto the undo stack. Ops committed
// outside a stream (an upload answer) apply through `server_ops` with the same revision guard.

import { applyOps, type DocOp } from '../../shared/comic/ops';
import type { AttachmentTarget, OpsOrigin, StudioEvent, StudioFocus } from '../../shared/comic/events';
import { getRender, renderTargetKey, type AssetRef, type ComicDoc, type Msg, type RefOwner, type RenderTarget } from '../../shared/comic/doc';
import type { ActivityItem, BoardTab, PendingAttachment } from './types';

// ── Signed URLs ──────────────────────────────────────────────────────────────

export interface UrlEntry {
  url: string;
  /** Epoch ms after which the URL stops working (Infinity for data:/blob: URLs). */
  expiresAt: number;
}

/** The server never hands out a signed URL with less than 10 minutes of validity left. */
export const URL_FALLBACK_TTL_MS = 10 * 60_000;
/** Re-sign a URL when less than this much validity remains. */
export const URL_RESIGN_BEFORE_MS = 5 * 60_000;

const decodeBase64Url = (input: string): string => {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof atob === 'function') return atob(padded);
  return Buffer.from(padded, 'base64').toString('binary');
};

/**
 * When a signed storage URL expires. Supabase signed URLs carry a JWT in `?token=` whose
 * `exp` is authoritative; anything else falls back to the server's minimum-validity
 * guarantee so we re-sign early rather than show a broken image.
 */
export const signedUrlExpiry = (url: string, receivedAt: number): number => {
  if (/^(data|blob):/i.test(url)) return Number.POSITIVE_INFINITY;
  try {
    const token = new URL(url).searchParams.get('token');
    const payload = token?.split('.')[1];
    if (payload) {
      const exp = (JSON.parse(decodeBase64Url(payload)) as { exp?: unknown }).exp;
      if (typeof exp === 'number' && Number.isFinite(exp)) return exp * 1000;
    }
  } catch {
    /* not a URL / not a JWT — use the fallback */
  }
  return receivedAt + URL_FALLBACK_TTL_MS;
};

export const urlIsFresh = (entry: UrlEntry | undefined, now: number): boolean =>
  !!entry && entry.expiresAt - now > URL_RESIGN_BEFORE_MS;

export const mergeUrls = (
  current: Record<string, UrlEntry>,
  incoming: Record<string, string> | undefined,
  now: number
): Record<string, UrlEntry> => {
  if (!incoming) return current;
  const entries = Object.entries(incoming).filter(([path, url]) => typeof path === 'string' && typeof url === 'string' && url);
  if (!entries.length) return current;
  const next = { ...current };
  for (const [path, url] of entries) next[path] = { url, expiresAt: signedUrlExpiry(url, now) };
  return next;
};

/** Storage path for urlFor() inputs (AssetRef, path string, or nothing). */
export const assetPath = (asset?: AssetRef | string | null): string | undefined => {
  if (!asset) return undefined;
  const path = typeof asset === 'string' ? asset : asset.path;
  return typeof path === 'string' && path ? path : undefined;
};

/** Values urlFor() can return as-is (already displayable). */
export const isDirectUrl = (value: string): boolean => /^(data:|blob:|https?:)/i.test(value);

// ── State ────────────────────────────────────────────────────────────────────

export type StreamKind = 'message' | 'action' | 'patch';

export interface StreamInfo {
  id: string;
  kind: StreamKind;
  /** Action type for action streams (render_pages, pick_style, …). */
  actionType?: string;
  startedAt: number;
  /** Last `error` event this stream delivered. */
  errored?: string;
  /** Its server code (COOLDOWN, CONTENT_POLICY, …). */
  erroredCode?: string;
  /**
   * Message streams only: the director's reply has landed. The stream stays open for the renders
   * the turn started (live progress), but the server accepts the next message, so the composer does.
   */
  replied?: boolean;
}

/** A user message shown immediately, until the server's `message` op for it lands. */
export interface PendingUserMessage {
  id: string;
  text: string;
  attachments: PendingAttachment[];
  at: number;
  status: 'sending' | 'failed';
  error?: string;
  /** Server code of the failure (COOLDOWN, CONTENT_POLICY, …) so the bubble can tailor its hint. */
  code?: string;
  streamId?: string;
  /** What "Try again" re-sends besides the text (SendOptions). */
  inboxPaths?: string[];
  attachmentTargets?: AttachmentTarget[];
  focus?: StudioFocus;
}

export interface OptimisticPatch {
  id: string;
  ops: DocOp[];
}

/** A director batch waiting to become an undo entry: the base it applied to + its ops. */
export interface DirectorBatch {
  rev: number;
  before: ComicDoc;
  ops: DocOp[];
  label?: string;
  at: number;
  /** The stream (one director reply) it came from: batches of one reply undo together. */
  streamId?: string;
}

/** Keep at most this many director batches queued (the hook drains them every render). */
export const MAX_UNDO_INBOX = 50;

export interface StudioState {
  /** Last server-confirmed doc. */
  base: ComicDoc | null;
  /** What the UI renders: base + optimistic patches. */
  doc: ComicDoc | null;
  optimistic: OptimisticPatch[];
  loading: boolean;
  loadError: string | null;
  urls: Record<string, UrlEntry>;
  drafts: Record<string, string>;
  activity: ActivityItem[];
  streams: Record<string, StreamInfo>;
  pendingMessage: PendingUserMessage | null;
  error: string | null;
  /** Highest revision the server told us about (hello/ops/done). */
  behindRev: number;
  /** The server is at an older revision than us (restart/rollback) — refetch now. */
  hardRefresh: boolean;
  /** A stream broke mid-way — refetch once every stream has settled. */
  syncDue: boolean;
  refreshing: boolean;
  cancelling: boolean;
  /** USD the last finished turn/job reported (`done.spentUsd`). */
  lastSpentUsd: number | null;
  /** USD the software saved in the last turn/job (`done.savedUsd`, decisions-final #6). */
  lastSavedUsd: number | null;
  /** Server code of `error` (COOLDOWN, CONTENT_POLICY, LIMIT, NOT_READY, …). */
  errorCode: string | null;
  /** Revision bump counter for "the latest ops touched X" consumers. */
  lastOps: { rev: number; ops: DocOp[]; echo: boolean; origin?: OpsOrigin; label?: string } | null;
  /** Director batches not yet pushed onto the undo stack (oldest first). */
  undoInbox: DirectorBatch[];
}

export const initialStudioState = (): StudioState => ({
  base: null,
  doc: null,
  optimistic: [],
  loading: true,
  loadError: null,
  urls: {},
  drafts: {},
  activity: [],
  streams: {},
  pendingMessage: null,
  error: null,
  behindRev: 0,
  hardRefresh: false,
  syncDue: false,
  refreshing: false,
  cancelling: false,
  lastSpentUsd: null,
  lastSavedUsd: null,
  errorCode: null,
  lastOps: null,
  undoInbox: []
});

export type StudioReducerAction =
  | { type: 'load_start' }
  | { type: 'load_success'; doc: ComicDoc; urls?: Record<string, string>; now: number }
  | { type: 'load_error'; message: string }
  | { type: 'refresh_start' }
  | { type: 'refresh_success'; doc: ComicDoc; urls?: Record<string, string>; now: number }
  | { type: 'refresh_error'; message?: string }
  | { type: 'stream_start'; streamId: string; kind: StreamKind; actionType?: string; now: number }
  | { type: 'stream_event'; streamId: string; event: StudioEvent; now: number }
  | { type: 'stream_end'; streamId: string; error?: string; code?: string; aborted?: boolean; now: number }
  /** Ops the server committed outside a stream (e.g. a ref upload answer); same revision guard. */
  | { type: 'server_ops'; rev: number; ops: DocOp[]; origin?: OpsOrigin; label?: string; now: number }
  /** The hook pushed every queued director batch up to this revision onto the undo stack. */
  | { type: 'undo_inbox_drain'; upToRev: number }
  | { type: 'message_pending'; message: PendingUserMessage }
  | { type: 'message_dismiss' }
  | { type: 'patch_local'; patch: OptimisticPatch; now: number }
  | { type: 'patch_settled'; ids: string[]; error?: string; code?: string; now: number }
  | { type: 'urls_merge'; urls: Record<string, string>; now: number }
  | { type: 'urls_invalidate'; paths: string[] }
  | { type: 'set_error'; message: string | null; code?: string | null }
  | { type: 'cancel_start' }
  | { type: 'cancel_end' };

const MAX_ACTIVITY = 24;

// ── Derivations ──────────────────────────────────────────────────────────────

/** base + optimistic patches. Optimistic ops are client-patchable content edits, all idempotent. */
export const deriveDoc = (base: ComicDoc | null, optimistic: OptimisticPatch[]): ComicDoc | null => {
  if (!base) return null;
  if (!optimistic.length) return base;
  const viewed = optimistic.reduce((doc, patch) => applyOps(doc, patch.ops, base.updatedAt), base);
  return { ...viewed, rev: base.rev };
};

const withView = (state: StudioState): StudioState => ({ ...state, doc: deriveDoc(state.base, state.optimistic) });

/** True when the client is (or may be) out of sync with the server and should refetch. */
export const needsRefresh = (state: StudioState): boolean =>
  !!state.base && (state.hardRefresh || state.base.rev < state.behindRev || (state.syncDue && !Object.keys(state.streams).length));

/** Streams that make the studio "busy" (patch streams are silent saves). */
export const visibleStreams = (state: StudioState): StreamInfo[] =>
  Object.values(state.streams).filter((s) => s.kind !== 'patch');

/** A director turn is in flight: a message stream whose reply has not landed yet (renders may go on after). */
export const isMessageBusy = (state: StudioState): boolean =>
  Object.values(state.streams).some((s) => s.kind === 'message' && !s.replied);

export const isRenderBusy = (status?: string): boolean => status === 'queued' || status === 'rendering';

export const isTargetRendering = (doc: ComicDoc | null, target: RenderTarget): boolean =>
  !!doc && isRenderBusy(getRender(doc, target)?.status);

/** Pages currently queued or drawing. */
export const renderingPageCount = (doc: ComicDoc | null): number =>
  doc ? doc.pages.filter((p) => isRenderBusy(p.render.status)).length : 0;

/** Everything queued or drawing (pages, sheets, places, style options, cover). */
export const renderingCount = (doc: ComicDoc | null): number => {
  if (!doc) return 0;
  let n = 0;
  doc.pages.forEach((p) => (n += isRenderBusy(p.render.status) ? 1 : 0));
  doc.cast.forEach((c) => (n += isRenderBusy(c.sheet.status) ? 1 : 0));
  doc.places.forEach((p) => (n += isRenderBusy(p.sheet.status) ? 1 : 0));
  doc.style.options.forEach((o) => (n += isRenderBusy(o.render.status) ? 1 : 0));
  n += isRenderBusy(doc.cover.render.status) ? 1 : 0;
  return n;
};

const TAB_BY_RENDER_KIND: Record<RenderTarget['kind'], BoardTab> = {
  page: 'pages',
  cover: 'pages',
  sheet: 'cast',
  place: 'cast',
  style_option: 'style'
};

const tabForOwner = (owner: RefOwner | undefined): BoardTab | null =>
  owner?.kind === 'character' || owner?.kind === 'place' ? 'cast' : owner?.kind === 'style' ? 'style' : null;

const tabForOp = (op: DocOp): BoardTab | null => {
  switch (op.op) {
    case 'character':
    case 'character_remove':
    case 'place':
    case 'place_remove':
      return 'cast';
    case 'style':
    case 'style_option':
    case 'style_options_clear':
      return 'style';
    case 'pages':
    case 'page':
    case 'page_panels':
    case 'panel':
    case 'line':
    case 'balloons':
    case 'balloon':
    case 'plan_status':
    case 'cover':
      return 'pages';
    case 'render':
      return TAB_BY_RENDER_KIND[op.target.kind] || null;
    case 'brief':
    case 'note_add':
    case 'source':
      return 'story';
    // v5
    case 'letter_style':
    case 'line_style':
    case 'pages_reorder':
    case 'page_insert':
    case 'page_duplicate':
    case 'page_delete':
    case 'page_restore':
    case 'book':
      return 'pages';
    case 'render_use':
      return TAB_BY_RENDER_KIND[op.target?.kind] || null;
    case 'ref_add':
    case 'ref_patch':
    case 'ref_move':
    case 'ref_remove':
      return tabForOwner(op.owner);
    case 'ref_transfer':
      return tabForOwner(op.to);
    case 'edition':
    case 'translation':
    case 'translations':
    case 'edition_text':
    case 'edition_balloon':
    case 'glossary_term':
      return 'languages';
    default:
      // format/settings/message/spend/gate/memory/reader/version_star/asset_meta/safety/publication
      // don't move the board.
      return null;
  }
};

/** The board area the most recent meaningful op in a batch touched (null = no switch). */
export const tabForOps = (ops: DocOp[]): BoardTab | null => {
  for (let i = ops.length - 1; i >= 0; i -= 1) {
    const tab = tabForOp(ops[i]);
    if (tab) return tab;
  }
  return null;
};

/**
 * Server op shapes that always carry a field clear (`error: undefined` when a render is
 * queued/finished, `presetId: undefined` when a style option is locked). JSON drops
 * `undefined`, so when the key is missing on arrival the client can't apply the clear —
 * resync once the studio is idle. (A server that sends `null` keeps the key: no resync.)
 */
export const mayHaveDroppedClears = (ops: DocOp[]): boolean =>
  ops.some((op) => {
    if (op.op === 'render') {
      const status = op.patch?.status;
      return (status === 'queued' || status === 'ready') && !Object.prototype.hasOwnProperty.call(op.patch, 'error');
    }
    if (op.op === 'style') return op.patch?.status === 'locked' && !Object.prototype.hasOwnProperty.call(op.patch, 'presetId');
    return false;
  });

const ownerSig = (v: unknown): string | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as { kind?: unknown; id?: unknown };
  return typeof o.kind === 'string' ? (typeof o.id === 'string' ? `${o.kind}:${o.id}` : o.kind) : undefined;
};
const targetSig = (v: unknown): string | undefined => {
  if (!v || typeof v !== 'object' || typeof (v as { kind?: unknown }).kind !== 'string') return undefined;
  try {
    return renderTargetKey(v as RenderTarget);
  } catch {
    return undefined;
  }
};

/** Signature used to recognize the server's echo of our own patch (sanitized values may differ). */
const opSignature = (op: DocOp): string => {
  const o = op as unknown as Record<string, unknown>;
  const lineIds = Array.isArray(o.lineIds) ? (o.lineIds as unknown[]).join(',') : undefined;
  return [op.op, o.id, o.newId, o.pageId, o.panelId, o.lineId, lineIds, o.lang, o.field, o.path, targetSig(o.target), ownerSig(o.owner), ownerSig(o.from), ownerSig(o.to)]
    .filter((v) => v !== undefined && v !== null && v !== '')
    .join(':');
};

export const isEchoOf = (ops: DocOp[], optimistic: OptimisticPatch[]): boolean => {
  if (!optimistic.length) return false;
  const sig = ops.map(opSignature).join('|');
  return optimistic.some((p) => p.ops.map(opSignature).join('|') === sig) || sig === optimistic.flatMap((p) => p.ops).map(opSignature).join('|');
};

/** Live (started, not ended) activity lines, oldest first. */
export const activeActivities = (activity: ActivityItem[]): ActivityItem[] => activity.filter((a) => a.phase === 'start');

/** Conversation messages with any streaming drafts that have no message yet appended. */
export interface ConversationEntry {
  msg: Msg;
  /** Streaming text not yet committed to the message. */
  draft?: string;
}

export const conversationEntries = (doc: ComicDoc | null, drafts: Record<string, string>): ConversationEntry[] => {
  const messages = doc?.conversation || [];
  const ids = new Set(messages.map((m) => m.id));
  const out: ConversationEntry[] = messages.map((msg) => {
    const draft = drafts[msg.id];
    // Show the draft while it is longer than what has been committed (streaming text).
    return draft && draft.length > (msg.text || '').length ? { msg, draft } : { msg };
  });
  for (const [msgId, text] of Object.entries(drafts)) {
    if (ids.has(msgId) || !text) continue;
    out.push({ msg: { id: msgId, role: 'assistant', text: '', at: 0 }, draft: text });
  }
  return out;
};

// ── Event handling ───────────────────────────────────────────────────────────

const upsertActivity = (activity: ActivityItem[], event: Extract<StudioEvent, { type: 'activity' }>, now: number): ActivityItem[] => {
  const idx = activity.findIndex((a) => a.id === event.id);
  if (idx === -1) {
    if (event.phase === 'end') return activity; // an end for a line we never saw (joined late)
    return [...activity, { id: event.id, label: event.label, phase: 'start' as const, at: now, ...(event.cost ? { cost: event.cost } : {}) }].slice(-MAX_ACTIVITY);
  }
  const next = activity.slice();
  next[idx] = {
    ...next[idx],
    label: event.label || next[idx].label,
    phase: event.phase,
    ...(event.phase === 'end' ? { ok: event.ok !== false } : {}),
    ...(event.cost ? { cost: event.cost } : {}),
    at: now
  };
  return next;
};

const landedText = (msg: Msg | undefined) => (msg?.text || '').trim();

const applyOpsEvent = (state: StudioState, event: Extract<StudioEvent, { type: 'ops' }>, now: number, streamId?: string): StudioState => {
  const base = state.base;
  if (!base || !Array.isArray(event.ops) || typeof event.rev !== 'number') return state;
  if (event.rev <= base.rev) return state; // already applied (another stream delivered it)
  if (event.rev !== base.rev + 1) return { ...state, behindRev: Math.max(state.behindRev, event.rev) };

  const knownIds = new Set(base.conversation.map((m) => m.id));
  const nextBase: ComicDoc = { ...applyOps(base, event.ops, now), rev: event.rev };

  let drafts = state.drafts;
  let pendingMessage = state.pendingMessage;
  let replyLanded = false;
  for (const op of event.ops) {
    if (op.op === 'message') {
      // The committed assistant text replaces the streamed draft once it has text.
      if (drafts[op.msg.id] !== undefined && landedText(op.msg)) {
        drafts = { ...drafts };
        delete drafts[op.msg.id];
      }
      // Our optimistic user bubble is replaced by the server's copy.
      if (pendingMessage && op.msg.role === 'user' && !knownIds.has(op.msg.id)) pendingMessage = null;
      // The director's reply: a NEW assistant message with text, committed by the turn itself and
      // delivered by a stream (a job notice carries origin 'job'; an older message re-committed,
      // e.g. with an option answer recorded on its card, is not new; server_ops have no stream).
      if (streamId && op.msg.role === 'assistant' && !event.origin && !knownIds.has(op.msg.id) && landedText(op.msg)) replyLanded = true;
    } else if (op.op === 'message_patch' && typeof op.patch.text === 'string' && op.patch.text.trim() && drafts[op.id] !== undefined) {
      drafts = { ...drafts };
      delete drafts[op.id];
    }
  }
  // One director turn runs at a time, and every open stream delivers every batch (whichever gets
  // it first applies it), so a landed reply answers every message stream still waiting for one.
  const streams =
    replyLanded && Object.values(state.streams).some((s) => s.kind === 'message' && !s.replied)
      ? Object.fromEntries(Object.entries(state.streams).map(([id, s]) => [id, s.kind === 'message' && !s.replied ? { ...s, replied: true } : s]))
      : state.streams;

  const origin = event.origin;
  const label = typeof event.label === 'string' && event.label.trim() ? event.label.trim() : undefined;
  // A director edit is undoable: queue it with the exact base it applied to (inverse before apply).
  const undoInbox =
    origin === 'director' && event.ops.length
      ? [...state.undoInbox, { rev: event.rev, before: base, ops: event.ops, ...(label ? { label } : {}), at: now, ...(streamId ? { streamId } : {}) }].slice(-MAX_UNDO_INBOX)
      : state.undoInbox;

  return withView({
    ...state,
    base: nextBase,
    streams,
    drafts,
    pendingMessage,
    behindRev: Math.max(state.behindRev, event.rev),
    syncDue: state.syncDue || mayHaveDroppedClears(event.ops),
    lastOps: {
      rev: event.rev,
      ops: event.ops,
      // Our own edit coming back (or another tab of ours): never yank the board for it.
      echo: origin === 'user' || isEchoOf(event.ops, state.optimistic),
      ...(origin ? { origin } : {}),
      ...(label ? { label } : {})
    },
    undoInbox
  });
};

const handleEvent = (state: StudioState, streamId: string, event: StudioEvent, now: number): StudioState => {
  switch (event.type) {
    case 'hello': {
      if (!state.base || typeof event.rev !== 'number') return state;
      // The server is BEHIND us: it restarted from an older save. Our copy can't be trusted.
      if (event.rev < state.base.rev) return { ...state, hardRefresh: true };
      return { ...state, behindRev: Math.max(state.behindRev, event.rev) };
    }
    case 'ops':
      return typeof event.rev === 'number' ? applyOpsEvent(state, event, now, streamId) : state;
    case 'delta': {
      if (!event.msgId || typeof event.text !== 'string' || !event.text) return state;
      return { ...state, drafts: { ...state.drafts, [event.msgId]: (state.drafts[event.msgId] || '') + event.text } };
    }
    case 'activity':
      return event.id ? { ...state, activity: upsertActivity(state.activity, event, now) } : state;
    case 'urls':
      return { ...state, urls: mergeUrls(state.urls, event.urls, now) };
    case 'error': {
      const message = (event.message || '').trim() || 'Something went wrong in the studio.';
      const stream = state.streams[streamId];
      const code = typeof event.code === 'string' && event.code ? event.code : null;
      return {
        ...state,
        error: message,
        errorCode: code,
        streams: stream ? { ...state.streams, [streamId]: { ...stream, errored: message, ...(code ? { erroredCode: code } : {}) } } : state.streams
      };
    }
    case 'done':
      return {
        ...state,
        behindRev: typeof event.rev === 'number' ? Math.max(state.behindRev, event.rev) : state.behindRev,
        lastSpentUsd: typeof event.spentUsd === 'number' && Number.isFinite(event.spentUsd) ? event.spentUsd : state.lastSpentUsd,
        lastSavedUsd: typeof event.savedUsd === 'number' && Number.isFinite(event.savedUsd) && event.savedUsd > 0 ? event.savedUsd : null
      };
    default:
      return state;
  }
};

const endStream = (state: StudioState, action: Extract<StudioReducerAction, { type: 'stream_end' }>): StudioState => {
  const stream = state.streams[action.streamId];
  if (!stream) return state;
  const streams = { ...state.streams };
  delete streams[action.streamId];
  const anyLeft = Object.keys(streams).length > 0;

  let error = state.error;
  let errorCode = state.errorCode;
  let pendingMessage = state.pendingMessage;
  const failure = action.aborted ? undefined : action.error || stream.errored;

  // A message turn that ended before the server recorded the user's message: keep the
  // text on screen as "not sent" (with retry) instead of silently losing it.
  if (stream.kind === 'message' && pendingMessage && pendingMessage.streamId === action.streamId) {
    if (failure) {
      const code = action.error ? action.code : stream.erroredCode;
      pendingMessage = { ...pendingMessage, status: 'failed', error: failure, ...(code ? { code } : {}) };
      if (error === failure) error = null; // shown on the bubble instead
    } else if (action.aborted) {
      pendingMessage = { ...pendingMessage, status: 'failed', error: 'Stopped before it was sent.' };
    } else {
      pendingMessage = null;
    }
  } else if (action.error && !action.aborted) {
    error = action.error;
    errorCode = action.code ?? null;
  }

  let drafts = state.drafts;
  let activity = state.activity;
  if (!anyLeft) {
    drafts = {};
    activity = [];
  } else {
    // Keep live lines (another stream is still working); drop the finished ones.
    activity = activity.filter((a) => a.phase === 'start');
    const doc = state.base;
    if (doc && Object.keys(drafts).length) {
      drafts = Object.fromEntries(
        Object.entries(drafts).filter(([id]) => !landedText(doc.conversation.find((m) => m.id === id)))
      );
    }
  }

  return {
    ...state,
    streams,
    error,
    errorCode: error ? errorCode : null,
    pendingMessage,
    drafts,
    activity,
    // A stream that broke (not cancelled by us) may have missed ops: resync once idle.
    syncDue: state.syncDue || (!!action.error && !action.aborted),
    cancelling: anyLeft ? state.cancelling : false
  };
};

// ── Reducer ──────────────────────────────────────────────────────────────────

export const studioReducer = (state: StudioState, action: StudioReducerAction): StudioState => {
  switch (action.type) {
    case 'load_start':
      return { ...initialStudioState(), loading: true };
    case 'load_success':
      return withView({
        ...state,
        base: action.doc,
        loading: false,
        loadError: null,
        urls: mergeUrls(state.urls, action.urls, action.now),
        behindRev: action.doc.rev,
        hardRefresh: false,
        syncDue: false
      });
    case 'load_error':
      return { ...state, loading: false, loadError: action.message || 'This comic could not be opened.' };
    case 'refresh_start':
      return { ...state, refreshing: true };
    case 'refresh_success': {
      const current = state.base;
      // Never regress: a stream may have applied newer ops while the GET was in flight.
      const take = !current || state.hardRefresh || action.doc.rev >= current.rev;
      const base = take || !current ? action.doc : current;
      return withView({
        ...state,
        base,
        refreshing: false,
        loading: false,
        loadError: null,
        urls: mergeUrls(state.urls, action.urls, action.now),
        // What the server just returned is the newest state we can get; never keep
        // chasing a revision it can't serve (that would loop refetches).
        behindRev: base.rev,
        hardRefresh: false,
        syncDue: false
      });
    }
    case 'refresh_error':
      return {
        ...state,
        refreshing: false,
        syncDue: false,
        hardRefresh: false,
        // Retrying a failed first load keeps the fatal screen, with the newest reason.
        ...(action.message ? (state.base ? { error: action.message } : { loadError: action.message }) : {})
      };
    case 'stream_start':
      return {
        ...state,
        streams: {
          ...state.streams,
          [action.streamId]: {
            id: action.streamId,
            kind: action.kind,
            ...(action.actionType ? { actionType: action.actionType } : {}),
            startedAt: action.now
          }
        }
      };
    case 'stream_event':
      // Late events from a stream we already closed (e.g. after a project switch) are dropped.
      if (!state.streams[action.streamId]) return state;
      return handleEvent(state, action.streamId, action.event, action.now);
    case 'stream_end':
      return endStream(state, action);
    case 'message_pending':
      return { ...state, pendingMessage: action.message };
    case 'message_dismiss':
      return { ...state, pendingMessage: null };
    case 'patch_local':
      return withView({ ...state, optimistic: [...state.optimistic, action.patch] });
    case 'patch_settled': {
      const ids = new Set(action.ids);
      return withView({
        ...state,
        optimistic: state.optimistic.filter((p) => !ids.has(p.id)),
        ...(action.error ? { error: action.error, errorCode: action.code ?? null } : {})
      });
    }
    case 'urls_merge':
      return { ...state, urls: mergeUrls(state.urls, action.urls, action.now) };
    case 'urls_invalidate': {
      if (!action.paths.some((p) => state.urls[p])) return state;
      const urls = { ...state.urls };
      action.paths.forEach((p) => {
        if (urls[p]) urls[p] = { ...urls[p], expiresAt: 0 };
      });
      return { ...state, urls };
    }
    case 'set_error':
      return { ...state, error: action.message, errorCode: action.message ? action.code ?? null : null };
    case 'server_ops':
      // Not tied to a stream: apply with the same revision guard (a gap triggers a refetch).
      return applyOpsEvent(state, { type: 'ops', rev: action.rev, ops: action.ops, ...(action.origin ? { origin: action.origin } : {}), ...(action.label ? { label: action.label } : {}) }, action.now);
    case 'undo_inbox_drain': {
      if (!state.undoInbox.length) return state;
      const undoInbox = state.undoInbox.filter((b) => b.rev > action.upToRev);
      return undoInbox.length === state.undoInbox.length ? state : { ...state, undoInbox };
    }
    case 'cancel_start':
      return { ...state, cancelling: true };
    case 'cancel_end':
      return { ...state, cancelling: false };
    default:
      return state;
  }
};
