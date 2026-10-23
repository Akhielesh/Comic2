// Recipe library API — CRUD over a user's saved recipes, a read-only view of the
// built-ins, validation, a streaming run endpoint, and the self-improvement "distill"
// endpoint. Mounted under requireAuth (`/api/recipes`).
//
// Provider/model resolution and billing reuse prepareChat + the usage enforcer from
// the chat route, so a recipe run is metered and gated exactly like a normal chat.

import { Router } from 'express';
import { catalogHoldFloorUsd, chatPricedModels, preparedInputTokens, prepareChat, settleSpentOrRelease } from './chat.js';
import { safeClientMessage } from '../ai/providers/errors.js';
import { TEXT_FALLBACK } from '../ai/autoRouter.js';
import { TEXT_REQUEST_TIMEOUT_MS } from '../config.js';
import { BUILTIN_RECIPES, getBuiltinRecipe } from '../ai/recipes/library.js';
import { sanitizeRecipe, resolveRecipe } from '../ai/recipes/validate.js';
import { runRecipe } from '../ai/recipes/runRecipe.js';
import { distillRecipe } from '../ai/recipes/learning.js';
import { listRecipes, getRecipe, saveRecipe, deleteRecipe } from '../services/recipes.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';

export const recipesRouter = Router();

const builtinSummaries = BUILTIN_RECIPES.map((r) => ({ ...r, builtin: true as const }));

// GET /api/recipes — built-ins + the user's saved recipes.
recipesRouter.get('/', async (req, res, next) => {
  try {
    const custom = await listRecipes(req.user!.id).catch(() => []);
    res.json({ builtins: builtinSummaries, custom });
  } catch (err) {
    next(err);
  }
});

// GET /api/recipes/:slug — a single recipe (built-in or the user's own).
recipesRouter.get('/:slug', async (req, res, next) => {
  try {
    const slug = req.params.slug;
    const builtin = getBuiltinRecipe(slug);
    if (builtin) return res.json({ recipe: { ...builtin, builtin: true } });
    const mine = await getRecipe(req.user!.id, slug).catch(() => null);
    if (!mine) return res.status(404).json({ error: { message: 'Recipe not found.' } });
    res.json({ recipe: mine });
  } catch (err) {
    next(err);
  }
});

