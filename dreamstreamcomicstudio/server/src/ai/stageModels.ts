// Per-stage AI model handling.
//
// Each pipeline stage declares the capabilities it needs. resolveStageModel() validates
// a requested model against the LIVE catalog and, when it can't meet the stage's
// requirements, falls back to a capability-filtered auto-pick. This prevents e.g. a
// text-only or non-JSON model being sent to analyze-script (which needs structured
// output), where it would otherwise fail at request time.

import { getCatalog } from '../services/modelCatalog.js';
import { pickTextModel, pickImageModel, type CostPref } from './autoRouter.js';
import type { AnnotatedModel } from './catalogAnnotations.js';

export type PipelineStage =
  | 'analyze_script' | 'extract_world' | 'panel_breakdown'
  | 'continuity_audit' | 'continuity_summary'
  | 'story_outline' | 'story_draft' | 'story_tool'
  | 'image_generation' | 'cover' | 'assistant' | 'testlab_report' | 'generate';

export type Capability = 'structuredJson' | 'imageOutput' | 'imageInput' | 'longContext';

const LONG_CONTEXT_MIN_TOKENS = 32_000;

export interface StageRequirement {
  kind: 'text' | 'image';
  /** Hard gates — a model must satisfy all of these to drive the stage. */
  requires: Capability[];
  /** Soft preferences — used to rank otherwise-eligible candidates. */
  prefers?: Capability[];
}

export const STAGE_REQUIREMENTS: Record<PipelineStage, StageRequirement> = {
  analyze_script:     { kind: 'text',  requires: ['structuredJson'] },
  extract_world:      { kind: 'text',  requires: ['structuredJson'] },
  panel_breakdown:    { kind: 'text',  requires: ['structuredJson'] },
  continuity_audit:   { kind: 'text',  requires: ['structuredJson'], prefers: ['longContext'] },
  continuity_summary: { kind: 'text',  requires: [] },
  story_outline:      { kind: 'text',  requires: [] },
  story_draft:        { kind: 'text',  requires: [] },
  story_tool:         { kind: 'text',  requires: [] },
  generate:           { kind: 'text',  requires: [] },
  testlab_report:     { kind: 'text',  requires: [] },
  assistant:          { kind: 'text',  requires: [] },
  image_generation:   { kind: 'image', requires: ['imageOutput'], prefers: ['imageInput'] },
  cover:              { kind: 'image', requires: ['imageOutput'], prefers: ['imageInput'] }
};

export const modelHasCapability = (m: AnnotatedModel, cap: Capability): boolean => {
  switch (cap) {
    case 'structuredJson': return Boolean(m.supportsJsonOutput);
    case 'imageOutput':    return Boolean(m.supportsImageOutput);
    case 'imageInput':     return Boolean(m.supportsImageInput);
    case 'longContext':    return (m.contextLength ?? 0) >= LONG_CONTEXT_MIN_TOKENS;
    default:               return true;
  }
};

const meetsAll = (m: AnnotatedModel, caps: Capability[]): boolean =>
  caps.every((c) => modelHasCapability(m, c));

export interface StageModelResolution {
  model: string;
  /** Present when a requested model was overridden for lacking a required capability. */
  downgradedFrom?: string;
  reason?: string;
}

const autoPick = (requirement: StageRequirement, costPref: CostPref): Promise<string> => {
  const filter = (m: AnnotatedModel) => meetsAll(m, requirement.requires);
  const prefer = requirement.prefers && requirement.prefers.length
    ? (m: AnnotatedModel) => meetsAll(m, requirement.prefers as Capability[])
    : undefined;
  return requirement.kind === 'image'
    ? pickImageModel({ costPref, filter, prefer })
    : pickTextModel({ costPref, filter, prefer });
};

/**
 * Resolve the model to use for a stage. A requested model is honored when it satisfies
 * the stage's required capabilities (per the live catalog), when the stage has no hard
 * requirements, or when the catalog can't be consulted (we can't prove it's incapable).
 * Otherwise we downgrade to a capability-valid auto-pick and report the downgrade.
 */
export const resolveStageModel = async (
  stage: PipelineStage,
  requested?: string,
  opts?: { costPref?: CostPref }
): Promise<StageModelResolution> => {
  const requirement = STAGE_REQUIREMENTS[stage] ?? { kind: 'text', requires: [] };
  const costPref: CostPref = opts?.costPref ?? 'free';
  const want = (requested || '').trim();

  if (!want) {
    return { model: await autoPick(requirement, costPref) };
  }
  if (requirement.requires.length === 0) {
    return { model: want };
  }

  let models: AnnotatedModel[] = [];
  try {
    ({ models } = await getCatalog());
  } catch {
    models = [];
  }

  const found = models.find((m) => m.id === want);
  if (!found || meetsAll(found, requirement.requires)) {
    return { model: want };
  }

  const fallback = await autoPick(requirement, costPref);
  return {
    model: fallback,
    downgradedFrom: want,
    reason: `Model "${want}" lacks ${requirement.requires.join(', ')} required for ${stage}; using "${fallback}".`
  };
};
