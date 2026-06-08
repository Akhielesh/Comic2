// Autopilot control plane — /api/ventures/* (Railway/Express). Epic A1.
//
// Mounted AFTER the global requireAuth, so req.user is always present. The whole surface is
// gated: usable only when VENTURES_ENABLED is true OR the caller is an admin (so the owner
// can pilot it before GA). Reads are owner-isolated by RLS; writes go through the
// service-role repository which scopes every query by user_id. No autonomous work runs here —
// this is CRUD + the human controls (budgets, checkpoints, kill switch).

import { Router, type Request, type Response, type NextFunction } from 'express';
import { VENTURES_ENABLED, VENTURES_DEFAULT_USD_PER_DAY, VENTURES_DEFAULT_USD_TOTAL } from '../config.js';
import { hydrateAccessProfile, requireAdmin } from '../middleware/requireAdmin.js';
import {
  createVenture,
  getVenture,
  listVentures,
  setVentureStatus,
  getBudget,
  upsertBudget,
  createCheckpoint,
  listOpenCheckpoints,
  resolveCheckpointRow,
  listEvents
} from '../ventures/repository.js';
import { createGoal, createGoals, listGoals, listConnections } from '../ventures/controlPlane.js';
import { runIntake } from '../ventures/intake.js';
import { studioStageComplete } from './studio.js';
import { getKillSwitch, setKillSwitch } from '../ventures/killSwitch.js';
import { budgetAlertLevel } from '../ventures/budget.js';
import {
  parseCreateVenture,
  parseCreateGoal,
  parseBudget,
  parseStatusChange,
  parseCheckpointDecision
} from '../ventures/validate.js';

export const venturesRouter = Router();

const badRequest = (res: Response, message: string) =>
  res.status(400).json({ error: { message } });
const notFound = (res: Response) =>
  res.status(404).json({ error: { message: 'Venture not found.' } });
const serverError = (res: Response, e: unknown) =>
  res.status(500).json({ error: { message: e instanceof Error ? e.message : String(e) } });

// Gate: allow when the feature flag is on, otherwise admins only (private pilot).
const ventureGate = async (req: Request, res: Response, next: NextFunction) => {
  if (VENTURES_ENABLED) return next();
  const profile = await hydrateAccessProfile(req);
  if (profile.isAdmin) return next();
  res.status(503).json({
    error: { message: 'Autopilot is not enabled yet.', code: 'VENTURES_DISABLED' }
  });
};
venturesRouter.use(ventureGate);

// --- Admin: global kill switch (registered before /:id so it never collides) -------------
venturesRouter.get('/admin/kill', requireAdmin, (_req, res) => {
  res.json({ killed: getKillSwitch() });
});
venturesRouter.post('/admin/kill', requireAdmin, (req, res) => {
  const on = (req.body || {}).on;
  if (typeof on !== 'boolean') return badRequest(res, "Body must be { on: boolean }.");
  setKillSwitch(on);
  res.json({ killed: getKillSwitch() });
});

// --- Ventures -------------------------------------------------------------------------
venturesRouter.get('/', async (req, res) => {
  try {
    res.json({ ventures: await listVentures(req.user!.id) });
  } catch (e) {
    serverError(res, e);
  }
});

venturesRouter.post('/', async (req, res) => {
  const parsed = parseCreateVenture(req.body);
  if (!parsed.valid) return badRequest(res, parsed.error as string);
  try {
    const { id } = await createVenture({ userId: req.user!.id, ...parsed.value! });
    // Seed a default budget so the brakes apply from the first tick.
    await upsertBudget({
      userId: req.user!.id,
      ventureId: id,
      usdPerDay: VENTURES_DEFAULT_USD_PER_DAY,
      usdTotal: VENTURES_DEFAULT_USD_TOTAL
    });
    res.status(201).json({ id });
  } catch (e) {
    serverError(res, e);
  }
});

// --- Intake → roadmap (A3) -----------------------------------------------------------
venturesRouter.post('/intake', async (req, res) => {
  const idea = typeof (req.body || {}).idea === 'string' ? (req.body as { idea: string }).idea.trim() : '';
  if (!idea) return badRequest(res, 'An "idea" describing the product is required.');
  if (idea.length > 8000) return badRequest(res, 'idea must be <= 8000 characters.');
  try {
    const complete = await studioStageComplete(req as never, (req.body || {}) as never, 2500);
    if (!complete) {
      return res.status(400).json({
        error: { message: 'No model key configured (add an OpenRouter or NVIDIA key in Settings).', code: 'NO_MODEL_KEY' }
      });
    }
    const roadmap = await runIntake(idea, complete);
    if (!roadmap) {
      return res.status(502).json({
        error: { message: 'Could not draft a roadmap. Try rephrasing the idea.', code: 'VENTURE_INTAKE_INVALID' }
      });
    }
    const { id } = await createVenture({
      userId: req.user!.id,
      name: roadmap.name,
      summary: roadmap.summary,
      scope: roadmap.scope
    });
    await upsertBudget({
      userId: req.user!.id,
      ventureId: id,
      usdPerDay: VENTURES_DEFAULT_USD_PER_DAY,
      usdTotal: VENTURES_DEFAULT_USD_TOTAL
    });
    await createGoals({ userId: req.user!.id, ventureId: id, goals: roadmap.goals });
    await setVentureStatus(req.user!.id, id, 'roadmap_pending');
    // Gate: the roadmap must be approved (checkpoint) before the loop works it.
    await createCheckpoint({
      userId: req.user!.id,
      ventureId: id,
      kind: 'roadmap_approval',
      title: `Approve the roadmap for "${roadmap.name}"`,
      detail: `${roadmap.goals.length} goals proposed.`
    });
    res.status(201).json({ id, roadmap });
  } catch (e) {
    serverError(res, e);
  }
});

