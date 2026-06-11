import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every recipes call must hit the mounted server prefix (`/api/recipes...`).
// The client once used bare `/recipes/...` paths: in dev they were swallowed by the
// SPA, in prod they 404'd on the API host — which broke EVERY `/`-skill run
// (/goal, /code-review, /loop, …) with "Couldn't complete that. Not Found".
const calls: { fn: string; path: string; body?: unknown }[] = [];
vi.mock('./apiClient', () => {
  const record = (fn: string) => async (path: string, body?: unknown) => {
    calls.push({ fn, path, body });
    return fn === 'postStream' ? new Response(null) : {};
  };
  return { get: record('get'), post: record('post'), del: record('del'), postStream: record('postStream') };
});

import { listRecipes, getRecipe, saveRecipe, deleteRecipe, validateRecipe, runRecipeStream, distillRun } from './recipes';
import type { RecipeCardArtifact } from '../apiTypes';

const recipe = { title: 'T', instructions: 'I' } as RecipeCardArtifact;

describe('recipes client API paths', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('routes every endpoint under /api/recipes', async () => {
    await listRecipes();
    await getRecipe('my-slug');
    await saveRecipe(recipe);
    await deleteRecipe('my-slug');
    await validateRecipe(recipe);
    await runRecipeStream({ recipeId: 'goal-coach', values: { goal: 'x' } });
    await distillRun('goal', 'transcript');

    expect(calls.length).toBe(7);
    for (const { fn, path } of calls) {
      expect(path, `${fn}(${path}) must target the mounted /api/recipes prefix`).toMatch(/^\/api\/recipes(\/|$)/);
    }
  });

  it('adds a placeholder message to runRecipeStream when none is given', async () => {
    await runRecipeStream({ recipeId: 'goal-coach' });
    expect(calls[0].path).toBe('/api/recipes/run');
    const body = calls[0].body as { messages: { role: string; content: string }[] };
    expect(body.messages).toEqual([{ role: 'user', content: 'Run recipe goal-coach' }]);
  });
});
