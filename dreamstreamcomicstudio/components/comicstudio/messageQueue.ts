// The visible message queue, "Up next" (agent-editor plan §3 A1; lead decision D1). Pure helpers, no React.
//
// While the director works, notes the creator types are queued instead of dropped. When the reply lands, the queue
// drains as ONE combined message ("(Sent while you were working:) 1. … 2. …"), split only where the focus differs (a
// different page or selection) or a size cap would be crossed, in order. The queue holds instead of draining while
// the last reply asks something (an unanswered options or conflict card), while a spend gate is open, after Stop,
// while a `plan_pages` action holds the turn lock, after a reload (never auto-sent), and after the server said BUSY
// (another tab or device). Every hold has visible copy (`holdLine`). useStudio owns the state (studioReducer's queue
// slice) and the drain; QueuedMessages renders it.
//
// The queue is saved per project in sessionStorage. Every read and write sits in try/catch: a private window or a
// full quota only loses the reload convenience, never the notes on screen.

import type { AttachmentTarget, StudioFocus } from '../../shared/comic/events';
import { CAST_KINDS, type ComicDoc, type Msg } from '../../shared/comic/doc';

export const QUEUE_LIMITS = {
  /** Notes waiting at once (plan §3 A1). */
  notes: 10,
  /** Characters per note, and per drained message (the server's MAX_MESSAGE_CHARS, routes/comic.ts). */
  chars: 60_000,
  /** Inbox photos per drained message (the server's cap; useStudio MAX_INBOX_ATTACHMENTS). */
  inboxPaths: 12,
  /** BUSY answers (another tab or device) retried automatically before the queue waits for a tap. */
  busyRetries: 3
} as const;

/** Delays before each automatic retry after BUSY (bounded: QUEUE_LIMITS.busyRetries, never an idle timer). */
export const QUEUE_RETRY_MS: readonly number[] = [8_000, 20_000, 45_000];

/** The line that opens a drained message, so the director knows these were typed while it worked (D1). */
export const QUEUE_PREFIX = '(Sent while you were working:)';

/** A note waiting in Up next. Photos travel as inbox paths already uploaded by the composer (plan §3 A1). */
export interface QueuedNote {
  id: string;
  text: string;
  /** Photos the composer uploaded first (`uploadRef(…, {kind:'inbox'})`). */
  inboxPaths?: string[];
  /** Quick-assign per inbox photo, aligned with `inboxPaths`. */
  attachmentTargets?: AttachmentTarget[];
  /** What the creator was looking at when they wrote it (a page, a selection). */
  focus?: StudioFocus;
  /** When it was queued (ms). */
  at: number;
}

/** Holds set by an event: Stop was pressed, the notes came back after a reload, or the server said BUSY. */
export type QueueEventHold = 'stopped' | 'restored' | 'elsewhere';
/** Why the queue is not draining on its own right now. */
export type QueueHold = QueueEventHold | 'plan_pages' | 'gate' | 'question';

export type QueueAddRefusal = 'empty' | 'full' | 'too_long' | 'too_many_photos';
export interface QueueAddResult {
  notes: QueuedNote[];
  added: boolean;
  reason?: QueueAddRefusal;
}

const clean = (text: unknown): string => (typeof text === 'string' ? text.trim() : '');

/** What `send()` resolved to, as a SendOutcome (a controller that resolves void sent it). */
export const sendOutcomeOf = (result: unknown): 'sent' | 'queued' | 'held' | 'refused' =>
  result === 'queued' || result === 'held' || result === 'refused' ? result : 'sent';

// ── Editing the queue ────────────────────────────────────────────────────────

/** Append a note at the end, within QUEUE_LIMITS. A refused note leaves the queue as it was and says why. */
export const add = (notes: readonly QueuedNote[], note: QueuedNote): QueueAddResult => {
  const text = clean(note.text);
  const photos = note.inboxPaths?.length ?? 0;
  if (!text && !photos) return { notes: [...notes], added: false, reason: 'empty' };
  if (notes.length >= QUEUE_LIMITS.notes) return { notes: [...notes], added: false, reason: 'full' };
  if (text.length > QUEUE_LIMITS.chars) return { notes: [...notes], added: false, reason: 'too_long' };
  if (photos > QUEUE_LIMITS.inboxPaths) return { notes: [...notes], added: false, reason: 'too_many_photos' };
  return { notes: [...notes, { ...note, text }], added: true };
};

/** Replace a note's text. An empty or over-long edit changes nothing (the editor keeps it open with its hint). */
export const edit = (notes: readonly QueuedNote[], id: string, text: string): QueuedNote[] => {
  const next = clean(text);
  if (!next || next.length > QUEUE_LIMITS.chars) return [...notes];
  return notes.map((n) => (n.id === id ? { ...n, text: next } : n));
};

