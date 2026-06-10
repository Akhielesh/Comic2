// Smart model selection — the app's own reasoning for picking the best model per scenario,
// across ALL sources (OpenRouter, NVIDIA, …), in two modes:
//   - 'best': the strongest model for the task regardless of price.
//   - 'free': the strongest TRULY-FREE ($0) model — "use any/all free models to get the best
//             consistent result for the user's needs."
//
// It is data-driven over the live catalog (capabilities + drawbacks) so new sources/models
// slot in automatically, and it KEEPS IMPROVING via user like/dislike feedback. Every pick
// is explainable (reasons), and it understands each model's drawbacks (penalizes them).

import type { CatalogModel } from './modelCatalog';
import { getCapabilities, type ModelCapabilities } from './modelCapabilities';
import { feedbackScore } from './modelFeedback';
import { getModelDomains, domainStrength, DOMAIN_META, type DomainId } from './modelDomains';

export type SmartTask =
  | 'script_analysis'
  | 'world_extraction'
  | 'panel_breakdown'
  | 'dialogue'
  | 'continuity_audit'
  | 'panel_art'
  | 'cover'
  | 'style';

export type SmartMode = 'best' | 'free';

export interface TaskProfile {
  label: string;
  kind: 'text' | 'image';
  /** Pipeline stage key this task maps to (for per-stage routing). */
  stage?: string;
  /** Hard requirement — models failing this are excluded entirely. */
  gate: (c: ModelCapabilities) => boolean;
  /** Capability-fit bonus for this scenario. */
  fit: (c: ModelCapabilities, m: CatalogModel) => number;
  /** Real-world domains that matter for this task — benchmark strength here boosts the score. */
  domains?: DomainId[];
  why: string;
}

export const TASK_PROFILES: Record<SmartTask, TaskProfile> = {
  script_analysis: {
    label: 'Script analysis', kind: 'text', stage: 'analyze_script',
    gate: (c) => c.textOutput,
    fit: (c) => (c.structuredJson ? 30 : 0) + (c.longContext ? 18 : c.contextLength >= 64000 ? 8 : 0) + (c.reasoning ? 6 : 0),
    domains: ['reasoning', 'knowledge'],
    why: 'Needs reliable structured JSON and enough context to read the whole script.'
  },
  world_extraction: {
    label: 'World extraction', kind: 'text', stage: 'extract_world',
    gate: (c) => c.textOutput,
    fit: (c) => (c.structuredJson ? 32 : 0) + (c.reasoning ? 10 : 0) + (c.longContext ? 8 : 0),
    domains: ['reasoning', 'knowledge'],
    why: 'Structured extraction of characters/items/locations; reasoning helps fill details.'
  },
  panel_breakdown: {
    label: 'Panel breakdown', kind: 'text', stage: 'panel_breakdown',
    gate: (c) => c.textOutput,
    fit: (c) => (c.structuredJson ? 30 : 0) + (c.reasoning ? 16 : 0),
    domains: ['reasoning'],
    why: 'Plans shot/angle/composition into JSON — benefits most from reasoning + structure.'
  },
  dialogue: {
    label: 'Dialogue', kind: 'text', stage: 'dialogue',
    gate: (c) => c.textOutput,
    fit: (c) => (c.structuredJson ? 10 : 0) + (c.reasoning ? 4 : 0),
    domains: ['writing'],
    why: 'Short, in-character lines — most capable text models do well.'
  },
  continuity_audit: {
    label: 'Continuity audit', kind: 'text', stage: 'continuity_audit',
    gate: (c) => c.textOutput,
    fit: (c) => (c.structuredJson ? 28 : 0) + (c.reasoning ? 14 : 0),
    domains: ['reasoning'],
    why: 'Cross-checks panels for drift — structured + reasoning.'
  },
  panel_art: {
    label: 'Panel art', kind: 'image', stage: 'panel',
    gate: (c) => c.imageOutput,
    fit: (c) => (c.multiImageRefs ? 45 : 0) + (c.imageInput ? 18 : 0),
    why: 'Character consistency across panels needs strong multi-reference image support.'
  },
  cover: {
    label: 'Cover', kind: 'image', stage: 'cover',
    gate: (c) => c.imageOutput,
    fit: (c) => (c.imageInput ? 12 : 0) + (c.multiImageRefs ? 8 : 0),
    why: 'High-impact single image; reference support helps stay on-world.'
  },
  style: {
    label: 'Style', kind: 'image', stage: 'style',
    gate: (c) => c.imageOutput,
    fit: () => 0,
    why: 'Look-and-feel study — any capable image model works.'
  }
};

