import { ComicPanel, GenerationInsight, StoryMood } from '../types';
import { derivePanelTitle } from './panelDescription';

/**
 * Capture a compact record of what the AI "understood" for one generation run and how it
 * turned out, so issues like "I gave a happy story and it rendered dark & moody" can be
 * analysed later. Prompts/responses are already persisted as GenerationArtifacts; this
 * adds the higher-level decision context (mood -> style -> outcome) that was previously
 * only in ephemeral in-memory logs.
 */
export const buildGenerationInsight = (params: {
  panels: ComicPanel[];
  mood?: StoryMood;
  styleId?: string;
  stylePrompt?: string;
  modelsUsed?: string[];
  fallbacks?: number;
  generatedAt?: number;
}): GenerationInsight => {
  const panels = params.panels || [];
  const rendered = panels.filter((p) => p.imageId).length;
  const failedPanels = panels.filter((p) => p.failureReason && !p.imageId);

  return {
    generatedAt: params.generatedAt ?? Date.now(),
    mood: params.mood
      ? {
          key: params.mood.key,
          label: params.mood.label,
          brightness: params.mood.brightness,
          confidence: params.mood.confidence,
          summary: params.mood.summary
        }
      : undefined,
    styleId: params.styleId,
    stylePrompt: params.stylePrompt,
    totals: {
      panels: panels.length,
      rendered,
      failed: failedPanels.length,
      fallbacks: Math.max(0, params.fallbacks || 0)
    },
    modelsUsed: [...new Set(params.modelsUsed || [])],
    failedPanelTitles: failedPanels.slice(0, 12).map((p, i) => derivePanelTitle(p, i))
  };
};

/** Append an insight to the rolling history, keeping only the most recent `cap`. */
export const appendGenerationInsight = (
  existing: GenerationInsight[] | undefined,
  insight: GenerationInsight,
  cap = 8
): GenerationInsight[] => {
  const next = [...(existing || []), insight];
  return next.length > cap ? next.slice(next.length - cap) : next;
};

/** A one-line, log-friendly summary (mirrors the existing `[METRICS]` log style). */
export const formatInsightLogLine = (insight: GenerationInsight): string =>
  `[INSIGHTS] mood=${insight.mood?.key || 'n/a'}(${insight.mood?.brightness || '-'},conf=${insight.mood?.confidence ?? 0}) ` +
  `style=${insight.styleId || 'custom'} panels=${insight.totals.panels} rendered=${insight.totals.rendered} ` +
  `failed=${insight.totals.failed} fallbacks=${insight.totals.fallbacks} models=${insight.modelsUsed.join('|') || 'none'}`;