export const remove = (notes: readonly QueuedNote[], id: string): QueuedNote[] => notes.filter((n) => n.id !== id);

/** Move a note to another position (clamped). */
export const moveTo = (notes: readonly QueuedNote[], id: string, index: number): QueuedNote[] => {
  const from = notes.findIndex((n) => n.id === id);
  if (from === -1 || !Number.isFinite(index)) return [...notes];
  const to = Math.max(0, Math.min(notes.length - 1, Math.trunc(index)));
  if (to === from) return [...notes];
  const next = [...notes];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

/** Move a note one step up (-1) or down (+1); at either end nothing changes. */
export const move = (notes: readonly QueuedNote[], id: string, dir: -1 | 1): QueuedNote[] => {
  const from = notes.findIndex((n) => n.id === id);
  if (from === -1) return [...notes];
  return moveTo(notes, id, from + (dir < 0 ? -1 : 1));
};

/**
 * Put notes back that went out but never reached the director (the server said BUSY): drained notes go back at the
 * head, in their order; a message sent straight from the composer goes to the tail (it is the newest). A note
 * already queued keeps its place. Never capped: putting back never loses a note.
 */
export const requeue = (notes: readonly QueuedNote[], back: readonly QueuedNote[], at: 'head' | 'tail'): QueuedNote[] => {
  const ids = new Set(notes.map((n) => n.id));
  const fresh = back.filter((n) => n && !ids.has(n.id));
  return at === 'head' ? [...fresh, ...notes] : [...notes, ...fresh];
};

// ── Draining ─────────────────────────────────────────────────────────────────

const sortedIds = (ids?: readonly string[]) => (Array.isArray(ids) ? [...ids].filter((v) => typeof v === 'string' && v).sort().join(',') : '');

/** Notes about the same thing share a key (page, selected balloons, panel, frames, overlays); the surface does not count. */
export const focusKey = (focus?: StudioFocus | null): string => {
  if (!focus || typeof focus !== 'object') return '';
  const panel = typeof focus.panelN === 'number' ? String(focus.panelN) : '';
  return [focus.pageId || '', sortedIds(focus.lineIds), panel, sortedIds(focus.panelIds), sortedIds(focus.layerIds)].join('|').replace(/^\|+$/, '');
};

/** A note's words without a prefix it already carries (a drained message that came back through "Try again"). */
const unprefixed = (text: string): string => (text.startsWith(QUEUE_PREFIX) ? text.slice(QUEUE_PREFIX.length).trim() : text);

/** The text a batch drains as: one note keeps its words after the prefix; several are numbered (D1). */
export const combinedText = (batch: readonly QueuedNote[]): string => {
  const texts = batch.map((n) => unprefixed(clean(n.text)));
  if (!texts.length) return '';
  if (texts.length === 1) return texts[0] ? `${QUEUE_PREFIX} ${texts[0]}` : '';
  return [QUEUE_PREFIX, ...texts.map((t, i) => `${i + 1}. ${t || '(photos)'}`)].join('\n');
};

/**
 * The queue as the messages it drains into, in order: consecutive notes with the same focus share one message; a
 * different focus starts a new one (D1), and so does a message that would pass the server's text or photo cap.
 */
export const batchesForDrain = (notes: readonly QueuedNote[]): QueuedNote[][] => {
  const batches: QueuedNote[][] = [];
  let current: QueuedNote[] = [];
  let key = '';
  const fits = (batch: QueuedNote[], note: QueuedNote) => {
    const next = [...batch, note];
    const photos = next.reduce((n, x) => n + (x.inboxPaths?.length ?? 0), 0);
    return combinedText(next).length <= QUEUE_LIMITS.chars && photos <= QUEUE_LIMITS.inboxPaths;
  };
  for (const note of notes) {
    const k = focusKey(note.focus);
    if (current.length && (k !== key || !fits(current, note))) {
      batches.push(current);
      current = [];
    }
    if (!current.length) key = k;
    current.push(note);
  }
  if (current.length) batches.push(current);
  return batches;
};

/** What one batch sends: the combined text, every photo in order, its quick-assigns aligned, and the shared focus. */
export interface DrainRequest {
  text: string;
  inboxPaths?: string[];
  attachmentTargets?: AttachmentTarget[];
  focus?: StudioFocus;
}

export const drainRequest = (batch: readonly QueuedNote[]): DrainRequest => {
  const inboxPaths: string[] = [];
  const targets: AttachmentTarget[] = [];
  for (const n of batch) {
    const paths = n.inboxPaths ?? [];
    paths.forEach((p, i) => {
      inboxPaths.push(p);
      targets.push(n.attachmentTargets?.[i] ?? null);
    });
  }
  const focus = batch.find((n) => n.focus)?.focus;
  return {
    text: combinedText(batch),
    ...(inboxPaths.length ? { inboxPaths } : {}),
    ...(targets.some(Boolean) ? { attachmentTargets: targets } : {}),
    ...(focus ? { focus } : {})
  };
};

/** What a note is about, in the focus chip's words ("Page 3 · 2 balloons"), or null when it names no page. */
export const noteFocusLabel = (doc: Pick<ComicDoc, 'pages'> | null | undefined, focus?: StudioFocus | null): string | null => {
  if (!focus?.pageId || !Array.isArray(doc?.pages)) return null;
  const page = doc.pages.find((p) => p.id === focus.pageId);
  if (!page) return 'A page that was removed';
  const n = focus.lineIds?.length || 0;
  const detail = n ? ` · ${n} ${n === 1 ? 'balloon' : 'balloons'}` : typeof focus.panelN === 'number' ? ` · panel ${focus.panelN}` : '';
  return `Page ${page.n}${detail}`;
};

// ── Holds ────────────────────────────────────────────────────────────────────

const lastAssistant = (doc: ComicDoc | null | undefined): Msg | undefined => {
  const list = doc?.conversation;
  if (!Array.isArray(list)) return undefined;
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i]?.role === 'assistant') return list[i];
  return undefined;
};

