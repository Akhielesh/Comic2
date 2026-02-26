import { describe, expect, it } from 'vitest';
import { recommendLayouts } from './layoutRecommendation';
import { GRID_TEMPLATES } from './gridTemplates';

describe('layout recommendation', () => {
  it('returns ranked templates with reasons', () => {
    const scenes = [
      {
        id: 1,
        rawText: 'SALTY and BARNABY chase the ball through the tunnel.',
        synopsis: 'They run and jump across the catwalk in a tense chase.',
        characters: ['SALTY', 'BARNABY'],
        setting: 'Pipe-room catwalk'
      },
      {
        id: 2,
        rawText: 'PIP lunges and catches the ball mid-fall.',
        synopsis: 'A dramatic action beat with quick movement and recovery.',
        characters: ['PIP'],
        setting: 'Whirlpool edge'
      }
    ];

    const ranked = recommendLayouts({
      scenes,
      selectedFormFactor: '3:4',
      templates: GRID_TEMPLATES
    });

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0].templateId).toBeTruthy();
    expect(typeof ranked[0].reason).toBe('string');
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[ranked.length - 1].score);
  });
});
