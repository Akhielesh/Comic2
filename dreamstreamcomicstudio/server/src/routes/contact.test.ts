// @vitest-environment node
// POST /api/contact (CONTACT-1): Settings › Contact used to insert into public.contact_messages
// straight from the browser — a table no server/sql file created, so every send failed. The route
// below is the only way in now: signed in (401 otherwise), validated against the SQL caps (400),
// limited per user to 5 an hour and 20 a day (429), stored with the service role through the store
// seam (503 when it is not there), and it never echoes or logs what was typed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => ({ lines: [] as unknown[][] }));
vi.mock('../lib/logger.js', () => {
  const push = (...args: unknown[]) => { logged.lines.push(args); };
  return { logger: { debug: push, info: push, warn: push, error: push } };
});

import { InMemoryRateLimitStore, type RateLimitStore } from '../middleware/rateLimitStore.js';
import type { ContactMessageInput, ContactStore } from '../services/contactStore.js';
import { CONTACT_COPY, CONTACT_RATE_LIMITS, createContactRouter, parseContactBody } from './contact.js';

const USER = '0f0e0d0c-0b0a-4908-8706-050403020100';
const EMAIL = 'reader.reply@example.com';
const MESSAGE = 'The page flip stops on page 3 of my comic on my phone. Phone: 555 0100 1234';

// A fake store that records what the route asked it to write.
const fake = { inserts: [] as unknown[], result: { ok: true } as { ok: true } | { ok: false; reason: 'unavailable' | 'failed' }, throws: false };
const store: ContactStore = {
  insert: async (input: ContactMessageInput) => {
    fake.inserts.push(input);
    if (fake.throws) throw new Error(`boom ${input.message}`);
    return fake.result;
  },
  list: async () => ({ ok: true, items: [] }),
  markHandled: async () => ({ ok: false, reason: 'not_found' })
};

// A controllable clock shared by the limiter store and the router.
let clock = Date.UTC(2026, 10, 12, 9, 0, 0);
let limiter = new InMemoryRateLimitStore(() => clock);
let limiterThrows = false;
const throwingLimiter: RateLimitStore = { kind: 'memory', hit: async () => { throw new Error('store down'); } };

let signedInAs: string | null = USER;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (signedInAs) req.user = { id: signedInAs, email: 'account@example.com' };
  next();
});
app.use(
  '/api/contact',
  createContactRouter({
    store,
    now: () => clock,
    limiter: () => (limiterThrows ? throwingLimiter : limiter)
  })
);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  signedInAs = USER;
  clock = Date.UTC(2026, 10, 12, 9, 0, 0);
  limiter = new InMemoryRateLimitStore(() => clock);
  limiterThrows = false;
  fake.inserts.length = 0;
  fake.result = { ok: true };
  fake.throws = false;
  logged.lines.length = 0;
});

const send = async (body: unknown, init: RequestInit = {}) => {
  const res = await fetch(`${base}/api/contact`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null, headers: res.headers };
};