/**
 * The last reply asks something the creator has not answered: an options card with no answer, or a conflict card
 * with an item not yet resolved. Its answer belongs to that question, so queued notes wait (plan §3 A1).
 */
export const openQuestion = (doc: ComicDoc | null | undefined): boolean => {
  const cards = lastAssistant(doc)?.cards;
  if (!Array.isArray(cards)) return false;
  return cards.some((card) => {
    if (!card || typeof card !== 'object') return false;
    if (card.type === 'options') return Array.isArray(card.choices) && card.choices.length > 0 && !(card.answered || []).some(Boolean);
    if (card.type === 'conflict') return Array.isArray(card.items) && card.items.some((item) => item && !item.resolved);
    return false;
  });
};

export interface QueueHoldInput {
  doc: ComicDoc | null | undefined;
  /** The event hold, if any (Stop, a reload, BUSY). */
  held?: QueueEventHold | null;
  /** A `plan_pages` action holds the turn lock. */
  planning?: boolean;
}

/** Why the queue waits instead of draining, most binding first; null = it drains as soon as the turn is free. */
export const holdReason = (input: QueueHoldInput): QueueHold | null => {
  if (input.held === 'stopped' || input.held === 'restored') return input.held;
  if (input.planning) return 'plan_pages';
  if (input.held === 'elsewhere') return 'elsewhere';
  if (input.doc?.gate && input.doc.gate.status === 'open') return 'gate';
  if (openQuestion(input.doc)) return 'question';
  return null;
};

/** The one-tap way out of a hold, shown beside its line. */
export type QueueHoldAction = 'send_anyway' | 'send' | 'retry';

/** The visible line for the queue's state (never silent). `retriesLeft` false = BUSY retries are used up. */
export const holdLine = (hold: QueueHold | null, count: number, opts: { retriesLeft?: boolean } = {}): { text: string; action?: QueueHoldAction; clear?: boolean } => {
  const notes = count === 1 ? '1 note is' : `${count} notes are`;
  switch (hold) {
    case 'stopped':
      return { text: `Stopped. ${notes} waiting.`, action: 'send', clear: true };
    case 'restored':
      return { text: `${count === 1 ? '1 note was' : `${count} notes were`} waiting.`, action: 'send', clear: true };
    case 'plan_pages':
      return { text: 'Planning the pages — these go once the plan is in.' };
    case 'elsewhere':
      return opts.retriesLeft === false
        ? { text: 'Still busy in another tab or on another device.', action: 'retry', clear: true }
        : { text: 'The director is busy in another tab or on another device. Trying again shortly.', action: 'retry', clear: true };
    case 'gate':
      return { text: 'Approve or skip the drawing above first, or', action: 'send_anyway' };
    case 'question':
      return { text: 'Answer the question above first, or', action: 'send_anyway' };
    default:
      return { text: 'The director reads these when it finishes this step.' };
  }
};

// ── Saved per project (sessionStorage) ───────────────────────────────────────

export const QUEUE_STORAGE_PREFIX = 'comicstudio.queue.v1.';
/** Size guard for one stored queue (text only; photos are paths). */
const MAX_STORED_CHARS = 700_000;
const MAX_FOCUS_IDS = 80;

