// Rate a reply (docs/features/reply-ratings.md): where each rating stands lives in THIS page's memory, keyed by comic
// and message, not inside the row. A row the conversation mounts again (the pane coming back, a layout swap) shows the
// same "Thanks" and Undo, an open thumbs-down note keeps its words, and a request that lands after its row went away
// still settles here, so a reply is never rated twice in one visit. Nothing is persisted: a reload starts fresh, the
// same as general chat. Every request is a click (or the person leaving with a note open): nothing runs on a timer.

import type { FeedbackVoteValue } from '../../../apiTypes';
import type { Msg } from '../../../shared/comic/doc';
import { submitFeedback } from '../../../services/feedback';
import { replyRatingInput, withdrawReplyRating } from './replyRating';

/**
 * `noting`: thumbs down chosen, the note is open, nothing sent yet. `resending`: Try again after a send that failed.
 * `undoing` / `undoFailed`: the Undo is under way / did not go through (the rating stands).
 */
export type RatingStatus = 'idle' | 'noting' | 'sending' | 'resending' | 'sent' | 'failed' | 'undoing' | 'undoFailed';

export interface RatingEntry {
  status: RatingStatus;
  vote: FeedbackVoteValue | null;
  /** The thumbs-down note as typed (it goes only when `share` is ticked). */
  note: string;
  share: boolean;
}

/** What a rating sends: the reply's facts and the comic it belongs to. */
export interface RatingSubject {
  msg: Pick<Msg, 'id' | 'cards' | 'nextSteps'>;
  comicId?: string | null;
}

export const IDLE_RATING: RatingEntry = Object.freeze({ status: 'idle', vote: null, note: '', share: false });

const entries = new Map<string, RatingEntry>();
const listeners = new Set<() => void>();
/** How many controls show each rating right now. */
const shown = new Map<string, number>();

const notify = () => {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
};

export const ratingKey = (comicId: string | null | undefined, messageId: string): string => `${comicId ?? ''}\u0000${messageId}`;

export const subscribeRatings = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** The rating's state; the same object until it changes (a stable snapshot for useSyncExternalStore). */
export const getRating = (key: string): RatingEntry => entries.get(key) ?? IDLE_RATING;

const write = (key: string, next: RatingEntry) => {
  if (next.status === 'idle') entries.delete(key);
  else entries.set(key, next);
  notify();
};

/** Change the rating's local state (open or close the note, type in it, tick the box). Never sends anything. */
export const patchRating = (key: string, patch: Partial<RatingEntry>): void => {
  write(key, patch.status === 'idle' ? IDLE_RATING : { ...getRating(key), ...patch });
};

const SENDABLE: ReadonlySet<RatingStatus> = new Set(['idle', 'noting', 'failed']);

/**
 * Send the rating's one feedback row (a thumbs-up, a thumbs-down with its note, or Try again after a failure). A
 * rating already sent, or on its way, is never sent again. Resolves to where it settled.
 */
export const sendRating = async (key: string, subject: RatingSubject, vote: FeedbackVoteValue, note?: { text: string; share: boolean }): Promise<RatingStatus> => {
  const cur = getRating(key);
  if (!SENDABLE.has(cur.status)) return cur.status;
  write(key, { ...cur, vote, status: cur.status === 'failed' ? 'resending' : 'sending', ...(note ? { note: note.text, share: note.share } : {}) });
  const result = await submitFeedback(replyRatingInput(subject.msg, subject.comicId, vote, note));
  const status: RatingStatus = result.persisted ? 'sent' : 'failed';
  write(key, { ...getRating(key), status });
  return status;
};

/** Undo: take the person's own rating of this reply back on the server. Resolves to where it settled. */
export const undoRating = async (key: string, messageId: string): Promise<RatingStatus> => {
  const cur = getRating(key);
  if (cur.status !== 'sent' && cur.status !== 'undoFailed') return cur.status;
  write(key, { ...cur, status: 'undoing' });
  const result = await withdrawReplyRating(messageId);
  if (!result.withdrawn) {
    write(key, { ...getRating(key), status: 'undoFailed' });
    return 'undoFailed';
  }
  write(key, IDLE_RATING);
  return 'idle';
};

/**
 * A control showing this rating is on screen; call the returned function when it leaves. When the last one leaves
 * with the thumbs-down note still open, the thumbs-down is recorded once (a ticked note with it), as general chat
 * does. That check waits for the end of the current commit, so a row that is only mounted again keeps its note open.
 */
export const showRating = (key: string, subject: () => RatingSubject): (() => void) => {
  shown.set(key, (shown.get(key) ?? 0) + 1);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const n = (shown.get(key) ?? 1) - 1;
    if (n > 0) shown.set(key, n);
    else shown.delete(key);
    if (n > 0 || getRating(key).status !== 'noting') return;
    queueMicrotask(() => {
      const cur = getRating(key);
      if (shown.has(key) || cur.status !== 'noting') return;
      void sendRating(key, subject(), 'dislike', { text: cur.note, share: cur.share });
    });
  };
};

export const __resetReplyRatings = (): void => {
  entries.clear();
  shown.clear();
  notify();
};
