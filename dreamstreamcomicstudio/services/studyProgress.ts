// Per-deck flashcard study progress (spaced-repetition lite).
//
// A flashcard deck is saved inside its chat turn, but *which cards you've mastered* was
// ephemeral React state — reset on every reload. This persists the "known" / "review"
// sets per deck (keyed by a stable hash of the cards) in localStorage, so a study
// session carries across reloads and future visits and you can drill just what's left.

export interface DeckProgress {
  /** Card indices the learner marked "got it". */
  known: number[];
  /** Card indices explicitly flagged for more review. */
  review: number[];
  updatedAt: number;
}

const keyFor = (deckId: string) => `ds_flashcards_${deckId}`;

/** Stable id derived from the deck's contents (so the same deck restores its progress). */
export const deckIdFor = (cards: { front: string; back: string }[], title?: string): string => {
  const basis = `${title || ''}|${cards.map((c) => `${c.front}=>${c.back}`).join('|')}`;
  let h = 5381;
  for (let i = 0; i < basis.length; i += 1) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return `${cards.length}_${h.toString(36)}`;
};

export const loadProgress = (deckId: string): DeckProgress | null => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(keyFor(deckId)) : null;
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<DeckProgress>;
    if (!p || !Array.isArray(p.known) || !Array.isArray(p.review)) return null;
    return { known: p.known.filter((n) => Number.isInteger(n)), review: p.review.filter((n) => Number.isInteger(n)), updatedAt: p.updatedAt || 0 };
  } catch {
    return null;
  }
};

export const saveProgress = (deckId: string, p: DeckProgress): void => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(keyFor(deckId), JSON.stringify(p));
  } catch {
    /* quota exceeded / storage denied — progress is best-effort */
  }
};

export const clearProgress = (deckId: string): void => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(keyFor(deckId));
  } catch {
    /* noop */
  }
};
