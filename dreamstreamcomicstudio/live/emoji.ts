/**
 * Reaction emoji for Stream Studio. QUICK_EMOJI is the one-tap bar; the full
 * EMOJI_LIBRARY backs the picker. Keep in sync with
 * live-worker/src/moderation.ts (the room's allowlist).
 */

export const QUICK_EMOJI = ['❤️', '🔥', '👏', '😂', '🤯', '🎉'] as const;

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
