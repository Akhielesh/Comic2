import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell, useGameLoop, useThemeColors, dirFromKey, useSwipe, type Dir } from '../kit/game';
import { withAlpha } from '../kit';
import { stepSnake, opposite, type Point } from './logic';

// Classic grid Snake on a canvas. The simulation lives in refs and advances on a
// fixed step accumulated from the loop's delta time (so it's the same speed on every
// display), while React state holds only what the chrome shows (score, best, phase).
// Arrows/WASD or a swipe steer; Space or a tap starts, pauses and restarts.

const COLS = 17;
const ROWS = 17;

const DIFF_SPEED: Record<string, { base: number; min: number; step: number }> = {
  easy: { base: 0.16, min: 0.09, step: 0.004 },
  normal: { base: 0.12, min: 0.07, step: 0.005 },
  hard: { base: 0.09, min: 0.05, step: 0.006 }
};

const bestKey = 'ds.game.snake.best';
const readBest = () => { try { return Number(localStorage.getItem(bestKey)) || 0; } catch { return 0; } };
const writeBest = (n: number) => { try { localStorage.setItem(bestKey, String(n)); } catch { /* ignore */ } };

const rr = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
};

const randFood = (snake: Point[]): Point => {
  let p: Point;
  do {
    p = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (snake.some((s) => s.x === p.x && s.y === p.y));
  return p;
};

type Phase = 'idle' | 'running' | 'over';

export const SnakeGame: React.FC<{ difficulty?: string }> = ({ difficulty = 'normal' }) => {
  const speed = DIFF_SPEED[difficulty] ?? DIFF_SPEED.normal;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colors = useThemeColors();

  const [phase, setPhase] = useState<Phase>('idle');
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(readBest);

  const snake = useRef<Point[]>([{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }]);
  const dir = useRef<Dir>('right');
  const queued = useRef<Dir>('right');
  const food = useRef<Point>({ x: 12, y: 8 });
  const acc = useRef(0);
  const interval = useRef(speed.base);
  const dims = useRef({ w: 0, h: 0 });

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const { w, h } = dims.current;
    const cell = Math.floor(Math.min(w / COLS, h / ROWS));
    const boardW = cell * COLS;
    const boardH = cell * ROWS;
    const ox = Math.floor((w - boardW) / 2);
    const oy = Math.floor((h - boardH) / 2);

    ctx.clearRect(0, 0, w, h);
    // Recessed board + faint grid.
    ctx.fillStyle = colors.board;
    rr(ctx, ox, oy, boardW, boardH, Math.min(14, cell)); ctx.fill();
    ctx.strokeStyle = colors.hairline;
    ctx.lineWidth = 1;
    for (let i = 1; i < COLS; i++) {
      ctx.beginPath(); ctx.moveTo(ox + i * cell + 0.5, oy); ctx.lineTo(ox + i * cell + 0.5, oy + boardH); ctx.stroke();
    }
    for (let j = 1; j < ROWS; j++) {
      ctx.beginPath(); ctx.moveTo(ox, oy + j * cell + 0.5); ctx.lineTo(ox + boardW, oy + j * cell + 0.5); ctx.stroke();
    }

    // Food — a calm green pip with a soft ring.
    const f = food.current;
    const fx = ox + f.x * cell + cell / 2;
    const fy = oy + f.y * cell + cell / 2;
    ctx.fillStyle = withAlpha(colors.up, 0.18);
    ctx.beginPath(); ctx.arc(fx, fy, cell * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colors.up;
    ctx.beginPath(); ctx.arc(fx, fy, cell * 0.26, 0, Math.PI * 2); ctx.fill();

    // Snake — terracotta accent, head full, body fading slightly toward the tail.
    const s = snake.current;
    const pad = Math.max(1, Math.floor(cell * 0.1));
    s.forEach((p, i) => {
      ctx.fillStyle = i === 0 ? colors.accent : withAlpha(colors.accent, Math.max(0.45, 1 - i / (s.length + 4)));
      rr(ctx, ox + p.x * cell + pad, oy + p.y * cell + pad, cell - pad * 2, cell - pad * 2, Math.max(2, cell * 0.28));
      ctx.fill();
    });

    // Overlay for idle / game-over.
    if (phase !== 'running') {
      ctx.fillStyle = withAlpha(colors.board, 0.82);
      rr(ctx, ox, oy, boardW, boardH, Math.min(14, cell)); ctx.fill();
      ctx.fillStyle = colors.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(cell * 1.0)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(phase === 'over' ? 'Game over' : 'Snake', w / 2, h / 2 - cell * 0.7);
      ctx.fillStyle = colors.muted;
      ctx.font = `500 ${Math.round(cell * 0.62)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillText(phase === 'over' ? `Score ${score} — tap or Space to retry` : 'Tap or press Space to play', w / 2, h / 2 + cell * 0.6);
    }
  }, [colors, phase, score]);

  // Advance the simulation while running.
  useGameLoop((dt) => {
    acc.current += dt;
    while (acc.current >= interval.current) {
      acc.current -= interval.current;
      if (!opposite(dir.current, queued.current)) dir.current = queued.current;
      const res = stepSnake(snake.current, dir.current, food.current, COLS, ROWS);
      if (res.dead) {
        setPhase('over');
        setBest((b) => { const nb = Math.max(b, score); if (nb !== b) writeBest(nb); return nb; });
        break;
      }
      snake.current = res.snake;
      if (res.ate) {
        food.current = randFood(snake.current);
        interval.current = Math.max(speed.min, interval.current - speed.step);
        setScore((s) => s + 1);
      }
    }
    draw();
  }, phase === 'running');

  // Redraw on size/theme/phase change (covers the non-running frames too).
  useEffect(() => { draw(); }, [draw]);

  const start = useCallback(() => {
    snake.current = [{ x: 8, y: 8 }, { x: 7, y: 8 }, { x: 6, y: 8 }];
    dir.current = 'right';
    queued.current = 'right';
    food.current = randFood(snake.current);
    acc.current = 0;
    interval.current = speed.base;
    setScore(0);
    setPhase('running');
  }, [speed]);

  const action = useCallback(() => {
    if (phase === 'running') setPhase('idle');     // pause
    else if (phase === 'idle' && score > 0) setPhase('running'); // resume a paused run
    else start();                                   // fresh start / retry
  }, [phase, score, start]);

  const steer = (d: Dir) => {
    if (phase === 'idle' && score === 0) start(); // resets queued, so set the dir after
    queued.current = d;
  };

  const swipe = useSwipe(steer, action);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = dirFromKey(e.key);
    if (k === 'action') action();
    else if (k) steer(k);
  };

  return (
    <GameShell
      title="Snake"
      subtitle="Eat, grow, don't bite yourself"
      storageKey="snake"
      aspect={1}
      onKeyDown={onKeyDown}
      onRestart={start}
      status={<span className="tabular-nums">Score <b className="text-[var(--ds-ink)]">{score}</b> · Best <b className="text-[var(--ds-ink)]">{best}</b></span>}
      hint="Arrows / WASD / swipe"
    >
      {({ width, height }) => {
        const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;
        dims.current = { w: width, h: height };
        return (
          <canvas
            ref={(el) => {
              canvasRef.current = el;
              if (!el) return;
              if (el.width !== width * dpr || el.height !== height * dpr) {
                el.width = width * dpr;
                el.height = height * dpr;
                const ctx = el.getContext('2d');
                if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
              }
              draw();
            }}
            style={{ width, height, display: 'block', cursor: 'pointer' }}
            onPointerDown={(e) => { if (e.pointerType === 'mouse') action(); }}
            {...swipe}
          />
        );
      }}
    </GameShell>
  );
};
