// Comic Studio's alert moments (notify SPEC §5.2), as a pure function from one rendered studio state to the next.
// The mounted studio (a hook in useStudio, NF-2) and a stream held after the person left the comic (studioDetached,
// NF-2 / liveturn LT-2) both fold their events through the real studioReducer and call this with the frames before and
// after, so both produce the same alerts. It reads the doc of the frame it is given, never a ref inside a stream
// callback (one event stale). Patch streams (silent saves) are ignored everywhere.
//
//  - Replied: a message stream's `replied` turned true. A new needs-you in the replied doc alerts as itself; otherwise,
//    while pictures are drawing or a publish runs, nothing yet (the settle reports the work); otherwise "The Director
//    replied", keyed by the reply's message id.
//  - Settled: a stream left. At most one alert, in this order: failed (a server error inside the stream, or a new studio
//    error with a server code, never Stop, BUSY or a lost connection), a new needs-you, drawn / drawn with issues,
//    translated / a translation that needs a look, published / couldn't publish, a reply nobody alerted yet.
//    Translation alerts come only from a stream that translated (a translate action, an approved translate gate, or a
//    turn that posted a translation card), and name only the languages it wrote: an edit that leaves an edition stale is
//    not a translation.
//  - Stop: a stream that ends while the studio is cancelling is the person's own Stop: silent.
//  - A lost connection (a transport error with no server code) is never alerted: the server may still finish the turn.
//
// Keys use message, card, gate and picture ids, so a replayed stream (liveturn's attach) dedupes against the first.

import type { Card, ComicDoc, LanguageEdition, Msg, RenderState, TextTranslation, TranslationFailure } from '../../../shared/comic/doc';
import { editionProgress } from '../../../shared/comic/i18n';
import { anyRenderBusy, needsYouOf, type NeedsWhy, type NeedsYou } from '../../../shared/comic/attention';
import type { AlertDraft, AlertKind } from '../../../services/alerts/types';
import type { StreamInfo, StudioState } from '../studioReducer';

/** One rendered studio state, as the alert transitions read it. */
export interface StudioAlertFrame {
  projectId: string;
  /** The person's own comic title. */
  title: string;
  streams: Record<string, StreamInfo>;
  doc: ComicDoc | null;
  error: string | null;
  errorCode: string | null;
  /** Stop is winding the turn down (StudioState.cancelling): what ends now is the person's own Stop. */
  cancelling?: boolean;
}

/** What the transitions remember for one comic (one per mounted studio or held comic). */
export interface TransitionMemo {
  /** The doc each open stream started from. */
  startDocs: Map<string, ComicDoc | null>;
  /** Pictures already reported (`<targetKey>@<asset path | failed:updatedAt>`) and needs-you keys already posted. */
  reported: Set<string>;
  /** Message streams that already alerted for their reply. */
  alertedStreams: Set<string>;
}

export const createTransitionMemo = (): TransitionMemo => ({ startDocs: new Map(), reported: new Set(), alertedStreams: new Set() });

/** A frame from a studio state. */
export const studioFrameOf = (projectId: string, state: StudioState): StudioAlertFrame => ({
  projectId,
  title: typeof state.doc?.brief?.title === 'string' ? state.doc.brief.title : '',
  streams: state.streams,
  doc: state.doc,
  error: state.error,
  errorCode: state.errorCode,
  cancelling: state.cancelling
});

/** Not failures: Stop, another tab holding the turn, a steer with no turn running, a lost connection. */
const NOT_FAILURES = new Set(['CANCELLED', 'connection_lost', 'BUSY', 'NOT_RUNNING']);
/** Keep remembered picture and needs-you keys bounded on a long session. */
const REPORTED_MAX = 400;

const NEEDS_KIND: Record<NeedsWhy, AlertKind> = { approval: 'approval', question: 'question', plan: 'plan', style: 'style' };

