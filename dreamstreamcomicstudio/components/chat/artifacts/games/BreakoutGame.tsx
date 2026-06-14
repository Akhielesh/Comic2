import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Heart } from 'lucide-react';
import { GameShell, useGameLoop, useThemeColors, useGameAudio, useGamepad, dirFromKey } from '../kit/game';
import { withAlpha } from '../kit';

// Brick-breaker on a canvas. The whole simulation runs in a NORMALIZED [0,1] space
// (the field is square), so the exact same physics scale flawlessly from the compact
// glance card to fullscreen — only the final draw multiplies by the pixel size. The
// paddle follows the pointer/touch (or arrow keys); a tap or Space launches the ball,
// clears a level into a faster one, and restarts after the last life.

const ROWS = 5;
const COLS = 8;
const MARGIN_X = 0.06;
const BRICK_TOP = 0.1;
const BRICK_GAP = 0.012;
const BRICK_H = 0.035;
const BRICK_W = (1 - 2 * MARGIN_X - BRICK_GAP * (COLS - 1)) / COLS;
const PADDLE_W = 0.18;
const PADDLE_H = 0.022;
const PADDLE_Y = 0.93;
const BALL_R = 0.013;

const DIFF_SPEED: Record<string, number> = { easy: 0.55, normal: 0.68, hard: 0.82 };

type Phase = 'idle' | 'running' | 'over' | 'won';

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

const freshBricks = (): boolean[][] => Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => true));

