// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  buildSecuritySection,
  cspDatasetFromEnv,
  cspQueryDays,
  cspSql,
  fetchCspCounts,
  loadSignInCounts,
  parseCspRows,
  SECURITY_THRESHOLDS,
  type CountClient,
  type CspHourRow,
  type SecurityBuildInput
} from './securitySignals.js';
import { buildCostCentreReport, computeCostRange, type CostCentreRows } from './costCentre.js';
import type { SignalRow } from '../../../shared/stream/signals.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const HOUR = 3_600_000;
const UUID = '11111111-1111-4111-8111-111111111111';

const range7 = () => {
  const r = computeCostRange(7, new Date(NOW));
  return { fromMs: r.fromMs, toMs: r.toMs, prevFromMs: r.prevFromMs, days: 7 };
};

const csp = (hoursAgo: number, over: Partial<CspHourRow> = {}): CspHourRow => ({
  at: Math.floor((NOW - hoursAgo * HOUR) / HOUR) * HOUR,
  disposition: 'report',
  page: 'live',
  directive: 'script-src-elem',
  blocked: 'https://cdn.example',
  firstParty: true,
  count: 1,
  ...over
});

const input = (over: Partial<SecurityBuildInput> = {}): SecurityBuildInput => ({
  nowMs: NOW,
  range: range7(),
  csp: { measured: true, rows: [] },
  signIns: { measured: true, newSessions: 12, alertsEmailed: 4, secured: 0, devicesAdded: 2, devicesRevoked: 1 },
  signals: [],
  aeFromMs: NOW - 90 * 86_400_000,
  ...over
});

describe('security signals — CSP counts', () => {
  it('reads a plain dataset name only (no SQL can ride in on the env)', () => {
    expect(cspDatasetFromEnv({} as NodeJS.ProcessEnv)).toBe('csp_reports');
    expect(cspDatasetFromEnv({ CSP_REPORTS_DATASET: 'csp_v2' } as NodeJS.ProcessEnv)).toBe('csp_v2');
    expect(cspDatasetFromEnv({ CSP_REPORTS_DATASET: 'x; DROP TABLE y' } as NodeJS.ProcessEnv)).toBe('csp_reports');
    const sql = cspSql('csp_reports', 1);
    expect(sql).toContain("INTERVAL '2' DAY"); // the 48 h gate always fits
    expect(sql).toContain('FROM csp_reports');
    expect(sql).toContain('blob6 AS party');
    expect(cspSql('csp_reports', 400)).toContain("INTERVAL '90' DAY");
    expect(cspQueryDays(7)).toBe(8);
    expect(cspQueryDays(1)).toBe(2);
  });

  it('parses hourly rows and keeps an origin, never a path', () => {
    const rows = parseCspRows({
      data: [
        { hour: '2026-10-28 10:00:00', disposition: 'report', page: 'live', directive: 'connect-src', blocked: 'https://evil.example/share/abc?k=1', party: 'first', n: '3' },
        { hour: '2026-10-28 09:00:00', disposition: 'enforce', page: 'main', directive: 'script-src', blocked: 'extension', party: 'extension', n: 2 },
        { hour: 'nope', n: 1 },
        { hour: '2026-10-28 08:00:00', n: 0 }
      ]
    });
    expect(rows).toEqual([
      { at: Date.parse('2026-10-28T10:00:00Z'), disposition: 'report', page: 'live', directive: 'connect-src', blocked: 'https://evil.example', firstParty: true, count: 3 },
      { at: Date.parse('2026-10-28T09:00:00Z'), disposition: 'enforce', page: 'main', directive: 'script-src', blocked: 'extension', firstParty: false, count: 2 }
    ]);
    expect(parseCspRows(null)).toEqual([]);
  });

  it('asks nothing without credentials, and scrubs the token and account id from a failure', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchCspCounts({ nowMs: NOW, days: 7, creds: null, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    const failing = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({ errors: [{ message: 'unknown table csp_reports for token SECRET-T account acct-9' }] }) }));
    const out = await fetchCspCounts({ nowMs: NOW, days: 7, creds: { token: 'SECRET-T', accountId: 'acct-9' }, fetchImpl: failing });
    expect(out?.measured).toBe(false);
    expect(out?.error).toContain('unknown table');
    expect(out?.error).not.toContain('SECRET-T');
    expect(out?.error).not.toContain('acct-9');
    const ok = vi.fn(async (url: string, init?: { body?: string }) => {
      expect(url).toContain('/accounts/acct-9/analytics_engine/sql');
      expect(String(init?.body)).toContain('FROM csp_reports');
      return { ok: true, status: 200, json: async () => ({ data: [{ hour: '2026-10-28 10:00:00', disposition: 'report', page: 'live', directive: 'img-src', blocked: 'data:', party: 'first', n: 1 }] }) };
    });
    const measured = await fetchCspCounts({ nowMs: NOW, days: 7, creds: { token: 't', accountId: 'acct-9' }, dataset: 'csp_reports', fetchImpl: ok });
    expect(measured).toMatchObject({ measured: true, rows: [expect.objectContaining({ blocked: 'data:', count: 1 })] });
  });
});

