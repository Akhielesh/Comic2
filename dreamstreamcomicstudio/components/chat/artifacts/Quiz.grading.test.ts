import { describe, it, expect } from 'vitest';
import { isCorrect } from './Quiz';
import type { QuizQuestion } from '../../../apiTypes';

const short = (correct: string[]): QuizQuestion => ({ id: 'q', type: 'short', prompt: 'p', correct });
const single = (correct: string[]): QuizQuestion => ({
  id: 'q', type: 'single', prompt: 'p',
  choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct
});

describe('Quiz short-answer grading (forgiving)', () => {
  it('accepts exact and case/space-insensitive matches', () => {
    expect(isCorrect(short(['Chloroplast']), 'chloroplast')).toBe(true);
    expect(isCorrect(short(['oxygen', 'o2']), '  O2 ')).toBe(true);
  });

  it('accepts the expected term embedded as whole words', () => {
    expect(isCorrect(short(['chloroplast']), 'the chloroplast')).toBe(true);
    expect(isCorrect(short(['oxygen']), "it's oxygen gas")).toBe(true);
  });

  it('does NOT accept wrong answers or partial/substring noise', () => {
    expect(isCorrect(short(['oxygen']), 'nitrogen')).toBe(false);
    expect(isCorrect(short(['ice']), 'nice')).toBe(false);        // word boundary required
    expect(isCorrect(short(['oxygen']), 'ox')).toBe(false);
    expect(isCorrect(short(['oxygen']), '')).toBe(false);
  });

  it('keeps very short expected terms exact-only (no loose embedding)', () => {
    expect(isCorrect(short(['o2']), 'co2')).toBe(false); // 2-char term → exact match only
    expect(isCorrect(short(['o2']), 'o2')).toBe(true);
  });

  it('still grades choice questions correctly', () => {
    expect(isCorrect(single(['b']), ['b'])).toBe(true);
    expect(isCorrect(single(['b']), ['a'])).toBe(false);
  });
});
