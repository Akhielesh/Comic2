import { describe, it, expect } from 'vitest';
import { classifyStoryMood, moodHintLine } from './storyMood';

describe('classifyStoryMood', () => {
  it('reads a happy story as bright and recommends bright styles (not noir)', () => {
    const mood = classifyStoryMood(
      'A joyful, sunny day at the festival. The friends laugh and celebrate together, full of hope and delight.'
    );
    expect(mood.brightness).toBe('bright');
    expect(mood.key).toBe('bright_joyful');
    expect(mood.recommendedStyleIds).not.toContain('noir');
    expect(mood.recommendedStyleIds).not.toContain('brutalist');
    expect(mood.recommendedStyleIds[0]).toBeTruthy();
    expect(mood.promptGuidance.toLowerCase()).toContain('warm');
  });

  it('reads a tragic/dark story as dark', () => {
    const mood = classifyStoryMood(
      'After the war, grief and death haunt the ruined city. Despair and loss weigh on every survivor.'
    );
    expect(mood.brightness).toBe('dark');
    expect(['dark_somber', 'horror', 'tense_action']).toContain(mood.key);
  });

  it('weights creative direction heavily over neutral script text', () => {
    const mood = classifyStoryMood(
      'A person walks down a street and enters a building.',
      'Keep it whimsical, magical and cute like a childrens fairytale.'
    );
    expect(mood.brightness).toBe('bright');
    expect(mood.key).toBe('whimsical');
  });

  it('falls back to a balanced neutral mood when there is no signal', () => {
    const mood = classifyStoryMood('The object sits on the table. It is there.');
    expect(mood.key).toBe('balanced');
    expect(mood.brightness).toBe('neutral');
    expect(mood.confidence).toBe(0);
    expect(mood.recommendedStyleIds.length).toBeGreaterThan(0);
  });

  it('produces a usable one-line hint', () => {
    const mood = classifyStoryMood('a happy joyful celebration');
    expect(moodHintLine(mood)).toContain(mood.label);
    expect(moodHintLine(mood)).toContain('palette');
  });
});