describe('security signals — sign-in alert counts', () => {
  const client = (counts: Record<string, number>, fail?: string): CountClient => ({
    from: (table: string) => ({
      select: () => {
        const filters: Record<string, unknown> = { table };
        const q: any = {
          eq: (c: string, v: unknown) => ((filters[c] = v), q),
          gte: () => q,
          lt: () => q,
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve(fail ? { count: null, error: { message: fail } } : { count: counts[`${filters.kind}${filters.notified ? '+notified' : ''}`] ?? 0, error: null }).then(res)
        };
        return q;
      }
    })
  });

  it('counts by kind with HEAD queries — never a row', async () => {
    const out = await loadSignInCounts(client({ sign_in: 9, 'sign_in+notified': 3, secured: 1, device_added: 2, device_revoked: 0 }), NOW - 7 * 86_400_000, NOW);
    expect(out).toEqual({ measured: true, newSessions: 9, alertsEmailed: 3, secured: 1, devicesAdded: 2, devicesRevoked: 0 });
  });

  it('is "not measured" while live_security_v2.sql isn’t applied', async () => {
    const out = await loadSignInCounts(client({}, 'Could not find the table public.security_events'), NOW - 86_400_000, NOW);
    expect(out).toMatchObject({ measured: false, newSessions: null, secured: null });
    expect(out.error).toContain('security_events');
    const s = buildSecuritySection(input({ signIns: out }));
    expect(s.signIns.measured).toBe(false);
    expect(s.signIns.note).toContain('live_security_v2.sql');
  });
});

