// @vitest-environment node
/**
 * ADR 0006 WS-1 — POST /csp-report (functions/csp-report.ts): both report formats, counts by
 * directive and blocked origin, and never a URL with a path or query in a log line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REPORT_BYTES,
  classifyDocument,
  handleCspReport,
  normalizeReportedUrl,
  onRequest,
  parseCspReports,
  resetCspCounts,
} from '../../functions/csp-report';

const post = (body: string, type = 'application/reports+json', extra: Record<string, string> = {}) =>
  new Request('https://stream.dreamstreamstudio.ai/csp-report', { method: 'POST', body, headers: { 'content-type': type, ...extra } });

const reportingApiBody = (body: Record<string, unknown>, url = 'https://stream.dreamstreamstudio.ai/?e=evt_1&k=SECRETKEY') =>
  JSON.stringify([{ type: 'csp-violation', age: 10, url, user_agent: 'x', body: { documentURL: url, disposition: 'report', ...body } }]);

beforeEach(() => resetCspCounts());

describe('normalisation (nothing identifying survives)', () => {
  it('cuts URLs down to an origin, keeps keywords, labels extensions', () => {
    expect(normalizeReportedUrl('https://evil.example:8443/steal?token=abc#frag')).toBe('https://evil.example:8443');
    expect(normalizeReportedUrl('wss://x.supabase.co/realtime/v1/websocket?apikey=k')).toBe('wss://x.supabase.co');
    expect(normalizeReportedUrl('inline')).toBe('inline');
    expect(normalizeReportedUrl('eval')).toBe('eval');
    expect(normalizeReportedUrl('wasm-eval')).toBe('wasm-eval');
    expect(normalizeReportedUrl('trusted-types-sink')).toBe('trusted-types-sink');
    expect(normalizeReportedUrl('data')).toBe('data:');
    expect(normalizeReportedUrl('data:image/png;base64,AAAA')).toBe('data:');
    expect(normalizeReportedUrl('blob:https://stream.dreamstreamstudio.ai/1234-uuid')).toBe('blob:');
    expect(normalizeReportedUrl('chrome-extension://abcdef/content.js')).toBe('extension');
    expect(normalizeReportedUrl('moz-extension://abc/x.js')).toBe('extension');
    expect(normalizeReportedUrl('safari-web-extension://abc/x.js')).toBe('extension');
    expect(normalizeReportedUrl('')).toBe('');
    expect(normalizeReportedUrl(42)).toBe('');
    expect(normalizeReportedUrl('not a url')).toBe('other');
  });

  it('says which app a document was, never its path', () => {
    expect(classifyDocument('https://stream.dreamstreamstudio.ai/?e=1#/studio?k=x')).toBe('live');
    expect(classifyDocument('https://dreamstreamstudio.ai/live?k=x')).toBe('live');
    expect(classifyDocument('https://dreamstreamstudio.ai/share/tok_123')).toBe('main');
    expect(classifyDocument('about:srcdoc')).toBe('srcdoc');
    expect(classifyDocument('')).toBe('other');
  });
});

describe('parsing both formats', () => {
  it('reads the Reporting API batch (application/reports+json)', () => {
    const [v] = parseCspReports('application/reports+json', reportingApiBody({
      blockedURL: 'https://odml.pa.googleapis.com/v1/log', effectiveDirective: 'connect-src', sourceFile: 'https://stream.dreamstreamstudio.ai/assets/sceneAi-x.js',
    }))!;
    expect(v).toEqual({
      disposition: 'report', page: 'live', directive: 'connect-src',
      blocked: 'https://odml.pa.googleapis.com', source: 'https://stream.dreamstreamstudio.ai', firstParty: true,
    });
  });

  it('reads the legacy report-uri body (application/csp-report) and falls back to violated-directive', () => {
    const body = JSON.stringify({ 'csp-report': {
      'document-uri': 'https://dreamstreamstudio.ai/live', 'blocked-uri': 'inline', 'violated-directive': 'script-src-elem', 'original-policy': "default-src 'self'",
      disposition: 'enforce', 'source-file': 'https://dreamstreamstudio.ai/live', 'script-sample': 'alert(document.cookie)',
    } });
    expect(parseCspReports('application/csp-report', body)).toEqual([
      { disposition: 'enforce', page: 'live', directive: 'script-src-elem', blocked: 'inline', source: 'https://dreamstreamstudio.ai', firstParty: true },
    ]);
  });

  it('marks extension noise as not first-party, skips non-CSP reports and junk', () => {
    const batch = JSON.stringify([
      { type: 'csp-violation', url: 'https://dreamstreamstudio.ai/live', body: { blockedURL: 'inline', effectiveDirective: 'script-src-elem', sourceFile: 'chrome-extension://abc/x.js', disposition: 'enforce' } },
      { type: 'deprecation', url: 'https://dreamstreamstudio.ai/live', body: { id: 'x' } },
      'nonsense',
      { type: 'csp-violation', body: null },
    ]);
    const out = parseCspReports('application/reports+json', batch)!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ source: 'extension', firstParty: false });
    expect(parseCspReports('application/reports+json', '{not json')).toBeNull();
    expect(parseCspReports('application/csp-report', '{"other":1}')).toBeNull();
  });

  it('never trusts a directive name it does not recognise', () => {
    const [v] = parseCspReports('application/reports+json', reportingApiBody({ blockedURL: 'inline', effectiveDirective: 'script-src; drop table' }))!;
    expect(v.directive).toBe('unknown');
    const [w] = parseCspReports('application/reports+json', reportingApiBody({ blockedURL: 'inline', effectiveDirective: '<img src=x>' }))!;
    expect(w.directive).toBe('unknown');
  });
});

describe('the endpoint', () => {
  it('answers 204, writes one Analytics Engine point per violation, logs no URL', async () => {
    const writeDataPoint = vi.fn();
    const log = vi.fn();
    const res = await handleCspReport(post(reportingApiBody({
      blockedURL: 'https://evil.example/collect?c=SESSIONCOOKIE', effectiveDirective: 'connect-src', sourceFile: 'https://stream.dreamstreamstudio.ai/assets/x.js',
    })), { CSP_REPORTS: { writeDataPoint } }, log);
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ['connect-src'],
      blobs: ['report', 'live', 'connect-src', 'https://evil.example', 'https://stream.dreamstreamstudio.ai', 'first'],
      doubles: [1],
    });
    const line = log.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({ evt: 'csp_violation', n: 1, directive: 'connect-src', blocked: 'https://evil.example' });
    for (const secret of ['SECRETKEY', 'SESSIONCOOKIE', '?', '/assets', '/collect']) expect(line).not.toContain(secret);
  });

  it('logs the 1st, 10th and 100th of a kind — not every one', async () => {
    const log = vi.fn();
    const body = reportingApiBody({ blockedURL: 'inline', effectiveDirective: 'script-src-elem' });
    for (let i = 0; i < 120; i++) await handleCspReport(post(body), undefined, log);
    expect(log.mock.calls.map((c) => JSON.parse(c[0] as string).n)).toEqual([1, 10, 100]);
  });

  it('keeps answering 204 when the Analytics Engine binding throws, or is absent', async () => {
    const env = { CSP_REPORTS: { writeDataPoint: () => { throw new Error('quota'); } } };
    expect((await handleCspReport(post(reportingApiBody({ blockedURL: 'eval', effectiveDirective: 'script-src' })), env, () => {})).status).toBe(204);
    expect((await onRequest({ request: post('[]') })).status).toBe(204);
    expect((await handleCspReport(post('{broken', 'application/csp-report'), undefined, () => {})).status).toBe(204);
  });

  it('accepts the legacy content types, refuses others, and only POST', async () => {
    const legacy = JSON.stringify({ 'csp-report': { 'document-uri': 'https://dreamstreamstudio.ai/', 'blocked-uri': 'inline', 'effective-directive': 'script-src-elem' } });
    expect((await handleCspReport(post(legacy, 'application/csp-report'), undefined, () => {})).status).toBe(204);
    expect((await handleCspReport(post(legacy, 'application/json; charset=utf-8'), undefined, () => {})).status).toBe(204);
    expect((await handleCspReport(post(legacy, 'text/plain'), undefined, () => {})).status).toBe(415);
    const get = await handleCspReport(new Request('https://dreamstreamstudio.ai/csp-report'));
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, OPTIONS');
    expect((await handleCspReport(new Request('https://dreamstreamstudio.ai/csp-report', { method: 'OPTIONS' }))).status).toBe(204);
  });

  it('refuses bodies over 64 KiB, declared or not', async () => {
    const big = `[${' '.repeat(MAX_REPORT_BYTES + 10)}]`;
    expect((await handleCspReport(post(big), undefined, () => {})).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 20; i++) controller.enqueue(new Uint8Array(8 * 1024).fill(32));
        controller.close();
      },
    });
    const undeclared = new Request('https://dreamstreamstudio.ai/csp-report', {
      method: 'POST', body: stream, headers: { 'content-type': 'application/reports+json' }, duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect((await handleCspReport(undeclared, undefined, () => {})).status).toBe(413);
  });

  it('looks at no more than 50 reports from one request', async () => {
    const writeDataPoint = vi.fn();
    const one = { type: 'csp-violation', url: 'https://dreamstreamstudio.ai/', body: { blockedURL: 'inline', effectiveDirective: 'script-src-elem' } };
    await handleCspReport(post(JSON.stringify(Array.from({ length: 80 }, () => one))), { CSP_REPORTS: { writeDataPoint } }, () => {});
    expect(writeDataPoint).toHaveBeenCalledTimes(50);
  });
});
