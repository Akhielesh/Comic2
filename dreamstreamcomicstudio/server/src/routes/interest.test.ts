// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFileSync } from 'fs';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// Register interest end to end, over an in-memory stand-in for the service-role Supabase client
// (waitlist_signups with its unique (email, kind) index, email_log, email_suppressions and the
// summary RPC). The real emailStore / interestStore run on top of it; only the mailer, Turnstile
// and the role lookup are faked. The mailer fake writes email_log rows like the real one, so the
// per-recipient throttle is exercised against the same table it reads in production. `latencyMs`
// delays every query, so parallel requests really interleave (the send-claim race).

type Row = Record<string, unknown>;

const h = vi.hoisted(() => {
  vi.stubEnv('EMAIL_PUBLIC_BASE_URL', 'https://dreamstreamstudio.ai');
  vi.stubEnv('APP_PUBLIC_URL', 'https://dreamstreamstudio.ai');
  // Signs the confirmation tokens (services/confirmToken.ts).
  vi.stubEnv('EMAIL_HMAC_SECRET', 'test-hmac-secret');

  const state = {
    noAdmin: false,
    mailerConfigured: true,
    turnstileConfigured: true,
    /** What the next confirmation sends do: 'sent' | 'failed' | 'not_configured' | 'rate_limited'. */
    sendOutcome: 'sent' as 'sent' | 'failed' | 'not_configured' | 'rate_limited',
    /** Inject a query error: { table, op, code }. */
    fail: null as null | { table: string; op: 'select' | 'insert' | 'update' | 'rpc'; code: string; message?: string },
    /** Hide a function from the fake schema (PGRST202), as before the SQL file is applied. */
    rpcMissing: false,
    /** Simulate a concurrent insert winning the race once. */
    raceOnInsert: false,
    isAdmin: false,
    /** Delay every query by this much (0 = synchronous). */
    latencyMs: 0,
    /**
     * Runs just before an update is applied (after its latency), so a test can land a parallel
     * request's write between another request's read and its write. Returns true once it acted.
     */
    beforeUpdate: null as null | ((table: string, payload: Row) => boolean)
  };
  const tables: Record<string, Row[]> = { waitlist_signups: [], email_log: [], email_suppressions: [] };
  let seq = 0;

  type Filter = (r: Row) => boolean;
  const URL_LIMIT_BYTES = 8192;
  const builder = (table: string) => {
    const filters: Filter[] = [];
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let payload: Row | Row[] | null = null;
    let head = false;
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    let range: [number, number] | null = null;
    let single: 'maybe' | 'one' | null = null;
    let returning = false;
    // Filters travel in the request URL; past what gateways accept, the request fails (414).
    let urlBytes = 0;
    const inUrl = (value: unknown) => {
      urlBytes += encodeURIComponent(String(value)).length;
    };

    const run = () => {
      const rows = tables[table] ?? (tables[table] = []);
      const injected = state.fail && state.fail.table === table && state.fail.op === op ? state.fail : null;
      if (injected) return { data: null, error: { code: injected.code, message: injected.message ?? injected.code }, count: null };
      if (urlBytes > URL_LIMIT_BYTES) return { data: null, error: { code: '414', message: 'Request-URI Too Large' }, count: null };
      if (op === 'insert') {
        const list = Array.isArray(payload) ? payload : [payload as Row];
        for (const r of list) {
          if (table === 'waitlist_signups') {
            const clash = rows.some((x) => String(x.email).toLowerCase() === String(r.email).toLowerCase() && x.kind === r.kind);
            if (clash || state.raceOnInsert) {
              if (state.raceOnInsert) {
                state.raceOnInsert = false;
                rows.push({ id: `row-${++seq}`, created_at: new Date().toISOString(), confirmed: false, product_interests: [], ...r, confirm_token: 'raced-token' });
              }
              return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' }, count: null };
            }
          }
          rows.push({ id: `row-${++seq}`, created_at: new Date().toISOString(), ...r });
        }
        return { data: list, error: null, count: null };
      }
      if (op === 'upsert') {
        const r = payload as Row;
        const i = rows.findIndex((x) => x.email === r.email && x.scope === r.scope);
        if (i >= 0) rows[i] = { ...rows[i], ...r };
        else rows.push({ created_at: new Date().toISOString(), ...r });
        return { data: null, error: null, count: null };
      }
      if (op === 'update' && state.beforeUpdate?.(table, payload as Row)) state.beforeUpdate = null;
      let matched = rows.filter((r) => filters.every((f) => f(r)));
      if (op === 'update') {
        for (const r of matched) Object.assign(r, structuredClone(payload));
        return { data: returning ? matched.map((r) => structuredClone(r)) : null, error: null, count: null };
      }
      if (op === 'delete') {
        tables[table] = rows.filter((r) => !matched.includes(r));
        return { data: null, error: null, count: null };
      }
      if (order) {
        const { col, asc } = order;
        matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (range) matched = matched.slice(range[0], range[1] + 1);
      if (limit != null) matched = matched.slice(0, limit);
      if (head) return { data: null, error: null, count: matched.length };
      const copy = matched.map((r) => ({ ...r }));
      if (single) return { data: copy[0] ?? null, error: null, count: null };
      return { data: copy, error: null, count: null };
    };

    // PostgREST's or=(col.op.value,…): just the operators the code uses.
    const orFilter = (expr: string): Filter => {
      const parts = expr.match(/(?:[^,"]+|"[^"]*")+/g) ?? [];
      const tests = parts.map((part) => {
        const [col, oper, ...rest] = part.split('.');
        const value = rest.join('.').replace(/^"|"$/g, '');
        if (oper === 'is' && value === 'null') return (r: Row) => (r[col] ?? null) === null;
        if (oper === 'lt') return (r: Row) => r[col] != null && String(r[col]) < value;
        if (oper === 'gt') return (r: Row) => r[col] != null && String(r[col]) > value;
        if (oper === 'eq') return (r: Row) => String(r[col]) === value;
        throw new Error(`fake: unsupported or() operator ${oper}`);
      });
      return (r) => tests.some((t) => t(r));
    };
    // A Postgres array literal with quoted elements ({"a","b\"c"}), as the code sends them.
    const parseTextArray = (literal: string): string[] => {
      if (!/^\{.*\}$/.test(literal)) throw new Error(`fake: not an array literal ${literal}`);
      return [...literal.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
    };
    // A column, or a jsonb path into one (metadata->pending_interests), as PostgREST reads it.
    const valueAt = (r: Row, col: string): unknown => {
      const [base, ...keys] = col.split('->');
      let v: unknown = r[base];
      for (const k of keys) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Row)[k] : undefined;
      return v;
    };
    // jsonb / array containment (@>), the way Postgres compares them: a stored PgNumeric (a jsonb
    // number JavaScript can't hold exactly) equals only itself, never the double it parses to.
    const contains = (a: unknown, b: unknown): boolean => {
      if (Array.isArray(b)) return Array.isArray(a) && b.every((x) => a.some((y) => contains(y, x)));
      if (b && typeof b === 'object') {
        return Boolean(a) && typeof a === 'object' && !Array.isArray(a) && Object.entries(b).every(([k, v]) => k in (a as Row) && contains((a as Row)[k], v));
      }
      return a === b;
    };
    const containFilter = (col: string, oper: string, value: string): Filter => {
      const given = col.startsWith('metadata') ? JSON.parse(value) : parseTextArray(value);
      if (oper === 'cs') return (r) => valueAt(r, col) != null && contains(valueAt(r, col), given);
      if (oper === 'cd') return (r) => valueAt(r, col) != null && contains(given, valueAt(r, col));
      throw new Error(`fake: unsupported filter operator ${oper}`);
    };
    // ILIKE with backslash escapes; '*' is PostgREST's alias for '%'.
    const ilikeFilter = (col: string, pattern: string): Filter => {
      let re = '';
      for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '\\' && i + 1 < pattern.length) re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        else if (c === '%' || c === '*') re += '.*';
        else if (c === '_') re += '.';
        else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      const rx = new RegExp(`^${re}$`, 'i');
      return (r) => rx.test(String(r[col] ?? ''));
    };
    const later = async () => {
      if (state.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, state.latencyMs));
      return run();
    };

    const q = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        if (op === 'select') head = Boolean(opts?.head);
        else returning = true;
        return q;
      },
      insert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), q),
      update: (p: Row) => ((op = 'update'), (payload = p), q),
      upsert: (p: Row) => ((op = 'upsert'), (payload = p), q),
      delete: () => ((op = 'delete'), q),
      eq: (col: string, val: unknown) => (inUrl(val), filters.push((r) => r[col] === val), q),
      in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), q),
      gte: (col: string, val: string) => (filters.push((r) => String(r[col]) >= val), q),
      is: (col: string, val: unknown) => (filters.push((r) => (valueAt(r, col) ?? null) === val), q),
      or: (expr: string) => (inUrl(expr), filters.push(orFilter(expr)), q),
      filter: (col: string, oper: string, value: string) => (inUrl(value), filters.push(containFilter(col, oper, value)), q),
      not: (col: string, oper: string, value: unknown) => {
        if (oper !== 'is' || value !== null) throw new Error(`fake: unsupported not() ${oper}`);
        filters.push((r) => (r[col] ?? null) !== null);
        return q;
      },
      ilike: (col: string, pattern: string) => (inUrl(pattern), filters.push(ilikeFilter(col, pattern)), q),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), q),
      limit: (n: number) => ((limit = n), q),
      range: (a: number, b: number) => ((range = [a, b]), q),
      maybeSingle: async () => ((single = 'maybe'), later()),
      single: async () => ((single = 'one'), later()),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => later().then(resolve, reject)
    };
    return q;
  };

  const rpc = vi.fn(async (name: string) => {
    if (state.fail?.op === 'rpc') return { data: null, error: { code: state.fail.code, message: state.fail.code } };
    if (name !== 'waitlist_interest_summary' || state.rpcMissing) {
      return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name}` } };
    }
    // The SQL function's semantics, over the fake table.
    const out = new Map<string, { confirmed: number; pending: number; unsubscribed: number; access_requests: number }>();
    const bump = (studio: string, r: Row) => {
      const t = out.get(studio) ?? { confirmed: 0, pending: 0, unsubscribed: 0, access_requests: 0 };
      if (r.kind === 'access') t.access_requests++;
      else if (r.unsubscribed_at) t.unsubscribed++;
      else if (r.confirmed) t.confirmed++;
      else t.pending++;
      out.set(studio, t);
    };
    for (const r of tables.waitlist_signups) {
      bump('*', r);
      for (const s of (r.product_interests as string[]) ?? []) bump(s, r);
    }
    return { data: [...out].map(([studio, t]) => ({ studio, ...t })), error: null };
  });

  const admin = { from: (t: string) => builder(t), rpc };

  const now = () => new Date().toISOString();
  const logSend = (to: string, template: string, status: string) =>
    tables.email_log.push({ id: `log-${++seq}`, to_email: to, template, kind: 'essential', status, created_at: now() });

  const sendNewsletterConfirm = vi.fn(async (to: string, _url: string, _firstName?: string) => {
    if (state.sendOutcome === 'not_configured') {
      logSend(to, 'newsletter-confirm', 'skipped');
      return { ok: false, skipped: 'not_configured' };
    }
    if (state.sendOutcome === 'rate_limited') {
      logSend(to, 'newsletter-confirm', 'rate_limited');
      return { ok: false, skipped: 'rate_limited' };
    }
    logSend(to, 'newsletter-confirm', state.sendOutcome);
    return state.sendOutcome === 'sent' ? { ok: true, messageId: 'm1' } : { ok: false, error: 'worker responded 500' };
  });
  const sendNewsletterWelcome = vi.fn(async () => ({ ok: true }));
  // The early-access receipt, logged like the real mailer does (the per-inbox day limit reads it).
  const sendAccessRequested = vi.fn(async (to: string, _firstName?: string) => {
    // The real mailer reads usage before it logs the send: a parallel request's check can run first.
    if (state.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, state.latencyMs * 4));
    logSend(to, 'access-requested', 'sent');
    return { ok: true, messageId: 'm2' };
  });
  const verifyTurnstile = vi.fn(async (token?: string) => token === 'good-token');

  return { state, tables, admin, rpc, sendNewsletterConfirm, sendNewsletterWelcome, sendAccessRequested, verifyTurnstile, logSend };
});

vi.mock('../services/supabase.js', () => ({
  getSupabaseAdmin: () => {
    if (h.state.noAdmin) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
    return h.admin;
  }
}));
vi.mock('../services/mailer.js', () => ({
  mailerConfigured: () => h.state.mailerConfigured,
  sendNewsletterConfirm: h.sendNewsletterConfirm,
  sendNewsletterWelcome: h.sendNewsletterWelcome,
  sendAccessRequested: h.sendAccessRequested,
  verifyUnsubscribeToken: (_e: string, t: string) => t === 'valid-unsub'
}));
vi.mock('../services/turnstile.js', () => ({
  turnstileConfigured: () => h.state.turnstileConfigured,
  verifyTurnstile: h.verifyTurnstile
}));
vi.mock('../services/invites.js', () => ({ resendPendingInvite: vi.fn(async () => ({ status: 'none' })) }));
vi.mock('../services/rbac.js', () => ({
  resolveAccessProfile: vi.fn(async () => ({
    isAdmin: h.state.isAdmin,
    isModerator: h.state.isAdmin,
    isResearcher: h.state.isAdmin,
    bootstrapAdmin: false,
    roles: h.state.isAdmin ? ['admin'] : []
  }))
}));

const { interestRouter, adminInterestRouter } = await import('./interest.js');
const { newsletterRouter } = await import('./newsletter.js');
const { requireAdmin } = await import('../middleware/requireAdmin.js');
const {
  ANSWER_FLOOR_MS,
  CONFIRM_EMAIL_BUDGET_SHARE,
  INTEREST_CONFIRM_THROTTLE,
  answerTargetMs,
  checkConfirmThrottle,
  holdAnswer,
  noteSentDuration,
  resetInterestGuardsForTests
} = await import('../services/interestStore.js');
const { WAITLIST_PRODUCTS, inboxKey } = await import('../services/emailStore.js');
const { STUDIO_INTEREST_IDS } = await import('../../../services/studioInterests.js');

// Mirrors the production mounts in server/src/index.ts (minus the per-IP limiters), with a
// stand-in for requireAuth/optionalAuth that signs the caller in when `signedIn` is set.
let signedIn = false;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (signedIn) req.user = { id: 'admin-user', email: 'boss@dreamstreamstudio.ai' };
  next();
});
app.use('/api/interest', interestRouter);
app.use('/api/newsletter', newsletterRouter);
app.use('/api/admin/interest', requireAdmin, adminInterestRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  Object.assign(h.state, {
    noAdmin: false,
    mailerConfigured: true,
    turnstileConfigured: true,
    sendOutcome: 'sent',
    fail: null,
    rpcMissing: false,
    raceOnInsert: false,
    isAdmin: false,
    latencyMs: 0,
    beforeUpdate: null
  });
  h.tables.waitlist_signups = [];
  h.tables.email_log = [];
  h.tables.email_suppressions = [];
  // In-memory per-inbox claims and answer timings (interestStore.ts): fresh per test, no floor.
  resetInterestGuardsForTests({ answerFloorMs: 0 });
  h.sendNewsletterConfirm.mockClear();
  h.sendNewsletterWelcome.mockClear();
  h.sendAccessRequested.mockClear();
  h.verifyTurnstile.mockClear();
  signedIn = false;
});

const post = async (body: unknown, path = '/api/interest') => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  // No error middleware in this harness: a 500 is Express's HTML page, so parse JSON only.
  const text = await res.text();
  const json = (text.startsWith('{') ? JSON.parse(text) : {}) as Record<string, unknown>;
  return { status: res.status, headers: res.headers, body: json };
};

const register = (over: Record<string, unknown> = {}) =>
  post({ email: 'Ada@Example.com', studios: ['atlas_studio', 'comic_studio'], source: 'home-stay-updated', captchaToken: 'good-token', ...over });

const rows = () => h.tables.waitlist_signups;
const row = () => rows()[0] as Row;
/** Move every stored timestamp back, as if `ms` had passed. */
const age = (ms: number) => {
  const back = (v: unknown) => (typeof v === 'string' ? new Date(Date.parse(v) - ms).toISOString() : v);
  for (const r of h.tables.email_log) r.created_at = back(r.created_at);
  for (const r of rows()) {
    r.created_at = back(r.created_at);
    r.confirm_sent_at = back(r.confirm_sent_at);
  }
};
const tokenFromLastEmail = (): string => {
  const url = String(h.sendNewsletterConfirm.mock.calls.at(-1)?.[1] ?? '');
  return new URL(url).searchParams.get('t') ?? '';
};
/** What a mail scanner or a person's first click does: GET the link in the email. */
const openLink = (email: string, token: string) =>
  fetch(`${base}/api/newsletter/confirm?e=${encodeURIComponent(email)}&t=${token}`, { redirect: 'manual' });
/** The Confirm button on that page: a form POST, same origin. */
const pressConfirm = (email: string, token: string) =>
  fetch(`${base}/api/newsletter/confirm`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ e: email, t: token }).toString()
  });
/** What a browser posts when the person presses Confirm on the page `html`: the form's hidden fields. */
const pressConfirmOnPage = (html: string) => {
  const fields = Object.fromEntries([...html.matchAll(/<input type="hidden" name="([a-z])" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
  return fetch(`${base}/api/newsletter/confirm`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString()
  });
};
/** The Unsubscribe link in an email (the mailer fake's verifyUnsubscribeToken accepts 'valid-unsub'). */
const unsubUrl = (email: string, token = 'valid-unsub') => `${base}/api/newsletter/unsubscribe?e=${encodeURIComponent(email)}&t=${token}`;
/** What a mail scanner or a person's first click does with it: GET. */
const openUnsubscribe = (email: string, token?: string) => fetch(unsubUrl(email, token), { redirect: 'manual' });
/** The Unsubscribe button on that page: a form POST back to the link. */
const pressUnsubscribe = (email: string, token?: string) =>
  fetch(unsubUrl(email, token), {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'via=page'
  });
/** A mail provider's RFC 8058 One-Click POST (List-Unsubscribe-Post), on the person's request. */
const oneClickUnsubscribe = (email: string, token?: string) =>
  fetch(unsubUrl(email, token), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click'
  });

/** A jsonb number JavaScript can't hold exactly: it serialises to the nearest double, as a real read does. */
class PgNumeric {
  constructor(readonly text: string) {}
  toJSON() {
    return Number(this.text);
  }
}

describe('the shared studio list', () => {
  it('is the one the server accepts (emailStore whitelist = services/studioInterests.ts)', () => {
    expect([...WAITLIST_PRODUCTS]).toEqual([...STUDIO_INTEREST_IDS]);
    expect(WAITLIST_PRODUCTS).not.toContain('code_studio');
    expect(WAITLIST_PRODUCTS).not.toContain('dashboards');
  });
});

describe('POST /api/interest — validation', () => {
  it.each([
    [{ email: '' }, 'invalid_email'],
    [{ email: 'not-an-email' }, 'invalid_email'],
    [{ email: `${'a'.repeat(320)}@x.io` }, 'invalid_email'],
    [{ studios: 'comic_studio' }, 'invalid_studios'],
    [{ studios: [] }, 'invalid_studios'],
    [{ studios: ['code_studio', 'dashboards'] }, 'invalid_studios'],
    [{ studios: Array.from({ length: 21 }, () => 'comic_studio') }, 'invalid_studios']
  ])('rejects %j with 400 %s, before the captcha and the database', async (over, code) => {
    const res = await register(over);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, code });
    expect(h.verifyTurnstile).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it('drops unknown ids, dedupes, and stores the canonical order', async () => {
    const res = await register({ studios: ['future_studios', 'code_studio', 'comic_studio', 'comic_studio'] });
    expect(res.status).toBe(200);
    expect(res.body.studios).toEqual(['comic_studio', 'future_studios']);
    expect(row().product_interests).toEqual(['comic_studio', 'future_studios']);
  });
});

describe('POST /api/interest — captcha', () => {
  it('requires a token while Turnstile is configured', async () => {
    const res = await register({ captchaToken: undefined });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('captcha_required');
    expect(rows()).toHaveLength(0);
  });

  it('rejects a token that fails verification', async () => {
    const res = await register({ captchaToken: 'bad-token' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('captcha_failed');
    expect(rows()).toHaveLength(0);
    expect(h.sendNewsletterConfirm).not.toHaveBeenCalled();
  });

  it('still verifies a sent token when Turnstile is not configured, and accepts none', async () => {
    h.state.turnstileConfigured = false;
    expect((await register({ captchaToken: 'bad-token' })).body.code).toBe('captcha_failed');
    expect((await register({ captchaToken: undefined })).status).toBe(200);
  });
});

describe('POST /api/interest — registration and double opt-in', () => {
  it('stores a pending row and emails a signed confirm link on the public origin', async () => {
    const res = await register();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'pending', studios: ['comic_studio', 'atlas_studio'], message: expect.stringMatching(/Comic Studio and Atlas Studio/) });
    expect(rows()).toHaveLength(1);
    expect(row()).toMatchObject({ email: 'ada@example.com', kind: 'updates', confirmed: false, source: 'home-stay-updated' });
    expect(String(row().confirm_token)).toMatch(/^[0-9a-f]{64}$/);

    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    const [to, url] = h.sendNewsletterConfirm.mock.calls[0];
    expect(to).toBe('ada@example.com');
    expect(url).toBe(`https://dreamstreamstudio.ai/api/newsletter/confirm?e=ada%40example.com&t=${row().confirm_token}`);
    // Nothing secret goes back to the browser.
    expect(JSON.stringify(res.body)).not.toContain(String(row().confirm_token));
  });

  it('never builds the link from a forged Host header', async () => {
    const res = await fetch(`${base}/api/interest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-host': 'evil.example', host: 'evil.example' },
      body: JSON.stringify({ email: 'ada@example.com', studios: ['comic_studio'], captchaToken: 'good-token' })
    });
    expect(res.status).toBe(200);
    expect(String(h.sendNewsletterConfirm.mock.calls[0][1])).toMatch(/^https:\/\/dreamstreamstudio\.ai\//);
  });

  it('the email link only shows a Confirm page; nothing changes until the button is pressed', async () => {
    await register();
    const token = tokenFromLastEmail();
    const page = await openLink('ada@example.com', token);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('same-origin');
    expect(page.headers.get('content-security-policy')).toMatch(/form-action 'self' https:\/\/dreamstreamstudio\.ai/);
    expect(page.headers.get('content-security-policy')).not.toMatch(/script-src/);
    const html = await page.text();
    expect(html).toContain('<form method="post" action="/api/newsletter/confirm">');
    expect(html).toContain(`name="t" value="${token}"`);
    expect(html).not.toMatch(/<script/i);
    // A link scanner fetching it twice changes nothing.
    await openLink('ada@example.com', token);
    expect(row()).toMatchObject({ confirmed: false, confirm_token: token });
    expect(h.sendNewsletterWelcome).not.toHaveBeenCalled();
  });

  it('pressing Confirm activates it; the welcome goes out once; repeat clicks are harmless', async () => {
    await register();
    const token = tokenFromLastEmail();
    const first = await pressConfirm('ada@example.com', token);
    expect(first.status).toBe(303);
    expect(first.headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=confirmed');
    expect(row()).toMatchObject({ confirmed: true, confirm_token: null });
    expect(typeof row().confirmed_at).toBe('string');
    expect(h.sendNewsletterWelcome).toHaveBeenCalledTimes(1);
    // A second press, or opening the link again, sends nothing new.
    expect((await pressConfirm('ada@example.com', token)).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=confirmed');
    expect((await openLink('ada@example.com', token)).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=confirmed');
    expect(h.sendNewsletterWelcome).toHaveBeenCalledTimes(1);
  });

  it('a link only works for the address it was sent to', async () => {
    await register();
    const token = tokenFromLastEmail();
    h.tables.waitlist_signups.push({ id: 'other', email: 'eve@example.com', kind: 'updates', confirmed: false, confirm_token: token, product_interests: [] });
    expect((await pressConfirm('eve@example.com', token)).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=invalid');
    expect(rows().find((r) => r.id === 'other')).toMatchObject({ confirmed: false });
  });

  it('treats a concurrent insert of the same address as the existing row', async () => {
    h.state.raceOnInsert = true;
    const res = await register();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(rows()).toHaveLength(1);
  });

  it('an unsubscribed address must confirm again; only the button press re-activates it', async () => {
    await register({ studios: ['comic_studio'] });
    await pressConfirm('ada@example.com', tokenFromLastEmail());
    await oneClickUnsubscribe('ada@example.com');
    expect(h.tables.email_suppressions).toHaveLength(1);
    const unsubscribedAt = row().unsubscribed_at;
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    h.sendNewsletterConfirm.mockClear();
    h.sendNewsletterWelcome.mockClear();

    const res = await register({ studios: ['atlas_studio'] });
    expect(res.body.status).toBe('pending');
    expect(row()).toMatchObject({ confirmed: false, product_interests: ['atlas_studio'] });
    expect(row().unsubscribed_at).toBe(unsubscribedAt);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);

    // Mail scanners open the link: still unsubscribed, still suppressed.
    const token = tokenFromLastEmail();
    expect((await openLink('ada@example.com', token)).status).toBe(200);
    expect(row().unsubscribed_at).toBe(unsubscribedAt);
    expect(h.tables.email_suppressions).toHaveLength(1);

    // The press is the fresh opt-in: subscription back on, marketing suppression lifted.
    await pressConfirm('ada@example.com', token);
    expect(row()).toMatchObject({ confirmed: true, unsubscribed_at: null, product_interests: ['atlas_studio'] });
    expect(h.tables.email_suppressions).toHaveLength(0);
    expect(h.sendNewsletterWelcome).toHaveBeenCalledTimes(1);
  });

  it('unsubscribing clears the picks (waiting ones too); an old confirm link then fails', async () => {
    await register({ studios: ['comic_studio'] });
    const token = tokenFromLastEmail();
    await pressConfirm('ada@example.com', token);
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    await register({ studios: ['stream_studio'] }); // waits for a click
    expect(row().metadata).toMatchObject({ pending_interests: ['stream_studio'] });
    const unsub = await pressUnsubscribe('ada@example.com');
    expect(unsub.status).toBe(303);
    expect(unsub.headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=unsubscribed');
    expect(row()).toMatchObject({ product_interests: [], confirm_token: null });
    expect(row().metadata).not.toHaveProperty('pending_interests');
    expect(typeof row().unsubscribed_at).toBe('string');
    expect(h.tables.email_suppressions).toMatchObject([{ email: 'ada@example.com', scope: 'marketing' }]);
    expect((await openLink('ada@example.com', token)).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=invalid');
    expect((await pressConfirm('ada@example.com', tokenFromLastEmail())).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=invalid');
    expect(h.tables.email_suppressions).toHaveLength(1);
  });
});

describe('/api/newsletter/unsubscribe — the email link only shows a page; the button or One-Click unsubscribes', () => {
  it('a GET (a mail scanner, or the first click) changes nothing; the page’s button unsubscribes', async () => {
    await register({ studios: ['comic_studio'] });
    await pressConfirm('ada@example.com', tokenFromLastEmail());
    for (let i = 0; i < 2; i++) {
      const page = await openUnsubscribe('ada@example.com');
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/text\/html/);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('referrer-policy')).toBe('same-origin');
      expect(page.headers.get('content-security-policy')).toMatch(/form-action 'self' https:\/\/dreamstreamstudio\.ai/);
      expect(page.headers.get('content-security-policy')).not.toMatch(/script-src/);
      const html = await page.text();
      expect(html).toContain('<form method="post" action="/api/newsletter/unsubscribe?e=ada%40example.com&amp;t=valid-unsub">');
      expect(html).toContain('<input type="hidden" name="via" value="page">');
      // What the button does, as Privacy #emails and markUnsubscribed describe it.
      expect(html).toContain('The studio picks and any note saved with your updates are deleted too.');
      expect(html).not.toMatch(/<script/i);
    }
    expect(row()).toMatchObject({ confirmed: true, unsubscribed_at: null, product_interests: ['comic_studio'] });
    expect(h.tables.email_suppressions).toHaveLength(0);

    const press = await pressUnsubscribe('ada@example.com');
    expect(press.status).toBe(303);
    expect(press.headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=unsubscribed');
    expect(row()).toMatchObject({ product_interests: [] });
    expect(typeof row().unsubscribed_at).toBe('string');
    expect(h.tables.email_suppressions).toMatchObject([{ email: 'ada@example.com', scope: 'marketing' }]);
  });

  it('the RFC 8058 One-Click POST unsubscribes at once and answers JSON', async () => {
    await register({ studios: ['comic_studio'] });
    const res = await oneClickUnsubscribe('ada@example.com');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(typeof row().unsubscribed_at).toBe('string');
  });

  it('a link that doesn’t verify: the GET and the button bounce to the banner, One-Click gets 400, nothing changes', async () => {
    await register({ studios: ['comic_studio'] });
    expect((await openUnsubscribe('ada@example.com', 'forged')).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=unsub-invalid');
    const press = await pressUnsubscribe('ada@example.com', 'forged');
    expect(press.status).toBe(303);
    expect(press.headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=unsub-invalid');
    expect((await oneClickUnsubscribe('ada@example.com', 'forged')).status).toBe(400);
    expect(row().unsubscribed_at ?? null).toBeNull();
    expect(row().product_interests).toEqual(['comic_studio']);
    expect(h.tables.email_suppressions).toHaveLength(0);
  });
});

describe('POST /api/interest — no oracle, no tampering (anyone can type anyone’s address)', () => {
  const seedRow = (r: Row) => h.tables.waitlist_signups.push({ id: `seed-${rows().length}`, kind: 'updates', confirmed: false, confirm_token: null, confirm_sent_at: null, unsubscribed_at: null, product_interests: [], metadata: {}, created_at: '2026-11-01T00:00:00.000Z', ...r });

  it('answers every state the same way, and echoes only what was submitted', async () => {
    const recent = new Date().toISOString();
    seedRow({ email: 'subscribed@example.com', confirmed: true, confirmed_at: '2026-10-01T00:00:00.000Z', product_interests: ['stream_studio', 'chat_studio'] });
    seedRow({ email: 'pending@example.com', product_interests: ['atlas_studio'], confirm_sent_at: '2026-11-01T00:00:00.000Z' });
    seedRow({ email: 'gone@example.com', confirmed: true, unsubscribed_at: '2026-10-02T00:00:00.000Z' });
    seedRow({ email: 'recent@example.com', product_interests: ['comic_studio'], confirm_sent_at: recent });
    for (let i = 0; i < 3; i++) h.logSend('capped@example.com', 'newsletter-confirm', 'sent');
    h.tables.email_log.forEach((r) => (r.created_at = new Date(Date.now() - 3_600_000).toISOString()));

    const addresses = ['nobody@example.com', 'subscribed@example.com', 'pending@example.com', 'gone@example.com', 'recent@example.com', 'capped@example.com'];
    const answers = [];
    for (const email of addresses) answers.push(await register({ email, studios: ['future_studios'] }));
    for (const a of answers) {
      expect(a.status).toBe(200);
      expect(a.headers.get('retry-after')).toBeNull();
    }
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    expect(answers[0].body).toEqual({ ok: true, status: 'pending', studios: ['future_studios'], message: expect.any(String) });
    expect(answers[0].body.message).not.toMatch(/Stream|Chat|Atlas|Comic|already|subscribed/i);
  });

  it('never changes a subscriber’s picks without their click; their click applies them', async () => {
    await register({ studios: ['comic_studio'] });
    await pressConfirm('ada@example.com', tokenFromLastEmail());
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    h.sendNewsletterConfirm.mockClear();
    h.sendNewsletterWelcome.mockClear();

    const res = await register({ studios: ['stream_studio', 'comic_studio'] });
    expect(res.body).toMatchObject({ status: 'pending', studios: ['comic_studio', 'stream_studio'] });
    expect(row()).toMatchObject({ confirmed: true, product_interests: ['comic_studio'] });
    expect(row().metadata).toMatchObject({ pending_interests: ['stream_studio'] });
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);

    await pressConfirm('ada@example.com', tokenFromLastEmail());
    expect(row()).toMatchObject({ confirmed: true, unsubscribed_at: null, product_interests: ['comic_studio', 'stream_studio'] });
    expect(row().metadata).not.toHaveProperty('pending_interests');
    expect(h.sendNewsletterWelcome).not.toHaveBeenCalled(); // not a new opt-in
  });

  it('a row written straight into the table (public anon key) can’t confirm or lift a suppression', async () => {
    // What the live anon INSERT grant allows before register_interest_2026_11.sql: a chosen token.
    seedRow({ email: 'victim@example.com', confirm_token: 'x'.repeat(48), confirm_sent_at: new Date().toISOString() });
    h.tables.email_suppressions.push({ email: 'victim@example.com', scope: 'marketing', reason: 'user_unsubscribe' });
    expect((await openLink('victim@example.com', 'x'.repeat(48))).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=invalid');
    expect((await pressConfirm('victim@example.com', 'x'.repeat(48))).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=invalid');
    // A well-formed token that this server never signed fails too.
    const fake = 'a'.repeat(64);
    row().confirm_token = fake;
    expect((await pressConfirm('victim@example.com', fake)).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=invalid');
    expect(row()).toMatchObject({ confirmed: false });
    expect(h.tables.email_suppressions).toHaveLength(1);

    // Asking for a confirmation never re-sends the planted token: the victim gets a fresh one.
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    await register({ email: 'victim@example.com' });
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    expect(tokenFromLastEmail()).not.toBe(fake);
    expect(row().confirm_token).toBe(tokenFromLastEmail());
  });

  it('a forged "confirmed" row gets the same answer and a real confirmation, not a free pass', async () => {
    seedRow({ email: 'forged@example.com', confirmed: true, product_interests: ['comic_studio'] });
    const res = await register({ email: 'forged@example.com', studios: ['comic_studio'] });
    expect(res.body).toEqual((await register({ email: 'fresh@example.com', studios: ['comic_studio'] })).body);
    expect(h.sendNewsletterConfirm.mock.calls.map((c) => c[0])).toEqual(['forged@example.com', 'fresh@example.com']);
  });

  it('a row stored with capitals is found, lowercased, and confirms normally (no 500)', async () => {
    seedRow({ email: 'Victim@Example.com' });
    const res = await register({ email: 'victim@example.com', studios: ['comic_studio'] });
    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(row()).toMatchObject({ email: 'victim@example.com', product_interests: ['comic_studio'] });
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    await pressConfirm('victim@example.com', tokenFromLastEmail());
    expect(row()).toMatchObject({ confirmed: true });
    // The older route too.
    seedRow({ email: 'Other@Example.com' });
    expect((await post({ email: 'other@example.com', kind: 'updates', captchaToken: 'good-token' }, '/api/newsletter/subscribe')).status).toBe(200);
  });

  it('the older /subscribe answers the same for a subscriber and a stranger, and never replaces a note', async () => {
    seedRow({ email: 'subscribed@example.com', confirmed: true, product_interests: ['comic_studio'], feedback: 'their own note' });
    const sub = (email: string) => post({ email, kind: 'updates', feedback: 'spam', captchaToken: 'good-token' }, '/api/newsletter/subscribe');
    const a = await sub('subscribed@example.com');
    const b = await sub('stranger@example.com');
    expect(a.status).toBe(200);
    expect(a.body).toEqual(b.body);
    expect(a.body).toEqual({ ok: true, message: 'Almost there! Check your inbox to confirm your subscription.' });
    expect(rows().find((r) => r.email === 'subscribed@example.com')).toMatchObject({ feedback: 'their own note', product_interests: ['comic_studio'] });
  });
});

describe('POST /api/interest — per-recipient throttle (abuse-ops-11)', () => {
  it('sends no second confirmation within 10 minutes but keeps the new picks', async () => {
    await register({ studios: ['comic_studio'] });
    const token = row().confirm_token;
    const first = h.sendNewsletterConfirm.mock.calls.length;
    const res = await register({ studios: ['chat_studio'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'pending', studios: ['chat_studio'], message: expect.any(String) });
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(first);
    expect(row().product_interests).toEqual(['comic_studio', 'chat_studio']);
    // The link already in the inbox still works.
    expect(row().confirm_token).toBe(token);
  });

  it('counts per inbox: +tags, Gmail dots and googlemail.com share one allowance', async () => {
    expect(inboxKey('V.ictim+promo@GoogleMail.com')).toBe('victim@gmail.com');
    expect(inboxKey('first.last+x@example.com')).toBe('first.last@example.com');
    expect(inboxKey('+only@example.com')).toBe('+only@example.com');
    const send = (email: string) => register({ email, studios: ['comic_studio'] });
    const answers = [await send('victim@gmail.com'), await send('victim+1@gmail.com'), await send('v.i.c.t.i.m@googlemail.com')];
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
    // Other inboxes are not affected (a dot outside Gmail is a different mailbox).
    await send('victim2@gmail.com');
    await send('vic.tim@example.com');
    await send('victim@example.com');
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(4);
    // Three a day per inbox, whichever alias each one went to.
    for (const alias of ['victim+2@gmail.com', 'vic.tim+3@gmail.com', 'victim+4@gmail.com']) {
      age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
      await send(alias);
    }
    expect(h.sendNewsletterConfirm.mock.calls.filter(([to]) => inboxKey(String(to)) === 'victim@gmail.com')).toHaveLength(INTEREST_CONFIRM_THROTTLE.maxPerDay);
  });

  it('after the cooldown re-sends the SAME still-valid link', async () => {
    await register();
    const token = row().confirm_token;
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    const res = await register();
    expect(res.body.status).toBe('pending');
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(2);
    expect(row().confirm_token).toBe(token);
    expect(tokenFromLastEmail()).toBe(token);
  });

  it('re-sending a link never extends its lifetime (it expires from when it was first issued)', async () => {
    const realNow = Date.now();
    const at = (hours: number) => vi.spyOn(Date, 'now').mockReturnValue(realNow + hours * 3_600_000);
    try {
      await register();
      const token = tokenFromLastEmail();
      at(100);
      await register(); // past the cooldown: the same link goes out again
      expect(tokenFromLastEmail()).toBe(token);
      at(167.5);
      await register(); // under an hour left: a fresh link instead
      expect(tokenFromLastEmail()).not.toBe(token);
      at(168.1);
      expect((await openLink('ada@example.com', tokenFromLastEmail())).status).toBe(200);
      expect((await pressConfirm('ada@example.com', token)).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=invalid');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it(`caps confirmations at ${3} per address per day, with the same answer`, async () => {
    for (let i = 0; i < INTEREST_CONFIRM_THROTTLE.maxPerDay; i++) {
      expect((await register()).body.status).toBe('pending');
      age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    }
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(INTEREST_CONFIRM_THROTTLE.maxPerDay);
    const res = await register({ studios: ['future_studios'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'pending', studios: ['future_studios'] });
    expect(res.headers.get('retry-after')).toBeNull();
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(INTEREST_CONFIRM_THROTTLE.maxPerDay);
    expect(row().product_interests).toContain('future_studios');
  });

  it('parallel requests send ONE email (the send slot is claimed atomically)', async () => {
    h.state.latencyMs = 5;
    const burst = () => Promise.all(Array.from({ length: 6 }, () => register()));
    const fresh = await burst();
    expect(fresh.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);

    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    const again = await burst();
    expect(new Set(again.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(2);
  });

  it('a failed send does not count: the visitor is told, and may retry at once', async () => {
    h.state.sendOutcome = 'failed';
    const failed = await register();
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('email_unavailable');
    expect(rows()).toHaveLength(1); // picks saved
    expect(row()).toMatchObject({ confirm_token: null, confirm_sent_at: null }); // slot given back
    h.state.sendOutcome = 'sent';
    const retry = await register();
    expect(retry.body.status).toBe('pending');
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(2);

    // On an existing row, too: the earlier link survives a failed re-send.
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    const token = row().confirm_token;
    const sentAt = row().confirm_sent_at;
    h.state.sendOutcome = 'rate_limited';
    expect((await register()).body.code).toBe('email_unavailable');
    expect(row()).toMatchObject({ confirm_token: token, confirm_sent_at: sentAt });
    h.state.sendOutcome = 'sent';
    expect((await register()).body.status).toBe('pending');
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(4);
  });

  it('when email_log is unreadable, the cooldown falls back to confirm_sent_at', async () => {
    await register();
    h.state.fail = { table: 'email_log', op: 'select', code: '57014', message: 'statement timeout' };
    const res = await register();
    expect(res.body.status).toBe('pending');
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
  });

  it('the cooldown uses the later of the log and the row (a lagging log is not a free pass)', async () => {
    await register();
    // The log only shows an old send; the row was stamped a moment ago.
    h.tables.email_log.forEach((r) => (r.created_at = new Date(Date.now() - 3_600_000).toISOString()));
    await register();
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
  });

  it('the older /api/newsletter/subscribe path is throttled the same way', async () => {
    const sub = () => post({ email: 'ada@example.com', kind: 'updates', captchaToken: 'good-token' }, '/api/newsletter/subscribe');
    expect((await sub()).body.ok).toBe(true);
    expect((await sub()).body.ok).toBe(true);
    expect((await sub()).body.ok).toBe(true);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    expect(rows()).toHaveLength(1);
  });

  it('confirmation mail may use only its share of the daily email cap; then nothing is stored', async () => {
    // Defaults: EMAIL_MAX_PER_DAY 200, share 0.5 → 100 confirmation emails a day, all addresses.
    for (let i = 0; i < Math.floor(200 * CONFIRM_EMAIL_BUDGET_SHARE); i++) h.logSend(`p${i}@example.com`, 'newsletter-confirm', 'sent');
    const res = await register();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('email_unavailable');
    expect(rows()).toHaveLength(0);
    expect(h.sendNewsletterConfirm).not.toHaveBeenCalled();
    // Other mail (sign-in, recovery) doesn't count against it.
    h.tables.email_log = h.tables.email_log.map((r) => ({ ...r, template: 'auth-recovery' }));
    expect((await register()).status).toBe(200);
  });
});

describe('POST /api/interest — per-inbox claim, the mailer cap, and answer timing', () => {
  it('parallel requests for different aliases of one inbox send ONE email (the claim is per inbox, not per row)', async () => {
    h.state.latencyMs = 5;
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => register({ email: `victim+${i}@gmail.com`, studios: ['comic_studio'] }))
    );
    expect(burst.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(new Set(burst.map((r) => r.body.status))).toEqual(new Set(['pending']));
    const toInbox = h.tables.email_log.filter((r) => r.template === 'newsletter-confirm' && inboxKey(String(r.to_email)) === 'victim@gmail.com');
    expect(toInbox).toHaveLength(1);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    // Every alias's registration is kept (picks saved, no link): the throttle only holds the email.
    expect(rows()).toHaveLength(10);
  });

  it('the older /subscribe path shares the per-inbox claim', async () => {
    h.state.latencyMs = 5;
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        post({ email: `v.ictim+${i}@gmail.com`, kind: 'updates', productInterests: ['comic_studio'], captchaToken: 'good-token' }, '/api/newsletter/subscribe')
      )
    );
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
  });

  it('while the mailer is at its hard cap, every address gets the same answer and nothing is sent (no throttled/unthrottled split)', async () => {
    await register({ email: 'recent@example.com' });
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    // Other mail (not public-form mail) fills today's hard cap (EMAIL_MAX_PER_DAY, default 200).
    for (let i = 0; i < 200; i++) h.logSend(`u${i}@example.com`, 'welcome', 'sent');
    const recent = await register({ email: 'recent@example.com' });
    const fresh = await register({ email: 'fresh@example.com' });
    expect([recent.status, recent.body.code]).toEqual([503, 'email_unavailable']);
    expect([fresh.status, fresh.body.code]).toEqual([503, 'email_unavailable']);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
  });

  it('an answer that sent the email and one that sent nothing (throttled) are held to the same time, also before any send on this instance', async () => {
    resetInterestGuardsForTests({ answerFloorMs: 250 });
    const timed = async (over: Record<string, unknown>) => {
      const started = Date.now();
      const res = await register(over);
      return { ms: Date.now() - started, body: res.body };
    };
    // Nothing sent yet on this instance (just started): both are held to the floor.
    h.logSend('recent@example.com', 'newsletter-confirm', 'sent'); // a link went out a moment ago
    const throttled = await timed({ email: 'recent@example.com' });
    const sent = await timed({ email: 'fresh@example.com' });
    expect([throttled.body.status, sent.body.status]).toEqual(['pending', 'pending']);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    for (const t of [throttled, sent]) expect(t.ms).toBeGreaterThanOrEqual(240);
    expect(Math.abs(throttled.ms - sent.ms)).toBeLessThan(120);
  });

  it('the time every answer is held to: the floor (from the first request), or longer while recent sends took longer, up to the mailer\'s timeout', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      resetInterestGuardsForTests(); // production settings
      expect(ANSWER_FLOOR_MS).toBeGreaterThanOrEqual(1500);
      expect(answerTargetMs()).toBe(ANSWER_FLOOR_MS);
      let done = false;
      void holdAnswer(Date.now()).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(ANSWER_FLOOR_MS - 50);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(done).toBe(true);
      // A slow email worker: a send took 9 s. Every answer now takes that long (not 3 s).
      noteSentDuration(Date.now() - 9_000);
      expect(answerTargetMs()).toBe(9_000);
      done = false;
      void holdAnswer(Date.now()).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(8_900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      resetInterestGuardsForTests({ answerFloorMs: 0 });
    }
  });
});

describe('POST /api/newsletter/subscribe kind=access — the receipt is limited per inbox, shares the budget, and takes no name', () => {
  const access = (over: Record<string, unknown>) =>
    post({ email: 'vic@example.com', kind: 'access', captchaToken: 'good-token', ...over }, '/api/newsletter/subscribe');
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20)); // the receipt is sent in the background

  it('one receipt per inbox a day, however many aliases ask; every request is stored and answered the same', async () => {
    const answers = [];
    for (let i = 0; i < 5; i++) {
      answers.push((await access({ email: `victim+${i}@gmail.com` })).body);
      await settle();
    }
    expect(answers.every((a) => a.ok === true && a.status === 'joined')).toBe(true);
    expect(rows().filter((r) => r.kind === 'access')).toHaveLength(5);
    expect(h.sendAccessRequested).toHaveBeenCalledTimes(1);
    age(24 * 60 * 60_000 + 1000);
    await access({ email: 'victim+9@gmail.com' });
    await settle();
    expect(h.sendAccessRequested).toHaveBeenCalledTimes(2);
  });

  it('parallel aliases get one receipt', async () => {
    h.state.latencyMs = 5;
    await Promise.all(Array.from({ length: 8 }, (_, i) => access({ email: `victim+${i}@gmail.com` })));
    await settle();
    expect(h.sendAccessRequested).toHaveBeenCalledTimes(1);
  });

  it('receipts and confirmations share one budget: once it is used, neither goes out (sign-in, recovery and invite mail keep the rest)', async () => {
    for (let i = 0; i < Math.floor(200 * CONFIRM_EMAIL_BUDGET_SHARE); i++) h.logSend(`r${i}@example.com`, 'access-requested', 'sent');
    expect((await access({ email: 'new@example.com' })).body.status).toBe('joined');
    await settle();
    expect(h.sendAccessRequested).not.toHaveBeenCalled();
    const res = await register({ email: 'other@example.com' });
    expect([res.status, res.body.code]).toEqual([503, 'email_unavailable']);
  });

  it('never puts a caller-supplied name into the email (it goes to whatever address the caller typed)', async () => {
    await access({ email: 'stranger@example.com', firstName: 'your account is locked, verify at evil.example' });
    await settle();
    expect(h.sendAccessRequested).toHaveBeenCalledTimes(1);
    expect(h.sendAccessRequested.mock.calls[0][1]).toBeUndefined();
    await post({ email: 'stranger2@example.com', kind: 'updates', firstName: 'click evil.example', captchaToken: 'good-token' }, '/api/newsletter/subscribe');
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
    expect(h.sendNewsletterConfirm.mock.calls[0][2]).toBeUndefined();
    expect(readFileSync(new URL('./newsletter.ts', import.meta.url), 'utf8')).not.toMatch(/req\.body\?\.firstName/);
  });
});

describe('POST /api/interest — rows planted, links re-sent, parallel picks, informed confirm', () => {
  it('a row planted with a future confirm_sent_at does not block the confirmation email', async () => {
    // What the old all-column anon INSERT allowed (before register_interest_2026_11.sql).
    h.tables.waitlist_signups.push({ id: 'planted', email: 'vic@example.com', kind: 'updates', confirmed: false, confirm_token: null, confirm_sent_at: '2099-01-01T00:00:00.000Z', unsubscribed_at: null, product_interests: [], metadata: {} });
    expect(await checkConfirmThrottle('vic@example.com', '2099-01-01T00:00:00.000Z')).toBeNull();

    // A failed send gives the slot back without restoring the planted stamp.
    h.state.sendOutcome = 'failed';
    expect((await register({ email: 'vic@example.com' })).body.code).toBe('email_unavailable');
    expect(row().confirm_sent_at).toBeNull();

    h.state.sendOutcome = 'sent';
    const res = await register({ email: 'vic@example.com' });
    expect(res.body.status).toBe('pending');
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(2); // the failed one, then this one
    expect(Date.parse(String(row().confirm_sent_at))).toBeLessThanOrEqual(Date.now());
    // ...and the address can confirm with the link it got.
    await pressConfirm('vic@example.com', tokenFromLastEmail());
    expect(row()).toMatchObject({ confirmed: true });
  });

  it('planted metadata JavaScript can’t hold exactly never blocks registering (only the waiting picks are compared)', async () => {
    // Any client can still insert metadata after register_interest_2026_11.sql (section 7).
    h.tables.waitlist_signups.push({ id: 'planted', email: 'vic@example.com', kind: 'updates', confirmed: false, confirm_token: null, confirm_sent_at: null, unsubscribed_at: null, product_interests: [], metadata: { n: new PgNumeric('12345678901234567890') } });
    const res = await register({ email: 'vic@example.com', studios: ['comic_studio'] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(row().product_interests).toEqual(['comic_studio']);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);
  });

  it('planted lists of thousands of picks never block registering: they are not compared (the filter would outgrow the URL), and the cleaned list replaces them', async () => {
    const flood = Array.from({ length: 4000 }, (_, i) => (i % 2 ? 'comic_studio' : `junk-${i}`));
    // Before section 7 the anon key could plant any picks; after it, any metadata.
    h.tables.waitlist_signups.push({ id: 'planted-1', email: 'vic@example.com', kind: 'updates', confirmed: false, confirm_token: null, confirm_sent_at: null, unsubscribed_at: null, product_interests: flood, metadata: { pending_interests: flood } });
    const res = await register({ email: 'vic@example.com', studios: ['stream_studio'] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(row()).toMatchObject({ product_interests: ['comic_studio', 'stream_studio'] });
    expect(row().metadata).not.toHaveProperty('pending_interests');
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(1);

    h.tables.waitlist_signups.push({ id: 'planted-2', email: 'sub@example.com', kind: 'updates', confirmed: true, confirm_token: null, confirm_sent_at: null, unsubscribed_at: null, product_interests: ['comic_studio'], metadata: { pending_interests: flood } });
    const sub = await register({ email: 'sub@example.com', studios: ['chat_studio'] });
    expect(sub.status).toBe(200);
    expect(sub.body.status).toBe('pending');
    const planted = h.tables.waitlist_signups.find((r) => r.id === 'planted-2') as Row;
    // A subscriber's picks wait for the click; the junk is gone, the one known id in it kept.
    expect(planted.product_interests).toEqual(['comic_studio']);
    expect(planted.metadata).toEqual({ pending_interests: ['comic_studio', 'chat_studio'] });
  });

  it('planted waiting picks that are not plain strings are replaced, not compared', async () => {
    // Before section 7, the anon key could also plant a "confirmed" row with junk waiting picks.
    h.tables.waitlist_signups.push({ id: 'planted', email: 'vic@example.com', kind: 'updates', confirmed: true, confirm_token: null, confirm_sent_at: null, unsubscribed_at: null, product_interests: ['comic_studio'], metadata: { pending_interests: [new PgNumeric('1e400')] } });
    const res = await register({ email: 'vic@example.com', studios: ['stream_studio'] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');
    expect(row().metadata).toEqual({ pending_interests: ['stream_studio'] });
    expect(row().product_interests).toEqual(['comic_studio']);
  });

  it('back after unsubscribing: a second request re-sends the first link, which still works', async () => {
    await register({ studios: ['comic_studio'] });
    const beforeUnsubscribe = tokenFromLastEmail();
    await pressConfirm('ada@example.com', beforeUnsubscribe);
    await oneClickUnsubscribe('ada@example.com');
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    // age() leaves unsubscribed_at alone; the unsubscribe was a while ago too (a token's issue
    // time has one-second resolution, and one from the same second as the unsubscribe is rotated).
    row().unsubscribed_at = new Date(Date.parse(String(row().unsubscribed_at)) - INTEREST_CONFIRM_THROTTLE.minIntervalMs).toISOString();

    await register({ studios: ['stream_studio'] });
    const linkA = tokenFromLastEmail();
    expect(linkA).not.toBe(beforeUnsubscribe);
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    await register({ studios: ['stream_studio'] }); // the same person again, or anyone typing the address
    expect(tokenFromLastEmail()).toBe(linkA);
    expect(row().confirm_token).toBe(linkA);

    // The link from before the unsubscribe never comes back...
    expect((await pressConfirm('ada@example.com', beforeUnsubscribe)).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=invalid');
    expect(row()).toMatchObject({ confirmed: false, confirm_token: linkA });
    // ...the first link since does.
    expect((await openLink('ada@example.com', linkA)).status).toBe(200);
    expect((await pressConfirm('ada@example.com', linkA)).headers.get('location')).toBe('https://dreamstreamstudio.ai/?newsletter=confirmed');
    expect(row()).toMatchObject({ confirmed: true, unsubscribed_at: null, product_interests: ['stream_studio'] });
  });

  it('parallel requests keep every request’s picks, whichever one sends the email', async () => {
    await register({ studios: ['comic_studio'] });
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    h.state.latencyMs = 5;
    const [a, b] = await Promise.all([register({ studios: ['stream_studio'] }), register({ studios: ['chat_studio'] })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(2); // the first registration, then one of these two
    expect(row().product_interests).toEqual(['comic_studio', 'stream_studio', 'chat_studio']);

    // Inside the cooldown (every request throttled), too.
    const throttled = await Promise.all([register({ studios: ['atlas_studio'] }), register({ studios: ['future_studios'] })]);
    expect(throttled.map((r) => r.body.status)).toEqual(['pending', 'pending']);
    expect(h.sendNewsletterConfirm).toHaveBeenCalledTimes(2);
    expect(row().product_interests).toEqual([...STUDIO_INTEREST_IDS]);
  });

  it('parallel requests for a subscriber all wait for their click, none lost', async () => {
    await register({ studios: ['comic_studio'] });
    await pressConfirm('ada@example.com', tokenFromLastEmail());
    h.state.latencyMs = 5;
    await Promise.all([register({ studios: ['stream_studio'] }), register({ studios: ['chat_studio'] }), register({ studios: ['atlas_studio'] })]);
    expect(row()).toMatchObject({ confirmed: true, product_interests: ['comic_studio'] });
    expect(row().metadata).toMatchObject({ pending_interests: ['stream_studio', 'chat_studio', 'atlas_studio'] });
  });

  it('the Confirm page says which studios the click confirms, and which it adds', async () => {
    await register({ studios: ['stream_studio', 'comic_studio'] });
    const first = await (await openLink('ada@example.com', tokenFromLastEmail())).text();
    expect(first).toContain('Press Confirm to get DreamStream updates about <strong>Comic Studio and Stream Studio</strong> at <strong>ada@example.com</strong>.');
    await pressConfirm('ada@example.com', tokenFromLastEmail());

    // Someone (maybe not them) asks for Future studios too.
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    await register({ studios: ['future_studios', 'comic_studio'] });
    const page = await (await openLink('ada@example.com', tokenFromLastEmail())).text();
    expect(page).toContain('<strong>ada@example.com</strong> already gets DreamStream updates about <strong>Comic Studio and Stream Studio</strong>.');
    expect(page).toContain('Pressing Confirm also adds <strong>Future studios</strong>.');
    expect(page).not.toMatch(/<script/i);
    await pressConfirm('ada@example.com', tokenFromLastEmail());
    expect(row().product_interests).toEqual(['comic_studio', 'stream_studio', 'future_studios']);

    // A re-request with nothing new says so.
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    await register({ studios: ['comic_studio'] });
    expect(await (await openLink('ada@example.com', tokenFromLastEmail())).text()).toContain('There is nothing new to add');
  });

  it('Confirm applies exactly what the page showed: picks a stranger adds after it opened are not subscribed, and the page is shown again', async () => {
    // A subscriber of Comic Studio.
    await register({ studios: ['comic_studio'] });
    await pressConfirmOnPage(await (await openLink('ada@example.com', tokenFromLastEmail())).text());
    expect(row()).toMatchObject({ confirmed: true, product_interests: ['comic_studio'] });
    // A stranger asks for Stream Studio; the link goes out and the page names it.
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    await register({ studios: ['stream_studio'] });
    const token = tokenFromLastEmail();
    const page = await (await openLink('ada@example.com', token)).text();
    expect(page).toContain('Pressing Confirm also adds <strong>Stream Studio</strong>.');
    // While it is open, the stranger asks for two more (throttled: no new email, same link).
    const sends = h.sendNewsletterConfirm.mock.calls.length;
    await register({ studios: ['chat_studio'] });
    await register({ studios: ['atlas_studio'] });
    expect(h.sendNewsletterConfirm.mock.calls.length).toBe(sends);
    // Pressing Confirm on the page as shown changes nothing and shows the page again, with the new list.
    const again = await pressConfirmOnPage(page);
    expect(again.status).toBe(200);
    const shownAgain = await again.text();
    expect(shownAgain).toContain('The studios on this page changed after it opened');
    expect(shownAgain).toMatch(/Pressing Confirm also adds <strong>[^<]*Atlas Studio[^<]*<\/strong>\./);
    expect(row()).toMatchObject({ confirmed: true, product_interests: ['comic_studio'] });
    // Confirming that page applies what it names, and nothing else.
    const done = await pressConfirmOnPage(shownAgain);
    expect(done.status).toBe(303);
    expect([...(row().product_interests as string[])].sort()).toEqual(['atlas_studio', 'chat_studio', 'comic_studio', 'stream_studio']);
  });

  it('the same holds before the first confirmation: picks added after the page opened are not confirmed with it', async () => {
    await register({ studios: ['comic_studio'] });
    const page = await (await openLink('ada@example.com', tokenFromLastEmail())).text();
    expect(page).toContain('<input type="hidden" name="s" value="comic_studio">');
    await register({ studios: ['stream_studio'] }); // throttled, same link
    const res = await pressConfirmOnPage(page);
    expect(res.status).toBe(200);
    expect(row()).toMatchObject({ confirmed: false });
    expect(await res.text()).toContain('Press Confirm to get DreamStream updates about <strong>Comic Studio and Stream Studio</strong>');
  });

  it('a pick that lands between the click\'s read and its write is neither confirmed nor lost: the page is shown again with it', async () => {
    await register({ studios: ['comic_studio'] });
    const page = await (await openLink('ada@example.com', tokenFromLastEmail())).text();
    // A parallel (throttled) registration for Stream Studio saves its pick just before the click's
    // write lands, as savePicks would: the click read the row before that.
    h.state.beforeUpdate = (table, payload) => {
      if (table !== 'waitlist_signups' || payload.confirmed !== true) return false;
      row().product_interests = ['comic_studio', 'stream_studio'];
      return true;
    };
    const res = await pressConfirmOnPage(page);
    expect(res.status).toBe(200);
    const shownAgain = await res.text();
    expect(shownAgain).toContain('The studios on this page changed after it opened');
    expect(shownAgain).toContain('Press Confirm to get DreamStream updates about <strong>Comic Studio and Stream Studio</strong>');
    expect(row()).toMatchObject({ confirmed: false, product_interests: ['comic_studio', 'stream_studio'] });
    // The link still works, and confirming that page subscribes both.
    expect((await pressConfirmOnPage(shownAgain)).status).toBe(303);
    expect(row()).toMatchObject({ confirmed: true, product_interests: ['comic_studio', 'stream_studio'] });
  });

  it('the same for a subscriber: a pick waiting for this click that arrives mid-click stays waiting, and the page names it', async () => {
    await register({ studios: ['comic_studio'] });
    await pressConfirmOnPage(await (await openLink('ada@example.com', tokenFromLastEmail())).text());
    age(INTEREST_CONFIRM_THROTTLE.minIntervalMs + 1000);
    await register({ studios: ['stream_studio'] });
    const page = await (await openLink('ada@example.com', tokenFromLastEmail())).text();
    expect(page).toContain('Pressing Confirm also adds <strong>Stream Studio</strong>.');
    h.state.beforeUpdate = (table, payload) => {
      if (table !== 'waitlist_signups' || payload.confirmed !== true) return false;
      row().metadata = { ...(row().metadata as Row), pending_interests: ['stream_studio', 'chat_studio'] };
      return true;
    };
    const res = await pressConfirmOnPage(page);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/Pressing Confirm also adds <strong>[^<]*Chat Studio[^<]*<\/strong>\./);
    expect(row().product_interests).toEqual(['comic_studio']);
    expect((row().metadata as Row).pending_interests).toEqual(['stream_studio', 'chat_studio']);
  });

  it('the Confirm page escapes what it shows', async () => {
    const email = `a"<b>'x@example.com`;
    await register({ email, studios: ['comic_studio'] });
    const html = await (await openLink(email.toLowerCase(), tokenFromLastEmail())).text();
    expect(html).toContain('a&quot;&lt;b&gt;&#39;x@example.com');
    expect(html).not.toContain('<b>');
  });
});

