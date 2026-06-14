import { useEffect, useRef } from 'react';
import type { Dir } from './useInput';

// Gamepad API support for games (Game Engine skill: controller input). Polls the
// connected pad each animation frame and edge-detects the d-pad / left-stick into
// discrete directions + an action button, plus an optional continuous X axis for
// paddles. No-ops cleanly when no pad is present or the API is unavailable, so it's
// safe to call unconditionally from any game. Handlers are read through a ref so the
// poll loop always sees the latest closures without re-subscribing.

interface GamepadHandlers {
  /** Edge-triggered direction (d-pad or left-stick tilt). */
  onDir?: (d: Dir) => void;
  /** Edge-triggered action (A / Start). */
  onAction?: () => void;
  /** Continuous left-stick X in [-1, 1] — for paddle-style control. */
  onAxis?: (x: number) => void;
  /** Disable polling entirely. */
  enabled?: boolean;
}

const AXIS_THRESHOLD = 0.5;

export const useGamepad = ({ onDir, onAction, onAxis, enabled = true }: GamepadHandlers): void => {
  const h = useRef({ onDir, onAction, onAxis });
  h.current = { onDir, onAction, onAxis };

  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !navigator.getGamepads) return;
    let raf = 0;
    const prev = { up: false, down: false, left: false, right: false, action: false };
    const poll = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const gp = Array.from(pads).find((p): p is Gamepad => !!p);
      if (gp) {
        const ax = gp.axes[0] ?? 0;
        const ay = gp.axes[1] ?? 0;
        const btn = (i: number) => !!gp.buttons[i]?.pressed;
        const up = btn(12) || ay < -AXIS_THRESHOLD;
        const down = btn(13) || ay > AXIS_THRESHOLD;
        const left = btn(14) || ax < -AXIS_THRESHOLD;
        const right = btn(15) || ax > AXIS_THRESHOLD;
        const action = btn(0) || btn(9);
        if (up && !prev.up) h.current.onDir?.('up');
        if (down && !prev.down) h.current.onDir?.('down');
        if (left && !prev.left) h.current.onDir?.('left');
        if (right && !prev.right) h.current.onDir?.('right');
        if (action && !prev.action) h.current.onAction?.();
        prev.up = up; prev.down = down; prev.left = left; prev.right = right; prev.action = action;
        if (h.current.onAxis && Math.abs(ax) > 0.08) h.current.onAxis(ax);
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);
};
