// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  aeUsageSql,
  AE_ROW_LIMIT,
  buildStreamSection,
  fetchStreamAnalytics,
  namespaceLabelsFromEnv,
  parseAeRows,
  r2OperationClass,
  streamVerdict,
  topNurseryIds,
  type AeUsageRow,
  type StreamAnalytics
} from './streamCosts.js';
import { buildCostCentreReport, computeCostRange, formatUsd, type CostCentreRows } from './costCentre.js';
import { addUsage, emptyCounters, USAGE_DOUBLES, usageToDoubles, type UsageDelta } from '../../../shared/stream/usage.js';

const NOW = Date.parse('2026-10-21T12:00:00.000Z'); // 20.5 days into a 31-day month
const N1 = '11111111-1111-4111-8111-111111111111';
const N2 = '22222222-2222-4222-8222-222222222222';
const U1 = '33333333-3333-4333-8333-333333333333';
const MONITOR_NS = 'a'.repeat(32);
const OTHER_NS = 'b'.repeat(32);

const row = (day: string, kind: AeUsageRow['kind'], scope: AeUsageRow['scope'], scopeId: string, d: UsageDelta, account = ''): AeUsageRow => ({
  day,
  kind,
  scope,
  scopeId,
  account,
  counters: addUsage(emptyCounters(), d)
});

const range30 = () => {
  const r = computeCostRange(30, new Date(NOW));
  return { fromMs: r.fromMs, toMs: r.toMs, prevFromMs: r.prevFromMs, days: 30 };
};

/** A month of measured figures + in-room rows for two nurseries, a caller and an event. */
const analytics = (over: Partial<StreamAnalytics> = {}): StreamAnalytics => ({
  configured: true,
  nowMs: NOW,
  aeFromMs: NOW - 90 * 86_400_000,
  workersMtd: [
    { script: 'dreamstream-live', requests: 300_000 },
    { script: 'dreamstream-api', requests: 100_000 },
    { script: 'atlasd', requests: 100_000 }
  ],
  doRequests: [
    { date: '2026-10-19', namespaceId: MONITOR_NS, requests: 3000 },
    { date: '2026-10-20', namespaceId: MONITOR_NS, requests: 3000 },
    { date: '2026-10-20', namespaceId: OTHER_NS, requests: 4000 }
  ],
  doPeriodic: [
    { date: '2026-10-19', namespaceId: MONITOR_NS, activeTimeUs: 100 * 1e6, rowsWritten: 9000 },
    { date: '2026-10-20', namespaceId: MONITOR_NS, activeTimeUs: 100 * 1e6, rowsWritten: 9000 },
    { date: '2026-10-20', namespaceId: OTHER_NS, activeTimeUs: 1000 * 1e6, rowsWritten: 2000 }
  ],
  r2Ops: [
    { bucket: 'dreamstream-live', actionType: 'PutObject', requests: 600 },
    { bucket: 'dreamstream-live', actionType: 'GetObject', requests: 900 },
    { bucket: 'other', actionType: 'PutObject', requests: 400 },
    { bucket: 'dreamstream-live', actionType: 'DeleteObject', requests: 50 }
  ],
  turnEgressBytes: 40e9,
  ae: [
    row('2026-10-19', 'monitor', 'nursery', N1, { relayFrames: 54_000, minutes: { server: 60, direct: 400, lan: 140 } }),
    row('2026-10-20', 'monitor', 'nursery', N1, { relayFrames: 540_000, minutes: { server: 600 } }),
    row('2026-10-20', 'monitor', 'nursery', N2, { minutes: { lan: 600 } }),
    row('2026-10-20', 'call', 'account', U1, { minutes: { turn: 30, direct: 30 } }, U1),
    row('2026-10-20', 'broadcast', 'event', 'ev123abc', { segCount: 600, segBytes: 1.17e9, viewerMinutes: 1200, doRequestsEst: 1200, rowsWrittenEst: 600, workerRequestsEst: 600 }, U1),
    // previous period
    row('2026-09-10', 'monitor', 'nursery', N1, { relayFrames: 20_000 })
  ],
  errors: [],
  ...over
});

