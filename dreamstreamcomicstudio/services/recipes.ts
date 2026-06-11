// Client API for the recipe library (the native goose-recipe port). Thin wrappers
// over /api/recipes using the shared apiClient. The server is the source of truth and
// re-sanitizes everything; these helpers just type the round-trips.

import { get, post, del, postStream } from './apiClient';
import { readSSEStream } from './sse';
import type { RecipeCardArtifact, ChatArtifact, ChatCitation, ChatToolEvent, ChatToolImage, CapabilityNotice, ChatRequestMessage } from '../apiTypes';

/** A stored recipe as returned by the API (recipe fields + storage metadata). */
export interface StoredRecipe extends RecipeCardArtifact {
  slug?: string;
  isPublic?: boolean;
  updatedAt?: string;
}

export interface RecipeLibrary {
  builtins: StoredRecipe[];
  custom: StoredRecipe[];
}

export const listRecipes = (): Promise<RecipeLibrary> => get<RecipeLibrary>('/api/recipes');

export const getRecipe = (slug: string): Promise<{ recipe: StoredRecipe }> =>
  get<{ recipe: StoredRecipe }>(`/api/recipes/${encodeURIComponent(slug)}`);

export const saveRecipe = (recipe: RecipeCardArtifact, isPublic = false): Promise<{ recipe: StoredRecipe }> =>
  post<{ recipe: RecipeCardArtifact; isPublic: boolean }, { recipe: StoredRecipe }>('/api/recipes', { recipe, isPublic });

export const deleteRecipe = (slug: string): Promise<{ deleted: boolean }> =>
  del<{ deleted: boolean }>(`/api/recipes/${encodeURIComponent(slug)}`);

export interface ValidateResult {
  valid: boolean;
  recipe?: RecipeCardArtifact;
  missing?: string[];
  errors?: string[];
}

export const validateRecipe = (recipe: RecipeCardArtifact, values?: Record<string, unknown>): Promise<ValidateResult> =>
  post<{ recipe: RecipeCardArtifact; values?: Record<string, unknown> }, ValidateResult>('/api/recipes/validate', { recipe, values });

export interface RunRecipeRequest {
  recipeId?: string;
  recipe?: RecipeCardArtifact;
  values?: Record<string, unknown>;
  /** A placeholder message is required by the chat pipeline; defaults are added below. */
  messages?: ChatRequestMessage[];
  model?: string;
  source?: string;
  systemPrompt?: string;
}

/**
 * Run a recipe and return the raw SSE Response to stream (event: meta|delta|trace|
 * reasoning|final|error). Adds a placeholder user message so prepareChat accepts it.
 */
export const runRecipeStream = (req: RunRecipeRequest, signal?: AbortSignal): Promise<Response> => {
  const body: RunRecipeRequest = {
    ...req,
    messages: req.messages && req.messages.length ? req.messages : [{ role: 'user', content: `Run recipe ${req.recipeId || req.recipe?.title || ''}`.trim() }]
  };
  return postStream<RunRecipeRequest>('/api/recipes/run', body, { signal });
};

export interface DistillResult {
  score?: number;
  justification?: string;
  learnings: string[];
  proposedRecipe?: RecipeCardArtifact;
}

export interface RecipeRunOutcome {
  text: string;
  model?: string;
  citations?: ChatCitation[];
  toolEvents?: ChatToolEvent[];
  images?: ChatToolImage[];
  notices?: CapabilityNotice[];
  artifacts?: ChatArtifact[];
  structured?: unknown;
  activities?: string[];
  error?: string;
}

/**
 * Run a recipe and consume the SSE stream, accumulating the answer and surfacing the
 * final artifacts/structured output. `onDelta` streams text as it arrives; `onTrace`
 * receives live swarm progress.
 */
export const runRecipe = async (
  req: RunRecipeRequest,
  handlers: { onDelta?: (chunk: string) => void; onTrace?: (trace: unknown) => void } = {},
  signal?: AbortSignal
): Promise<RecipeRunOutcome> => {
  const res = await runRecipeStream(req, signal);
  let text = '';
  let error: string | undefined;
  let final: {
    text?: string;
    model?: string;
    citations?: ChatCitation[];
    toolEvents?: ChatToolEvent[];
    images?: ChatToolImage[];
    notices?: CapabilityNotice[];
    artifacts?: ChatArtifact[];
    structured?: unknown;
    activities?: string[];
  } | null = null;

  await readSSEStream(res.body, ({ event, data }) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === 'delta' && typeof parsed.content === 'string') {
      text += parsed.content;
      handlers.onDelta?.(parsed.content);
    } else if (event === 'trace') {
      handlers.onTrace?.(parsed);
    } else if (event === 'final') {
      final = parsed as typeof final;
    } else if (event === 'error') {
      error = typeof parsed.message === 'string' ? parsed.message : 'The recipe failed.';
    }
  });

  if (final) {
    return {
      text: typeof final.text === 'string' && final.text ? final.text : text,
      model: final.model,
      citations: final.citations,
      toolEvents: final.toolEvents,
      images: final.images,
      notices: final.notices,
      artifacts: final.artifacts,
      structured: final.structured,
      activities: final.activities,
      error
    };
  }
  return { text, error };
};

/** Reflect on a completed run → score + learnings + a proposed reusable recipe. */
export const distillRun = (goal: string, transcript: string, model?: string): Promise<DistillResult> =>
  post<{ goal: string; transcript: string; messages: { role: 'user'; content: string }[]; model?: string }, DistillResult>(
    '/api/recipes/distill',
    { goal, transcript, messages: [{ role: 'user', content: goal }], model }
  );
