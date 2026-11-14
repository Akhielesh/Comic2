import { Router } from 'express';
import { createRateLimit } from '../middleware/rateLimit.js';
import { authenticateCatalogMaintenance, type CatalogMaintenanceAction } from '../services/catalogMaintenanceAuth.js';
import { refreshModelCatalog } from '../jobs/refreshModelCatalog.js';
import { probeNvidiaAvailability } from '../jobs/probeNvidiaAvailability.js';

const SAFE_ERRORS = new Set(['CATALOG_STORAGE_UNAVAILABLE', 'CATALOG_PERSIST_FAILED', 'NVIDIA_API_KEY_MISSING',
  'NVIDIA_LIST_UNAVAILABLE', 'NVIDIA_LIST_EMPTY', 'NVIDIA_PROBE_UNAVAILABLE']);

/** Only GitHub's two production maintenance workflows can reach either fixed operation. */
export const createCatalogMaintenanceRouter = (dependencies = {
  authenticate: authenticateCatalogMaintenance,
  refresh: refreshModelCatalog,
  probe: probeNvidiaAvailability,
  now: Date.now
}) => {
  const router = Router();
  let running = false;
  const lastRun = new Map<CatalogMaintenanceAction, number>();
  router.use(createRateLimit({ scope: 'catalog-maintenance', windowMs: 60_000, maxRequests: 10 }));
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });

  for (const action of ['refresh', 'probe-nvidia'] as const) {
    router.post(`/${action}`, async (req, res) => {
      if (Object.keys(req.query).length || (req.body && Object.keys(req.body).length)) {
        res.status(400).json({ ok: false, code: 'MAINTENANCE_NO_PARAMETERS' }); return;
      }
      const auth = req.header('authorization') ?? '';
      if (!auth.startsWith('Bearer ')) { res.status(401).json({ ok: false, code: 'MAINTENANCE_UNAUTHORIZED' }); return; }
      let identity: { runId: string; attempt: string };
      try { identity = await dependencies.authenticate(auth.slice(7), action); }
      catch { res.status(401).json({ ok: false, code: 'MAINTENANCE_UNAUTHORIZED' }); return; }
      if (running) { res.status(409).json({ ok: false, code: 'MAINTENANCE_RUNNING' }); return; }
      const cooldown = action === 'refresh' ? 60_000 : 60 * 60_000;
      if (dependencies.now() - (lastRun.get(action) ?? -Infinity) < cooldown) {
        res.setHeader('Retry-After', String(cooldown / 1000));
        res.status(429).json({ ok: false, code: 'MAINTENANCE_COOLDOWN' }); return;
      }
      running = true;
      lastRun.set(action, dependencies.now());
      try {
        if (action === 'refresh') {
          const results = await dependencies.refresh();
          const ok = !results.some((result) => result.status === 'unavailable');
          res.status(ok ? 200 : 503).json({ ok, action, ...identity, results, completedAt: new Date(dependencies.now()).toISOString() });
        } else {
          const summary = await dependencies.probe();
          res.json({ ok: true, action, ...identity, summary, completedAt: new Date(dependencies.now()).toISOString() });
        }
      } catch (error) {
        const code = error instanceof Error && SAFE_ERRORS.has(error.message) ? error.message : 'MAINTENANCE_FAILED';
        // A missing key is explicit unavailability, never a successful zero-model probe.
        res.status(503).json({ ok: false, action, ...identity, status: 'unavailable', code });
      } finally { running = false; }
    });
  }
  return router;
};

export const catalogMaintenanceRouter = createCatalogMaintenanceRouter();
