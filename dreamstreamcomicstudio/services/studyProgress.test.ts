import { describe, it, expect, beforeEach } from 'vitest';
import {
  deckIdFor, loadProgress, saveProgress, clearProgress,
  quizIdFor, loadQuizAttempt, saveQuizAttempt, clearQuizAttempt
} from './studyProgress';

const cards = [
  { front: 'ser', back: 'to be (permanent)' },
  { front: 'estar', back: 'to be (temporary)' }
];

describe('studyProgress', () => {
  beforeEach(() => localStorage.clear());

  it('derives a stable id from deck contents and title', () => {
    const a = deckIdFor(cards, 'Spanish');
    expect(a).toBe(deckIdFor(cards, 'Spanish'));
    // Different cards / title → different id.
    expect(a).not.toBe(deckIdFor(cards, 'French'));
    expect(a).not.toBe(deckIdFor([...cards, { front: 'tener', back: 'to have' }], 'Spanish'));
  });

  it('round-trips known/review progress', () => {
    const id = deckIdFor(cards, 'Spanish');
    expect(loadProgress(id)).toBeNull();
    saveProgress(id, { known: [0], review: [1], updatedAt: 123 });
    expect(loadProgress(id)).toEqual({ known: [0], review: [1], updatedAt: 123 });
  });

  it('clears progress', () => {
    const id = deckIdFor(cards, 'Spanish');
    saveProgress(id, { known: [0, 1], review: [], updatedAt: 1 });
    clearProgress(id);
    expect(loadProgress(id)).toBeNull();
  });

  it('ignores malformed stored data', () => {
    const id = deckIdFor(cards);
    localStorage.setItem(`ds_flashcards_${id}`, '{not json');
    expect(loadProgress(id)).toBeNull();
  });
});

const questions = [
  { id: 'q1', prompt: 'Where does photosynthesis occur?' },
  { id: 'q2', prompt: 'Name an input.' }
];

describe('quiz attempt persistence', () => {
  beforeEach(() => localStorage.clear());

  it('derives a stable id from questions + title', () => {
    expect(quizIdFor(questions, 'Bio')).toBe(quizIdFor(questions, 'Bio'));
    expect(quizIdFor(questions, 'Bio')).not.toBe(quizIdFor(questions, 'Chem'));
  });

  it('round-trips an attempt and clears it', () => {
    const id = quizIdFor(questions, 'Bio');
    expect(loadQuizAttempt(id)).toBeNull();
    saveQuizAttempt(id, { answers: { q1: ['b'] }, text: { q2: 'water' }, checked: true, updatedAt: 5 });
    expect(loadQuizAttempt(id)).toEqual({ answers: { q1: ['b'] }, text: { q2: 'water' }, checked: true, updatedAt: 5 });
    clearQuizAttempt(id);
    expect(loadQuizAttempt(id)).toBeNull();
  });
});