export const BreakoutGame: React.FC<{ difficulty?: string }> = ({ difficulty = 'normal' }) => {
  const baseSpeed = DIFF_SPEED[difficulty] ?? DIFF_SPEED.normal;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colors = useThemeColors();
  const audio = useGameAudio();

  const [phase, setPhase] = useState<Phase>('idle');
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [level, setLevel] = useState(1);

  const bricks = useRef<boolean[][]>(freshBricks());
  const remaining = useRef(ROWS * COLS);
  const paddleX = useRef(0.5);
  const ball = useRef({ x: 0.5, y: PADDLE_Y - PADDLE_H / 2 - BALL_R, vx: 0, vy: 0 });
  const speed = useRef(baseSpeed);
  const dims = useRef({ w: 0, h: 0 });
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const { w: W, h: H } = dims.current;
    const S = Math.min(W, H);
    const ox = (W - S) / 2;
    const oy = (H - S) / 2;
    const X = (n: number) => ox + n * S;
    const Y = (n: number) => oy + n * S;
    const U = (n: number) => n * S;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = colors.board;
    rr(ctx, ox, oy, S, S, U(0.04)); ctx.fill();

    // Bricks.
    for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (!bricks.current[r][cc]) continue;
        const bxn = MARGIN_X + cc * (BRICK_W + BRICK_GAP);
        const byn = BRICK_TOP + r * (BRICK_H + BRICK_GAP);
        ctx.fillStyle = withAlpha(colors.ramp[r % colors.ramp.length], 0.92);
        rr(ctx, X(bxn), Y(byn), U(BRICK_W), U(BRICK_H), U(0.008)); ctx.fill();
      }
    }

    // Paddle.
    ctx.fillStyle = colors.accent;
    rr(ctx, X(paddleX.current - PADDLE_W / 2), Y(PADDLE_Y - PADDLE_H / 2), U(PADDLE_W), U(PADDLE_H), U(PADDLE_H / 2)); ctx.fill();

    // Ball.
    ctx.fillStyle = colors.ink;
    ctx.beginPath(); ctx.arc(X(ball.current.x), Y(ball.current.y), U(BALL_R), 0, Math.PI * 2); ctx.fill();

    if (phase !== 'running') {
      ctx.fillStyle = withAlpha(colors.board, 0.82);
      rr(ctx, ox, oy, S, S, U(0.04)); ctx.fill();
      ctx.fillStyle = colors.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `600 ${Math.round(U(0.06))}px ui-sans-serif, system-ui, sans-serif`;
      const title = phase === 'over' ? 'Game over' : phase === 'won' ? `Level ${level} cleared!` : 'Brick breaker';
      ctx.fillText(title, X(0.5), Y(0.44));
      ctx.fillStyle = colors.muted;
      ctx.font = `500 ${Math.round(U(0.035))}px ui-sans-serif, system-ui, sans-serif`;
      const sub = phase === 'over' ? `Score ${score} — tap or Space to retry`
        : phase === 'won' ? 'Tap or press Space for the next level'
        : 'Tap or Space to launch · drag to move';
      ctx.fillText(sub, X(0.5), Y(0.54));
    }
  }, [colors, phase, score, level]);

  const resetBall = useCallback(() => {
    ball.current = { x: paddleX.current, y: PADDLE_Y - PADDLE_H / 2 - BALL_R, vx: 0, vy: 0 };
  }, []);

  const launch = useCallback(() => {
    const ang = (Math.random() * 0.5 - 0.25); // ±0.25 rad off vertical
    ball.current.vx = Math.sin(ang) * speed.current;
    ball.current.vy = -Math.cos(ang) * speed.current;
  }, []);

  const startLevel = useCallback((lvl: number, resetScore: boolean) => {
    bricks.current = freshBricks();
    remaining.current = ROWS * COLS;
    speed.current = baseSpeed * (1 + (lvl - 1) * 0.12);
    paddleX.current = 0.5;
    resetBall();
    setLevel(lvl);
    if (resetScore) { setScore(0); setLives(3); }
    setPhase('idle');
  }, [baseSpeed, resetBall]);

  useGameLoop((dt) => {
    const b = ball.current;
    if (b.vx === 0 && b.vy === 0) { draw(); return; } // launched yet?
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // Walls.
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); }
    if (b.x > 1 - BALL_R) { b.x = 1 - BALL_R; b.vx = -Math.abs(b.vx); }
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }

    // Paddle.
    const pTop = PADDLE_Y - PADDLE_H / 2;
    if (b.vy > 0 && b.y + BALL_R >= pTop && b.y - BALL_R <= PADDLE_Y + PADDLE_H / 2) {
      const half = PADDLE_W / 2;
      if (b.x >= paddleX.current - half && b.x <= paddleX.current + half) {
        const offset = (b.x - paddleX.current) / half; // -1..1
        const ang = offset * 1.05; // steer up to ~60°
        b.vx = Math.sin(ang) * speed.current;
        b.vy = -Math.abs(Math.cos(ang) * speed.current);
        b.y = pTop - BALL_R;
        audio.play('flip');
      }
    }

    // Bricks — reflect on the axis of least penetration; one hit per frame.
    outer: for (let r = 0; r < ROWS; r++) {
      for (let cc = 0; cc < COLS; cc++) {
        if (!bricks.current[r][cc]) continue;
        const bx = MARGIN_X + cc * (BRICK_W + BRICK_GAP);
        const by = BRICK_TOP + r * (BRICK_H + BRICK_GAP);
        if (b.x + BALL_R > bx && b.x - BALL_R < bx + BRICK_W && b.y + BALL_R > by && b.y - BALL_R < by + BRICK_H) {
          const ix = Math.min(b.x + BALL_R, bx + BRICK_W) - Math.max(b.x - BALL_R, bx);
          const iy = Math.min(b.y + BALL_R, by + BRICK_H) - Math.max(b.y - BALL_R, by);
          if (ix < iy) b.vx = -b.vx; else b.vy = -b.vy;
          bricks.current[r][cc] = false;
          remaining.current -= 1;
          setScore((s) => s + 10);
          if (remaining.current === 0) { setPhase('won'); resetBall(); audio.play('win'); }
          else audio.play('hit');
          break outer;
        }
      }
    }

    // Missed the paddle.
    if (b.y - BALL_R > 1) {
      setLives((lv) => {
        const next = lv - 1;
        if (next <= 0) { setPhase('over'); resetBall(); audio.play('lose'); return 0; }
        resetBall();
        audio.play('hit');
        return next;
      });
    }
    draw();
  }, phase === 'running');

  useEffect(() => { draw(); }, [draw]);

  const action = useCallback(() => {
    if (phase === 'idle') {
      launch();
      setPhase('running');
    } else if (phase === 'won') {
      startLevel(level + 1, false);
    } else if (phase === 'over') {
      startLevel(1, true);
    }
  }, [phase, launch, startLevel, level]);

  const movePaddle = (clientX: number, rect: DOMRect) => {
    const { w: W, h: H } = dims.current;
    const S = Math.min(W, H);
    const ox = (W - S) / 2;
    const n = (clientX - rect.left - ox) / S;
    paddleX.current = Math.max(PADDLE_W / 2, Math.min(1 - PADDLE_W / 2, n));
    if (ball.current.vx === 0 && ball.current.vy === 0) resetBall();
    if (phaseRef.current !== 'running') draw();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = dirFromKey(e.key);
    if (k === 'action') { action(); return; }
    if (k === 'left' || k === 'right') {
      const step = 0.06 * (k === 'left' ? -1 : 1);
      paddleX.current = Math.max(PADDLE_W / 2, Math.min(1 - PADDLE_W / 2, paddleX.current + step));
      if (ball.current.vx === 0 && ball.current.vy === 0) resetBall();
      if (phase !== 'running') draw();
    }
  };

  useGamepad({
    onAxis: (x) => {
      paddleX.current = Math.max(PADDLE_W / 2, Math.min(1 - PADDLE_W / 2, (x + 1) / 2));
      if (ball.current.vx === 0 && ball.current.vy === 0) resetBall();
      if (phaseRef.current !== 'running') draw();
    },
    onAction: action
  });

  return (
    <GameShell
      title="Brick breaker"
      subtitle="Clear every brick, don't drop the ball"
      storageKey="breakout"
      aspect={1}
      onKeyDown={onKeyDown}
      onRestart={() => startLevel(1, true)}
      audio={audio}
      status={
        <span className="flex items-center gap-2 tabular-nums">
          <span>Score <b className="text-[var(--ds-ink)]">{score}</b></span>
          <span className="text-[var(--ds-faint)]">·</span>
          <span className="flex items-center gap-0.5" aria-label={`${lives} lives`}>
            {Array.from({ length: 3 }).map((_, i) => (
              <Heart key={i} className={`h-3 w-3 ${i < lives ? 'fill-[var(--ds-accent)] text-[var(--ds-accent)]' : 'text-[var(--ds-faint)]'}`} />
            ))}
          </span>
          <span className="text-[var(--ds-faint)]">·</span>
          <span>Lv {level}</span>
        </span>
      }
      hint="Drag / arrows · Space to launch"
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
            style={{ width, height, display: 'block', cursor: 'pointer', touchAction: 'none' }}
            onPointerMove={(e) => movePaddle(e.clientX, e.currentTarget.getBoundingClientRect())}
            onPointerDown={(e) => { e.currentTarget.focus(); action(); }}
            onTouchMove={(e) => {
              const t = e.touches[0];
              if (t) { e.preventDefault(); movePaddle(t.clientX, e.currentTarget.getBoundingClientRect()); }
            }}
          />
        );
      }}
    </GameShell>
  );
};
