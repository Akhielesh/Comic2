import { useEffect, useRef } from 'react';

// The heart of every canvas game: a requestAnimationFrame loop that hands the
// caller a delta time (seconds since the last frame) so movement is frame-rate
// independent. The loop only runs while `running` is true (paused games, off-screen
// tabs and game-over screens simply stop ticking), and dt is clamped so a long
// stall (tab switch, breakpoint) can't teleport everything across the board on
// resume — the classic "spiral of death" guard.

export const useGameLoop = (update: (dtSeconds: number) => void, running: boolean): void => {
  const cb = useRef(update);
  cb.current = update;

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      cb.current(dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running]);
};
