// Rate a reply: which replies carry the thumbs and what one rating sends (docs/features/reply-ratings.md).
import { describe, expect, it } from 'vitest';
import type { Msg } from '../../../shared/comic/doc';
import { RATING_NOTE_MAX, rateableReplyIds, replyFacts, replyRatingInput } from './replyRating';

const T = 1_760_000_000_000;
const user = (id: string, extra: Partial<Msg> = {}): Msg => ({ id, role: 'user', text: 'Make the rain heavier', at: T, ...extra });
const said = (id: string, extra: Partial<Msg> = {}): Msg => ({ id, role: 'assistant', text: 'Done — the rain is heavier on page 2.', at: T, ...extra });

describe('rateableReplyIds: the Director’s answers to what the person sent', () => {
  it('the first reply with words after each message the person sent', () => {
    expect(rateableReplyIds([said('welcome'), user('u1'), said('a1'), said('a2'), user('u2'), said('a3')])).toEqual(['a1', 'a3']);
  });

  it('never background work (a drawing’s progress or outcome, a translation, an allowance notice) and never a reply with no words', () => {
    const conv = [user('u1'), said('progress', { runAt: T - 5 }), said('cards-only', { text: '  ' }), said('a1'), user('u2'), said('outcome', { runAt: T })];
    expect(rateableReplyIds(conv)).toEqual(['a1']);
  });

  it('a note sent while the Director worked is answered by the reply after it', () => {
    expect(rateableReplyIds([user('u1'), user('u2', { steered: true }), said('a1')])).toEqual(['a1']);
  });

  it('older comics and junk read as nothing to rate', () => {
    expect(rateableReplyIds(undefined)).toEqual([]);
    expect(rateableReplyIds(null)).toEqual([]);
    expect(rateableReplyIds([null as unknown as Msg, { role: 'assistant' } as Msg, said('a0')])).toEqual([]);
  });
});

describe('replyRatingInput: one feedback row, coarse facts only', () => {
  const msg: Pick<Msg, 'id' | 'cards' | 'nextSteps'> = {
    id: 'msg_7',
    cards: [
      { type: 'plan', id: 'c1' },
      { type: 'notice', id: 'c2', tone: 'info', text: 'Held back page 4' },
      { type: 'plan', id: 'c3' }
    ] as Msg['cards'],
    nextSteps: [{ label: 'Draw page 2', action: { type: 'render_pages', pageIds: ['pg_2'] }, usd: 0.04 }]
  };

  it('a thumbs-up names the reply and the comic, never its words, story or price', () => {
    const input = replyRatingInput(msg, 'proj_1', 'like');
    expect(input).toEqual({
      targetType: 'comic_reply',
      targetId: 'msg_7',
      vote: 'like',
      source: 'comic_studio',
      surface: 'comic_studio_conversation',
      sessionId: 'proj_1',
      metadata: { cards: ['plan', 'notice'], nextSteps: 1 }
    });
    expect(JSON.stringify(input)).not.toMatch(/Held back|Draw page|0\.04|\$/);
  });

  it('a note goes only when it is shared, trimmed and capped', () => {
    expect(replyRatingInput(msg, 'proj_1', 'dislike', { text: 'Too long, and it ignored my ending.', share: false }).comment).toBeUndefined();
    expect(replyRatingInput(msg, 'proj_1', 'dislike', { text: '  It ignored my ending.  ', share: true }).comment).toBe('It ignored my ending.');
    expect(replyRatingInput(msg, 'proj_1', 'dislike', { text: '   ', share: true })).not.toHaveProperty('comment');
    expect(replyRatingInput(msg, 'proj_1', 'dislike', { text: 'x'.repeat(RATING_NOTE_MAX + 50), share: true }).comment).toHaveLength(RATING_NOTE_MAX);
  });

  it('a reply from an older comic (no cards, no steps) still rates', () => {
    expect(replyFacts({})).toEqual({ cards: [], nextSteps: 0 });
    expect(replyRatingInput({ id: 'm' }, null, 'like')).not.toHaveProperty('sessionId');
  });
});
