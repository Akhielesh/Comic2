// The recipe runner — executes a resolved Recipe against the app's existing engines.
//
// A recipe is just a structured way to configure one run, so the runner does NOT
// reinvent inference: it resolves parameters, builds the effective system
// (instructions) + kickoff (prompt), and then routes to the right engine:
//   - swarm recipes  → runSwarm (plan → dispatch → verify → synthesize)
//   - single recipes → runChat with the recipe's tool allowlist
// If the recipe declares response.json_schema, the runner asks for JSON and best-
// effort parses it into `structured`. Every run also emits a `recipe_run` artifact
// so the chat/Recipe Studio can show what was run with which parameters.

import { runChat } from '../chat.js';
import { runSwarm } from '../agents/orchestrator.js';
import { runDeepResearch, type ResearchDepth } from '../research/deepResearch.js';
import { resolveTools, type ToolContext } from '../tools/registry.js';
import { TEXT_FALLBACK } from '../autoRouter.js';
import { spentUsageOf } from '../usage.js';
import { safeClientMessage } from '../providers/errors.js';
import { coerceJsonOrNull } from '../jsonCoerce.js';
import { withAgentPersona } from '../persona.js';
import type { ChatMessage, AIProviderId } from '../providers/types.js';
import type {
  ChatArtifact,
  ChatClientContext,
  ChatCitation,
  ChatToolEvent,
  ChatToolImage,
  CapabilityNotice,
  ApiUsage
} from '../../../../apiTypes.js';
import { resolveRecipe } from './validate.js';
import type { Recipe } from './schema.js';

export interface RunRecipeParams {
  recipe: Recipe;
  /** Caller-supplied parameter values (coerced + defaulted by resolveRecipe). */
  values?: Record<string, unknown>;
  provider: AIProviderId;
  apiKey: string;
  /**
   * Model for the answer/synthesis — already resolved, checked and priced by the caller. A
   * recipe's own `settings.model` pin is resolved by the route (routes/recipes.ts makes it the
   * requested model before prepareChat), never here: the runner only ever calls this model.
   */
  model: string;
  /** Prior conversation, if running a recipe inside an existing chat. */
  priorMessages?: ChatMessage[];
  /** Durable user memory/persona to thread through the run. */
  systemPrompt?: string;
  clientContext?: ChatClientContext;
  fallbackModel?: string;
  /**
   * Free-only (X-Free-Only): the run is offered no paid retry in any engine — no `fallbackModel`,
   * `freeOnly` on every provider request, and a free planner/agents pick (RunSwarmParams.noPaidRetry).
   */
  noPaidRetry?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (delta: { content?: string; reasoning?: string }) => void;
  onProgress?: (trace: unknown) => void;
}

export interface RecipeRunArtifactData {
  recipeId?: string;
  title: string;
  description?: string;
  params: { key: string; value: string }[];
  mode: 'swarm' | 'agent';
  status: 'done' | 'error';
  structured?: unknown;
  activities?: string[];
}

export interface RunRecipeResult {
  recipeId?: string;
  title: string;
  /** Required params the caller did not supply (run did not execute). */
  missing: string[];
  text: string;
  model: string;
  reasoning?: string;
  citations?: ChatCitation[];
  toolEvents?: ChatToolEvent[];
  images?: ChatToolImage[];
  artifacts: ChatArtifact[];
  notices?: CapabilityNotice[];
  usage: ApiUsage;
  /** Parsed structured output when the recipe declared response.json_schema. */
  structured?: unknown;
  /** Suggested follow-ups (templated). */
  activities: string[];
}

const toolCtxFrom = (ctx?: ChatClientContext): ToolContext | undefined =>
  ctx ? { timezone: ctx.timezone, locale: ctx.locale, units: ctx.units, location: ctx.location } : undefined;

const jsonDirective = (schema: Record<string, unknown>): string =>
  `\n\nIMPORTANT — return your final answer as a single JSON object that conforms to this JSON Schema, with no prose or code fences around it:\n${JSON.stringify(schema)}`;

