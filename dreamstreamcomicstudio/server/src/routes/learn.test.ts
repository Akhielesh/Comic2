// @vitest-environment node
// abuse-ops-2, route side: POST /api/learn/sql has its own per-account allowance (on top of the shared
// `text` limiter) and hands the runner the account, which may have one run in flight at a time.
// The runner is faked here; services/sqlRunner.test.ts covers the runs themselves.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const calls = vi.hoisted(() => [] as { query: string; caller?: string }[]);
vi.mock('../services/sqlRunner.js', () => ({
  MAX_SCHEMA_CHARS: 20_000,
  MAX_QUERY_CHARS: 4_000,
  runSql: async (_schema: string, query: string, caller?: string) => {
    calls.push({ query, caller });
    return { columns: ['x'], rows: [[1]], rowCount: 1, truncated: false };
  }
}));

const { learnRouter, LEARN_SQL_WINDOWS } = await import('./learn.js');

const app = express();
app.use(express.json());
// requireAuth stand-in: `x-test-user` is the signed-in account.
app.use((req, _res, next) => {
  const id = req.header('x-test-user');
  if (id) (req as unknown as { user: { id: string } }).user = { id };
  next();
});
app.use('/api/learn', learnRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const run = (user: string, query = 'SELECT 1') =>
  fetch(`${base}/api/learn/sql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': user },
    body: JSON.stringify({ schema: '', query })
  });

describe('POST /api/learn/sql limits', () => {
  it('allows 15 runs a minute and 1,000 a day per account', () => {
    expect(LEARN_SQL_WINDOWS.map((w) => [w.scope, w.windowMs, w.maxRequests])).toEqual([
      ['learn_sql', 60_000, 15],
      ['learn_sql_day', 24 * 60 * 60_000, 1_000]
    ]);
  });

  it('the 16th run in a minute is refused with the usual 429 body; another account is unaffected', async () => {
    const before = calls.length;
    for (let i = 0; i < 15; i++) expect((await run('learner-1')).status).toBe(200);
    const res = await run('learner-1');
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatchObject({ code: 'RATE_LIMITED', details: { scope: 'learn_sql', limit: 15, keyType: 'user' } });
    expect(calls.length - before).toBe(15); // the refused run never reached the runner
    expect((await run('learner-2')).status).toBe(200);
  });

  it('passes the account to the runner as the caller', async () => {
    await run('learner-3', 'SELECT 42');
    expect(calls.at(-1)).toEqual({ query: 'SELECT 42', caller: 'user:learner-3' });
  });
});
