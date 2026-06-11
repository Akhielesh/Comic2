import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Layers, RotateCcw, Shuffle, Check, RefreshCw, ChevronLeft, ChevronRight, Target, Download } from 'lucide-react';
import type { FlashcardsArtifact } from '../../../apiTypes';
import { deckIdFor, loadProgress, saveProgress, clearProgress } from '../../../services/studyProgress';
import { downloadTextFile } from '../../../services/chatUtils';
import { Surface, SurfaceTitle, SurfaceSubtitle, useCompact } from './kit';

// CSV field quoting (Anki/Quizlet import friendly): quote fields containing commas,
// quotes or newlines, doubling embedded quotes.
const csvField = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

// A flip-card study deck the AI generates on demand. The learner flips each card,
// marks it "known" or "review", can shuffle, and sees progress. Progress (known/review)
// PERSISTS per deck across reloads/sessions (spaced-repetition lite), so studying picks
// up where it left off and the learner can drill just the cards they haven't mastered.
//
// TWO VERSIONS: compact (deck title + count + first-card teaser, no flipping UI) and
// detailed (the full study experience), selected via the WidgetFrame density context.

const shuffled = (n: number): number[] => {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

export const Flashcards: React.FC<{ data: FlashcardsArtifact }> = ({ data }) => {
  const compact = useCompact();
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

  // ── Compact: a quiet glance card — deck identity, size, mastery and a teaser of the
  //    first card's front. No flipping UI; expand the widget to study.
  if (compact) {
    return (
      <Surface
        accent="#8b5cf6"
        header={
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 rounded-lg bg-[var(--ds-well-strong)] p-1.5 text-[var(--ds-muted)]">
              <Layers className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <SurfaceTitle>{data.title || 'Flashcards'}</SurfaceTitle>
              {data.topic && <SurfaceSubtitle>{data.topic}</SurfaceSubtitle>}
            </div>
          </div>
        }
        right={
          <span className="text-[11px] text-[var(--ds-muted)] tabular-nums">
            {known.size === cards.length ? 'mastered' : `${known.size}/${cards.length} known`}
          </span>
        }
      >
        <div className="px-3 pb-3">
          <div className="rounded-xl bg-[var(--ds-well)] px-3 py-2.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] mb-0.5">First card</div>
            <div className="text-sm text-[var(--ds-ink)] line-clamp-2 whitespace-pre-wrap">{cards[0].front}</div>
          </div>
          <div className="mt-1.5 text-[11px] text-[var(--ds-muted)]">
            {cards.length} card{cards.length === 1 ? '' : 's'}{review.size ? ` · ${review.size} flagged for review` : ''}
          </div>
        </div>
      </Surface>
    );
  }

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
  const exportCsv = () => {
    const csv = 'front,back\n' + cards.map((c) => `${csvField(c.front)},${csvField(c.back)}`).join('\n');
    const base = (data.title || 'flashcards').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'flashcards';
    downloadTextFile(`${base}.csv`, csv, 'text/csv');
  };

  // Keyboard drilling: once the deck is focused, space/enter flips, ← → navigate, and
  // ↑/k · ↓/j mark known/review — so a learner can rip through a deck without the mouse.
  const onKey = (e: React.KeyboardEvent) => {
    const k = e.key;
    if (k === ' ' || k === 'Enter') { e.preventDefault(); setFlipped((f) => !f); }
    else if (k === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (k === 'ArrowUp' || k === 'k' || k === 'K') { e.preventDefault(); mark(true); }
    else if (k === 'ArrowDown' || k === 'j' || k === 'J') { e.preventDefault(); mark(false); }
  };

  const secondaryBtn = 'flex items-center gap-1 text-[12px] font-semibold rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] px-2.5 py-1 text-[var(--ds-ink)] transition-colors duration-200 hover:bg-[var(--ds-hover)]';

  return (
    <div
      tabIndex={0}
      role="group"
      aria-label={`Flashcard deck: ${data.title || 'Flashcards'}. Use space to flip, arrow keys to navigate.`}
      onKeyDown={onKey}
      className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]/50 rounded-2xl"
    >
      <Surface
        accent="#8b5cf6"
        header={
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 rounded-lg bg-[var(--ds-well-strong)] p-1.5 text-[var(--ds-muted)]">
              <Layers className="w-4 h-4" />
            </span>
            <div className="min-w-0">
              <SurfaceTitle>{data.title || 'Flashcards'}</SurfaceTitle>
              {data.topic && <SurfaceSubtitle>{data.topic}</SurfaceSubtitle>}
            </div>
          </div>
        }
        right={
          <span className="text-[11px] text-[var(--ds-muted)] tabular-nums">
            {known.size === cards.length ? '✓ mastered' : `${known.size}/${cards.length} known`}
          </span>
        }
      >
        {/* Mastery bar: green = known, amber = flagged for review, quiet track = remaining. */}
        <div className="mx-3 flex h-1 overflow-hidden rounded-full bg-[var(--ds-well-strong)]" aria-hidden="true">
          <div className="bg-emerald-500 transition-all" style={{ width: `${(known.size / cards.length) * 100}%` }} />
          <div className="bg-amber-400 transition-all" style={{ width: `${(review.size / cards.length) * 100}%` }} />
        </div>

        {/* Resumed-progress hint (only when there was saved progress to restore). */}
        {resumed && (
          <div className="mx-3 mt-2 rounded-lg bg-violet-50 px-2.5 py-1 text-[11px] font-medium text-violet-700">
            Resumed your saved progress{review.size ? ` · ${review.size} flagged for review` : ''}.
          </div>
        )}

        <div className="p-3">
          {/* The card — click (or space, when the deck is focused) to flip. */}
          <div
            role="button"
            onClick={() => setFlipped((f) => !f)}
            className={`w-full min-h-[150px] rounded-xl border flex items-center justify-center text-center p-5 transition-colors duration-200 cursor-pointer ${
              flipped ? 'border-violet-200 bg-violet-50/70' : 'border-[var(--ds-hairline)] bg-[var(--ds-well)] hover:bg-[var(--ds-hover)]'
            }`}
          >
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)] mb-1">{flipped ? 'Answer' : 'Term'}</div>
              <div className="text-lg font-semibold tracking-tight text-[var(--ds-ink)] whitespace-pre-wrap">{flipped ? card.back : card.front}</div>
              {!flipped && <div className="text-[11px] text-[var(--ds-muted)] mt-2">Click to flip · or focus the deck and use <kbd>space</kbd> / <kbd>←</kbd> <kbd>→</kbd></div>}
            </div>
          </div>

          {/* Nav + progress */}
          <div className="flex items-center justify-between mt-3">
            <button onClick={() => go(-1)} disabled={pos === 0} className="flex items-center gap-1 text-sm font-semibold text-[var(--ds-muted)] transition-colors duration-200 disabled:opacity-30 hover:text-[var(--ds-ink)]">
              <ChevronLeft className="w-4 h-4" /> Prev
            </button>
            <span className="text-[11px] text-[var(--ds-muted)] tabular-nums">{pos + 1} / {order.length}{known.has(cardIndex) ? ' · ✓' : ''}</span>
            <button onClick={() => go(1)} disabled={pos >= order.length - 1} className="flex items-center gap-1 text-sm font-semibold text-[var(--ds-muted)] transition-colors duration-200 disabled:opacity-30 hover:text-[var(--ds-ink)]">
              Next <ChevronRight className="w-4 h-4" />
            </button>
          </div>

          {/* Mark known / review + deck controls */}
          <div className="flex items-center gap-2 mt-3 flex-wrap">
            <button onClick={() => mark(true)} className="flex items-center gap-1 text-[12px] font-semibold rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-700 transition-colors duration-200 hover:bg-emerald-100"><Check className="w-3.5 h-3.5" /> Got it</button>
            <button onClick={() => mark(false)} className="flex items-center gap-1 text-[12px] font-semibold rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-700 transition-colors duration-200 hover:bg-amber-100"><RefreshCw className="w-3.5 h-3.5" /> Review</button>
            {/* Spaced-repetition: drill just the not-yet-known cards (toggle back to all). */}
            {unknownOnly ? (
              <button onClick={studyAll} className="flex items-center gap-1 text-[12px] font-semibold rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1 text-violet-700 transition-colors duration-200 hover:bg-violet-100"><Layers className="w-3.5 h-3.5" /> All cards</button>
            ) : (
              <button onClick={studyUnknown} disabled={known.size >= cards.length} className="flex items-center gap-1 text-[12px] font-semibold rounded-lg border border-violet-200 bg-violet-50 px-2.5 py-1 text-violet-700 transition-colors duration-200 hover:bg-violet-100 disabled:opacity-40" title="Study only the cards you haven't marked known"><Target className="w-3.5 h-3.5" /> Study {cards.length - known.size} left</button>
            )}
            <button onClick={exportCsv} title="Download as CSV (import into Anki / Quizlet)" className={`ml-auto ${secondaryBtn}`}><Download className="w-3.5 h-3.5" /> CSV</button>
            <button onClick={reshuffle} className={secondaryBtn}><Shuffle className="w-3.5 h-3.5" /> Shuffle</button>
            <button onClick={reset} className={secondaryBtn} title="Clear saved progress"><RotateCcw className="w-3.5 h-3.5" /> Reset</button>
          </div>
        </div>
      </Surface>
    </div>
  );
};