const strings = (v: unknown, max: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 512).slice(0, max);
  return out.length ? out : undefined;
};

const targetOf = (v: unknown): AttachmentTarget => {
  if (!v || typeof v !== 'object') return null;
  const t = v as { kind?: unknown; id?: unknown; name?: unknown; castKind?: unknown };
  if (t.kind === 'new_character' && typeof t.name === 'string' && t.name.trim()) {
    const castKind = CAST_KINDS.find((k) => k === t.castKind);
    return { kind: 'new_character', name: t.name.trim().slice(0, 80), ...(castKind ? { castKind } : {}) };
  }
  if ((t.kind === 'character' || t.kind === 'place') && typeof t.id === 'string' && t.id) return { kind: t.kind, id: t.id };
  if (t.kind === 'style') return { kind: 'style' };
  return null;
};

const focusOf = (v: unknown): StudioFocus | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const f = v as Record<string, unknown>;
  const surface = f.surface === 'board' || f.surface === 'page_editor' || f.surface === 'reader' || f.surface === 'timeline' ? f.surface : undefined;
  const out: StudioFocus = {
    ...(typeof f.pageId === 'string' && f.pageId ? { pageId: f.pageId } : {}),
    ...(strings(f.lineIds, MAX_FOCUS_IDS) ? { lineIds: strings(f.lineIds, MAX_FOCUS_IDS) } : {}),
    ...(typeof f.panelN === 'number' && Number.isInteger(f.panelN) && f.panelN >= 0 ? { panelN: f.panelN } : {}),
    ...(strings(f.panelIds, MAX_FOCUS_IDS) ? { panelIds: strings(f.panelIds, MAX_FOCUS_IDS) } : {}),
    ...(strings(f.layerIds, MAX_FOCUS_IDS) ? { layerIds: strings(f.layerIds, MAX_FOCUS_IDS) } : {}),
    ...(surface ? { surface } : {})
  };
  return Object.keys(out).length ? out : undefined;
};

/** A stored note as a valid QueuedNote, or null (anything malformed is dropped on read, never trusted). */
export const sanitizeNote = (raw: unknown): QueuedNote | null => {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw as Record<string, unknown>;
  if (typeof n.id !== 'string' || !n.id || n.id.length > 80) return null;
  const text = clean(n.text).slice(0, QUEUE_LIMITS.chars);
  const inboxPaths = strings(n.inboxPaths, QUEUE_LIMITS.inboxPaths);
  if (!text && !inboxPaths) return null;
  const targets = inboxPaths && Array.isArray(n.attachmentTargets) ? inboxPaths.map((_, i) => targetOf((n.attachmentTargets as unknown[])[i])) : undefined;
  const focus = focusOf(n.focus);
  return {
    id: n.id,
    text,
    ...(inboxPaths ? { inboxPaths } : {}),
    ...(targets && targets.some(Boolean) ? { attachmentTargets: targets } : {}),
    ...(focus ? { focus } : {}),
    at: typeof n.at === 'number' && Number.isFinite(n.at) ? n.at : 0
  };
};

const storage = (): Storage | null => {
  try {
    return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
  } catch {
    return null;
  }
};

/** The notes saved for this project in this tab (empty when none, unreadable or storage is blocked). */
export const readStoredQueue = (projectId: string): QueuedNote[] => {
  if (!projectId) return [];
  try {
    const raw = storage()?.getItem(QUEUE_STORAGE_PREFIX + projectId);
    if (!raw || raw.length > MAX_STORED_CHARS) return [];
    const parsed = JSON.parse(raw) as { v?: unknown; notes?: unknown };
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.notes)) return [];
    const seen = new Set<string>();
    const out: QueuedNote[] = [];
    for (const item of parsed.notes) {
      const note = sanitizeNote(item);
      if (!note || seen.has(note.id)) continue;
      seen.add(note.id);
      out.push(note);
      if (out.length >= QUEUE_LIMITS.notes) break;
    }
    return out;
  } catch {
    return [];
  }
};

/** Save (or, when empty, forget) this project's queue. Fails quietly: the notes on screen are the source of truth. */
export const writeStoredQueue = (projectId: string, notes: readonly QueuedNote[]): void => {
  if (!projectId) return;
  try {
    const store = storage();
    if (!store) return;
    const key = QUEUE_STORAGE_PREFIX + projectId;
    if (!notes.length) {
      store.removeItem(key);
      return;
    }
    const raw = JSON.stringify({ v: 1, notes });
    if (raw.length > MAX_STORED_CHARS) return;
    store.setItem(key, raw);
  } catch {
    /* private mode or a full quota: the queue still works for this page */
  }
};
