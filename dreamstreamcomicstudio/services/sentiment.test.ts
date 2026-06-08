import { describe, it, expect } from 'vitest';
import { detectSentiment } from './sentiment';

describe('detectSentiment', () => {
  it('flags strong venting as frustrated', () => {
    expect(detectSentiment('this is useless')).toBe('frustrated');
    expect(detectSentiment('the studio is completely BROKEN')).toBe('frustrated');
    expect(detectSentiment("it doesn't work at all")).toBe('frustrated');
    expect(detectSentiment('so frustrating, total waste of time')).toBe('frustrated');
  });

  it('flags softer dissatisfaction as negative', () => {
    expect(detectSentiment('this answer is wrong')).toBe('negative');
    expect(detectSentiment('the UI is really confusing')).toBe('negative');
    expect(detectSentiment('generation is too slow')).toBe('negative');
  });

  it('returns null for neutral / positive messages', () => {
    expect(detectSentiment('how do I add a panel?')).toBeNull();
    expect(detectSentiment('thanks, that worked great!')).toBeNull();
    expect(detectSentiment('')).toBeNull();
  });

  it('prefers the stronger signal when both could match', () => {
    // Contains the soft cue "wrong" but also the strong cue "useless".
    expect(detectSentiment('this is useless and the output is wrong')).toBe('frustrated');
  });
});