const conv = (doc: ComicDoc | null | undefined): Msg[] => (Array.isArray(doc?.conversation) ? doc!.conversation : []);
const lastUserIndex = (msgs: readonly Msg[]): number => {
  for (let i = msgs.length - 1; i >= 0; i -= 1) if (msgs[i]?.role === 'user') return i;
  return -1;
};
const landed = (m: Msg | undefined): boolean => !!m && m.role === 'assistant' && typeof m.text === 'string' && !!m.text.trim();
const newestAssistantId = (doc: ComicDoc | null | undefined): string | null => {
  const msgs = conv(doc);
  for (let i = msgs.length - 1; i >= 0; i -= 1) if (landed(msgs[i])) return msgs[i].id;
  return null;
};

/** A publish card is running in the current turn (a reply that started it is reported when it ends). */
const publishRunning = (doc: ComicDoc | null | undefined): boolean => {
  const msgs = conv(doc);
  for (let i = msgs.length - 1; i > lastUserIndex(msgs); i -= 1) {
    const cards = Array.isArray(msgs[i]?.cards) ? (msgs[i].cards as Card[]) : [];
    if (cards.some((c) => c?.type === 'publish' && c.status === 'running')) return true;
  }
  return false;
};
const workRunning = (doc: ComicDoc | null | undefined): boolean => anyRenderBusy(doc) || publishRunning(doc);

const remember = (memo: TransitionMemo, key: string) => {
  memo.reported.add(key);
  if (memo.reported.size > REPORTED_MAX) memo.reported.delete(memo.reported.values().next().value as string);
};

interface RenderTargetEntry {
  key: string;
  page: boolean;
  render: RenderState | undefined;
}

/** Every render target that alerts (pages, cover, cast and place sheets). Style options are left to the style needs-you. */
const targetsOf = (doc: ComicDoc | null | undefined): Map<string, RenderTargetEntry> => {
  const out = new Map<string, RenderTargetEntry>();
  if (!doc) return out;
  for (const p of Array.isArray(doc.pages) ? doc.pages : []) if (p?.id) out.set(`page:${p.id}`, { key: `page:${p.id}`, page: true, render: p.render });
  if (doc.cover) out.set('cover', { key: 'cover', page: false, render: doc.cover.render });
  for (const c of Array.isArray(doc.cast) ? doc.cast : []) if (c?.id) out.set(`sheet:${c.id}`, { key: `sheet:${c.id}`, page: false, render: c.sheet });
  for (const p of Array.isArray(doc.places) ? doc.places : []) if (p?.id) out.set(`place:${p.id}`, { key: `place:${p.id}`, page: false, render: p.sheet });
  return out;
};

const draftBase = (frame: StudioAlertFrame) => ({ target: { app: 'comic' as const, id: frame.projectId }, title: frame.title });

const needsDraft = (frame: StudioAlertFrame, needs: NeedsYou): AlertDraft => ({
  kind: NEEDS_KIND[needs.why],
  key: `comic:${frame.projectId}:needs:${needs.key}`,
  ...draftBase(frame),
  ...(needs.imageCount ? { imageCount: needs.imageCount } : {})
});

/** A needs-you that is new: not what waited when the stream started, and not posted for this comic yet. */
const newNeeds = (memo: TransitionMemo, doc: ComicDoc | null, start: ComicDoc | null | undefined): NeedsYou | null => {
  const needs = needsYouOf(doc);
  if (!needs) return null;
  if (memo.reported.has(`needs:${needs.key}`)) return null;
  if (start !== undefined && needsYouOf(start)?.key === needs.key) return null;
  return needs;
};

