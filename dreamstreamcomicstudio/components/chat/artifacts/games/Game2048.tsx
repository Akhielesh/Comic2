import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell, useThemeColors, dirFromKey, useSwipe, type Dir } from '../kit/game';
import { withAlpha } from '../kit';
import { emptyGrid, move, spawnTile, hasMoves, maxTile, type Grid } from './logic';

// 2048 as a DOM board (theme tokens + a pop animation per new/merged tile) rather
// than canvas — the typography and light/dark tinting come straight from the house
// style. All the merge math lives in logic.ts; this component is just input + paint.
// Arrows/WASD or a swipe slide the board; reaching 2048 wins (keep going for a high
// score), and a locked board ends it.

const bestKey = 'ds.game.2048.best';
const readBest = () => { try { return Number(localStorage.getItem(bestKey)) || 0; } catch { return 0; } };
const writeBest = (n: number) => { try { localStorage.setItem(bestKey, String(n)); } catch { /* ignore */ } };

const start = (): Grid => spawnTile(spawnTile(emptyGrid()));

type Phase = 'playing' | 'won' | 'over';

export const Game2048: React.FC = () => {
  const colors = useThemeColors();
  const [grid, setGrid] = useState<Grid>(start);
  const [score, setScore] = useState(0);
  const [best, setBest] = useState(readBest);
  const [phase, setPhase] = useState<Phase>('playing');
  const keepGoing = useRef(false);
  const phaseRef = useRef<Phase>('playing');
  phaseRef.current = phase;

  const tileColor = (v: number): { bg: string; fg: string } => {
    const exp = Math.log2(v); // 1..11
    const a = Math.min(0.95, 0.1 + exp * 0.085);
    return { bg: withAlpha(colors.accent, a), fg: a < 0.42 ? colors.ink : '#fff' };
  };

  const doMove = useCallback((dir: Dir) => {
    if (phaseRef.current === 'over') return;
    setGrid((g) => {
      const res = move(g, dir);
      if (!res.moved) return g;
      const next = spawnTile(res.grid);
      if (res.gained) {
        setScore((s) => {
          const ns = s + res.gained;
          setBest((b) => { const nb = Math.max(b, ns); if (nb !== b) writeBest(nb); return nb; });
          return ns;
        });
      }
      if (!keepGoing.current && maxTile(next) >= 2048) setPhase('won');
      else if (!hasMoves(next)) setPhase('over');
      return next;
    });
  }, []);

  const newGame = useCallback(() => {
    keepGoing.current = false;
    setGrid(start());
    setScore(0);
    setPhase('playing');
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = dirFromKey(e.key);
    if (k && k !== 'action') doMove(k);
  };

  const swipe = useSwipe(doMove);

  // Sync best on first load (covers SSR-safe initial state).
  useEffect(() => { setBest((b) => Math.max(b, readBest())); }, []);

  return (
    <GameShell
      title="2048"
      subtitle="Slide, merge, reach 2048"
      storageKey="2048"
      aspect={1}
      onKeyDown={onKeyDown}
      onRestart={newGame}
      status={<span className="tabular-nums">Score <b className="text-[var(--ds-ink)]">{score}</b> · Best <b className="text-[var(--ds-ink)]">{best}</b></span>}
      hint="Arrows / WASD / swipe"
    >
      {({ width, height }) => {
        const S = Math.min(width, height);
        const pad = Math.round(S * 0.03);
        const gap = Math.round(S * 0.025);
        const cell = (S - pad * 2 - gap * 3) / 4;
        const fontFor = (v: number) => Math.round(cell * (v < 100 ? 0.42 : v < 1000 ? 0.34 : 0.27));
        return (
          <div
            className="relative select-none rounded-2xl border border-[var(--ds-hairline)] bg-[var(--ds-well)]"
            style={{ width: S, height: S, padding: pad }}
            {...swipe}
          >
            <div
              className="grid h-full w-full"
              style={{ gridTemplateColumns: `repeat(4, 1fr)`, gridTemplateRows: `repeat(4, 1fr)`, gap }}
            >
              {Array.from({ length: 16 }).map((_, i) => {
                const r = Math.floor(i / 4);
                const c = i % 4;
                const v = grid[r][c];
                return (
                  <div key={i} className="flex items-center justify-center rounded-xl bg-[var(--ds-hairline-soft)]">
                    {v > 0 && (
                      <div
                        key={`${i}-${v}`}
                        className="flex h-full w-full animate-scale-in items-center justify-center rounded-xl font-bold tabular-nums shadow-[0_1px_3px_rgba(0,0,0,0.1)]"
                        style={{ background: tileColor(v).bg, color: tileColor(v).fg, fontSize: fontFor(v) }}
                      >
                        {v}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {phase !== 'playing' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-2xl backdrop-blur-sm" style={{ backgroundColor: withAlpha(colors.board, 0.85) }}>
                <p className="text-lg font-semibold text-[var(--ds-ink)]">{phase === 'won' ? 'You reached 2048! 🎉' : 'No moves left'}</p>
                <div className="flex gap-2">
                  {phase === 'won' && (
                    <button
                      onClick={() => { keepGoing.current = true; setPhase(hasMoves(grid) ? 'playing' : 'over'); }}
                      className="rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-strong)] px-3 py-1.5 text-xs font-semibold text-[var(--ds-ink)] transition-colors hover:bg-[var(--ds-hover)]"
                    >
                      Keep going
                    </button>
                  )}
                  <button
                    onClick={newGame}
                    className="rounded-lg bg-[var(--ds-accent)] px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-[var(--ds-accent-hover)]"
                  >
                    New game
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      }}
    </GameShell>
  );
};
