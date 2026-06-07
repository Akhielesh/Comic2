// Client API for the recipe library (the native goose-recipe port). Thin wrappers
// over /api/recipes using the shared apiClient. The server is the source of truth and
// re-sanitizes everything; these helpers just type the round-trips.

import { get, post, del, postStream } from './apiClient';
import type { RecipeCardArtifact } from '../apiTypes';

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

export const listRecipes = (): Promise<RecipeLibrary> => get<RecipeLibrary>('/recipes');

export const getRecipe = (slug: string): Promise<{ recipe: StoredRecipe }> =>
  get<{ recipe: StoredRecipe }>(`/recipes/${encodeURIComponent(slug)}`);

export const saveRecipe = (recipe: RecipeCardArtifact, isPublic = false): Promise<{ recipe: StoredRecipe }> =>
  post<{ recipe: RecipeCardArtifact; isPublic: boolean }, { recipe: StoredRecipe }>('/recipes', { recipe, isPublic });

export const deleteRecipe = (slug: string): Promise<{ deleted: boolean }> =>
  del<{ deleted: boolean }>(`/recipes/${encodeURIComponent(slug)}`);

export interface ValidateResult {
  valid: boolean;
  recipe?: RecipeCardArtifact;
  missing?: string[];
  errors?: string[];
}

export const validateRecipe = (recipe: RecipeCardArtifact, values?: Record<string, unknown>): Promise<ValidateResult> =>
  post<{ recipe: RecipeCardArtifact; values?: Record<string, unknown> }, ValidateResult>('/recipes/validate', { recipe, values });

export interface RunRecipeRequest {
  recipeId?: string;
  recipe?: RecipeCardArtifact;
  values?: Record<string, unknown>;
  /** A placeholder message is required by the chat pipeline; defaults are added below. */
  messages?: { role: 'user' | 'assistant'; content: string }[];
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
  return postStream<RunRecipeRequest>('/recipes/run', body, { signal });
};

export interface DistillResult {
  score?: number;
  justification?: string;
  learnings: string[];
  proposedRecipe?: RecipeCardArtifact;
}

/** Reflect on a completed run → score + learnings + a proposed reusable recipe. */
export const distillRun = (goal: string, transcript: string, model?: string): Promise<DistillResult> =>
  post<{ goal: string; transcript: string; messages: { role: 'user'; content: string }[]; model?: string }, DistillResult>(
    '/recipes/distill',
    { goal, transcript, messages: [{ role: 'user', content: goal }], model }
  );
