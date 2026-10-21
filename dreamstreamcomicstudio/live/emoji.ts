/**
 * Reaction emoji for Stream Studio. QUICK_EMOJI is the default one-tap bar
 * (hosts can pick their own six); EMOJI_GROUPS sorts the whole library into
 * the picker's tabs. EMOJI_LIBRARY must stay in sync with
 * live-worker/src/moderation.ts (the room's allowlist).
 */

export const QUICK_EMOJI = ['❤️', '🔥', '👏', '😂', '🤯', '🎉'] as const;
export const QUICK_SLOTS = 6;

export interface EmojiGroup {
  id: string;
  label: string;
  /** The tab's own emoji. */
  icon: string;
  emoji: readonly string[];
}

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  { id: 'love', label: 'Love', icon: '❤️', emoji: ['❤️', '😍', '🥰', '🫶', '💜', '💙', '💚', '🧡', '💛', '🤍', '🤗', '😇'] },
  { id: 'hype', label: 'Hype', icon: '🔥', emoji: ['🔥', '🚀', '⚡', '💯', '🏆', '🥇', '🏅', '🐐', '💎', '⭐', '🌟', '✨', '🎯', '🧨', '🤑', '💸'] },
  { id: 'cheer', label: 'Cheer', icon: '👏', emoji: ['👏', '🙌', '👍', '👎', '💪', '🤝', '🙏', '👋', '🫡'] },
  { id: 'funny', label: 'Funny', icon: '😂', emoji: ['😂', '🤣', '😅', '😜', '🤪', '😉', '🤭', '😈', '💀', '🥲'] },
  { id: 'faces', label: 'Faces', icon: '🤯', emoji: ['🤯', '😎', '🤩', '🥹', '😭', '😴', '🤓', '🤔', '😱', '😤', '😮', '😀', '😄', '😢', '🥶', '🥵', '👀', '🤖', '👽'] },
  { id: 'party', label: 'Party', icon: '🎉', emoji: ['🎉', '🥳', '🎊', '🎁', '🎂', '🍾', '🪩', '🎈', '🎟️', '📣', '🎶', '🌈', '🦄'] },
  { id: 'things', label: 'Things', icon: '💡', emoji: ['💡', '🎨', '🖌️', '🍿', '☕', '🧠', '💬', '❓', '🌶️', '🧊', '🛠️', '📚', '🐱', '🐶', '🍕', '🍩', '🎮', '🕹️', '🎤', '🎧', '📸', '🎬', '🔔', '🪄', '🧿', '🃏', '♟️', '🔮', '🍀'] },
];

export const EMOJI_LIBRARY = [
  '❤️', '🔥', '👏', '😂', '🤯', '🎉',
  '😍', '🥰', '😎', '🤩', '🥹', '😭',
  '😅', '🙌', '👍', '👎', '💪', '🫶',
  '✨', '⭐', '🌟', '🚀', '🎨', '🖌️',
  '🍿', '☕', '🧠', '👀', '💬', '❓',
  '💜', '💙', '💚', '🧡', '💛', '🤍',
  '🤣', '😉', '😴', '🤓', '🫡', '🤝',
  '🎶', '🏆', '🎯', '⚡', '🌈', '🤔',
  '🥳', '😱', '💀', '💯', '🙏', '👋',
  '🤗', '😤', '🥲', '😮', '🤭', '😇',
  '🎁', '🎂', '🍾', '🪩', '📣', '🎊',
  '🐐', '🦄', '🌶️', '🧊', '🛠️', '📚',
  '😀', '😄', '😜', '🤪', '😢', '🥶',
  '🥵', '😈', '🤖', '👽', '🐱', '🐶',
  '🍕', '🍩', '🎮', '🕹️', '🎤', '🎧',
  '📸', '🎬', '💡', '🔔', '💎', '🧨',
  '🎈', '🪄', '🧿', '🃏', '♟️', '🏅',
  '🥇', '🎟️', '🔮', '🍀', '💸', '🤑',
] as const;

const LIB = new Set<string>(EMOJI_LIBRARY);

/** A host's quick bar: six distinct library emoji, defaults filling any gaps. */
export function normalizeQuick(list: readonly unknown[] | null | undefined): string[] {
  const out: string[] = [];
  for (const e of list ?? []) if (typeof e === 'string' && LIB.has(e) && !out.includes(e) && out.length < QUICK_SLOTS) out.push(e);
  for (const e of QUICK_EMOJI) if (out.length < QUICK_SLOTS && !out.includes(e)) out.push(e);
  return out;
}

const RECENT_KEY = 'ds-live-recent-emoji';

/** Reactions you sent lately (this device), newest first. */
export function recentEmoji(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') as unknown;
    return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string' && LIB.has(e)).slice(0, 12) : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(e: string): void {
  if (!LIB.has(e)) return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, 12)));
  } catch { /* storage unavailable */ }
}
