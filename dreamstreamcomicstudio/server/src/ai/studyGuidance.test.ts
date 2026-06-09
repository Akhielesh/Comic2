import { describe, it, expect } from 'vitest';
import { studyGuidanceBlock } from './chat.js';

describe('studyGuidanceBlock', () => {
  it('adds exam-ready depth guidance on clear study/exam intent', () => {
    for (const text of [
      'help me study for my biology exam',
      'I need to prepare for the SQL interview',
      'teach me how recursion works',
      'quiz me on the French revolution',
      'revise calculus derivatives with me'
    ]) {
      const block = studyGuidanceBlock(text);
      expect(block).toContain('EXAM / STUDY MODE');
      expect(block.toLowerCase()).toContain('practice');
    }
  });

  it('stays silent on non-study questions (no over-flavoring)', () => {
    for (const text of [
      "what's the weather in Paris",
      'summarize this email',
      'convert 10 USD to EUR',
      'write a haiku about the sea'
    ]) {
      expect(studyGuidanceBlock(text)).toBe('');
    }
  });

  it('returns empty for empty input', () => {
    expect(studyGuidanceBlock('')).toBe('');
  });
});
