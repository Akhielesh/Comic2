import { Router } from 'express';
import { runSql, MAX_SCHEMA_CHARS, MAX_QUERY_CHARS } from '../services/sqlRunner.js';
import { createPublicDataLimit, publicRequesterKey, type PublicDataWindow } from '../middleware/publicDataLimits.js';

// Learning execution endpoints. Authed + rate-limited (mounted under /api/learn).
export const learnRouter = Router();

/**
 * Per-account allowance for the SQL playground (abuse-ops-2), on top of the shared `text` limiter.
 * Every run is CPU on a 1/4-vCPU container (about 0.1 s for a trivial query, up to the 2 s deadline
 * for a runaway one), and sign-up is open. The playground runs a query only when the learner presses
 * Run (components/chat/artifacts/SqlPlayground.tsx), one at a time: 15 a minute is a fast iteration
 * pace, and 1,000 a day is over 8 hours of practice at 2 a minute.
 */
export const LEARN_SQL_WINDOWS: readonly PublicDataWindow[] = [
  { scope: 'learn_sql', windowMs: 60_000, maxRequests: 15 },
  { scope: 'learn_sql_day', windowMs: 24 * 60 * 60_000, maxRequests: 1_000 }
];
const learnSqlLimit = createPublicDataLimit(...LEARN_SQL_WINDOWS);

// Run a learner's SQL against an ephemeral in-memory SQLite seeded from the exercise
// schema. The engine (sql.js / WASM) is fully sandboxed — no filesystem or network — and runs
// in its own worker thread with a 2 s deadline and memory caps (services/sqlWorker.ts), so a
// runaway query never blocks this process. An account has at most one run in flight.
learnRouter.post('/sql', learnSqlLimit, async (req, res, next) => {
  try {
    const schema = typeof req.body?.schema === 'string' ? req.body.schema.slice(0, MAX_SCHEMA_CHARS) : '';
    const query = typeof req.body?.query === 'string' ? req.body.query.slice(0, MAX_QUERY_CHARS) : '';
    res.json(await runSql(schema, query, publicRequesterKey(req)));
  } catch (err) {
    next(err);
  }
});
