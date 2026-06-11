/**
 * Pure moderation + reaction helpers for the Stream Studio worker.
 * No platform dependencies — unit-tested from the main repo's vitest suite.
 */

/** Reactions the room accepts. The client's quick bar is a subset; the picker
 *  exposes the whole library. Keep in sync with live/emoji.ts. */
export const EMOJI_LIBRARY = [
  '❤️', '🔥', '👏', '😂', '🤯', '🎉',
  '😍', '🥰', '😎', '🤩', '🥹', '😭',
  '😅', '🙌', '👍', '👎', '💪', '🫶',
  '✨', '⭐', '🌟', '🚀', '🎨', '🖌️',
  '🍿', '☕', '🧠', '👀', '💬', '❓',
  '💜', '💙', '💚', '🧡', '💛', '🤍',
  '🤣', '😉', '😴', '🤓', '🫡', '🤝',
  '🎶', '🏆', '🎯', '⚡', '🌈', '🤔',
] as const;

const PROFANITY = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'whore',
  'slut', 'faggot', 'nigger', 'nigga', 'retard', 'kys', 'kill yourself',
];

const leet = (s: string) =>
  s
    .toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[3]/g, 'e')
    .replace(/[5$]/g, 's')
    .replace(/[7]/g, 't');

/** True when the message contains profanity (incl. simple leet-speak). */
export function hasProfanity(text: string): boolean {
  const t = ` ${leet(text).replace(/[^a-z ]/g, ' ')} `;
  return PROFANITY.some((w) => t.includes(` ${w} `) || (w.length > 4 && t.includes(w)));
}

export interface SpamState {
  lastText: string;
  repeats: number;
  lastAt: number;
}

/** Sliding repeat detector: the same message 3+ times inside 30 s is spam. */
export function checkSpam(state: SpamState | undefined, text: string, now: number): { spam: boolean; next: SpamState } {
  const norm = text.trim().toLowerCase();
  if (state && state.lastText === norm && now - state.lastAt < 30_000) {
    const repeats = state.repeats + 1;
    return { spam: repeats >= 3, next: { lastText: norm, repeats, lastAt: now } };
  }
  return { spam: false, next: { lastText: norm, repeats: 1, lastAt: now } };
}

export const STRIKE_LIMIT = 3;
export const TIMEOUT_MS = 5 * 60_000;
