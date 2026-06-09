import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, RotateCcw, Shuffle, Check, RefreshCw, ChevronLeft, ChevronRight, Target } from 'lucide-react';
import type { FlashcardsArtifact } from '../../../apiTypes';
import { deckIdFor, loadProgress, saveProgress, clearProgress } from '../../../services/studyProgress';

// A flip-card study deck the AI generates on demand. The learner flips each card,
// marks it "known" or "review", can shuffle, and sees progress. Progress (known/review)
// PERSISTS per deck across reloads/sessions (spaced-repetition lite), so studying picks
// up where it left off and the learner can drill just the cards they haven't mastered.

const shuffled = (n: number): number[] => {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

export const Flashcards: React.FC<{ data: FlashcardsArtifact }> = ({ data }) => {
  const cards = useMemo(() => (Array.isArray(data?.cards) ? data.cards.filter((c) => c && (c.front || c.back)) : []), [data]);
  const deckId = useMemo(() => deckIdFor(cards, data?.title), [cards, data?.title]);
  // Restore any saved progress for this deck on first render.
  const saved = useRef(loadProgress(deckId));
  const [order, setOrder] = useState<number[]>(() => cards.map((_, i) => i));
  const [pos, setPos] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [known, setKnown] = useState<Set<number>>(() => new Set(saved.current?.known || []));
  const [review, setReview] = useState<Set<number>>(() => new Set(saved.current?.review || []));
  const [unknownOnly, setUnknownOnly] = useState(false);
  const resumed = (saved.current?.known.length || 0) + (saved.current?.review.length || 0) > 0;

  // Persist whenever mastery changes (best-effort; debounced via React batching).
  useEffect(() => {
    saveProgress(deckId, { known: [...known], review: [...review], updatedAt: Date.now() });
  }, [deckId, known, review]);

  if (cards.length === 0) return null;

  const cardIndex = order[Math.min(pos, order.length - 1)];
  const card = cards[cardIndex];
  const go = (delta: number) => { setPos((p) => Math.max(0, Math.min(order.length - 1, p + delta))); setFlipped(false); };
  const mark = (isKnown: boolean) => {
    setKnown((prev) => { const n = new Set(prev); isKnown ? n.add(cardIndex) : n.delete(cardIndex); return n; });
    setReview((prev) => { const n = new Set(prev); isKnown ? n.delete(cardIndex) : n.add(cardIndex); return n; });
    if (pos < order.length - 1) go(1); else setFlipped(false);
  };
  const reshuffle = () => { setOrder(shuffled(cards.length).filter((i) => !unknownOnly || !known.has(i))); setPos(0); setFlipped(false); };
  const reset = () => { clearProgress(deckId); setOrder(cards.map((_, i) => i)); setPos(0); setFlipped(false); setKnown(new Set()); setReview(new Set()); setUnknownOnly(false); };
  // Drill only the cards not yet marked "known" — the core spaced-repetition move.
  const studyUnknown = () => {
    const remaining = cards.map((_, i) => i).filter((i) => !known.has(i));
    setUnknownOnly(true);
    setOrder(remaining.length ? remaining : cards.map((_, i) => i));
    setPos(0); setFlipped(false);
  };
  const studyAll = () => { setUnknownOnly(false); setOrder(cards.map((_, i) => i)); setPos(0); setFlipped(false); };

  return (
    <div className="border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden animate-fade-in">
      <div className="bg-violet-600 text-white px-4 py-2.5 flex items-center gap-2">
        <Layers className="w-5 h-5" />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg leading-none truncate">{data.title || 'Flashcards'}</div>
          {data.topic && <div className="text-[11px] font-bold uppercase tracking-wide text-white/70">{data.topic}</div>}
        </div>
        <span className="text-[11px] font-bold">{known.size}/{cards.length} known</span>
      </div>

      {/* Resumed-progress hint (only when there was saved progress to restore). */}
      {resumed && (
        <div className="bg-violet-50 border-b-2 border-violet-200 px-4 py-1 text-[11px] text-violet-700 font-semibold">
          Resumed your saved progress{review.size ? ` · ${review.size} flagged for review` : ''}.
        </div>
      )}

      <div className="p-4">
        {/* The card — click to flip. */}
        <button
          type="button"
          onClick={() => setFlipped((f) => !f)}
          className={`w-full min-h-[150px] rounded-xl border-2 border-black flex items-center justify-center text-center p-5 transition-colors ${flipped ? 'bg-violet-50' : 'bg-brand-yellow'}`}
        >
          <div>
            <div className="text-[10px] font-bold uppercase tracking-wide text-black/50 mb-1">{flipped ? 'Answer' : 'Term'}</div>
            <div className="text-lg font-bold whitespace-pre-wrap">{flipped ? card.back : card.front}</div>
            {!flipped && <div className="text-[11px] text-black/50 mt-2">Click to flip</div>}
          </div>
        </button>

        {/* Nav + progress */}
        <div className="flex items-center justify-between mt-3">
          <button onClick={() => go(-1)} disabled={pos === 0} className="flex items-center gap-1 text-sm font-bold disabled:opacity-30 hover:text-black">
            <ChevronLeft className="w-4 h-4" /> Prev
          </button>
          <span className="text-xs font-bold text-slate-500 tabular-nums">{pos + 1} / {order.length}{known.has(cardIndex) ? ' · ✓' : ''}</span>
          <button onClick={() => go(1)} disabled={pos >= order.length - 1} className="flex items-center gap-1 text-sm font-bold disabled:opacity-30 hover:text-black">
            Next <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Mark known / review + deck controls */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <button onClick={() => mark(true)} className="flex items-center gap-1 text-[12px] font-bold border-2 border-black rounded-md px-2.5 py-1 bg-green-100 hover:bg-green-200"><Check className="w-3.5 h-3.5" /> Got it</button>
          <button onClick={() => mark(false)} className="flex items-center gap-1 text-[12px] font-bold border-2 border-black rounded-md px-2.5 py-1 bg-amber-100 hover:bg-amber-200"><RefreshCw className="w-3.5 h-3.5" /> Review</button>
          {/* Spaced-repetition: drill just the not-yet-known cards (toggle back to all). */}
          {unknownOnly ? (
            <button onClick={studyAll} className="flex items-center gap-1 text-[12px] font-bold border-2 border-black rounded-md px-2.5 py-1 bg-violet-100 hover:bg-violet-200"><Layers className="w-3.5 h-3.5" /> All cards</button>
          ) : (
            <button onClick={studyUnknown} disabled={known.size >= cards.length} className="flex items-center gap-1 text-[12px] font-bold border-2 border-black rounded-md px-2.5 py-1 bg-violet-100 hover:bg-violet-200 disabled:opacity-40" title="Study only the cards you haven't marked known"><Target className="w-3.5 h-3.5" /> Study {cards.length - known.size} left</button>
          )}
          <button onClick={reshuffle} className="ml-auto flex items-center gap-1 text-[12px] font-bold border-2 border-black rounded-md px-2.5 py-1 bg-white hover:bg-slate-100"><Shuffle className="w-3.5 h-3.5" /> Shuffle</button>
          <button onClick={reset} className="flex items-center gap-1 text-[12px] font-bold border-2 border-black rounded-md px-2.5 py-1 bg-white hover:bg-slate-100" title="Clear saved progress"><RotateCcw className="w-3.5 h-3.5" /> Reset</button>
        </div>
      </div>
    </div>
  );
};
