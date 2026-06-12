import { describe, expect, it } from 'vitest';
import { AppStep, ComicState } from '../types';
import { migrateComicStateForFlow } from './useProjectManager';

const makeState = (overrides?: Partial<ComicState>): ComicState => ({
  step: 1,
  maxStepReached: 6,
  flowVersion: 3,
  script: 'Scene 1: SALTY and PIP enter the tunnel.',
  scenes: [
    {
      id: 1,
      rawText: 'SALTY and PIP enter the tunnel.',
      synopsis: 'SALTY and PIP enter the tunnel.',
      characters: ['SALTY', 'PIP'],
      setting: 'Tunnel'
    }
  ],
  continuitySummary: '',
  continuity: undefined,
  overview: '',
  comments: [],
  isFeatured: false,
  coverPrompt: '',
  styleVariants: [],
  stylePrompt: '',
  styleCategory: '',
  styleAspectRatio: '1:1',
  imageResolution: '1K',
  characters: [],
  items: [],
  locations: [],
  layoutType: 'grid',
  panels: [],
  textLayout: 'caption',
  pricingConfig: undefined,
  ...overrides
});

describe('flow migration v4', () => {
  it('migrates legacy projects without gating them on the removed planning stage', () => {
    const migrated = migrateComicStateForFlow(makeState());

    expect(migrated.flowVersion).toBe(4);
    // flow v3 step 1 (old STYLE position) shifts +1 to the current STYLE_SELECTION —
    // and is never parked on the retired STORY_PLANNING stage.
    expect(migrated.step).toBe(AppStep.STYLE_SELECTION);
    expect(migrated.maxStepReached).toBeGreaterThanOrEqual(AppStep.STYLE_SELECTION);
    expect(migrated.step).not.toBe(AppStep.STORY_PLANNING);
    expect(migrated.storyPlanning).toBeDefined();
  });

  it('allows migrated projects with approved planning to continue', () => {
    const migrated = migrateComicStateForFlow(makeState({
      storyPlanning: {
        formFactor: 'us_comic',
        recommendedRange: { min: 6, max: 10 },
        userRange: { min: 6, max: 10 },
        recommendedPageCount: 8,
        approvedPageCount: 8,
        feasibility: {
          status: 'ok',
          reason: 'Valid range.',
          estimatedPanels: { min: 24, max: 60 }
        },
        estimatedCostRange: { currency: 'USD', minUsd: 1.1, maxUsd: 2.8 },
        approved: true,
        approvedAt: Date.now(),
        resumeStep: AppStep.STYLE_SELECTION
      }
    }));

    expect(migrated.step).toBe(AppStep.STYLE_SELECTION);
    expect(migrated.maxStepReached).toBeGreaterThanOrEqual(AppStep.STYLE_SELECTION);
  });
});
