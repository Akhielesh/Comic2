import { describe, it, expect, beforeEach } from 'vitest';
import { deckIdFor, loadProgress, saveProgress, clearProgress } from './studyProgress';

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
