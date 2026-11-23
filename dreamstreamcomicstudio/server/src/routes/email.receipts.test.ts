// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

const fixture = vi.hoisted(() => ({ row: {} as Record<string, unknown>, reads: 0, down: false }));
vi.mock('../services/supabase.js', () => ({ getSupabaseAdmin: () => ({ from: () => {
  let matches = true;
  let write: Record<string, unknown> | undefined;
  const read = () => {
    fixture.reads++;
    if (fixture.down) return { error: { code: 'DB' }, data: null };
    if (matches && write) Object.assign(fixture.row, write);
    return { error: null, data: matches ? fixture.row : null };
  };
  const chain = {
    update: (v: Record<string, unknown>) => { write = v; return chain; },
    select: () => chain,
    eq: (key: string, value: unknown) => { matches &&= fixture.row[key] === value; return chain; },
    is: (key: string, value: unknown) => { matches &&= fixture.row[key] === value; return chain; },
    gte: (key: string, value: string) => { matches &&= String(fixture.row[key]) >= value; return chain; },
    in: (key: string, values: unknown[]) => { matches &&= values.includes(fixture.row[key]); return chain; },
    maybeSingle: async () => read(),
    then: (resolve: (result: ReturnType<typeof read>) => unknown) => resolve(read())
  };
  return chain;
} }) }));
const { emailRouter } = await import('./email.js');
const ack = 'a'.repeat(43), open = 'b'.repeat(43);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
let base: string, server: Server;
beforeAll(async () => {
  const app = express();
  app.use('/api/email', emailRouter);
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/email`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
afterEach(() => vi.unstubAllEnvs());
beforeEach(() => {
  fixture.reads = 0; fixture.down = false;
  fixture.row = { id: '12345678-1234-4123-8123-123456789abc', status: 'sent', template: 'welcome', receipt_version: 2,
    created_at: new Date().toISOString(), ack_receipt_hash: hash(ack), open_receipt_hash: hash(open), acknowledged_at: null, opened_at: null };
});
const submit = (token = ack, choice = 'yes', extra: Record<string, string> = {}) =>
  fetch(base + '/ack/' + token, { method: 'POST', body: new URLSearchParams({ acknowledge: choice }), headers: extra });

it('GET, HEAD and link previews never acknowledge a message and need no identity or tracking', async () => {
  for (const method of ['GET', 'HEAD']) {
    const res = await fetch(base + '/ack/' + ack, { method });
    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('content-security-policy')).toContain("form-action 'self'");
    if (method === 'GET') {
      const html = await res.text();
      expect(html).toContain('method="post"');
      expect(html).not.toMatch(/<script|<img|example\.test/);
    }
  }
  expect(fixture.reads).toBe(0);
});
it('requires deliberate confirmation, keeps the first timestamp, and records no image or identity inference', async () => {
  expect((await submit(ack, '')).status).toBe(400);
  expect((await submit(ack, 'yes', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(400);
  expect((await submit(open)).status).toBe(410);
  expect((await submit()).status).toBe(200);
  const first = fixture.row.acknowledged_at;
  expect(typeof first).toBe('string');
  expect((await submit()).status).toBe(200);
  expect(fixture.row.acknowledged_at).toBe(first);
  expect(fixture.row.opened_at).toBeNull();
});
it('collects only first image GET when enabled, including eligible legacy messages', async () => {
  const pixel = (token = open, method = 'GET') => fetch(base + '/o/' + token + '.gif', { method });
  vi.stubEnv('EMAIL_OPEN_SIGNALS', 'off');
  expect((await pixel()).headers.get('content-type')).toContain('image/gif');
  vi.stubEnv('EMAIL_OPEN_SIGNALS', 'on');
  await pixel(open, 'HEAD'); await pixel(ack); await pixel(String(fixture.row.id));
  expect(fixture.row.opened_at).toBeNull();
  await pixel();
  const first = fixture.row.opened_at;
  expect(typeof first).toBe('string');
  await pixel();
  expect(fixture.row.opened_at).toBe(first);
  expect(fixture.row.acknowledged_at).toBeNull();
  fixture.row.opened_at = null; fixture.row.receipt_version = null;
  await pixel(String(fixture.row.id));
  expect(typeof fixture.row.opened_at).toBe('string');
});
it('handles opt-out, expiry, excluded templates and store failure without claiming success', async () => {
  vi.stubEnv('EMAIL_ACKNOWLEDGEMENTS', 'off');
  expect((await submit()).status).toBe(410);
  vi.stubEnv('EMAIL_ACKNOWLEDGEMENTS', 'on');
  fixture.row.template = 'auth-security-notice';
  expect((await submit()).status).toBe(410);
  fixture.row.template = 'welcome'; fixture.row.created_at = '2000-01-01T00:00:00Z';
  expect((await submit()).status).toBe(410);
  fixture.down = true;
  expect((await submit()).status).toBe(503);
  expect(fixture.row.acknowledged_at).toBeNull();
});