const drawnDraft = (frame: StudioAlertFrame, memo: TransitionMemo, start: ComicDoc | null): AlertDraft | null => {
  const before = targetsOf(start);
  const drawn: string[] = [];
  const failed: string[] = [];
  let allPages = true;
  for (const [key, entry] of targetsOf(frame.doc)) {
    const now = entry.render;
    if (!now) continue;
    const was = before.get(key)?.render;
    let mark: string | null = null;
    if (now.status === 'ready' && now.asset?.path && (was?.status !== 'ready' || was.asset?.path !== now.asset.path)) mark = `${key}@${now.asset.path}`;
    else if (now.status === 'failed' && (was?.status !== 'failed' || was.updatedAt !== now.updatedAt)) mark = `${key}@failed:${now.updatedAt ?? 0}`;
    if (!mark || memo.reported.has(mark)) continue;
    remember(memo, mark);
    (now.status === 'ready' ? drawn : failed).push(mark);
    if (!entry.page) allPages = false;
  }
  if (!drawn.length && !failed.length) return null;
  const reported = [...drawn, ...failed].sort().join(',');
  if (failed.length) return { kind: 'drawn_issues', key: `comic:${frame.projectId}:drawn:${reported}`, ...draftBase(frame), count: drawn.length, failedCount: failed.length };
  return { kind: 'drawn', key: `comic:${frame.projectId}:drawn:${reported}`, ...draftBase(frame), count: drawn.length, pictures: !allPages };
};

const translationCardIds = (doc: ComicDoc | null | undefined): Set<string> => {
  const ids = new Set<string>();
  for (const m of conv(doc)) for (const c of Array.isArray(m?.cards) ? (m.cards as Card[]) : []) if (c?.type === 'translation') ids.add(c.id);
  return ids;
};

/** The stream ran a translation: a translate action, an approved translate gate, or a turn that posted a translation card. */
const translated = (s: StreamInfo, start: ComicDoc | null, doc: ComicDoc): boolean => {
  if (s.actionType === 'translate') return true;
  if (s.actionType === 'approve_gate') return start?.gate?.action?.type === 'translate';
  if (s.kind !== 'message') return false;
  const before = translationCardIds(start);
  for (const id of translationCardIds(doc)) if (!before.has(id)) return true;
  return false;
};

/** A translation written (new, or rewritten) between the two docs. */
const wrote = (was: TextTranslation | undefined, now: TextTranslation | undefined): boolean =>
  !!now && (!was || was.at !== now.at || was.sourceHash !== now.sourceHash || was.text !== now.text);
const triedAgain = (was: TranslationFailure | undefined, now: TranslationFailure | null | undefined): boolean =>
  !!now && (!was || was.at !== now.at || was.attempts !== now.attempts);

/** The edition received work between the two docs: a line or a title written, or an attempt that failed recorded. */
const editionWorkedOn = (was: LanguageEdition | undefined, now: LanguageEdition): boolean => {
  const lines = now.lines && typeof now.lines === 'object' ? now.lines : {};
  for (const [id, t] of Object.entries(lines)) if (wrote(was?.lines?.[id], t)) return true;
  if (wrote(was?.cover?.title, now.cover?.title) || wrote(was?.cover?.tagline, now.cover?.tagline)) return true;
  if (wrote(was?.brief?.title, now.brief?.title) || wrote(was?.brief?.logline, now.brief?.logline)) return true;
  for (const [id, f] of Object.entries(now.failures ?? {})) if (triedAgain(was?.failures?.[id], f)) return true;
  return false;
};

const incompleteEdition = (doc: ComicDoc, lang: string): boolean => {
  try {
    const p = editionProgress(doc, lang);
    return p.total === 0 || p.done < p.total;
  } catch {
    return true;
  }
};

const translateDraft = (frame: StudioAlertFrame, s: StreamInfo, start: ComicDoc | null): AlertDraft | null => {
  const doc = frame.doc;
  const editions = doc?.i18n?.editions;
  if (!doc || !editions || !translated(s, start, doc)) return null;
  const before = start?.i18n?.editions ?? {};
  // Only the languages this stream wrote: a source edit raises an edition's stale count, which is not a translation.
  const changed = Object.keys(editions)
    .filter((lang) => !!editions[lang] && editionWorkedOn(before[lang], editions[lang]))
    .sort();
  if (!changed.length) return null;
  const incomplete = changed.filter((lang) => incompleteEdition(doc, lang));
  const key = `comic:${frame.projectId}:translate:${changed.join(',')}:${doc.rev}`;
  if (incomplete.length) return { kind: 'translate_issues', key, ...draftBase(frame), languages: incomplete };
  return { kind: 'translated', key, ...draftBase(frame), languages: changed };
};

