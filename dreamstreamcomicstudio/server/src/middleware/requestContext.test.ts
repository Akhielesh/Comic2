import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestLogger } from './requestContext.js';

const SLUG = 'Ab3dEf6hIj9kLm2nP';

/** Drives requestLogger for one request and returns the parsed http_request line. */
const logLine = (originalUrl: string, method = 'GET'): Record<string, unknown> => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const res = Object.assign(new EventEmitter(), { statusCode: 200 });
  const req = { originalUrl, url: originalUrl, method, requestId: 'r1', ip: '203.0.113.9' };
  const next = vi.fn();
  requestLogger(req as never, res as never, next);
  expect(next).toHaveBeenCalledTimes(1);
  res.emit('finish');
  expect(info).toHaveBeenCalledTimes(1);
  const raw = String(info.mock.calls[0][0]);
  info.mockRestore();
  return { ...JSON.parse(raw), __raw: raw };
};

afterEach(() => vi.restoreAllMocks());

describe('requestLogger (S19: no read capability in the access log)', () => {
  it('masks the share slug of the reader report route (the one public slug route that reaches the container)', () => {
    const line = logLine(`/api/comic/public/s/${SLUG}/report?x=secret`, 'POST');
    expect(line.path).toBe('/api/comic/public/s/:slug/report');
    expect(line.__raw).not.toContain(SLUG);
    expect(line.__raw).not.toContain('secret');
    expect(line).toMatchObject({ event: 'http_request', method: 'POST', status: 200, requestId: 'r1' });
  });

  it('masks case variants, classic share tokens and query tokens', () => {
    expect(logLine(`/API/Comic/Public/S/${SLUG}/report`).path).toBe('/api/comic/public/s/:slug/report');
    expect(logLine('/api/shares/token/tok_abc123XYZ').path).toBe('/api/shares/token/:token');
    const newsletter = logLine('/api/newsletter/confirm?t=NEWSLETTERTOKEN');
    expect(newsletter.path).toBe('/api/newsletter/confirm');
    expect(newsletter.__raw).not.toContain('NEWSLETTERTOKEN');
  });

  it('keeps ordinary owner paths (project ids) for debugging', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(logLine(`/api/comic/projects/${id}/stream`).path).toBe(`/api/comic/projects/${id}/stream`);
  });
});
