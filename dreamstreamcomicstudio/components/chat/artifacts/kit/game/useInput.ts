import { useRef } from 'react';

// Shared input helpers so every game reads keyboard, swipe and tap the same way.
// Keyboard is handled by the GameShell's focusable playfield (it owns focus and
// preventDefault so arrow keys drive the game instead of scrolling the page); games
// translate the raw key with `dirFromKey`. Touch is owned by each game's own surface
// via `useSwipe`, which distinguishes a directional swipe from a tap.

export type Dir = 'up' | 'down' | 'left' | 'right';

/** Map a KeyboardEvent.key to a game direction, an action (space/enter), or null. */
export const dirFromKey = (key: string): Dir | 'action' | null => {
  switch (key) {
    case 'ArrowUp': case 'w': case 'W': return 'up';
    case 'ArrowDown': case 's': case 'S': return 'down';
    case 'ArrowLeft': case 'a': case 'A': return 'left';
    case 'ArrowRight': case 'd': case 'D': return 'right';
    case ' ': case 'Spacebar': case 'Enter': return 'action';
    default: return null;
  }
};

/** True for keys a focused game should swallow (so they don't scroll the page). */
export const isGameKey = (key: string): boolean => dirFromKey(key) !== null;

const SWIPE_MIN = 24; // px before a drag counts as a swipe rather than a tap

/**
 * Touch handlers for a game surface: a clear horizontal/vertical drag fires `onSwipe`
 * with the dominant direction; a short press with no real movement fires `onTap`.
 * Spread the returned object onto the canvas / grid element.
 */
export const useSwipe = (onSwipe: (d: Dir) => void, onTap?: () => void) => {
  const start = useRef<{ x: number; y: number } | null>(null);

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    if (t) start.current = { x: t.clientX, y: t.clientY };
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN && Math.abs(dy) < SWIPE_MIN) {
      onTap?.();
      return;
    }
    // The swipe drives the game, so stop the browser turning it into a scroll/zoom.
    e.preventDefault();
    if (Math.abs(dx) > Math.abs(dy)) onSwipe(dx > 0 ? 'right' : 'left');
    else onSwipe(dy > 0 ? 'down' : 'up');
  };

  return { onTouchStart, onTouchEnd };
};