export const runRecipe = async (params: RunRecipeParams): Promise<RunRecipeResult> => {
  const { recipe } = params;
  const resolution = resolveRecipe(recipe, params.values || {});
  if (resolution.missing.length || !resolution.resolved) {
    return {
      recipeId: recipe.id,
      title: recipe.title,
      missing: resolution.missing,
      text: '',
      model: params.model,
      artifacts: [],
      usage: {},
      activities: []
    };
  }
  const r = resolution.resolved;
  const wantsJson = Boolean(recipe.response?.json_schema);
  // Never recipe.settings.model: an unchecked pin here would run a model nobody priced (S11).
  const model = params.model;
  const temperature = recipe.settings?.temperature;
  const userMemory = params.systemPrompt?.trim();
  // Free-only: no engine gets the paid retry (each one also sends `freeOnly` to the provider).
  const freeOnly = params.noPaidRetry === true;
  const fallbackModel = freeOnly ? undefined : params.fallbackModel || TEXT_FALLBACK;
  const retry = { fallbackModel, ...(freeOnly ? { noPaidRetry: true } : {}) };

  // Effective kickoff message: the templated prompt, or — if the recipe is
  // instructions-only — a minimal nudge so the agent acts on the instructions.
  const kickoff = r.prompt || 'Carry out the task exactly as instructed above.';
  const paramSummary: RecipeRunArtifactData['params'] = Object.entries(r.values).map(([key, value]) => ({
    key,
    value: String(value).slice(0, 200)
  }));

  const baseArtifact = (status: 'done' | 'error', structured?: unknown, mode: 'swarm' | 'agent' = recipe.swarm ? 'swarm' : 'agent'): ChatArtifact => ({
    type: 'recipe_run',
    data: {
      recipeId: recipe.id,
      title: recipe.title,
      description: recipe.description,
      params: paramSummary,
      mode,
      status,
      structured,
      activities: r.activities
    } satisfies RecipeRunArtifactData
  });

  try {
    // ── Deep research ────────────────────────────────────────────────────────
    // The /research, /deepresearch and /science skills run a dedicated iterative,
    // citation-grounded engine (plan → parallel search → gap-fill → grounded synth)
    // instead of the shallow two-agent swarm pass.
    if (recipe.id === 'deep-research-brief') {
      const depthRaw = String(r.values.depth ?? 'standard');
      const depth: ResearchDepth = depthRaw === 'quick' || depthRaw === 'exhaustive' ? depthRaw : 'standard';
      const res = await runDeepResearch({
        topic: String(r.values.topic ?? '').trim(),
        audience: r.values.audience ? String(r.values.audience) : undefined,
        depth,
        provider: params.provider,
        apiKey: params.apiKey,
        model,
        priorMessages: params.priorMessages,
        systemPrompt: userMemory,
        ...retry,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        onDelta: params.onDelta,
        onProgress: params.onProgress ? (t) => params.onProgress?.(t) : undefined
      });
      return {
        recipeId: recipe.id,
        title: recipe.title,
        missing: [],
        text: res.text,
        model: res.model,
        citations: res.citations,
        toolEvents: res.toolEvents,
        artifacts: [
          { type: 'research_report', data: res.report },
          { type: 'swarm_trace', data: res.trace },
          baseArtifact('done')
        ],
        notices: res.notices,
        usage: res.usage,
        activities: r.activities
      };
    }

    // ── Swarm recipes ────────────────────────────────────────────────────────
    if (recipe.swarm) {
      // Instructions steer every agent + synthesis; merge with durable user memory.
      const swarmSystem = [r.instructions, userMemory].filter(Boolean).join('\n\n');
      const messages: ChatMessage[] = [...(params.priorMessages || []), { role: 'user', content: kickoff }];
      const res = await runSwarm({
        provider: params.provider,
        apiKey: params.apiKey,
        model,
        messages,
        systemPrompt: swarmSystem || undefined,
        clientContext: params.clientContext,
        ...retry,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        onDelta: params.onDelta,
        onProgress: params.onProgress ? (t) => params.onProgress?.(t) : undefined
      });
      const structured = wantsJson ? coerceJsonOrNull(res.text) ?? undefined : undefined;
      return {
        recipeId: recipe.id,
        title: recipe.title,
        missing: [],
        text: res.text,
        model: res.model,
        reasoning: res.reasoning,
        citations: res.citations,
        toolEvents: res.toolEvents,
        images: res.images,
        artifacts: [baseArtifact('done', structured), ...res.artifacts],
        notices: res.notices,
        usage: res.usage,
        structured,
        activities: r.activities
      };
    }

    // ── Single-agent recipes ─────────────────────────────────────────────────
    // For JSON recipes use the raw instructions + a strict JSON directive (no brand
    // persona, which would add markdown). Otherwise wrap in the shared brand voice.
    const baseInstructions = wantsJson ? r.instructions : withAgentPersona(r.instructions || recipe.description);
    const systemOverride =
      (wantsJson && recipe.response?.json_schema ? baseInstructions + jsonDirective(recipe.response.json_schema) : baseInstructions) +
      (userMemory ? `\n\nUser context / preferences:\n${userMemory}` : '');

    const messages: ChatMessage[] = [...(params.priorMessages || []), { role: 'user', content: kickoff }];
    const res = await runChat({
      provider: params.provider,
      apiKey: params.apiKey,
      model,
      messages,
      systemOverride,
      clientContext: params.clientContext,
      tools: resolveTools(recipe.tools, toolCtxFrom(params.clientContext)),
      temperature,
      maxTokens: 3072,
      ...retry,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      onDelta: params.onDelta
    });
    const structured = wantsJson ? coerceJsonOrNull(res.text) ?? undefined : undefined;
    return {
      recipeId: recipe.id,
      title: recipe.title,
      missing: [],
      text: res.text,
      model: res.model || model,
      reasoning: res.reasoning,
      citations: res.citations,
      toolEvents: res.toolEvents,
      images: res.images,
      artifacts: [baseArtifact('done', structured), ...(res.artifacts || [])],
      notices: res.notices,
      usage: res.usage,
      structured,
      activities: r.activities
    };
  } catch (err) {
    return {
      recipeId: recipe.id,
      title: recipe.title,
      missing: [],
      // A calm sentence, never the raw provider/engine error.
      text: `The recipe "${recipe.title}" couldn't finish. ${safeClientMessage(err, 'Please try again in a moment.')}`,
      model,
      artifacts: [baseArtifact('error')],
      // What the failed run had already spent still settles (S9); nothing spent → nothing billed.
      usage: spentUsageOf(err) ?? {},
      activities: r.activities
    };
  }
};