describe('Stream costs — fetch (≤ 4 GraphQL + 1 Analytics Engine query)', () => {
  it('does nothing without credentials', async () => {
    const fetchImpl = vi.fn();
    const a = await fetchStreamAnalytics({ nowMs: NOW, fromMs: NOW - 60 * 86_400_000, creds: null, fetchImpl });
    expect(a).toMatchObject({ configured: false, errors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks four GraphQL datasets month to date and Analytics Engine once, and parses them', async () => {
    const seen: { url: string; body: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      seen.push({ url, body: String(init?.body) });
      if (url.endsWith('/analytics_engine/sql')) {
        const d: Record<string, unknown> = { day: '2026-10-20 00:00:00', kind: 'monitor', scope: 'nursery', scope_id: N1, account: '' };
        usageToDoubles(addUsage(emptyCounters(), { relayFrames: 12, minutes: { server: 3 } })).forEach((v, i) => (d[`d${i + 1}`] = String(v)));
        return { ok: true, status: 200, json: async () => ({ data: [d, { ...d, kind: 'nope' }], rows: 2 }) };
      }
      const q = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      const account = q.query.includes('durableObjectsInvocationsAdaptiveGroups')
        ? { workersInvocationsAdaptive: [{ dimensions: { scriptName: 'dreamstream-live' }, sum: { requests: 5 } }], durableObjectsInvocationsAdaptiveGroups: [{ dimensions: { date: '2026-10-20', namespaceId: 'ABC' }, sum: { requests: 7 } }] }
        : q.query.includes('durableObjectsPeriodicGroups')
          ? { durableObjectsPeriodicGroups: [{ dimensions: { date: '2026-10-20', namespaceId: 'abc' }, sum: { activeTime: 2e6, rowsWritten: 9 } }] }
          : q.query.includes('r2OperationsAdaptiveGroups')
            ? {
                r2OperationsAdaptiveGroups: [{ dimensions: { actionType: 'PutObject', bucketName: 'dreamstream-live' }, sum: { requests: 3 } }],
                r2StorageAdaptiveGroups: [
                  { dimensions: { bucketName: 'dreamstream-live', datetime: '2026-10-21T10:00:00Z' }, max: { payloadSize: 9e9 } },
                  { dimensions: { bucketName: 'dreamstream-live', datetime: '2026-10-21T08:00:00Z' }, max: { payloadSize: 1 } }
                ]
              }
            : { callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: 123 } }] };
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { accounts: [account] } }, errors: null }) };
    });
    const a = await fetchStreamAnalytics({ nowMs: NOW, fromMs: NOW - 60 * 86_400_000, creds: { token: 't', accountId: 'acct' }, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(seen.filter((s) => s.url.endsWith('/graphql'))).toHaveLength(4);
    expect(seen.find((s) => s.url.includes('/accounts/acct/analytics_engine/sql'))?.body).toContain('FROM stream_usage');
    // Month to date: the queries start on the 1st.
    expect(JSON.parse(seen[0].body).variables).toMatchObject({ start: '2026-10-01T00:00:00.000Z', startDate: '2026-10-01', endDate: '2026-10-21' });
    expect(a.doRequests).toEqual([{ date: '2026-10-20', namespaceId: 'abc', requests: 7 }]);
    expect(a.doPeriodic?.[0]).toMatchObject({ activeTimeUs: 2e6, rowsWritten: 9 });
    expect(a.turnEgressBytes).toBe(123);
    expect(a.r2Storage).toEqual([{ bucket: 'dreamstream-live', payloadBytes: 9e9 }]); // latest sample per bucket
    expect(a.ae).toHaveLength(1);
    expect(a.ae?.[0].counters).toMatchObject({ relayFrames: 12, minutes: { server: 3 } });
    expect(a.errors).toEqual([]);
  });

  it('isolates a failing dataset and never echoes the token', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: { body?: string }) => {
      if (String(init?.body).includes('durableObjectsPeriodicGroups')) {
        return { ok: true, status: 200, json: async () => ({ data: null, errors: [{ message: 'unknown field rowsWritten for token SECRET-T' }] }) };
      }
      if (url.endsWith('/sql')) return { ok: false, status: 403, json: async () => ({ errors: [{ message: 'not entitled' }] }) };
      return { ok: true, status: 200, json: async () => ({ data: { viewer: { accounts: [{}] } } }) };
    });
    const a = await fetchStreamAnalytics({ nowMs: NOW, fromMs: NOW, creds: { token: 'SECRET-T', accountId: 'a' }, fetchImpl });
    expect(a.errors).toHaveLength(2);
    expect(a.errors.join(' ')).not.toContain('SECRET-T');
    expect(a.doRequests).toEqual([]); // the other datasets still answered
    expect(a.ae).toBeUndefined();
  });

  it('builds one Analytics Engine query with every counter, capped at its retention', () => {
    const sql = aeUsageSql(400);
    expect(sql).toContain(`INTERVAL '90' DAY`);
    expect(sql).toContain(`SUM(_sample_interval * double${USAGE_DOUBLES.length}) AS d${USAGE_DOUBLES.length}`);
    expect(sql).toContain(`LIMIT ${AE_ROW_LIMIT}`);
    expect(parseAeRows({ data: [{ day: 'bad', kind: 'monitor' }] })).toEqual([]);
  });

  it('classifies R2 operations like the pricing page', () => {
    expect(r2OperationClass('PutObject')).toBe('A');
    expect(r2OperationClass('UploadPart')).toBe('A');
    expect(r2OperationClass('GetObject')).toBe('B');
    expect(r2OperationClass('DeleteObject')).toBe('free');
    expect(r2OperationClass('SomethingNew')).toBe('A'); // conservative
  });

  it('reads optional namespace labels (non-secret)', () => {
    expect(namespaceLabelsFromEnv({ STREAM_DO_NAMESPACES: `MonitorRoom=${MONITOR_NS}, EventRoom=bad,UserLine=${OTHER_NS.toUpperCase()}` } as NodeJS.ProcessEnv)).toEqual({
      [MONITOR_NS]: 'MonitorRoom',
      [OTHER_NS]: 'UserLine'
    });
  });
});

