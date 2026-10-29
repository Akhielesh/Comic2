// @vitest-environment node
/**
 * ADR 0006 WS-8 — the 48 h CSP gate for Stream Studio, end to end: a browser's report → the Pages
 * function (functions/csp-report.ts) → the Analytics Engine row it writes → the backend's reader and
 * section (server/src/services/securitySignals.ts).
 *
 * The gate counts only violations of the policy that `ENFORCE_LIVE` will enforce. Stream Studio also
 * sends a Trusted Types policy that stays report-only for good (functions/_middleware.ts
 * LIVE_TRUSTED_TYPES_REPORT_ONLY: MediaPipe's loader assigns `script.src`), and every camera that loads
 * smart vision in Chrome reports against it. Counting those would keep the gate above 0 forever and the
 * warning on for good — so they are their own informational count instead.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { parseCspReports, recordViolation, resetCspCounts, type CspReportEnv } from '../../functions/csp-report';
import { documentSecurityHeaders, LIVE_TRUSTED_TYPES_REPORT_ONLY } from '../../functions/_middleware';
import { buildSecuritySection, parseCspRows, type CspCounts } from '../../server/src/services/securitySignals';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const PAGE = 'https://stream.dreamstreamstudio.ai/';

/** What Chrome posts (Reporting API) for one violation on a Stream Studio page. */
const report = (body: Record<string, unknown>) =>
  JSON.stringify([{ type: 'csp-violation', age: 1, url: PAGE, user_agent: 'x', body: { documentURL: PAGE, disposition: 'report', ...body } }]);

/** MediaPipe's loader: `document.createElement('script'); e.src = …` against require-trusted-types-for 'script'. */
const TRUSTED_TYPES_SINK = { effectiveDirective: 'require-trusted-types-for', blockedURL: 'trusted-types-sink', sourceFile: `${PAGE}assets/vision.js`, sample: 'HTMLScriptElement src|https://cdn…' };

/** Runs reports through the Pages function into a fake Analytics Engine, then reads them back like the backend. */
function pipeline(bodies: string[], hoursAgo = 2): CspCounts {
  const points: { blobs?: string[]; doubles?: number[] }[] = [];
  const env: CspReportEnv = { CSP_REPORTS: { writeDataPoint: (p) => points.push(p) } };
  for (const b of bodies) for (const v of parseCspReports('application/reports+json', b) ?? []) recordViolation(v, env, () => {});
  const hour = new Date(Math.floor((NOW - hoursAgo * 3_600_000) / 3_600_000) * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
  // The cspSql() columns: blob1..blob4 and blob6, double1 summed.
  const data = points.map((p) => ({ hour, disposition: p.blobs?.[0], page: p.blobs?.[1], directive: p.blobs?.[2], blocked: p.blobs?.[3], party: p.blobs?.[5], n: p.doubles?.[0] }));
  return { measured: true, rows: parseCspRows({ data }) };
}

const DAY = 86_400_000;
const section = (csp: CspCounts) =>
  buildSecuritySection({ nowMs: NOW, range: { fromMs: NOW - 7 * DAY, toMs: NOW, prevFromMs: NOW - 14 * DAY, days: 7 }, csp, signIns: null, signals: [], aeFromMs: null });

beforeEach(() => resetCspCounts());

describe('the Stream Studio CSP gate counts only the policy ENFORCE_LIVE will enforce', () => {
  it('Stream Studio always sends Trusted Types report-only, before and after the flip', () => {
    const origin = 'https://stream.dreamstreamstudio.ai';
    const before = documentSecurityHeaders('live', { origin, enforceLive: false });
    const after = documentSecurityHeaders('live', { origin, enforceLive: true });
    expect(before['Content-Security-Policy-Report-Only']).toContain(LIVE_TRUSTED_TYPES_REPORT_ONLY);
    expect(after['Content-Security-Policy-Report-Only']).toBe(LIVE_TRUSTED_TYPES_REPORT_ONLY);
    expect(after['Content-Security-Policy']).not.toContain('trusted-types');
  });

  it('a camera loading smart vision (Trusted Types reports) leaves the gate at 0 and fires nothing', () => {
    const s = section(pipeline(Array.from({ length: 40 }, () => report(TRUSTED_TYPES_SINK))));
    expect(s.csp.firstPartyLive48h).toBe(0);
    expect(s.csp.trustedTypesLive).toBe(40);
    expect(s.alerts).toEqual([]);
    // Still listed, so nobody wonders where the reports went.
    expect(s.csp.top[0]).toMatchObject({ page: 'live', directive: 'require-trusted-types-for', blocked: 'trusted-types-sink', count: 40 });
  });

  it('a violation of the policy that will be enforced still holds the gate and warns', () => {
    const s = section(pipeline([report(TRUSTED_TYPES_SINK), report({ effectiveDirective: 'connect-src', blockedURL: 'wss://other.example/socket?k=1', sourceFile: `${PAGE}assets/index.js` })]));
    expect(s.csp.firstPartyLive48h).toBe(1);
    expect(s.csp.trustedTypesLive).toBe(1);
    expect(s.alerts).toEqual([expect.objectContaining({ id: 'csp_live_violations', severity: 'warning' })]);
  });

  it('if Trusted Types were ever enforced and blocked our code, that is critical — the monitor may have lost smart vision', () => {
    const s = section(pipeline([report({ ...TRUSTED_TYPES_SINK, disposition: 'enforce' })]));
    expect(s.csp.firstPartyLiveEnforced).toBe(1);
    expect(s.alerts).toEqual([expect.objectContaining({ id: 'csp_live_blocked', severity: 'critical' })]);
  });
});
