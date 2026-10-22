// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LABEL, main, planIssueAction, readState, renderBody, stateOf, TITLE } from './streamCostWatch.mjs';

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
      const q = String(init?.body);
      return ok({ data: { viewer: { accounts: [q.includes('callsTurnUsageAdaptiveGroups') ? { callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: 800e9 } }] } : {}] } } });
    });
    const out = await main({ CF_ANALYTICS_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a', GITHUB_TOKEN: 'g', GITHUB_REPOSITORY: 'o/r' });
    expect(out.plan).toBe('open');
    expect([...hosts].sort()).toEqual(['api.cloudflare.com', 'api.github.com']);
    expect(created).toEqual([expect.objectContaining({ title: TITLE, labels: [LABEL] })]);
    expect(String(created[0].body)).toContain('TURN on course');
  });
});