describe('Stream costs — the section (pure)', () => {
  it('labels every figure with its provenance', () => {
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: analytics(), namespaceLabels: { [MONITOR_NS]: 'MonitorRoom' } });
    expect(s.sources).toEqual({ graphql: true, analyticsEngine: true });
    expect(new Set(s.headroom.map((h) => h.source))).toEqual(new Set(['measured']));
    expect(s.features.filter((f) => f.id !== 'push').every((f) => f.source === 'estimated')).toBe(true);
    expect(s.features.find((f) => f.id === 'push')?.source).toBe('fixed');
    expect(s.kpis.source).toBe('measured');
    expect(s.pricesCheckedOn).toBe('2026-10-22');
  });

  it('is $0 marginal inside the free tiers, with the list value beside it', () => {
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: analytics() });
    expect(s.marginalUsd).toBe(0);
    expect(s.listValueUsd).toBeGreaterThan(0);
    expect(streamVerdict(s, formatUsd)).toMatch(/^\$0 marginal \(inside free tiers\) · \$0\.\d+ at list price, est\. · 2 nurseries, 1 event$/);
  });

  it('allocates only the overage, after the account-wide free tier (TURN past 1 TB)', () => {
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: analytics({ turnEgressBytes: 1200e9 }) });
    expect(s.marginalUsd).toBeCloseTo(10, 6); // 200 GB × $0.05
    const turn = s.headroom.find((h) => h.id === 'turnGb')!;
    expect(turn).toMatchObject({ used: 1200, allowance: 1000, overageUsd: 10 });
    expect(s.alerts.map((a) => a.id)).toContain('turn_spend');
    expect(s.alerts.find((a) => a.id === 'turn_spend')?.severity).toBe('critical');
  });

  it('splits DO overage by namespace when the rooms are labelled, else counts it all (and says so)', () => {
    const heavy = analytics({ doRequests: [{ date: '2026-10-20', namespaceId: MONITOR_NS, requests: 1_500_000 }, { date: '2026-10-20', namespaceId: OTHER_NS, requests: 500_000 }] });
    const labelled = buildStreamSection({ nowMs: NOW, range: range30(), analytics: heavy, namespaceLabels: { [MONITOR_NS]: 'MonitorRoom', [OTHER_NS]: 'Backend' } });
    expect(labelled.marginalUsd).toBeCloseTo(0.15 * 0.75, 6); // 1M over × $0.15/M × 75 %
    const unlabelled = buildStreamSection({ nowMs: NOW, range: range30(), analytics: heavy });
    expect(unlabelled.marginalUsd).toBeCloseTo(0.15, 6);
    expect(unlabelled.notes.some((n) => n.includes('STREAM_DO_NAMESPACES'))).toBe(true);
    expect(unlabelled.kpis.source).toBe('estimated');
  });

  it('projects each allowance to month end and says when it crosses', () => {
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: analytics({ workersMtd: [{ script: 'dreamstream-live', requests: 8_000_000 }] }) });
    const w = s.headroom.find((h) => h.id === 'workerRequests')!;
    expect(w.projected).toBeCloseTo((8_000_000 / 20.5) * 31, 0);
    expect(w.crossesOn).toBe('2026-10-26');
    expect(s.alerts.find((a) => a.id === 'free_tier:workerRequests')?.severity).toBe('critical');
    expect(s.month).toMatchObject({ daysInMonth: 31, daysElapsed: 20.5 });
  });

  it('shows the path mix, free share, per-nursery and per-broadcast-hour costs', () => {
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: analytics() });
    const monitor = s.pathMix.find((p) => p.kind === 'monitor')!;
    expect(monitor.minutes).toEqual({ lan: 740, direct: 400, turn: 0, server: 660 });
    expect(s.freePathShare).toBeCloseTo((740 + 400 + 30) / (740 + 400 + 660 + 60), 4);
    expect(s.activeNurseries).toBe(2);
    expect(s.events).toBe(1);
    expect(s.perNurseryMonthUsd).toBeGreaterThan(0); // 3 nursery-days in range
    expect(s.perBroadcastHourUsd).toBeGreaterThan(0.004);
    expect(s.perBroadcastHourUsd).toBeLessThan(0.02);
    expect(s.prevListValueUsd).toBeGreaterThan(0);
  });

  it('lists top consumers with admin-only names; guests never appear', () => {
    const s = buildStreamSection({
      nowMs: NOW,
      range: range30(),
      analytics: analytics(),
      nurseryNames: new Map([[N1, { name: 'Aria’s room', owner: 'mom@example.com' }]]),
      emails: new Map([[U1, 'caller@example.com']])
    });
    expect(s.top.nurseries[0]).toMatchObject({ scope: 'nursery', id: N1, label: 'Aria’s room', owner: 'mom@example.com', serverMinutes: 660 });
    expect(s.top.nurseries[1].label).toBe('Nursery 22222222…');
    expect(s.top.accounts[0]).toMatchObject({ label: 'caller@example.com', turnGb: expect.any(Number) });
    expect(s.top.accounts[0].turnGb).toBeCloseTo((30 * 11.25e6) / 1e9, 2);
    expect(s.top.events[0]).toMatchObject({ label: 'Event ev123abc', owner: 'caller@example.com' });
    expect(topNurseryIds(analytics(), range30().fromMs, range30().toMs)).toEqual([N1, N2]);
  });

  it('computes the ADR 0006 per-nursery-day KPIs and flags broken hibernation from the MonitorRoom namespace', () => {
    const hot = analytics({
      doPeriodic: [
        { date: '2026-10-19', namespaceId: MONITOR_NS, activeTimeUs: (45 / 0.128) * 1e6, rowsWritten: 9000 },
        { date: '2026-10-20', namespaceId: MONITOR_NS, activeTimeUs: ((2 * 50) / 0.128) * 1e6, rowsWritten: 9000 }
      ]
    });
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: hot, namespaceLabels: { [MONITOR_NS]: 'MonitorRoom' } });
    // 3 active nursery-days this month (N1 on the 19th and 20th, N2 on the 20th).
    expect(s.kpis.activeNurseryDays).toBe(3);
    expect(s.kpis.doRequests).toBe(2000);
    expect(s.kpis.rowsWritten).toBe(6000);
    expect(s.alerts.map((a) => a.id)).toContain('hibernation');
    expect(s.projection.at1k).toBeGreaterThan(0);
  });

  it('reads R2 storage from its own query (the daily watch has no Workers card) and warns near the free 10 GB', () => {
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: analytics({ r2Storage: [{ bucket: 'dreamstream-live', payloadBytes: 9e9 }] }) });
    expect(s.headroom.find((h) => h.id === 'r2StoredGb')).toMatchObject({ used: 9, projected: 9, projectedPct: 90 });
    expect(s.alerts.filter((a) => a.id.includes('r2'))).toEqual([expect.objectContaining({ id: 'free_tier:r2StoredGb', severity: 'warning' })]);
  });

  it('is honest when nothing is connected', () => {
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: null });
    expect(s.sources).toEqual({ graphql: false, analyticsEngine: false });
    expect(s.marginalUsd).toBe(0);
    expect(s.headroom).toEqual([]);
    expect(s.alerts).toEqual([]);
    expect(s.notes.some((n) => n.includes('CF_ANALYTICS_API_TOKEN'))).toBe(true);
    expect(streamVerdict(s, formatUsd)).toMatch(/^Not measured yet/);
  });

  it('adds the shared email allowance and its alert from email_log', () => {
    const s = buildStreamSection({ nowMs: NOW, range: range30(), analytics: null, emailsMonthToDate: 2500 });
    expect(s.headroom.find((h) => h.id === 'emails')).toMatchObject({ used: 2500, allowance: 3000, source: 'measured' });
    expect(s.alerts.map((a) => a.id)).toEqual(expect.arrayContaining(['email_near_free', 'free_tier:emails']));
  });
});

