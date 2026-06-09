import { Router } from 'express';
import { runSql, MAX_SCHEMA_CHARS, MAX_QUERY_CHARS } from '../services/sqlRunner.js';

// Learning execution endpoints. Authed + rate-limited (mounted under /api/learn).
export const learnRouter = Router();

// Run a learner's SQL against an ephemeral in-memory SQLite seeded from the exercise
// schema. The engine (sql.js / WASM) is fully sandboxed — no filesystem or network.
learnRouter.post('/sql', async (req, res, next) => {
  try {
    const schema = typeof req.body?.schema === 'string' ? req.body.schema.slice(0, MAX_SCHEMA_CHARS) : '';
    const query = typeof req.body?.query === 'string' ? req.body.query.slice(0, MAX_QUERY_CHARS) : '';
    res.json(await runSql(schema, query));
  } catch (err) {
    next(err);
  }
});
