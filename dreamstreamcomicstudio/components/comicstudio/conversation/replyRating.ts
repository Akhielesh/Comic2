// Rate a reply (docs/features/reply-ratings.md): which Director replies carry the thumbs, what a rating sends, and its
// Undo. The rating rides general chat's own mechanism end to end: services/feedback.ts submitFeedback → POST
// /api/telemetry/feedback → user_feedback, one row per opinion. Only coarse facts go with it (the card kinds and the
// number of next steps): never the reply's words, the comic's story or a price. A note goes only when the person ticks
// "Share this note".

import type { FeedbackInput, FeedbackVoteValue, FeedbackWithdrawInput, FeedbackWithdrawResponse } from '../../../apiTypes';
import type { Msg } from '../../../shared/comic/doc';
import { post } from '../../../services/apiClient';

/** The longest note a rating carries (the store keeps up to 4,000 characters; a note is a sentence or two). */
export const RATING_NOTE_MAX = 1000;
/** At most this many card kinds describe a reply. */
const CARD_KINDS_MAX = 6;

/**
 * The Director's answers to what the person sent: for each run of messages after a user message, the first assistant
 * message with words that background work did not post (no Msg.runAt: not a drawing's progress or outcome, not a
 * translation, publish or allowance notice). Old docs need nothing new: every field read is optional.
 */
export const rateableReplyIds = (conversation: readonly Msg[] | null | undefined): string[] => {
  const out: string[] = [];
  let asked = false;
  for (const m of Array.isArray(conversation) ? conversation : []) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') continue;
    if (m.role === 'user') {
      asked = true;
      continue;
    }
    if (!asked || m.role !== 'assistant' || typeof m.runAt === 'number') continue;
    if (typeof m.text !== 'string' || !m.text.trim()) continue;
    out.push(m.id);
    asked = false;
  }
  return out;
};

/** What a rating says about the reply: the kinds of cards it carried and how many next steps it offered. */
export const replyFacts = (msg: Pick<Msg, 'cards' | 'nextSteps'>): { cards: string[]; nextSteps: number } => {
  const kinds: string[] = [];
  for (const c of Array.isArray(msg.cards) ? msg.cards : []) {
    const type = c && typeof c === 'object' && typeof c.type === 'string' ? c.type.slice(0, 40) : '';
    if (type && !kinds.includes(type)) kinds.push(type);
    if (kinds.length >= CARD_KINDS_MAX) break;
  }
  return { cards: kinds, nextSteps: Array.isArray(msg.nextSteps) ? msg.nextSteps.length : 0 };
};

/** The one feedback row a rating writes. The note goes only when it is shared and has words. */
export const replyRatingInput = (
  msg: Pick<Msg, 'id' | 'cards' | 'nextSteps'>,
  comicId: string | null | undefined,
  vote: FeedbackVoteValue,
  note?: { text: string; share: boolean }
): FeedbackInput => {
  const comment = note?.share ? note.text.trim().slice(0, RATING_NOTE_MAX) : '';
  return {
    targetType: 'comic_reply',
    targetId: msg.id,
    vote,
    source: 'comic_studio',
    surface: 'comic_studio_conversation',
    ...(comicId ? { sessionId: comicId } : {}),
    ...(comment ? { comment } : {}),
    metadata: replyFacts(msg)
  };
};

/**
 * Take back the person's own rating of one reply (the rating's Undo). Never throws: a failure resolves to
 * { withdrawn: false }, the rating stays, and the control says so and offers to try again.
 */
export const withdrawReplyRating = async (messageId: string): Promise<{ withdrawn: boolean }> => {
  try {
    const res = await post<FeedbackWithdrawInput, FeedbackWithdrawResponse>('/api/telemetry/feedback/withdraw', { targetType: 'comic_reply', targetId: messageId });
    return { withdrawn: Boolean(res?.ok && res.withdrawn) };
  } catch {
    return { withdrawn: false };
  }
};
