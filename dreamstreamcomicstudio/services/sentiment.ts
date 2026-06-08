// Lightweight, dependency-free disappointment detector. Kept in its own module
// (no network/Supabase imports) so it stays pure and unit-testable, and so the
// Universal Assistant can capture frustration without pulling in the API client.
//
// Used to "understand and write down" how a user feels: when they vent ("this is
// useless / broken / not working"), we tag the sentiment as feedback automatically.

import type { FeedbackSentiment } from '../apiTypes';

const STRONG_NEGATIVE = [
  'useless', 'terrible', 'awful', 'horrible', 'garbage', 'trash', 'worst',
  'hate this', 'i hate', 'stupid', 'broken', "doesn't work", 'does not work',
  'not working', 'doesnt work', 'wtf', 'frustrat', 'infuriat', 'waste of',
  'pathetic', 'unusable', 'disappoint', 'fed up', 'rubbish'
];
const SOFT_NEGATIVE = [
  'not good', 'not great', 'not helpful', 'unhelpful', 'wrong', 'confusing',
  'confused', 'annoying', 'too slow', 'so slow', 'keeps failing', 'failed again',
  "can't", 'cant ', "won't", 'wont ', 'still not', 'again?', 'why is', 'no idea'
];

export const detectSentiment = (rawText: string): FeedbackSentiment | null => {
  const text = (rawText || '').toLowerCase();
  if (!text.trim()) return null;
  // Strong cues win over soft ones when both appear.
  if (STRONG_NEGATIVE.some((kw) => text.includes(kw))) return 'frustrated';
  if (SOFT_NEGATIVE.some((kw) => text.includes(kw))) return 'negative';
  return null;
};
