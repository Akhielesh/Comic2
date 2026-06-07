// Exposes the recipe engine as chat tools, so ANY chat model (and every swarm agent)
// can run a saved recipe mid-conversation, or crystallize a good workflow into a new
// reusable recipe. This is the bridge that lets the agents actually USE — and grow —
// the recipe library, which is what "the agents improving themselves" means in practice.
//
// Kept in its own module (like swarmTool.ts) so the tool registry never imports the
// runner/orchestrator — avoids an import cycle.

import type { ChatTool } from '../tools/registry.js';
import type { AIProviderId, ChatMessage } from '../providers/types.js';
import type { ChatClientContext } from '../../../../apiTypes.js';
import { runRecipe } from './runRecipe.js';
import { sanitizeRecipe } from './validate.js';
import { getBuiltinRecipe, BUILTIN_RECIPES } from './library.js';
import { getRecipe, saveRecipe } from '../../services/recipes.js';

export interface RecipeToolContext {
  provider: AIProviderId;
  apiKey: string;
  model: string;
  messages?: ChatMessage[];
  systemPrompt?: string;
  clientContext?: ChatClientContext;
  userId?: string;
  /** The user's saved recipe slugs/titles, merged with built-ins for the tool description. */
  userRecipes?: { id: string; title: string; description: string }[];
  fallbackModel?: string;
  timeoutMs?: number;
}

export const RUN_RECIPE_TOOL = 'run_recipe';
export const SAVE_RECIPE_TOOL = 'save_recipe';

const asObject = (v: unknown): Record<string, unknown> => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
};

export const makeRecipeTools = (ctx: RecipeToolContext): ChatTool[] => {
  const available = [
    ...BUILTIN_RECIPES.map((r) => ({ id: r.id!, title: r.title, description: r.description })),
    ...(ctx.userRecipes || [])
  ];
  const catalog = available.map((r) => `  - ${r.id}: ${r.title} — ${r.description}`).join('\n');

  const runRecipeTool: ChatTool = {
    name: RUN_RECIPE_TOOL,
    description:
      'Run a saved RECIPE — a reusable, parameterized agent workflow — and return its result (answer + cards + sources). ' +
      'Use this when a task matches an existing recipe instead of improvising from scratch. Available recipes:\n' +
      catalog +
      '\nPass `values` for the recipe\'s parameters (e.g. {"topic":"…"}). Missing required parameters are reported back.',
    // NOTE: `values` is a JSON *string*, not an object-typed param. Strict providers
    // (Gemini family, OpenAI strict mode) reject an object param with no `properties`,
    // which fails the whole completion — so free-form dicts are passed as JSON text and
    // parsed by asObject().
    parameters: {
      type: 'object',
      properties: {
        recipe_id: { type: 'string', description: 'The id of the recipe to run (from the list above).' },
        values: { type: 'string', description: 'JSON object of parameter values, e.g. {"topic":"fusion energy"}.' }
      },
      required: ['recipe_id']
    },
    execute: async (args, signal) => {
      const id = String(args?.recipe_id || '').trim();
      if (!id) return { content: 'No recipe_id was provided.' };
      const recipe = getBuiltinRecipe(id) || (ctx.userId ? await getRecipe(ctx.userId, id).catch(() => null) : null);
      if (!recipe) return { content: `No recipe found with id "${id}". Available: ${available.map((r) => r.id).join(', ')}.` };

      const result = await runRecipe({
        recipe,
        values: asObject(args?.values),
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        model: ctx.model,
        priorMessages: ctx.messages,
        systemPrompt: ctx.systemPrompt,
        clientContext: ctx.clientContext,
        fallbackModel: ctx.fallbackModel,
        timeoutMs: ctx.timeoutMs,
        signal
      });

      if (result.missing.length) {
        return { content: `The recipe "${recipe.title}" needs these parameters: ${result.missing.join(', ')}. Ask the user for them, then call run_recipe again with values.` };
      }
      const content = `Ran recipe "${recipe.title}".\n\n${result.text || '(no answer)'}`;
      return { content, citations: result.citations, artifacts: result.artifacts };
    }
  };

  const saveRecipeTool: ChatTool = {
    name: SAVE_RECIPE_TOOL,
    description:
      'Save a new reusable RECIPE to the user\'s library so a good workflow can be re-run later (this is how the system improves itself). ' +
      'Provide a recipe object: { title, description, instructions (use {{parameter}} placeholders), prompt?, parameters?: [{key,input_type,requirement,description,default?}], tools?, agents?, swarm? }. ' +
      'At minimum a title plus instructions or a prompt are required.',
    parameters: {
      type: 'object',
      properties: {
        recipe: { type: 'string', description: 'The recipe to save as a JSON object string: {title, description, instructions, prompt?, parameters?, tools?, agents?, swarm?}.' }
      },
      required: ['recipe']
    },
    execute: async (args) => {
      if (!ctx.userId) return { content: 'Saving a recipe requires a signed-in user.' };
      const candidate = sanitizeRecipe(asObject(args?.recipe));
      if (!candidate) return { content: 'That recipe is invalid — it needs a title and at least instructions or a prompt.' };
      const saved = await saveRecipe(ctx.userId, candidate).catch(() => null);
      if (!saved) return { content: 'Could not save the recipe (storage unavailable).' };
      return {
        content: `Saved recipe "${saved.title}" as "${saved.slug}". It can now be run with run_recipe (recipe_id: ${saved.slug}).`,
        artifacts: [{ type: 'recipe_card', data: { ...saved, builtin: false } }]
      };
    }
  };

  return [runRecipeTool, saveRecipeTool];
};