describe('POST /api/contact', () => {
  it('stores a signed-in message through the store and answers { ok: true }', async () => {
    const r = await send({ email: `  ${EMAIL} `, message: `\n${MESSAGE}\n  ` });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    // Trimmed, and the user id comes from the session, never the body.
    expect(fake.inserts).toEqual([{ userId: USER, email: EMAIL, message: MESSAGE }]);
  });

  it('ignores a user id in the body: the row belongs to the signed-in account', async () => {
    await send({ email: EMAIL, message: MESSAGE, userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', user_id: 'x' });
    expect(fake.inserts).toEqual([{ userId: USER, email: EMAIL, message: MESSAGE }]);
  });

  it('401 without a signed-in user, and nothing is stored or counted', async () => {
    signedInAs = null;
    const r = await send({ email: EMAIL, message: MESSAGE });
    expect(r.status).toBe(401);
    expect(r.json.error).toEqual({ message: CONTACT_COPY.signIn, code: 'AUTH_REQUIRED' });
    expect(fake.inserts).toEqual([]);
    // Signing in afterwards still has the full allowance.
    signedInAs = USER;
    for (let i = 0; i < 5; i += 1) expect((await send({ email: EMAIL, message: MESSAGE })).status).toBe(200);
  });

  it.each([
    ['no body fields', {}, 'email', CONTACT_COPY.emailMissing],
    ['a blank email', { email: '   ', message: MESSAGE }, 'email', CONTACT_COPY.emailMissing],
    ['an email without @', { email: 'reader.example.com', message: MESSAGE }, 'email', CONTACT_COPY.emailShape],
    ['an email without a domain dot', { email: 'reader@example', message: MESSAGE }, 'email', CONTACT_COPY.emailShape],
    ['an email with a space', { email: 'rea der@example.com', message: MESSAGE }, 'email', CONTACT_COPY.emailShape],
    ['an email over 320 characters', { email: `${'a'.repeat(310)}@example.com`, message: MESSAGE }, 'email', CONTACT_COPY.emailShape],
    ['an email that is not a string', { email: ['a@b.co'], message: MESSAGE }, 'email', CONTACT_COPY.emailMissing],
    ['a blank message', { email: EMAIL, message: ' \n\t ' }, 'message', CONTACT_COPY.messageMissing],
    ['a message that is not a string', { email: EMAIL, message: { text: MESSAGE } }, 'message', CONTACT_COPY.messageMissing],
    ['a message over 5,000 characters', { email: EMAIL, message: 'x'.repeat(5001) }, 'message', CONTACT_COPY.messageTooLong]
  ])('400 for %s, with calm copy that never echoes the input', async (_label, body, field, copy) => {
    const r = await send(body);
    expect(r.status).toBe(400);
    expect(r.json.error).toEqual({ message: copy, code: 'INVALID_CONTACT', field });
    expect(r.text).not.toContain(EMAIL);
    expect(r.text).not.toContain(MESSAGE);
    expect(r.text).not.toContain('xxxxxxxxxx');
    expect(fake.inserts).toEqual([]);
  });

  it('400 for a body that is not JSON', async () => {
    const r = await send('email=a@b.co&message=hi', { headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBe(400);
    expect(fake.inserts).toEqual([]);
  });

  it('accepts exactly 5,000 characters, counted as Postgres counts them (code points)', async () => {
    expect((await send({ email: EMAIL, message: 'x'.repeat(5000) })).status).toBe(200);
    // 5,000 emoji are 10,000 UTF-16 units but 5,000 characters to char_length.
    expect((await send({ email: EMAIL, message: '🙂'.repeat(5000) })).status).toBe(200);
    expect((await send({ email: EMAIL, message: '🙂'.repeat(5001) })).status).toBe(400);
  });

  it('drops NUL characters, which a Postgres text column cannot hold', async () => {
    await send({ email: EMAIL, message: 'hello\u0000 there' });
    expect(fake.inserts).toEqual([{ userId: USER, email: EMAIL, message: 'hello there' }]);
  });

  it('429 on the 6th send in an hour, with Retry-After and nothing stored', async () => {
    for (let i = 0; i < 5; i += 1) expect((await send({ email: EMAIL, message: `${MESSAGE} #${i}` })).status).toBe(200);
    clock += 10 * 60_000;
    const r = await send({ email: EMAIL, message: MESSAGE });
    expect(r.status).toBe(429);
    expect(r.json.error).toMatchObject({ message: CONTACT_COPY.rateLimited, code: 'RATE_LIMITED' });
    expect(Number(r.headers.get('retry-after'))).toBe(50 * 60);
    expect(r.text).not.toContain(MESSAGE);
    expect(fake.inserts).toHaveLength(5);
  });

  it('the hour window reopens, and 20 a day is the ceiling', async () => {
    let sent = 0;
    for (let hour = 0; hour < 4; hour += 1) {
      for (let i = 0; i < 5; i += 1) {
        expect((await send({ email: EMAIL, message: `${MESSAGE} ${hour}.${i}` })).status).toBe(200);
        sent += 1;
      }
      clock += 60 * 60_000 + 1;
    }
    expect(sent).toBe(20);
    const r = await send({ email: EMAIL, message: MESSAGE });
    expect(r.status).toBe(429);
    expect(fake.inserts).toHaveLength(20);
    // The day window opened at the first send; it reopens a day later.
    clock = Date.UTC(2026, 10, 13, 9, 0, 1);
    expect((await send({ email: EMAIL, message: MESSAGE })).status).toBe(200);
  });

  it('limits each user separately', async () => {
    for (let i = 0; i < 5; i += 1) await send({ email: EMAIL, message: MESSAGE });
    expect((await send({ email: EMAIL, message: MESSAGE })).status).toBe(429);
    signedInAs = '11111111-2222-4333-8444-555555555555';
    expect((await send({ email: EMAIL, message: MESSAGE })).status).toBe(200);
  });

  it('does not count malformed sends against the limit', async () => {
    for (let i = 0; i < 10; i += 1) expect((await send({ email: 'nope', message: MESSAGE })).status).toBe(400);
    for (let i = 0; i < 5; i += 1) expect((await send({ email: EMAIL, message: MESSAGE })).status).toBe(200);
  });

  it('keys the limit on the shared store with the documented windows', () => {
    expect(CONTACT_RATE_LIMITS.map((l) => [l.windowMs, l.maxRequests])).toEqual([
      [60 * 60_000, 5],
      [24 * 60 * 60_000, 20]
    ]);
  });

  it('fails open when the limiter store errors (like createRateLimit)', async () => {
    limiterThrows = true;
    expect((await send({ email: EMAIL, message: MESSAGE })).status).toBe(200);
  });

  it.each([
    ['unavailable (no table / no service role)', { ok: false, reason: 'unavailable' } as const],
    ['failed', { ok: false, reason: 'failed' } as const]
  ])('503 with calm copy when the store is %s', async (_label, result) => {
    fake.result = result;
    const r = await send({ email: EMAIL, message: MESSAGE });
    expect(r.status).toBe(503);
    expect(r.json.error).toEqual({ message: CONTACT_COPY.unavailable, code: 'CONTACT_UNAVAILABLE' });
    expect(r.text).not.toContain(EMAIL);
    expect(r.text).not.toContain(MESSAGE);
  });

  it('503 when the store throws, without echoing or logging the message', async () => {
    fake.throws = true;
    const r = await send({ email: EMAIL, message: MESSAGE });
    expect(r.status).toBe(503);
    expect(r.text).not.toContain(MESSAGE);
    expect(JSON.stringify(logged.lines)).not.toContain(MESSAGE);
  });

  it('logs neither the message nor the address on any path', async () => {
    await send({ email: EMAIL, message: MESSAGE });
    await send({ email: 'bad', message: MESSAGE });
    fake.result = { ok: false, reason: 'failed' };
    await send({ email: EMAIL, message: MESSAGE });
    for (let i = 0; i < 6; i += 1) await send({ email: EMAIL, message: MESSAGE });
    const all = JSON.stringify(logged.lines);
    expect(all).not.toContain(MESSAGE);
    expect(all).not.toContain(EMAIL);
  });
});

describe('parseContactBody', () => {
  it('accepts an ordinary address and message, trimmed', () => {
    expect(parseContactBody({ email: ' a@b.co ', message: ' hi ' })).toEqual({ ok: true, email: 'a@b.co', message: 'hi' });
  });

  it('rejects arrays and non-objects', () => {
    expect(parseContactBody(null).ok).toBe(false);
    expect(parseContactBody([EMAIL, MESSAGE]).ok).toBe(false);
    expect(parseContactBody('x').ok).toBe(false);
  });
});

describe('server/src/index.ts mount', () => {
  it('mounts /api/contact once, after the global requireAuth', () => {
    const src = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    const mounts = [...src.matchAll(/^app\.use\('\/api\/contact',.*$/gm)];
    expect(mounts).toHaveLength(1);
    expect(mounts[0][0]).toMatch(/^app\.use\('\/api\/contact', systemRateLimit, contactRouter\);/);
    const requireAuthAt = src.indexOf("app.use('/api', requireAuth);");
    expect(requireAuthAt).toBeGreaterThan(0);
    expect(mounts[0].index!).toBeGreaterThan(requireAuthAt);
    expect(src).toContain("import { contactRouter } from './routes/contact.js';");
  });
});