// POST /:id/approve-roadmap — approve the roadmap checkpoint(s) + activate the venture (A3/A0).
venturesRouter.post('/:id/approve-roadmap', async (req, res) => {
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    const open = (await listOpenCheckpoints(req.user!.id, req.params.id)).filter((c) => c.kind === 'roadmap_approval');
    for (const c of open) {
      await resolveCheckpointRow(req.user!.id, c.id, { to: 'approved', resolvedBy: req.user!.id });
    }
    await setVentureStatus(req.user!.id, req.params.id, 'active');
    res.json({ ok: true, status: 'active', approved: open.length });
  } catch (e) {
    serverError(res, e);
  }
});

venturesRouter.get('/:id', async (req, res) => {
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    const budgetState = await getBudget(req.user!.id, req.params.id);
    const openCheckpoints = await listOpenCheckpoints(req.user!.id, req.params.id);
    const alert = budgetState ? budgetAlertLevel(budgetState.spend, budgetState.budget) : 'ok';
    res.json({ venture, budget: budgetState, budgetAlert: alert, openCheckpoints });
  } catch (e) {
    serverError(res, e);
  }
});

venturesRouter.patch('/:id/status', async (req, res) => {
  const parsed = parseStatusChange(req.body);
  if (!parsed.valid) return badRequest(res, parsed.error as string);
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    const pauseReason = parsed.value === 'paused' ? 'manual' : null;
    await setVentureStatus(req.user!.id, req.params.id, parsed.value!, pauseReason);
    res.json({ ok: true, status: parsed.value });
  } catch (e) {
    serverError(res, e);
  }
});

// --- Goals ----------------------------------------------------------------------------
venturesRouter.get('/:id/goals', async (req, res) => {
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    res.json({ goals: await listGoals(req.user!.id, req.params.id) });
  } catch (e) {
    serverError(res, e);
  }
});

venturesRouter.post('/:id/goals', async (req, res) => {
  const parsed = parseCreateGoal(req.body);
  if (!parsed.valid) return badRequest(res, parsed.error as string);
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    const { id } = await createGoal({ userId: req.user!.id, ventureId: req.params.id, ...parsed.value! });
    res.status(201).json({ id });
  } catch (e) {
    serverError(res, e);
  }
});

// --- Budget ---------------------------------------------------------------------------
venturesRouter.get('/:id/budget', async (req, res) => {
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    res.json({ budget: await getBudget(req.user!.id, req.params.id) });
  } catch (e) {
    serverError(res, e);
  }
});

venturesRouter.put('/:id/budget', async (req, res) => {
  const parsed = parseBudget(req.body);
  if (!parsed.valid) return badRequest(res, parsed.error as string);
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    await upsertBudget({ userId: req.user!.id, ventureId: req.params.id, ...parsed.value! });
    res.json({ ok: true });
  } catch (e) {
    serverError(res, e);
  }
});

// --- Checkpoints ----------------------------------------------------------------------
venturesRouter.get('/:id/checkpoints', async (req, res) => {
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    res.json({ checkpoints: await listOpenCheckpoints(req.user!.id, req.params.id) });
  } catch (e) {
    serverError(res, e);
  }
});

venturesRouter.post('/:id/checkpoints/:checkpointId/resolve', async (req, res) => {
  const parsed = parseCheckpointDecision(req.body);
  if (!parsed.valid) return badRequest(res, parsed.error as string);
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    const done = await resolveCheckpointRow(req.user!.id, req.params.checkpointId, {
      to: parsed.value!,
      resolvedBy: req.user!.id
    });
    if (!done) return res.status(409).json({ error: { message: 'Checkpoint not found or already resolved.' } });
    res.json({ ok: true, status: parsed.value });
  } catch (e) {
    serverError(res, e);
  }
});

// --- Events + connections (read) ------------------------------------------------------
venturesRouter.get('/:id/events', async (req, res) => {
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    const limit = Number((req.query.limit as string) || '100');
    res.json({ events: await listEvents(req.user!.id, req.params.id, Number.isFinite(limit) ? limit : 100) });
  } catch (e) {
    serverError(res, e);
  }
});

venturesRouter.get('/:id/connections', async (req, res) => {
  try {
    const venture = await getVenture(req.user!.id, req.params.id);
    if (!venture) return notFound(res);
    res.json({ connections: await listConnections(req.user!.id, req.params.id) });
  } catch (e) {
    serverError(res, e);
  }
});