// Small reliability priors for well-known families (nudge, not a gate).
const FAMILY_PRIOR: { re: RegExp; bonus: number }[] = [
  { re: /gemini/i, bonus: 8 },
  { re: /(gpt-4o|gpt-4\.1|gpt-5|o3|o4)/i, bonus: 7 },
  { re: /claude/i, bonus: 7 },
  { re: /(llama-3\.[13]|llama-4)/i, bonus: 6 },
  { re: /deepseek/i, bonus: 6 },
  { re: /(qwen|mistral|gemma)/i, bonus: 4 },
  { re: /flux/i, bonus: 4 }
];

const familyPrior = (id: string): number => {
  for (const f of FAMILY_PRIOR) if (f.re.test(id)) return f.bonus;
  return 0;
};

const costScore = (model: CatalogModel, mode: SmartMode, isFree: boolean): { score: number; reason?: string } => {
  if (isFree) return { score: mode === 'free' ? 45 : 22, reason: 'free to run' };
  if (mode === 'free') return { score: 0 }; // shouldn't reach (gated), defensive
  switch (model.costBand) {
    case 'low': return { score: 12, reason: 'low cost' };
    case 'medium': return { score: 2 };
    case 'high': return { score: -10, reason: 'premium price' };
    default: return { score: 0 };
  }
};

export interface ScoredModel {
  model: CatalogModel;
  score: number;
  reasons: string[];
}

/** Score one model for one task in one mode. Returns null if it fails the hard gate / free filter. */
export const scoreModelForTask = (model: CatalogModel, task: SmartTask, mode: SmartMode): ScoredModel | null => {
  // Download-only catalog entries (NVIDIA NIMs) 404 on the hosted API — never auto-pick them.
  if (model.apiCallable === false) return null;
  const profile = TASK_PROFILES[task];
  const caps = getCapabilities(model);
  if (!profile.gate(caps)) return null;
  const isFree = caps.isFree;
  if (mode === 'free' && !isFree) return null;

  const reasons: string[] = [];
  let score = 0;

  const fit = profile.fit(caps, model);
  if (fit > 0) { score += fit; reasons.push('strong fit for this task'); }

  // Domain-aware quality: reward proven benchmark strength in the domains this task needs
  // (e.g. reasoning for planning, writing for dialogue). Up to ~22 pts, so it tunes the order
  // without overriding hard capability fit. THIS is what makes "pick a model for X" actually good.
  if (profile.domains?.length) {
    const avg = profile.domains.reduce((s, d) => s + domainStrength(model, d), 0) / profile.domains.length;
    if (avg > 0) {
      score += Math.round(avg * 0.22);
      if (avg >= 70) reasons.push(`benchmark-strong at ${profile.domains.map((d) => DOMAIN_META[d].label.toLowerCase()).join(' & ')}`);
    }
  }

  const cost = costScore(model, mode, isFree);
  score += cost.score;
  if (cost.reason) reasons.push(cost.reason);

  // Understand drawbacks: each noted drawback costs the model.
  const drawbackCount = model.drawbacks?.length || 0;
  if (drawbackCount > 0) { score -= drawbackCount * 4; reasons.push(`${drawbackCount} known drawback${drawbackCount > 1 ? 's' : ''}`); }

  const prior = familyPrior(model.id);
  if (prior > 0) { score += prior; reasons.push('proven model family'); }

  // Keep improving from the user's likes/dislikes (bounded so it tunes, not dominates).
  const fb = feedbackScore(model.id, task);
  if (fb !== 0) {
    score += Math.max(-25, Math.min(25, fb * 8));
    reasons.push(fb > 0 ? 'you liked this before' : 'you disliked this before');
  }

  return { model, score: Math.round(score), reasons };
};