const publishDraft = (frame: StudioAlertFrame, start: ComicDoc | null): AlertDraft | null => {
  const statusById = new Map<string, string>();
  for (const m of conv(start)) for (const c of Array.isArray(m?.cards) ? (m.cards as Card[]) : []) if (c?.type === 'publish') statusById.set(c.id, c.status);
  for (const m of conv(frame.doc).slice().reverse()) {
    for (const c of Array.isArray(m?.cards) ? (m.cards as Card[]) : []) {
      if (c?.type !== 'publish' || (c.status !== 'done' && c.status !== 'failed') || statusById.get(c.id) === c.status) continue;
      return { kind: c.status === 'done' ? 'published' : 'publish_failed', key: `comic:${frame.projectId}:publish:${c.id}:${c.status}`, ...draftBase(frame) };
    }
  }
  return null;
};

const replyDraft = (frame: StudioAlertFrame, msgId: string): AlertDraft => ({ kind: 'reply', key: `comic:${frame.projectId}:reply:${msgId}`, ...draftBase(frame) });

/** The alerts between two rendered frames of one comic. `memo` is that comic's memory; `now` is for the caller's logs. */
export function studioTransitions(prev: StudioAlertFrame | null, next: StudioAlertFrame, memo: TransitionMemo, now: number): AlertDraft[] {
  void now;
  const out: AlertDraft[] = [];
  const before = prev?.streams ?? {};
  const after = next.streams ?? {};

  // Streams seen for the first time start from the doc before they appeared.
  for (const [id, s] of Object.entries(after)) {
    if (!s || s.kind === 'patch' || memo.startDocs.has(id)) continue;
    memo.startDocs.set(id, before[id] ? next.doc : prev?.doc ?? next.doc);
  }

  // Replied.
  for (const [id, s] of Object.entries(after)) {
    if (!s || s.kind !== 'message' || !s.replied || before[id]?.replied || memo.alertedStreams.has(id)) continue;
    const needs = newNeeds(memo, next.doc, memo.startDocs.get(id));
    if (needs) {
      remember(memo, `needs:${needs.key}`);
      memo.alertedStreams.add(id);
      out.push(needsDraft(next, needs));
      continue;
    }
    if (workRunning(next.doc)) continue;
    const msgId = newestAssistantId(next.doc);
    if (!msgId) continue;
    memo.alertedStreams.add(id);
    out.push(replyDraft(next, msgId));
  }

  // Settled.
  const stopping = !!prev?.cancelling || !!next.cancelling;
  for (const [id, s] of Object.entries(before)) {
    if (!s || s.kind === 'patch' || after[id]) continue;
    const start = memo.startDocs.has(id) ? memo.startDocs.get(id)! : prev?.doc ?? null;
    memo.startDocs.delete(id);
    const alerted = memo.alertedStreams.delete(id);
    if (stopping) continue;

    let draft: AlertDraft | null = null;
    const streamFailed = !!s.errored && !NOT_FAILURES.has(s.erroredCode ?? '');
    const stateFailed = !s.errored && !!next.error && next.error !== prev?.error && !!next.errorCode && !NOT_FAILURES.has(next.errorCode);
    if (streamFailed || stateFailed) draft = { kind: 'failed', key: `comic:${next.projectId}:failed:${id}`, ...draftBase(next) };
    if (!draft && !s.errored) {
      const needs = newNeeds(memo, next.doc, start);
      if (needs) {
        remember(memo, `needs:${needs.key}`);
        draft = needsDraft(next, needs);
      }
    }
    if (!draft) draft = drawnDraft(next, memo, start);
    if (!draft) draft = translateDraft(next, s, start);
    if (!draft) draft = publishDraft(next, start);
    if (!draft && s.kind === 'message' && !alerted && !s.errored) {
      const msgId = newestAssistantId(next.doc);
      const known = new Set(conv(start).map((m) => m.id));
      if (msgId && !known.has(msgId)) draft = replyDraft(next, msgId);
    }
    if (draft) out.push(draft);
  }
  return out;
}