describe('security signals — the section (pure)', () => {
  it('is quiet and honest when everything is clean', () => {
    const s = buildSecuritySection(input({ csp: { measured: true, rows: [csp(5, { page: 'main' }), csp(6, { firstParty: false, blocked: 'extension' })] } }));
    expect(s.alerts).toEqual([]);
    expect(s.csp).toMatchObject({ measured: true, total: 2, firstPartyLive48h: 0, firstPartyLiveEnforced: 0, extension: 1 });
    expect(s.signIns).toMatchObject({ newSessions: 12, alertsEmailed: 4, secured: 0 });
    expect(s.signals.counted).toBe(false);
    expect(s.signals.note).toContain('not wired');
    expect(s.notes[0]).toMatch(/Everything on this tab is a count/);
  });

  it('warns while Stream Studio’s report-only CSP isn’t clean for 48 h, and goes critical once it blocks for real', () => {
    const warn = buildSecuritySection(input({ csp: { measured: true, rows: [csp(47), csp(60)] } }));
    expect(warn.csp.firstPartyLive48h).toBe(1); // the 60 h-old one is outside the gate
    expect(warn.alerts).toEqual([expect.objectContaining({ id: 'csp_live_violations', severity: 'warning' })]);
    const crit = buildSecuritySection(input({ csp: { measured: true, rows: [csp(100, { disposition: 'enforce' })] } }));
    expect(crit.alerts).toEqual([expect.objectContaining({ id: 'csp_live_blocked', severity: 'critical' })]);
    expect(crit.csp.top[0]).toMatchObject({ page: 'live', directive: 'script-src-elem', blocked: 'https://cdn.example', disposition: 'enforce', firstParty: true, count: 1 });
    // Browser extensions never count against us.
    const ext = buildSecuritySection(input({ csp: { measured: true, rows: [csp(1, { firstParty: false, blocked: 'extension', disposition: 'enforce' })] } }));
    expect(ext.alerts).toEqual([]);
  });

  it('says how to turn CSP counts on when the binding is missing — never "zero violations"', () => {
    const s = buildSecuritySection(input({ csp: { measured: false, rows: [], error: 'unknown table csp_reports' } }));
    expect(s.csp).toMatchObject({ measured: false, total: null, firstPartyLive48h: null, error: 'unknown table csp_reports' });
    expect(s.csp.note).toContain('CSP_REPORTS');
    expect(buildSecuritySection(input({ csp: null })).csp.note).toContain('CF_ANALYTICS_API_TOKEN');
  });

  it('flags every use of “Not you?” as a suspected takeover', () => {
    const s = buildSecuritySection(input({ signIns: { measured: true, newSessions: 3, alertsEmailed: 3, secured: 2, devicesAdded: 0, devicesRevoked: 0 } }));
    expect(s.alerts).toEqual([expect.objectContaining({ id: 'not_you_used', severity: 'warning' })]);
    expect(s.alerts[0].cause).toContain('2 people');
  });

  it('lists the Worker’s refusal and disconnect counts with the period before and where they happened', () => {
    const sig = (day: string, name: SignalRow['name'], count: number, surface: SignalRow['surface'] = ''): SignalRow => ({ day, name, surface, count });
    const s = buildSecuritySection(
      input({
        signals: [
          sig('2026-10-27', 'mfa_refused', 3, 'monitor'),
          sig('2026-10-28', 'mfa_refused', 1, 'edge'),
          sig('2026-10-15', 'mfa_refused', 7, 'monitor'), // previous period
          sig('2026-10-26', 'kick', 2, 'account'),
          sig('2026-10-26', 'kick_closed', 9, 'monitor'),
          sig('2026-10-27', 'rate_limited', SECURITY_THRESHOLDS.floodPerDay, 'edge'),
          sig('2026-10-27', 'camera_spoof_refused', 1, 'camera'),
          sig('2026-10-27', 'glance_bump', 50) // an ops signal: not on this tab
        ]
      })
    );
    const row = (id: string) => s.signals.rows.find((r) => r.id === id)!;
    expect(s.signals).toMatchObject({ measured: true, counted: true });
    expect(row('mfa_refused')).toMatchObject({ count: 4, prevCount: 7, tone: 'bad', bySurface: [{ surface: 'monitor', count: 3 }, { surface: 'edge', count: 1 }] });
    expect(row('kick')).toMatchObject({ count: 2, tone: 'neutral' });
    expect(row('kick_closed').count).toBe(9);
    expect(s.signals.rows.some((r) => r.id === 'glance_bump')).toBe(false);
    expect(s.alerts.map((a) => a.id).sort()).toEqual(['camera_spoof', 'flood:rate_limited']);
  });

  it('leaves signals unknown when Analytics Engine wasn’t read', () => {
    const s = buildSecuritySection(input({ signals: null, aeFromMs: null }));
    expect(s.signals).toMatchObject({ measured: false, counted: false });
    expect(s.signals.rows.every((r) => r.count === 0 && r.prevCount === null)).toBe(true);
  });

  it('never carries an id: every string in the section is a label, a keyword, an origin or a date', () => {
    const s = buildSecuritySection(
      input({ signals: [{ day: '2026-10-27', name: 'guest_lockout', surface: '', count: 1 }], csp: { measured: true, rows: [csp(2, { page: 'live', blocked: 'https://x.example' })] } })
    );
    expect(JSON.stringify(s)).not.toContain(UUID);
    expect(JSON.stringify(s)).not.toMatch(/@/);
  });
});

describe('Cost centre — ships the security section', () => {
  const emptyRows = (): CostCentreRows => ({
    costEvents: [],
    ledger: [],
    providerUsage: [],
    emails: [],
    studioRuns: [],
    subscriptions: [],
    plans: [],
    profiles: [],
    liveProfiles: 0,
    telemetry: [],
    modelUsage: [],
    truncated: []
  });

  it('builds report.security from the CSP and sign-in counts and the Stream Studio signal rows', () => {
    const report = buildCostCentreReport(emptyRows(), {
      days: 7,
      now: new Date(NOW),
      budgetFor: () => null,
      stream: {
        analytics: {
          configured: true,
          nowMs: NOW,
          aeFromMs: NOW - 90 * 86_400_000,
          ae: [],
          aeSignals: [{ day: '2026-10-27', name: 'session_expired', surface: 'monitor', count: 5 }],
          errors: []
        }
      },
      security: { csp: { measured: true, rows: [] }, signIns: null }
    });
    expect(report.security?.signals.rows.find((r) => r.id === 'session_expired')?.count).toBe(5);
    expect(report.security?.csp.measured).toBe(true);
    expect(report.security?.signIns.measured).toBe(false);
  });

  it('without analytics, signals are unknown rather than zero', () => {
    const report = buildCostCentreReport(emptyRows(), { days: 7, now: new Date(NOW), budgetFor: () => null });
    expect(report.security?.signals.measured).toBe(false);
    expect(report.security?.csp.measured).toBe(false);
  });
});
