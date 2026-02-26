import { AspectRatio, Scene } from '../types';
import { GRID_TEMPLATES, GridTemplate } from './gridTemplates';

export interface LayoutRecommendation {
  templateId: string;
  score: number;
  reason: string;
}

const ACTION_KEYWORDS = ['chase', 'fight', 'run', 'jump', 'explosion', 'crash', 'lunge', 'heist'];
const DIALOGUE_MARKERS = ['"', ':'];

const countMatches = (text: string, keywords: string[]) => {
  const source = text.toLowerCase();
  return keywords.reduce((count, keyword) => (source.includes(keyword) ? count + 1 : count), 0);
};

const estimateActionDensity = (scenes: Scene[]) => {
  if (!scenes.length) return 0;
  const hits = scenes.reduce((sum, scene) => sum + countMatches(scene.synopsis || '', ACTION_KEYWORDS), 0);
  return hits / scenes.length;
};

const estimateDialogueDensity = (scenes: Scene[]) => {
  if (!scenes.length) return 0;
  const hits = scenes.reduce((sum, scene) => {
    const text = `${scene.rawText || ''} ${scene.synopsis || ''}`;
    return sum + countMatches(text, DIALOGUE_MARKERS);
  }, 0);
  return hits / scenes.length;
};

const scoreTemplate = (
  template: GridTemplate,
  scenes: Scene[],
  aspectRatio?: AspectRatio
): LayoutRecommendation => {
  const reasons: string[] = [];
  let score = 0;

  const sceneCount = scenes.length;
  const actionDensity = estimateActionDensity(scenes);
  const dialogueDensity = estimateDialogueDensity(scenes);

  if (aspectRatio) {
    if (template.compatibleRatios.includes(aspectRatio)) {
      score += 4;
      reasons.push('form-factor compatible');
    } else {
      score -= 2;
      reasons.push('not optimized for selected form factor');
    }
  }

  if (actionDensity >= 1.2 && template.tags.some((tag) => ['action', 'dynamic', 'cinematic', 'hero'].includes(tag))) {
    score += 3;
    reasons.push('matches action-heavy pacing');
  }

  if (dialogueDensity >= 1.0 && template.tags.some((tag) => ['dialogue', 'conversation', 'pacing', 'storyboard'].includes(tag))) {
    score += 3;
    reasons.push('supports dialogue density');
  }

  if (sceneCount >= 7 && template.panelCount >= 4) {
    score += 2;
    reasons.push('handles dense scene progression');
  }

  if (sceneCount <= 4 && template.panelCount <= 3) {
    score += 2;
    reasons.push('fits concise story arc');
  }

  if (template.tags.includes('simple')) {
    score += 1;
    reasons.push('high readability baseline');
  }

  return {
    templateId: template.id,
    score,
    reason: reasons.join(', ') || 'general balanced fit'
  };
};

export const recommendLayouts = (input: {
  scenes: Scene[];
  selectedFormFactor?: AspectRatio;
  templates?: GridTemplate[];
}) => {
  const templates = input.templates || GRID_TEMPLATES;
  return templates
    .map((template) => scoreTemplate(template, input.scenes || [], input.selectedFormFactor))
    .sort((a, b) => b.score - a.score);
};
