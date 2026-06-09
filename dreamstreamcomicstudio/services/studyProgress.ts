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

// djb2 hash → a short, stable id for a piece of study content.
const hash = (basis: string): string => {
  let h = 5381;
  for (let i = 0; i < basis.length; i += 1) h = ((h << 5) + h + basis.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

/** Stable id derived from the deck's contents (so the same deck restores its progress). */
export const deckIdFor = (cards: { front: string; back: string }[], title?: string): string => {
  const basis = `${title || ''}|${cards.map((c) => `${c.front}=>${c.back}`).join('|')}`;
  return `${cards.length}_${hash(basis)}`;
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

// --- Quiz attempt persistence -------------------------------------------------------
// A quiz lives in the saved chat turn, but the learner's answers + graded result were
// ephemeral — a reload wiped the attempt and they had to redo it. Persist the attempt
// (answers/text/checked) per quiz so reopening restores the result.

export interface QuizAttempt {
  answers: Record<string, string[]>;
  text: Record<string, string>;
  checked: boolean;
  updatedAt: number;
}

const quizKeyFor = (quizId: string) => `ds_quiz_${quizId}`;

/** Stable id derived from the quiz's questions (id + prompt) and title. */
export const quizIdFor = (questions: { id: string; prompt: string }[], title?: string): string => {
  const basis = `${title || ''}|${questions.map((q) => `${q.id}:${q.prompt}`).join('|')}`;
  return `${questions.length}_${hash(basis)}`;
};

export const loadQuizAttempt = (quizId: string): QuizAttempt | null => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(quizKeyFor(quizId)) : null;
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<QuizAttempt>;
    if (!a || typeof a !== 'object' || typeof a.answers !== 'object' || typeof a.text !== 'object') return null;
    return { answers: a.answers || {}, text: a.text || {}, checked: Boolean(a.checked), updatedAt: a.updatedAt || 0 };
  } catch {
    return null;
  }
};

export const saveQuizAttempt = (quizId: string, attempt: QuizAttempt): void => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(quizKeyFor(quizId), JSON.stringify(attempt));
  } catch {
    /* best-effort */
  }
};

export const clearQuizAttempt = (quizId: string): void => {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(quizKeyFor(quizId));
  } catch {
    /* noop */
  }
};
