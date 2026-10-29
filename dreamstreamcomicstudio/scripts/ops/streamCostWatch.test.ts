// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LABEL, main, planIssueAction, readState, renderBody, stateOf, TITLE } from './streamCostWatch.mjs';
import { alertDatasets, STREAM_DATASET_LABEL } from '../../server/src/services/streamCosts';

const crit = { id: 'turn_spend', severity: 'critical', title: 'TURN on course for $12.00 this month', cause: '800 GB so far.' };
const warn = { id: 'free_tier:doRowsWritten', severity: 'warning', title: 'Rows filling', cause: '85%.' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('stream cost watch — issue state', () => {
  it('round-trips the alert state through the issue body', () => {
    const body = renderBody([crit, warn], { checkedAt: '2026-10-21T06:17:00Z' });
    expect(body).toContain('**Critical — TURN on course for $12.00 this month.** 800 GB so far.');
    expect(body).toContain('never cut baby-monitor sound or alerts');
    expect(readState(body)).toEqual(stateOf([warn, crit]));
    expect(readState('no marker')).toEqual([]);
    expect(readState('<!-- stream-cost-watch-state: [not json] -->')).toEqual([]);
  });

  it('writes only when the set of firing alerts changes', () => {
    expect(planIssueAction(null, [])).toMatchObject({ kind: 'none' });
    const open = planIssueAction(null, [crit]);
    expect(open).toMatchObject({ kind: 'open', title: TITLE });
    const issue = { number: 7, body: open.body };
    expect(planIssueAction(issue, [crit])).toMatchObject({ kind: 'none', reason: 'alerts unchanged' });
    const more = planIssueAction(issue, [crit, warn]);
    expect(more).toMatchObject({ kind: 'update' });
    expect(more.comment).toContain('New: free_tier:doRowsWritten (warning)');
    // A severity change is a change.
    expect(planIssueAction(issue, [{ ...crit, severity: 'warning' }]).kind).toBe('update');
    const clear = planIssueAction(issue, []);
    expect(clear).toMatchObject({ kind: 'close' });
    expect(clear.comment).toContain('Cleared: turn_spend (critical)');
  });
});

describe('stream cost watch — fails safe when Cloudflare data is missing', () => {
  const leak = { id: 'turn_leak', severity: 'critical', title: 'TURN leak suspected', cause: '600 GB before the 15th.' };
  const creep = { id: 'relay_creep', severity: 'warning', title: 'Relay creep', cause: '20%.' };
  const gap = (dataset: keyof typeof STREAM_DATASET_LABEL, error = 'timed out after 8s') => ({ dataset, label: STREAM_DATASET_LABEL[dataset], error });
  const ctx = (...unmeasured: ReturnType<typeof gap>[]) => ({ unmeasured, dependsOn: alertDatasets, labels: STREAM_DATASET_LABEL });
  const openIssue = (...alerts: (typeof crit)[]) => ({ number: 9, body: planIssueAction(null, alerts).body as string });

  it('keeps an open TURN alert open when the TURN query fails — never "All clear", never closed', () => {
    const plan = planIssueAction(openIssue(leak), [], ctx(gap('turn')));
    expect(plan.kind).toBe('update');
    expect(readState(plan.body)).toEqual(['data:turn:unmeasured', 'turn_leak:critical']);
    expect(plan.comment).toContain("Couldn't measure: TURN egress.");
    expect(plan.comment).toContain('Kept as they were (not re-checked): turn_leak (critical).');
    expect(plan.comment).not.toMatch(/all clear/i);
    expect(plan.body).toContain("**Couldn't measure** — not \"all clear\"");
    expect(plan.body).toContain('TURN egress: timed out after 8s');
    // The next morning, still failing: no new write (no daily spam), still not closed.
    expect(planIssueAction({ number: 9, body: plan.body }, [], ctx(gap('turn')))).toMatchObject({ kind: 'none', reason: expect.stringContaining("still couldn't measure TURN egress") });
  });

  it('clears only what was measured: an Analytics Engine outage keeps relay creep, while a measured TURN figure clears TURN', () => {
    const plan = planIssueAction(openIssue(crit, creep), [], ctx(gap('ae')));
    expect(plan.kind).toBe('update'); // not 'close', though nothing fires
    expect(readState(plan.body)).toEqual(['data:ae:unmeasured', 'relay_creep:warning']);
    expect(plan.comment).toContain('Cleared: turn_spend (critical).');
    expect(plan.comment).toContain('Kept as they were (not re-checked): relay_creep (warning).');
  });

  it('a revoked token (every dataset failing) opens the issue instead of reporting nothing', () => {
    const all = (['requests', 'periodic', 'storage', 'r2', 'turn', 'ae'] as const).map((d) => gap(d, 'HTTP 403: Authentication error'));
    const plan = planIssueAction(null, [], ctx(...all));
    expect(plan.kind).toBe('open');
    expect(readState(plan.body)).toHaveLength(6);
    expect(plan.body).toContain('R2 operations + storage: HTTP 403: Authentication error');
  });

  it('closes only once every dataset answers and nothing fires', () => {
    const stillOut = planIssueAction(openIssue(leak), [], ctx(gap('turn')));
    const back = planIssueAction({ number: 9, body: stillOut.body as string }, [], ctx());
    expect(back.kind).toBe('close');
    expect(back.comment).toContain('All clear — every dataset answered');
    expect(back.comment).toContain('Measured again: TURN egress.');
    expect(back.comment).toContain('Cleared: turn_leak (critical).');
  });

  it('without a dependency map, a failure keeps every alert (the safe default)', () => {
    const plan = planIssueAction(openIssue(warn), [], { unmeasured: [gap('turn')] });
    expect(readState(plan.body)).toEqual(['data:turn:unmeasured', 'free_tier:doRowsWritten:warning']);
  });
});

describe('stream cost watch — run', () => {
  it('is a clear no-op without the read-only token', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(main({})).resolves.toEqual({ skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.mock.calls[0][0]).toMatch(/CF_ANALYTICS_API_TOKEN.*not set — nothing to check/);
  });

  it('reads Cloudflare (never the backend), and opens one labelled issue for a TURN alert', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T06:17:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const hosts = new Set<string>();
    const created: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      hosts.add(u.host);
      const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
      if (u.host === 'api.github.com') {
        if (init?.method === 'POST') {
          created.push(JSON.parse(String(init.body)));
          return ok({ number: 1 });
        }
        return ok([]);
      }
      if (u.pathname.endsWith('/analytics_engine/sql')) return ok({ data: [] });
      return ok({ data: { viewer: { accounts: [healthyAccount(String(init?.body), 800e9)] } } });
    });
    const out = await main({ CF_ANALYTICS_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', GITHUB_TOKEN: 'g', GITHUB_REPOSITORY: 'o/r' });
    expect(out.plan).toBe('open');
    expect(out).toMatchObject({ unmeasured: [], exitCode: 0 }); // every dataset answered: a green run
    expect([...hosts].sort()).toEqual(['api.cloudflare.com', 'api.github.com']);
    expect(created).toEqual([expect.objectContaining({ title: TITLE, labels: [LABEL] })]);
    expect(String(created[0].body)).toContain('TURN on course');
  });

  it('a revoked token keeps the open TURN issue open, says it couldn’t measure, and fails the run', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-09T06:17:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const open = { number: 4, body: planIssueAction(null, [{ id: 'turn_leak', severity: 'critical', title: 'TURN leak suspected', cause: 'x' }]).body };
    const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(url);
      if (u.host === 'api.github.com') {
        if (init?.method) writes.push({ method: init.method, path: u.pathname, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify(init?.method ? { number: 4 } : [open]), { status: 200 });
      }
      // The token was revoked: every Cloudflare read is refused (and the message names the account).
      return new Response(JSON.stringify({ errors: [{ message: 'Authentication error for account acct-123' }] }), { status: 403 });
    });
    const out = await main({ CF_ANALYTICS_API_TOKEN: 't0k', CLOUDFLARE_ACCOUNT_ID: 'acct-123', GITHUB_TOKEN: 'g', GITHUB_REPOSITORY: 'o/r' });
    expect(out).toMatchObject({ plan: 'update', exitCode: 1 });
    expect(out.unmeasured).toHaveLength(6);
    expect(writes.some((w) => w.body.state === 'closed')).toBe(false);
    const patched = writes.find((w) => w.method === 'PATCH')!;
    expect(readState(String(patched.body.body))).toContain('turn_leak:critical');
    const comment = String(writes.find((w) => w.path.endsWith('/comments'))?.body.body);
    expect(comment).toContain("Couldn't measure:");
    expect(comment).not.toMatch(/^All clear/);
    expect(JSON.stringify(writes)).not.toContain('acct-123'); // the public issue never carries the account id
  });

  it('a Cloudflare answer with no account is a failure, not zero usage', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-09T06:17:00Z'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', async (url: string) =>
      new URL(url).pathname.endsWith('/analytics_engine/sql')
        ? new Response(JSON.stringify({ data: [] }), { status: 200 })
        : new Response(JSON.stringify({ data: { viewer: { accounts: [] } } }), { status: 200 })
    );
    const out = await main({ CF_ANALYTICS_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'wrong' });
    expect(out).toMatchObject({ exitCode: 1, unmeasured: ['requests', 'periodic', 'storage', 'r2', 'turn'] });
  });
});

/** A GraphQL account answer with every dataset present (empty), and the given TURN egress. */
function healthyAccount(body: string, turnBytes = 0): Record<string, unknown> {
  if (body.includes('callsTurnUsageAdaptiveGroups')) return { callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: turnBytes } }] };
  if (body.includes('durableObjectsInvocationsAdaptiveGroups')) return { workersInvocationsAdaptive: [], durableObjectsInvocationsAdaptiveGroups: [] };
  if (body.includes('durableObjectsPeriodicGroups')) return { durableObjectsPeriodicGroups: [] };
  if (body.includes('durableObjectsStorageGroups')) return { durableObjectsStorageGroups: [] };
  return { r2OperationsAdaptiveGroups: [], r2StorageAdaptiveGroups: [] };
}