describe('POST /api/newsletter/subscribe kind=access — an existing request is never replaced', () => {
  const access = (over: Record<string, unknown>) =>
    post({ email: 'vic@example.com', kind: 'access', captchaToken: 'good-token', ...over }, '/api/newsletter/subscribe');

  it('the account check matches one address exactly: no wildcard, and an underscore is just an underscore', async () => {
    h.tables.profiles = [{ id: 'p1', email: 'boss@corp.example' }, { id: 'p2', email: 'a_b@corp.example' }];
    try {
      for (const email of ['*@corp.example', 'b*@corp.example', 'axb@corp.example', 'b%@corp.example']) {
        expect((await access({ email })).body.status, email).not.toBe('account-exists');
      }
      for (const email of ['a_b@corp.example', 'BOSS@corp.example']) {
        expect((await access({ email })).body.status, email).toBe('account-exists');
      }
    } finally {
      h.tables.profiles = [];
    }
  });

  it('adds new picks to the stored ones and keeps the stored note', async () => {
    h.tables.waitlist_signups.push({ id: 'acc-1', email: 'vic@example.com', kind: 'access', confirmed: false, product_interests: ['comic_studio', 'stream_studio'], feedback: 'my real note', metadata: {} });
    const res = await access({ productInterests: ['future_studios'], feedback: 'attacker text' });
    expect(res.body).toMatchObject({ ok: true, status: 'already-registered' });
    expect(rows().find((r) => r.id === 'acc-1')).toMatchObject({ product_interests: ['comic_studio', 'stream_studio', 'future_studios'], feedback: 'my real note' });
  });

  it('stores a note only when the request has none', async () => {
    h.tables.waitlist_signups.push({ id: 'acc-2', email: 'vic@example.com', kind: 'access', confirmed: false, product_interests: [], feedback: null, metadata: {} });
    await access({ feedback: 'first note' });
    await access({ feedback: 'second note' });
    expect(rows().find((r) => r.id === 'acc-2')).toMatchObject({ feedback: 'first note', product_interests: [] });
  });
});

