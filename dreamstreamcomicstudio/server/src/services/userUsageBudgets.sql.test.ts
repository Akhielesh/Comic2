// @vitest-environment node
// Static guard for the post-apply notes in server/sql/user_usage_budgets.sql: after
// billing_ledger_client_lockdown.sql no client policy or grant exists on generation_cost_events, so the
// run-by-hand check must not tell an operator that a SELECT policy is expected (it would read a leak as fine).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL_DIR = resolve(__dirname, '../../sql');
const budgets = readFileSync(resolve(SQL_DIR, 'user_usage_budgets.sql'), 'utf8');

describe('user_usage_budgets.sql post-apply notes', () => {
  it('say that no client policy or grant may exist on generation_cost_events (billing_ledger_client_lockdown)', () => {
    expect(budgets).not.toMatch(/only a SELECT policy may exist/i);
    const start = budgets.indexOf('Post-apply checks');
    expect(start).toBeGreaterThan(0);
    const note = budgets.slice(start);
    expect(note).toMatch(/generation_cost_events/);
    expect(note).toMatch(/NO client policy or grant may exist/i);
    expect(note).toMatch(/billing_ledger_client_lockdown\.sql/);
    expect(note).toMatch(/expect zero rows/i);
  });

  it('name a lockdown file that exists and really revokes the client roles', () => {
    const lockdown = readFileSync(resolve(SQL_DIR, 'billing_ledger_client_lockdown.sql'), 'utf8');
    expect(lockdown).toMatch(/revoke\s+all/i);
    expect(lockdown).toMatch(/generation_cost_events/);
    expect(lockdown).toMatch(/authenticated/);
  });
});
