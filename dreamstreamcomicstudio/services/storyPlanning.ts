import { AppStep, AspectRatio, ComicBookFormFactor, Scene, StoryPlanningState } from '../types';
import { estimateStoryCostRange } from './costProjection';

export interface ComicFormFactorPreset {
  id: ComicBookFormFactor;
  label: string;
  description: string;
  defaultAspectRatio: AspectRatio;
  panelsPerPageRange: {
    min: number;
    max: number;
  };
}

export interface StoryPlanInput {
  script: string;
  scenes: Scene[];
  formFactor?: ComicBookFormFactor;
  userRange?: { min: number; max: number };
  customFormFactorNote?: string;
}

const clampInt = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(value)));

const FORM_FACTOR_PRESETS: ComicFormFactorPreset[] = [
  {
    id: 'us_comic',
    label: 'US Comic (Single-Issue)',
    description: 'Action-forward pacing with classic page turns and balanced panel density.',
    defaultAspectRatio: '3:4',
    panelsPerPageRange: { min: 4, max: 6 }
  },
  {
    id: 'manga_tankobon',
    label: 'Manga Tankobon',
    description: 'Higher panel density and rhythm-friendly decompression for emotional beats.',
    defaultAspectRatio: '2:3',
    panelsPerPageRange: { min: 5, max: 8 }
  },
  {
    id: 'european_album',
    label: 'European Album',
    description: 'Larger framed panels with cleaner pacing and cinematic establishing shots.',
    defaultAspectRatio: '4:3',
    panelsPerPageRange: { min: 4, max: 6 }
  },
  {
    id: 'webtoon_vertical',
    label: 'Webtoon Vertical',
    description: 'Mobile-native vertical progression with frequent transition beats.',
    defaultAspectRatio: '9:16',
    panelsPerPageRange: { min: 5, max: 9 }
  },
  {
    id: 'trade_paperback',
    label: 'Trade Paperback',
    description: 'General-purpose format for serialized stories compiled as one volume.',
    defaultAspectRatio: '3:4',
    panelsPerPageRange: { min: 4, max: 7 }
  },
  {
    id: 'custom',
    label: 'Custom Format',
    description: 'User-defined physical or digital format requirements.',
    defaultAspectRatio: '3:4',
    panelsPerPageRange: { min: 4, max: 7 }
  }
];

const FORM_FACTOR_PAGE_MULTIPLIER: Record<ComicBookFormFactor, number> = {
  us_comic: 1.0,
  manga_tankobon: 1.15,
  european_album: 0.9,
  webtoon_vertical: 1.25,
  trade_paperback: 1.05,
  custom: 1.0
};

const getWordCount = (script: string) =>
  script
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

const buildRecommendedPageRange = (
  script: string,
  scenes: Scene[],
  formFactor: ComicBookFormFactor
) => {
  const words = getWordCount(script);
  const sceneCount = Math.max(1, scenes.length || 0);
  const baselineFromScenes = Math.ceil(sceneCount * 1.15);
  const baselineFromWords = Math.ceil(words / 110);
  const narrativeBase = Math.max(4, baselineFromScenes, baselineFromWords);
  const multiplier = FORM_FACTOR_PAGE_MULTIPLIER[formFactor] || 1.0;

  const recommended = clampInt(Math.round(narrativeBase * multiplier), 4, 160);
  const spread = Math.max(2, Math.ceil(recommended * 0.3));

  return {
    min: clampInt(recommended - spread, 1, 160),
    max: clampInt(recommended + spread, 1, 160),
    recommended
  };
};

const describeFeasibility = (
  recommendedRange: { min: number; max: number },
  userRange: { min: number; max: number }
) => {
  if (userRange.min > recommendedRange.max * 1.5) {
    return {
      status: 'insufficient' as const,
      reason: 'Requested page range is much higher than story content currently supports.'
    };
  }

  if (userRange.max < Math.ceil(recommendedRange.min * 0.7)) {
    return {
      status: 'tight' as const,
      reason: 'Requested page range is short; story may feel rushed unless scenes are compressed.'
    };
  }

  if (userRange.min > recommendedRange.max || userRange.max < recommendedRange.min) {
    return {
      status: 'tight' as const,
      reason: 'Requested page range is outside the recommended range and may need pacing adjustments.'
    };
  }

  return {
    status: 'ok' as const,
    reason: 'Requested page range is realistic for current script detail and pacing.'
  };
};

export const getComicFormFactorPresets = (): ComicFormFactorPreset[] => FORM_FACTOR_PRESETS;

export const getComicFormFactorPreset = (id: ComicBookFormFactor): ComicFormFactorPreset =>
  FORM_FACTOR_PRESETS.find((preset) => preset.id === id) || FORM_FACTOR_PRESETS[0];

export const getFormFactorDefaultAspectRatio = (id: ComicBookFormFactor): AspectRatio =>
  getComicFormFactorPreset(id).defaultAspectRatio;

export const recommendStoryPlanning = (input: StoryPlanInput): StoryPlanningState => {
  const formFactor = input.formFactor || 'us_comic';
  const preset = getComicFormFactorPreset(formFactor);
  const recommendation = buildRecommendedPageRange(input.script || '', input.scenes || [], formFactor);
  const userRange = input.userRange
    ? {
      min: clampInt(input.userRange.min || recommendation.min, 1, 160),
      max: clampInt(input.userRange.max || recommendation.max, 1, 160)
    }
    : {
      min: recommendation.min,
      max: recommendation.max
    };

  const normalizedRange = {
    min: Math.min(userRange.min, userRange.max),
    max: Math.max(userRange.min, userRange.max)
  };

  const feasibility = describeFeasibility(
    { min: recommendation.min, max: recommendation.max },
    normalizedRange
  );

  const costProjection = estimateStoryCostRange({
    pageRange: normalizedRange,
    panelsPerPageRange: preset.panelsPerPageRange
  });

  return {
    formFactor,
    customFormFactorNote: input.customFormFactorNote,
    recommendedRange: {
      min: recommendation.min,
      max: recommendation.max
    },
    userRange: normalizedRange,
    recommendedPageCount: recommendation.recommended,
    approvedPageCount: clampInt(
      Math.round((normalizedRange.min + normalizedRange.max) / 2),
      normalizedRange.min,
      normalizedRange.max
    ),
    feasibility: {
      status: feasibility.status,
      reason: feasibility.reason,
      estimatedPanels: costProjection.estimatedPanels
    },
    estimatedCostRange: {
      currency: costProjection.currency,
      minUsd: costProjection.minUsd,
      maxUsd: costProjection.maxUsd
    },
    approved: false,
    resumeStep: AppStep.STYLE_SELECTION
  };
};

export const getDefaultStoryPlanningState = (): StoryPlanningState => ({
  formFactor: 'us_comic',
  recommendedRange: { min: 6, max: 12 },
  userRange: { min: 6, max: 12 },
  recommendedPageCount: 8,
  approvedPageCount: 8,
  feasibility: {
    status: 'tight',
    reason: 'Run analysis to compute a script-grounded page recommendation.',
    estimatedPanels: { min: 24, max: 72 }
  },
  estimatedCostRange: {
    currency: 'USD',
    minUsd: 0,
    maxUsd: 0
  },
  approved: false,
  resumeStep: AppStep.STYLE_SELECTION
});