describe('index.ts mounts', () => {
  it('puts the interest per-IP limiter in front of the older /api/newsletter/subscribe too', () => {
    const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const limiter = src.indexOf("app.use('/api/newsletter/subscribe', interestRateLimit);");
    const mount = src.indexOf("app.use('/api/newsletter', systemRateLimit, optionalAuth, newsletterRouter);");
    expect(limiter).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(limiter);
    expect(src.indexOf('const interestRateLimit')).toBeLessThan(limiter);
  });
});

describe('POST /api/interest — unavailable', () => {
  it.each([
    ['a missing column (42703)', { table: 'waitlist_signups', op: 'select' as const, code: '42703' }],
    ['a missing table (PGRST205)', { table: 'waitlist_signups', op: 'select' as const, code: 'PGRST205' }],
    ['a column missing from the schema cache on insert (PGRST204)', { table: 'waitlist_signups', op: 'insert' as const, code: 'PGRST204' }]
  ])('answers 503 interest_unavailable for %s', async (_label, fail) => {
    h.state.fail = fail;
    const res = await register();
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false, code: 'interest_unavailable' });
    expect(h.sendNewsletterConfirm).not.toHaveBeenCalled();
  });

  it('answers 503 interest_unavailable without a service role', async () => {
    h.state.noAdmin = true;
    const res = await register();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('interest_unavailable');
  });

  it('answers 503 interest_unavailable, and stores nothing, without a mailer', async () => {
    h.state.mailerConfigured = false;
    const res = await register();
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('interest_unavailable');
    expect(rows()).toHaveLength(0);
  });

  it('other database errors are a 500, not a fake success', async () => {
    h.state.fail = { table: 'waitlist_signups', op: 'select', code: '08006', message: 'connection failure' };
    const res = await register();
    expect(res.status).toBe(500);
    expect(h.sendNewsletterConfirm).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/interest/summary', () => {
  const summary = () => fetch(`${base}/api/admin/interest/summary`);

  const seed = () => {
    const add = (r: Row) => h.tables.waitlist_signups.push({ id: `seed-${h.tables.waitlist_signups.length}`, created_at: '2026-11-01T00:00:00.000Z', confirm_token: 'secret-token', feedback: 'private note', source: 'home', ...r });
    add({ email: 'a@x.io', kind: 'updates', confirmed: true, product_interests: ['comic_studio', 'atlas_studio'] });
    add({ email: 'b@x.io', kind: 'updates', confirmed: false, product_interests: ['comic_studio'] });
    add({ email: 'c@x.io', kind: 'updates', confirmed: true, unsubscribed_at: '2026-11-02T00:00:00.000Z', product_interests: [] });
    add({ email: 'd@x.io', kind: 'access', confirmed: false, product_interests: ['stream_studio'] });
  };

  it('is admin-only (signed out and signed-in non-admins get 403)', async () => {
    expect((await summary()).status).toBe(403);
    signedIn = true;
    expect((await summary()).status).toBe(403);
    expect(h.rpc).not.toHaveBeenCalledWith('waitlist_interest_summary');
  });

  for (const via of ['rpc', 'scan'] as const) {
    it(`returns counts per studio and no personal data (${via})`, async () => {
      seed();
      h.state.rpcMissing = via === 'scan';
      signedIn = true;
      h.state.isAdmin = true;
      const res = await summary();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = (await res.json()) as { studios: Array<Record<string, unknown>>; totals: unknown; source: string };
      expect(body.source).toBe(via);
      expect(body.studios.map((s) => s.id)).toEqual([...STUDIO_INTEREST_IDS]);
      expect(body.studios.find((s) => s.id === 'comic_studio')).toEqual({ id: 'comic_studio', label: 'Comic Studio', confirmed: 1, pending: 1, accessRequests: 0 });
      expect(body.studios.find((s) => s.id === 'atlas_studio')).toMatchObject({ confirmed: 1, pending: 0 });
      expect(body.studios.find((s) => s.id === 'stream_studio')).toMatchObject({ confirmed: 0, pending: 0, accessRequests: 1 });
      expect(body.totals).toEqual({ confirmed: 1, pending: 1, unsubscribed: 1, accessRequests: 1 });
      const raw = JSON.stringify(body);
      expect(raw).not.toMatch(/@/);
      expect(raw).not.toContain('secret-token');
      expect(raw).not.toContain('private note');
    });
  }

  it('answers 503 interest_unavailable when the columns are missing', async () => {
    signedIn = true;
    h.state.isAdmin = true;
    h.state.rpcMissing = true;
    h.state.fail = { table: 'waitlist_signups', op: 'select', code: '42703' };
    const res = await summary();
    expect(res.status).toBe(503);
    expect(((await res.json()) as Record<string, unknown>).code).toBe('interest_unavailable');
  });
});
