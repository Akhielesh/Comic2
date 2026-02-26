export enum TaskType {
  STORY_ANALYSIS = 'story_analysis',
  STYLE_SUGGESTION = 'style_suggestion',
  ASSET_CARD_GEN = 'asset_card_gen',
  THUMBNAIL_GEN = 'thumbnail_gen',
  PANEL_GEN_DRAFT = 'panel_gen_draft',
  PANEL_GEN_FINAL = 'panel_gen_final',
  PANEL_GEN_EXPORT = 'panel_gen_export',
  QC_CHECK = 'qc_check',
  CONSISTENCY_CHECK = 'consistency_check'
}

export type ModelPolicy = {
  model: string;
  provider: 'gemini' | 'pixazo';
  estimatedCostUsd: number;
};

export const MODEL_ROUTING_TABLE: Record<TaskType, ModelPolicy> = {
  [TaskType.STORY_ANALYSIS]: {
    model: 'gemini-2.5-pro',
    provider: 'gemini',
    estimatedCostUsd: 0.006
  },
  [TaskType.STYLE_SUGGESTION]: {
    model: 'gemini-2.5-flash',
    provider: 'gemini',
    estimatedCostUsd: 0.002
  },
  [TaskType.ASSET_CARD_GEN]: {
    model: 'gemini-2.5-flash-image',
    provider: 'gemini',
    estimatedCostUsd: 0.039
  },
  [TaskType.THUMBNAIL_GEN]: {
    model: 'pixazo/flux-1-schnell',
    provider: 'pixazo',
    estimatedCostUsd: 0.005
  },
  [TaskType.PANEL_GEN_DRAFT]: {
    model: 'gemini-2.5-flash-image',
    provider: 'gemini',
    estimatedCostUsd: 0.039
  },
  [TaskType.PANEL_GEN_FINAL]: {
    model: 'gemini-3-pro-image-preview',
    provider: 'gemini',
    estimatedCostUsd: 0.069
  },
  [TaskType.PANEL_GEN_EXPORT]: {
    model: 'gemini-3-pro-image-preview',
    provider: 'gemini',
    estimatedCostUsd: 0.105
  },
  [TaskType.QC_CHECK]: {
    model: 'gemini-2.5-flash',
    provider: 'gemini',
    estimatedCostUsd: 0.003
  },
  [TaskType.CONSISTENCY_CHECK]: {
    model: 'gemini-2.5-pro',
    provider: 'gemini',
    estimatedCostUsd: 0.01
  }
};

export const getModelPolicy = (taskType: TaskType): ModelPolicy => MODEL_ROUTING_TABLE[taskType];

const NO_TEXT_GUARD = 'NO TEXT, NO LETTERS, NO WORDS, NO NUMBERS anywhere in the image. NO speech bubbles. NO caption boxes.';

export const buildNoTextPrompt = (basePrompt: string, balloonZoneInstruction: string): string => {
  const prompt = `${basePrompt.trim()}\n\n${balloonZoneInstruction.trim()}`.trim();
  if (prompt.toUpperCase().includes('NO TEXT')) {
    return prompt;
  }
  return `${prompt}\n\n${NO_TEXT_GUARD}`;
};

export const assertNoTextPromptContract = (prompt: string): void => {
  const normalized = prompt.trim().toUpperCase();
  if (!normalized.includes('NO TEXT')) {
    const error = new Error('ComicForge prompt contract violation: missing NO TEXT guard.') as Error & {
      status?: number;
      publicCode?: string;
    };
    error.status = 500;
    error.publicCode = 'PROMPT_CONTRACT_VIOLATION';
    throw error;
  }
};
