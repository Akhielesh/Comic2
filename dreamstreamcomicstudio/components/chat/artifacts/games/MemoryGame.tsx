import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GameShell, useGameAudio } from '../kit/game';
import { dealMemory } from './logic';

// Memory match — flip two cards, keep the pairs. A turn-based DOM game (no loop):
// state is the deck, the up-to-two flipped cards, and the matched set. Tap/click to
// flip; a mismatch flips back after a short reveal. Scored by moves (fewer is
// better), with a best-moves record per difficulty. Pure deal lives in logic.ts.

const FACES = ['🎮', '🌟', '🍕', '🚀', '🎵', '🐱', '🌈', '⚡', '🍩', '🎲', '🦊', '🌙', '🍒', '🐙', '🌵', '🎈', '🍔', '👾'];

const LAYOUT: Record<string, { cols: number; rows: number }> = {
  easy: { cols: 4, rows: 3 },
  normal: { cols: 4, rows: 4 },
  hard: { cols: 5, rows: 4 }
};

const bestKey = (d: string) => `ds.game.memory.best.${d}`;
const readBest = (d: string) => { try { return Number(localStorage.getItem(bestKey(d))) || 0; } catch { return 0; } };
const writeBest = (d: string, n: number) => { try { localStorage.setItem(bestKey(d), String(n)); } catch { /* ignore */ } };

export const MemoryGame: React.FC<{ difficulty?: string }> = ({ difficulty = 'normal' }) => {
  const diff = LAYOUT[difficulty] ? difficulty : 'normal';
  const { cols, rows } = LAYOUT[diff];
  const pairs = (cols * rows) / 2;
  const audio = useGameAudio();

  const [deck, setDeck] = useState<number[]>(() => dealMemory(pairs));
  const [flipped, setFlipped] = useState<number[]>([]);
  const [matched, setMatched] = useState<Set<number>>(new Set());
  const [moves, setMoves] = useState(0);
  const [best, setBest] = useState(() => readBest(diff));
  const lock = useRef(false);
  const timer = useRef<number | null>(null);

  const won = matched.size === deck.length && deck.length > 0;

  const newGame = useCallback(() => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null; }
    lock.current = false;
    setDeck(dealMemory(pairs));
    setFlipped([]);
    setMatched(new Set());
    setMoves(0);
  }, [pairs]);

  // Re-deal when the difficulty (and thus pair count) changes.
  useEffect(() => { newGame(); setBest(readBest(diff)); }, [diff, newGame]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  // Record best (fewest moves) on a win.
  useEffect(() => {
    if (!won) return;
    setBest((b) => { const nb = b === 0 ? moves : Math.min(b, moves); if (nb !== b) writeBest(diff, nb); return nb; });
    audio.play('win');
  }, [won, moves, diff, audio]);

  const flip = (i: number) => {
    if (lock.current || flipped.includes(i) || matched.has(i)) return;
    const next = [...flipped, i];
    setFlipped(next);
    audio.play('flip');
    if (next.length === 2) {
      setMoves((m) => m + 1);
      const [a, b] = next;
      if (deck[a] === deck[b]) {
        setMatched((prev) => new Set(prev).add(a).add(b));
        setFlipped([]);
        audio.play('match');
      } else {
        lock.current = true;
        timer.current = window.setTimeout(() => { setFlipped([]); lock.current = false; timer.current = null; }, 750);
      }
    }
  };

  return (
    <GameShell
      title="Memory match"
      subtitle="Flip two, keep the pairs"
      storageKey="memory"
      aspect={cols / rows}
      onRestart={newGame}
      audio={audio}
      status={
        <span className="tabular-nums">
          Moves <b className="text-[var(--ds-ink)]">{moves}</b>
          {best > 0 && <> · Best <b className="text-[var(--ds-ink)]">{best}</b></>}
          {won && <span className="ml-2 font-semibold text-[var(--ds-accent)]">Solved! 🎉</span>}
        </span>
      }
      hint="Tap to flip"
    >
      {({ width, height }) => {
        const gap = Math.round(Math.min(width, height) * 0.03);
        const cardW = (width - gap * (cols - 1)) / cols;
        const cardH = (height - gap * (rows - 1)) / rows;
        const face = Math.round(Math.min(cardW, cardH) * 0.5);
        return (
          <div className="grid h-full w-full select-none" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridTemplateRows: `repeat(${rows}, 1fr)`, gap }}>
            {deck.map((value, i) => {
              const faceUp = flipped.includes(i) || matched.has(i);
              const isMatched = matched.has(i);
              return (
                <button
                  key={i}
                  onClick={() => flip(i)}
                  aria-label={faceUp ? `Card ${FACES[value]}` : 'Hidden card'}
                  className="[perspective:700px]"
                  style={{ touchAction: 'manipulation' }}
                >
                  <div className={`relative h-full w-full transition-transform duration-300 [transform-style:preserve-3d] ${faceUp ? '[transform:rotateY(180deg)]' : ''}`}>
                    {/* Back */}
                    <div
                      className="absolute inset-0 flex items-center justify-center rounded-xl border border-[var(--ds-hairline)] [backface-visibility:hidden]"
                      style={{ backgroundColor: 'rgba(217,119,87,0.12)' }}
                    >
                      <span className="text-[var(--ds-accent)] opacity-50" style={{ fontSize: face * 0.7 }}>✦</span>
                    </div>
                    {/* Front */}
                    <div
                      className={`absolute inset-0 flex items-center justify-center rounded-xl border [transform:rotateY(180deg)] [backface-visibility:hidden] transition-opacity ${isMatched ? 'border-[var(--ds-accent)] opacity-60' : 'border-[var(--ds-hairline)]'}`}
                      style={{ fontSize: face, backgroundColor: 'var(--ds-surface-strong)' }}
                    >
                      {FACES[value % FACES.length]}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        );
      }}
    </GameShell>
  );
};