export const rankModelsForTask = (models: CatalogModel[], task: SmartTask, mode: SmartMode): ScoredModel[] =>
  models
    .map((m) => scoreModelForTask(m, task, mode))
    .filter((x): x is ScoredModel => x !== null)
    .sort((a, b) => b.score - a.score);

export const pickBestForTask = (models: CatalogModel[], task: SmartTask, mode: SmartMode): ScoredModel | null =>
  rankModelsForTask(models, task, mode)[0] || null;

export interface SmartTeam {
  mode: SmartMode;
  /** Headline text model (best for the most demanding text task). */
  text: ScoredModel | null;
  /** Headline image model (best for panel art = the consistency-critical task). */
  image: ScoredModel | null;
  /** Best model per task (text tasks carry a stage for per-stage routing). */
  perTask: Partial<Record<SmartTask, ScoredModel>>;
}

/**
 * Assemble the best "team" of models for the whole comic from the (multi-source) catalog.
 * Text tasks get per-stage picks; image uses the panel-art pick as the headline (most
 * demanding). Falls back gracefully when a mode/task has no eligible model.
 */
export const buildSmartTeam = (models: CatalogModel[], mode: SmartMode): SmartTeam => {
  const perTask: Partial<Record<SmartTask, ScoredModel>> = {};
  (Object.keys(TASK_PROFILES) as SmartTask[]).forEach((task) => {
    const best = pickBestForTask(models, task, mode);
    if (best) perTask[task] = best;
  });
  const text = perTask.panel_breakdown || perTask.script_analysis || perTask.world_extraction || null;
  const image = perTask.panel_art || perTask.cover || perTask.style || null;
  return { mode, text, image, perTask };
};

// ── Domain-first picking ───────────────────────────────────────────────────────
// For callers that think in domains rather than comic stages ("give me the best CODING model",
// "the best for science"). Ranks purely by benchmark strength in the domain, blended with cost,
// known drawbacks, family prior and your feedback — so it's explainable and keeps improving.

export interface DomainPick extends ScoredModel { strength: number; }

export const rankModelsForDomain = (models: CatalogModel[], domain: DomainId, mode: SmartMode = 'best'): DomainPick[] =>
  models
    .map((model): DomainPick | null => {
      if (model.apiCallable === false) return null; // download-only — would 404 on use
      const caps = getCapabilities(model);
      const isFree = caps.isFree;
      if (mode === 'free' && !isFree) return null;
      const strength = domainStrength(model, domain);
      if (strength <= 0) return null;

      const reasons: string[] = [`${DOMAIN_META[domain].label}: ${strength}/100`];
      let score = strength; // 0–100 from benchmarks/capabilities is the backbone

      const cost = costScore(model, mode, isFree);
      score += cost.score;
      if (cost.reason) reasons.push(cost.reason);

      const drawbacks = model.drawbacks?.length || 0;
      if (drawbacks > 0) score -= drawbacks * 3;

      const prior = familyPrior(model.id);
      if (prior > 0) score += prior;

      const fb = feedbackScore(model.id, `domain:${domain}`);
      if (fb !== 0) {
        score += Math.max(-25, Math.min(25, fb * 8));
        reasons.push(fb > 0 ? 'you liked this before' : 'you disliked this before');
      }
      return { model, score: Math.round(score), reasons, strength };
    })
    .filter((x): x is DomainPick => x !== null)
    .sort((a, b) => b.score - a.score);

export const pickBestForDomain = (models: CatalogModel[], domain: DomainId, mode: SmartMode = 'best'): DomainPick | null =>
  rankModelsForDomain(models, domain, mode)[0] || null;
