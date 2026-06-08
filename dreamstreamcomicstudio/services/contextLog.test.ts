import { describe, it, expect } from 'vitest';
import { buildGenerationInsight, appendGenerationInsight, formatInsightLogLine } from './contextLog';
import { ComicPanel, GenerationInsight, StoryMood } from '../types';

const panel = (over: Partial<ComicPanel>): ComicPanel => ({
  id: Math.random().toString(36).slice(2),
  sceneId: 1,
  description: 'd',
  dialogue: '',
  imageIdHistory: [],
  ...over
});

const mood: StoryMood = {
  key: 'bright_joyful', label: 'Bright & Joyful', brightness: 'bright', energy: 'high',
  palette: 'warm', lighting: 'bright', promptGuidance: 'g', recommendedStyleIds: ['webtoon'],
  summary: 's', confidence: 0.8
};

describe('buildGenerationInsight', () => {
  it('summarizes rendered vs failed panels and carries mood/style', () => {
    const insight = buildGenerationInsight({
      panels: [
        panel({ imageId: 'a', title: 'Done One' }),
        panel({ failureReason: 'missing ref', title: 'Broken One' })
      ],
      mood,
      styleId: 'webtoon',
      stylePrompt: 'bright clean',
      modelsUsed: ['gemini', 'gemini', 'flux'],
      fallbacks: 1
    });
    expect(insight.totals).toEqual({ panels: 2, rendered: 1, failed: 1, fallbacks: 1 });
    expect(insight.modelsUsed).toEqual(['gemini', 'flux']);
    expect(insight.mood?.key).toBe('bright_joyful');
    expect(insight.failedPanelTitles).toEqual(['Broken One']);
  });
});

describe('appendGenerationInsight', () => {
  it('caps the rolling history to the most recent entries', () => {
    let hist: GenerationInsight[] | undefined;
    for (let i = 0; i < 12; i++) {
      hist = appendGenerationInsight(hist, buildGenerationInsight({ panels: [], generatedAt: i }), 8);
    }
    expect(hist!.length).toBe(8);
    expect(hist![0].generatedAt).toBe(4);
    expect(hist![7].generatedAt).toBe(11);
  });
});

describe('formatInsightLogLine', () => {
  it('produces a compact [INSIGHTS] line', () => {
    const line = formatInsightLogLine(buildGenerationInsight({ panels: [], mood, styleId: 'webtoon' }));
    expect(line).toContain('[INSIGHTS]');
    expect(line).toContain('mood=bright_joyful');
    expect(line).toContain('style=webtoon');
  });
});