describe('Cost centre — the Stream Studio product row comes from data', () => {
  const emptyRows = (): CostCentreRows => ({
    costEvents: [],
    ledger: [],
    providerUsage: [],
    emails: [],
    studioRuns: [],
    subscriptions: [],
    plans: [],
    profiles: [{ id: U1, email: 'caller@example.com' }],
    liveProfiles: 3,
    telemetry: [],
    modelUsage: [],
    truncated: []
  });

  it('replaces the hard-coded $0 with marginal $ + list value, and ships the section', () => {
    const report = buildCostCentreReport(emptyRows(), { days: 30, now: new Date(NOW), budgetFor: () => null, stream: { analytics: analytics({ turnEgressBytes: 1100e9 }) } });
    const row = report.products.find((p) => p.id === 'stream')!;
    expect(row.costUsd).toBeCloseTo(5, 6); // 100 GB past the free TB × $0.05
    expect(row.listValueUsd).toBeGreaterThan(0);
    expect(row.verdict).toContain('marginal (past a free tier)');
    expect(row.verdict).toContain('3 members');
    expect(report.stream?.top.accounts[0].label).toBe('caller@example.com');
    expect(report.notes.some((n) => n.startsWith('Stream Studio owes $5.00'))).toBe(true);
  });

  it('stays honest without analytics', () => {
    const report = buildCostCentreReport(emptyRows(), { days: 30, now: new Date(NOW), budgetFor: () => null });
    const row = report.products.find((p) => p.id === 'stream')!;
    expect(row).toMatchObject({ costUsd: 0, listValueUsd: 0, users: 3 });
    expect(row.verdict).toMatch(/^Not measured yet/);
    expect(report.stream?.sources).toEqual({ graphql: false, analyticsEngine: false });
    expect(report.fixed.some((f) => f.service === 'Cloudflare Realtime TURN')).toBe(true);
  });
});