// POST /api/recipes — create or update a recipe (sanitized server-side).
recipesRouter.post('/', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Record<string, unknown>;
    const saved = await saveRecipe(req.user!.id, body.recipe ?? body, { isPublic: body.isPublic === true });
    if (!saved) {
      return res
        .status(400)
        .json({ error: { message: 'A recipe needs a title and at least instructions or a prompt.', code: 'RECIPE_INVALID' } });
    }
    res.json({ recipe: saved });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/recipes/:slug
recipesRouter.delete('/:slug', async (req, res, next) => {
  try {
    const ok = await deleteRecipe(req.user!.id, req.params.slug).catch(() => false);
    if (!ok) return res.status(404).json({ error: { message: 'Recipe not found.' } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/recipes/validate — sanitize + (optionally) check that supplied values
// satisfy the required params, without running anything.
recipesRouter.post('/validate', (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const recipe = sanitizeRecipe(body.recipe ?? body);
  if (!recipe) {
    return res.json({ valid: false, errors: ['A recipe needs a title and at least instructions or a prompt.'] });
  }
  const { missing } = resolveRecipe(recipe, (body.values as Record<string, unknown>) || {});
  res.json({ valid: true, recipe, missing });
});

const resolveTargetRecipe = async (req: any) => {
  const body = (req.body || {}) as Record<string, unknown>;
  if (typeof body.recipeId === 'string' && body.recipeId) {
    return getBuiltinRecipe(body.recipeId) || (await getRecipe(req.user!.id, body.recipeId).catch(() => null));
  }
  return sanitizeRecipe(body.recipe);
};

/**
 * `req` as prepareChat should see it when a recipe pins its own model: the pin becomes the
 * requested model (body.model). Everything else (headers, user, keys, path) reads through to the
 * real request; prepareChat writes nothing back.
 */
const withPinnedModel = (req: any, model: string): any => {
  const view = Object.create(req);
  view.body = { ...(req.body || {}), model };
  return view;
};

/** The answer size a recipe hold assumes (runRecipe's single-agent maxTokens). */
const RECIPE_HOLD_OUTPUT_TOKENS = 3_072;

// POST /api/recipes/run — run a recipe and stream the answer (SSE), exactly like the
// swarm route. Body: { recipeId | recipe, values, model?, source?, messages?, ... }.
recipesRouter.post('/run', async (req, res, next) => {
  let recipe: NonNullable<Awaited<ReturnType<typeof resolveTargetRecipe>>>;
  let values: Record<string, unknown>;
  let p: Extract<Awaited<ReturnType<typeof prepareChat>>, { prepared: unknown }>['prepared'];
  let reserve: Awaited<ReturnType<typeof reserveForOperation>> | null;
  try {
    // The recipe first (S11): a recipe that pins a model (settings.model) makes that pin the
    // REQUESTED model, so prepareChat applies exactly what a model picked in chat gets — the
    // chat-capability check, the plan policy and the [pin, paid net] chain — and the hold below
    // prices it. runRecipe then runs p.model and nothing else: never a model the route did not
    // resolve, check and price.
    const target = await resolveTargetRecipe(req);
    if (!target) {
      return res.status(400).json({ error: { message: 'Provide a valid recipeId or recipe.', code: 'RECIPE_NOT_FOUND' } });
    }
    recipe = target;
    const pinned = typeof recipe.settings?.model === 'string' ? recipe.settings.model.trim() : '';

    const prep = await prepareChat(pinned ? withPinnedModel(req, pinned) : req);
    if ('error' in prep) return res.status(prep.error.status).json(prep.error.body);
    p = prep.prepared;

    if (p.resolved.provider !== 'openrouter') {
      return res.status(400).json({
        error: { message: 'Recipes run on OpenRouter (agents + tools need function calling).', code: 'RECIPE_REQUIRES_OPENROUTER' }
      });
    }

    values = ((req.body || {}).values as Record<string, unknown>) || {};

    // Fail fast on missing required params so the client can prompt for them.
    const probe = resolveRecipe(recipe, values);
    if (probe.missing.length) {
      return res.status(422).json({ error: { message: `Missing required parameters: ${probe.missing.join(', ')}`, code: 'RECIPE_MISSING_PARAMS', missing: probe.missing } });
    }

    // Sized from what the run sends (history + the recipe's own text; the recipe brings its own
    // tools) and floored at the live catalog price of every model it may be billed for (S9).
    const recipeChars = (recipe.instructions?.length || 0) + (recipe.prompt?.length || 0) + JSON.stringify(values).length;
    const inputTokens = preparedInputTokens({ ...p, tools: [] }, recipeChars);
    const priced = chatPricedModels(p);
    const floorUsd = await catalogHoldFloorUsd([p.model, ...(priced || [])], inputTokens, RECIPE_HOLD_OUTPUT_TOKENS);
    reserve = req.user?.id
      ? await reserveForOperation({
          req,
          operation: 'chat.completion',
          fallbackModel: p.model,
          // Price the hold at every model the run may be billed for (a `:free` primary keeps the
          // paid TEXT_FALLBACK retry): an exhausted governed user must never pass at $0.
          pricedModels: chatPricedModels(p),
          inputTokens,
          outputTokens: RECIPE_HOLD_OUTPUT_TOKENS,
          ...(floorUsd ? { estimateFloorUsd: floorUsd } : {}),
          provider: p.resolved.provider,
          stage: 'chat',
          metadata: { route: req.path, model: p.model, recipe: recipe.id }
        })
      : null;
    if (reserve && 'details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }
  } catch (err) {
    // Nothing streamed or spent yet. Express 4 doesn't catch an async throw — answer instead of hanging.
    return next(err);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('meta', { model: p.model, recipe: { id: recipe.id, title: recipe.title }, source: p.resolved.provider });

  try {
    const result = await runRecipe({
      recipe,
      values,
      provider: p.resolved.provider,
      apiKey: p.resolved.apiKey,
      model: p.model,
      priorMessages: p.messages.slice(0, -1),
      systemPrompt: p.systemPrompt,
      clientContext: p.clientContext,
      fallbackModel: TEXT_FALLBACK,
      timeoutMs: TEXT_REQUEST_TIMEOUT_MS,
      onDelta: (d) => {
        if (d.content) send('delta', { content: d.content });
        else if (d.reasoning) send('reasoning', { reasoning: d.reasoning });
      },
      onProgress: (trace) => send('trace', trace)
    });

    const settled =
      reserve && reserve.allowed
        ? await settleReservedOperation({
            req,
            operation: 'chat.completion',
            provider: p.resolved.provider,
            model: result.model,
            seed: { provider: p.resolved.provider, model: result.model, operation: 'chat.completion', stage: 'chat', byok: reserve.reservation.byokBypass },
            usage: result.usage,
            metadata: { route: req.path, recipe: recipe.id }
          })
        : null;

    const payload: Record<string, unknown> = {
      text: result.text,
      model: result.model,
      source: p.resolved.provider,
      reasoning: result.reasoning,
      citations: result.citations,
      toolEvents: result.toolEvents,
      images: result.images,
      artifacts: result.artifacts,
      notices: result.notices,
      structured: result.structured,
      activities: result.activities,
      usage: result.usage
    };
    const finalPayload =
      reserve && reserve.allowed ? attachBillingToPayload(payload, reserve.reservation, settled) : payload;
    send('final', finalPayload);
    res.end();
  } catch (error) {
    if (reserve && reserve.allowed) {
      await settleSpentOrRelease({
        req,
        error,
        operation: 'chat.completion',
        provider: p.resolved.provider,
        model: p.model,
        byok: reserve.reservation.byokBypass,
        reason: 'recipe_run_failed',
        metadata: { route: req.path, recipe: recipe.id }
      }).catch(() => undefined);
    }
    send('error', { message: safeClientMessage(error, 'The recipe failed. Please try again.') });
    res.end();
  }
});

// POST /api/recipes/distill — reflect on a completed run and distill a score +
// learnings + an optional reusable recipe. Body: { goal, transcript, messages?, ... }.
recipesRouter.post('/distill', async (req, res, next) => {
  let p: Extract<Awaited<ReturnType<typeof prepareChat>>, { prepared: unknown }>['prepared'];
  let goal: string;
  let transcript: string;
  let reserve: Awaited<ReturnType<typeof reserveForOperation>> | null;
  try {
    const prep = await prepareChat(req);
    if ('error' in prep) return res.status(prep.error.status).json(prep.error.body);
    p = prep.prepared;
    if (p.resolved.provider !== 'openrouter') {
      return res.status(400).json({ error: { message: 'Distillation runs on OpenRouter.', code: 'RECIPE_REQUIRES_OPENROUTER' } });
    }

    const body = (req.body || {}) as Record<string, unknown>;
    goal = typeof body.goal === 'string' ? body.goal : '';
    transcript = typeof body.transcript === 'string' ? body.transcript : '';
    if (!goal || !transcript) {
      return res.status(400).json({ error: { message: 'distill needs a goal and a transcript.', code: 'DISTILL_INVALID' } });
    }

    // Sized from what the reflection sends (the goal + the transcript, which distillRecipe caps
    // at 12,000 characters) and floored at the live catalog price (S9).
    const inputTokens = preparedInputTokens({ ...p, tools: [] }, goal.length + Math.min(transcript.length, 12_000));
    const priced = chatPricedModels(p);
    const floorUsd = await catalogHoldFloorUsd([p.model, ...(priced || [])], inputTokens, RECIPE_HOLD_OUTPUT_TOKENS);
    reserve = req.user?.id
      ? await reserveForOperation({
          req,
          operation: 'chat.completion',
          fallbackModel: p.model,
          pricedModels: chatPricedModels(p),
          inputTokens,
          outputTokens: RECIPE_HOLD_OUTPUT_TOKENS,
          ...(floorUsd ? { estimateFloorUsd: floorUsd } : {}),
          provider: p.resolved.provider,
          stage: 'chat',
          metadata: { route: req.path, model: p.model, distill: true }
        })
      : null;
    if (reserve && 'details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }
  } catch (err) {
    return next(err);
  }

  try {
    const result = await distillRecipe({
      goal,
      transcript,
      provider: p.resolved.provider,
      apiKey: p.resolved.apiKey,
      model: p.model,
      clientContext: p.clientContext,
      fallbackModel: TEXT_FALLBACK,
      timeoutMs: TEXT_REQUEST_TIMEOUT_MS
    });

    if (reserve && reserve.allowed) {
      await settleReservedOperation({
        req,
        operation: 'chat.completion',
        provider: p.resolved.provider,
        model: p.model,
        seed: { provider: p.resolved.provider, model: p.model, operation: 'chat.completion', stage: 'chat', byok: reserve.reservation.byokBypass },
        usage: result.usage,
        metadata: { route: req.path, distill: true }
      });
    }

    res.json({
      score: result.score,
      justification: result.justification,
      learnings: result.learnings,
      proposedRecipe: result.proposedRecipe
    });
  } catch (error) {
    if (reserve && reserve.allowed) {
      await settleSpentOrRelease({
        req,
        error,
        operation: 'chat.completion',
        provider: p.resolved.provider,
        model: p.model,
        byok: reserve.reservation.byokBypass,
        reason: 'distill_failed',
        metadata: { route: req.path, distill: true }
      }).catch(() => undefined);
    }
    res.status(500).json({ error: { message: safeClientMessage(error, 'Distillation failed. Please try again.') } });
  }
});
