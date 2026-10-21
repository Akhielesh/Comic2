// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { EMOJI_LIBRARY as ROOM_LIBRARY } from '../live-worker/src/moderation';
import { EMOJI_GROUPS, EMOJI_LIBRARY, normalizeQuick, QUICK_EMOJI } from './emoji';

describe('reaction emoji', () => {
  it('every library emoji sits in exactly one picker group', () => {
    const grouped = EMOJI_GROUPS.flatMap((g) => g.emoji);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...EMOJI_LIBRARY].sort());
  });
  it('matches the room’s allowlist', () => {
    expect([...EMOJI_LIBRARY].sort()).toEqual([...ROOM_LIBRARY].sort());
  });
  it('a host’s quick bar is six distinct library emoji, defaults filling gaps', () => {
    expect(normalizeQuick(null)).toEqual([...QUICK_EMOJI]);
    expect(normalizeQuick(['🍕', '🍕', 'nope', '🔥'])).toEqual(['🍕', '🔥', '❤️', '👏', '😂', '🤯']);
    expect(normalizeQuick(['🍕', '🍩', '🎮', '🎤', '🎧', '📸', '🎬'])).toHaveLength(6);
  });
});
