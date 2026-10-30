// @vitest-environment node
//
// The conformance kit (plan §6; W1.4): its eleven checks pass on correct ports, and each one FAILS on a port that
// breaks its rule — a kit that cannot fail proves nothing. Then the fake platform (the in-memory /v1 every host tests
// against) enforces the wire's request rules.
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EmailReview } from '../src/contract/email.js';
import { CHAT_PRODUCT, COMIC_PRODUCT } from '../src/products.js';
import type { MeterPort } from '../src/gates/ports.js';
import {
  CONFORMANCE_CHECKS,
  FAKE_PLAN_KEY,
  createFakeIdentity,
  createFakeLedger,
  createFakePlatform,
  runConformance,
  type ConformanceSubject,
} from '../src/testing/index.js';
import { base64urlEncode, canonicalJson } from '../src/audit/inputHash.js';

/** A correct reviewEmail for the kit's own check (the real one is W1.3's; hosts wire it into their subject). */
const correctReview = (doc: { mode: string; to: { address: string }[] }, ctx: { participants: { address: string }[]; userTyped: string[] }): EmailReview => {
  const known = ctx.participants.map((p) => p.address.toLowerCase()).concat(ctx.userTyped.map((a) => a.toLowerCase()));
  const reply = doc.mode !== 'compose' && doc.mode !== 'forward';
  return {
    prefill: { to: reply ? [] : doc.to.filter((r) => known.indexOf(r.address.toLowerCase()) !== -1), cc: [], bcc: [] },
    flagged: doc.to.filter((r) => known.indexOf(r.address.toLowerCase()) === -1).map((r) => ({ address: r.address, field: 'to' as const, reason: 'model-only' as const })),
    links: [],
    warnings: [],
  };
};

const ledgers = (overrides: Partial<MeterPort> = {}) => (o: { governed: boolean; ledgerDown: boolean }): MeterPort => {
  const l = createFakeLedger({ governed: o.governed });
  l.setDown(o.ledgerDown);
  return Object.assign(l, overrides);
};

const goodSubject = (): ConformanceSubject => ({
  name: 'fakes',
  manifest: CHAT_PRODUCT,
  catalogue: ['web_search', 'email_draft', 'deck_create'],
  identity: (authenticated) => createFakeIdentity({ session: authenticated ? { userId: 'user-1' } : null }),
  meter: ledgers(),
  planKey: FAKE_PLAN_KEY,
  hmacSha256Hex: (key, message) => createHmac('sha256', key).update(message).digest('hex'),
  usageText: (usd, governed) => (governed ? `≈${Math.max(0, Math.round(usd))}% of your usage` : `$${usd}`),
  reviewEmail: correctReview as ConformanceSubject['reviewEmail'],
  emailPreviewAttributes: () => ({ sandbox: '', srcdoc: '<p>hi</p>' }),
});

describe('the conformance kit', () => {
  it('has the eleven checks of the plan, in order', () => {
    expect(CONFORMANCE_CHECKS.map((c) => c.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('passes on correct ports', async () => {
    const report = await runConformance(goodSubject());
    expect(report.filter((r) => r.status !== 'pass')).toEqual([]);
  });

  it('skips (never silently passes) the email checks a host has not wired yet', async () => {
    const { reviewEmail: _r, emailPreviewAttributes: _e, ...partial } = goodSubject();
    const report = await runConformance(partial);
    expect(report.filter((r) => r.status === 'skip').map((r) => r.id)).toEqual([8, 9]);
  });

  const REASONS: { [id: number]: RegExp } = {
    1: /no session/,
    2: /pdf\.fill/,
    3: /dollar sign/,
    4: /external write/,
    5: /ledger down/,
    6: /missing from the host catalogue/,
    7: /host HMAC differs/,
    8: /model-only address was pre-filled/,
    9: /sandbox=/,
    10: /ran without approval/,
    11: /second resume/,
  };
  const broken: [number, string, (s: ConformanceSubject) => ConformanceSubject][] = [
    [1, 'mints a user claim without a session', (s) => ({ ...s, identity: () => createFakeIdentity({ session: { userId: 'anyone' } }) })],
    [
      2,
      'mints a service claim with pdf.fill',
      (s) => ({
        ...s,
        identity: () => ({
          ...createFakeIdentity({ session: { userId: 'u' } }),
          mintServiceClaim: async (_p: 'preview', caps: readonly string[]) => `${base64urlEncode(canonicalJson({ v: 1, kind: 'service', purpose: 'preview', caps }))}.sig`,
        }),
      }),
    ],
    [3, 'words a governed price in dollars', (s) => ({ ...s, usageText: (usd) => `$${usd.toFixed(2)}` })],
    [4, 'lets a host policy lower the external-write floor', (s) => ({ ...s, policy: { app: 'dreamstream', confirm: 'sometimes' } as never })],
    [5, 'reserves with the ledger down', (s) => ({ ...s, meter: ledgers({ reserve: async () => ({ ok: true, reservationId: 'r-1' }) }) })],
    [6, 'is missing a tool from its catalogue', (s) => ({ ...s, catalogue: ['email_draft'] })],
    [7, 'has HMAC that disagrees with the vectors', (s) => ({ ...s, hmacSha256Hex: (key, message) => createHmac('sha256', `${key}x`).update(message).digest('hex') })],
    [
      8,
      'pre-fills a model-only address',
      (s) => ({ ...s, reviewEmail: ((doc: { to: { address: string }[] }) => ({ prefill: { to: doc.to, cc: [], bcc: [] }, flagged: [], links: [], warnings: [] })) as ConformanceSubject['reviewEmail'] }),
    ],
    [9, 'previews email without sandbox=""', (s) => ({ ...s, emailPreviewAttributes: () => ({ sandbox: 'allow-scripts', srcdoc: '<p>hi</p>' }) })],
    [10, 'cannot sign a plan (a key under 32 bytes), so no flow can stop for approval', (s) => ({ ...s, planKey: 'too-short' })],
    [11, 'lets a reservation be claimed twice', (s) => ({ ...s, meter: ledgers({ claim: async () => 'claimed' }) })],
  ];

  it.each(broken)('check %i fails when the host %s', async (id, _what, breakIt) => {
    const check = CONFORMANCE_CHECKS.find((c) => c.id === id)!;
    expect(await check.run(goodSubject())).toEqual({ status: 'pass' });
    const outcome = await check.run(breakIt(goodSubject())).catch((e: unknown) => ({ status: 'fail', reason: String(e) }));
    expect(outcome).toMatchObject({ status: 'fail', reason: REASONS[id] });
  });

  it('leaves no open hold on the host’s ledger', async () => {
    const shared = createFakeLedger({ governed: true });
    const report = await runConformance({ ...goodSubject(), meter: (o) => (o.ledgerDown ? ledgers()(o) : shared) });
    expect(report.filter((r) => r.status === 'fail')).toEqual([]);
    expect(shared.reservations.length).toBeGreaterThan(0);
    expect(shared.reservations.filter((r) => r.status === 'reserved' || r.status === 'claimed')).toEqual([]);
  });

  it('check 10 fails when runFlow ignores the flow floor (the decideGate half alone would still pass)', async () => {
    vi.resetModules();
    vi.doMock('../src/flows/run.js', async () => {
      const actual = await vi.importActual<typeof import('../src/flows/run.js')>('../src/flows/run.js');
      // A runFlow whose gate never sees maxModelCalls > 1: the flow floor is ignored, nothing else changes.
      const runFlow: typeof actual.runFlow = (def, params, ports, approved) => actual.runFlow({ ...def, limits: { ...def.limits, maxModelCalls: 1 } }, params, ports, approved);
      return { ...actual, runFlow };
    });
    try {
      const kit = await import('../src/testing/conformance.js');
      const check10 = kit.CONFORMANCE_CHECKS.find((c) => c.id === 10)!;
      expect(await check10.run(goodSubject())).toMatchObject({ status: 'fail', reason: /ran without approval/ });
    } finally {
      vi.doUnmock('../src/flows/run.js');
      vi.resetModules();
    }
  });

  it('check 11 fails when an expired approval keeps its hold', async () => {
    vi.resetModules();
    vi.doMock('../src/flows/run.js', async () => {
      const actual = await vi.importActual<typeof import('../src/flows/run.js')>('../src/flows/run.js');
      const tokens = await vi.importActual<typeof import('../src/flows/planToken.js')>('../src/flows/planToken.js');
      // The old behaviour: an expired token is refused with 403, and its hold is left for the ledger's sweep.
      const runFlow: typeof actual.runFlow = async (def, params, ports, approved) => {
        if (approved) {
          const v = tokens.verifyPlanToken(approved.planToken, ports.planKey, { nowMs: ports.clock(), sub: ports.sub, planHash: tokens.planHash(approved.plan) });
          if (v.ok === false && v.reason === 'expired') return { status: 'failed', steps: [], modelCalls: 0, spentUsd: 0, error: { code: 'forbidden', status: 403, reason: 'plan-expired', message: 'expired' } };
        }
        return actual.runFlow(def, params, ports, approved);
      };
      return { ...actual, runFlow };
    });
    try {
      const kit = await import('../src/testing/conformance.js');
      const shared = createFakeLedger({ governed: true });
      const check11 = kit.CONFORMANCE_CHECKS.find((c) => c.id === 11)!;
      expect(await check11.run({ ...goodSubject(), meter: () => shared })).toMatchObject({ status: 'fail', reason: /left its hold open/ });
      // …and even then the kit itself leaves nothing open on the host's ledger.
      expect(shared.reservations.filter((r) => r.status === 'reserved' || r.status === 'claimed')).toEqual([]);
    } finally {
      vi.doUnmock('../src/flows/run.js');
      vi.resetModules();
    }
  });

  it('runs against another product too (Comic Studio)', async () => {
    const report = await runConformance({ ...goodSubject(), manifest: COMIC_PRODUCT, catalogue: ['deck_create', 'email_draft'] });
    expect(report.filter((r) => r.status !== 'pass')).toEqual([]);
  });
});

// ── The fake platform ───────────────────────────────────────────────────────────────────────────────────────────

const now = Date.UTC(2026, 10, 2, 9, 0, 0);
const claimFor = async (purpose: 'extract' | 'pdf' | 'compose', caps: string[], userId = 'user-1') =>
  createFakeIdentity({ session: { userId }, clock: () => now }).mintUserClaim(purpose, caps as never);
const headers = (over: { [k: string]: string } = {}) => ({ 'X-Platform-App': 'dreamstream', 'X-Platform-Contract': '1', 'Idempotency-Key': 'k-1', ...over });

describe('createFakePlatform', () => {
  it('answers health and lists the app’s capabilities, with kill switches', async () => {
    const p = createFakePlatform({ clock: () => now });
    expect((await p.handle({ method: 'GET', path: '/v1/health' })).json()).toEqual({ ok: true, contract: 1 });
    p.disable('doc.extract');
    const caps = (await p.handle({ method: 'GET', path: '/v1/capabilities', headers: headers() })).json() as { capabilities: { id: string; disabled: boolean }[] };
    expect(caps.capabilities.find((c) => c.id === 'doc.extract')).toMatchObject({ disabled: true });
    expect(caps.capabilities.map((c) => c.id)).not.toContain('email.send');
  });

  it('refuses unknown apps, a wrong contract, a POST without an Idempotency-Key and a body without a claim', async () => {
    const p = createFakePlatform({ clock: () => now });
    const code = async (h: { [k: string]: string }, body?: string) => {
      const r = await p.handle({ method: 'POST', path: '/v1/extract', headers: { 'content-type': 'text/plain', ...h }, body });
      return [r.status, (r.json() as { error?: { code: string } }).error?.code];
    };
    expect(await code({ ...headers(), 'X-Platform-App': 'stranger' }, 'x')).toEqual([401, 'unauthorized']);
    expect(await code({ ...headers(), 'X-Platform-Contract': '2' }, 'x')).toEqual([400, 'invalid']);
    const noKey: { [k: string]: string } = { ...headers() };
    delete noKey['Idempotency-Key'];
    expect(await code(noKey, 'x')).toEqual([400, 'invalid']);
    expect(await code(headers(), 'hello')).toEqual([401, 'unauthorized']);
    expect(p.requests.every((r) => r.status >= 400)).toBe(true);
  });

  it('binds a claim to its capability; service claims only preview; disabled capabilities answer 503', async () => {
    const p = createFakePlatform({ clock: () => now });
    const send = async (claim: string, key: string) =>
      p.handle({ method: 'POST', path: '/v1/extract?maxPages=3', headers: { ...headers({ 'Idempotency-Key': key, 'X-Platform-Claim': claim }), 'content-type': 'text/plain' }, body: 'Meeting notes.' });
    expect((await send(await claimFor('pdf', ['pdf.inspect']), 'a')).status).toBe(403);
    const ok = await send(await claimFor('extract', ['doc.extract']), 'b');
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ plainText: 'Meeting notes.', pageCount: 1, truncated: false });
    const service = await createFakeIdentity({ session: null, clock: () => now }).mintServiceClaim!('preview', ['doc.extract']);
    expect((await send(service, 'c')).status).toBe(200);
    p.disable('doc.extract');
    expect((await send(await claimFor('extract', ['doc.extract']), 'd')).status).toBe(503);
  });

  it('scopes idempotency per caller: same body replays, a different body is 409, another user gets their own job', async () => {
    const p = createFakePlatform({ clock: () => now });
    const job = async (userId: string, op: string) =>
      p.handle({ method: 'POST', path: '/v1/jobs', headers: { ...headers({ 'X-Platform-Claim': await claimFor('compose', [], userId) }), 'content-type': 'application/json' }, body: JSON.stringify({ op }) });
    const a1 = await job('user-1', 'print');
    const a2 = await job('user-1', 'print');
    expect(a1.status).toBe(202);
    expect(a2.json()).toEqual(a1.json());
    expect((await job('user-1', 'other')).status).toBe(409);
    const b = await job('user-2', 'print');
    expect(b.status).toBe(202);
    expect((b.json() as { jobId: string }).jobId).not.toBe((a1.json() as { jobId: string }).jobId);
  });

  it('serves files as attachments only to their owner, and never HTML', async () => {
    const p = createFakePlatform({ clock: () => now });
    const claim = await claimFor('pdf', ['pdf.inspect']);
    const up = await p.handle({ method: 'POST', path: '/v1/files', headers: headers({ 'X-Platform-Claim': claim, 'X-Platform-File-Name': 'a.pdf' }), body: '%PDF-1.7 fake' });
    const { fileRef, sniffed } = up.json() as { fileRef: string; sniffed: string };
    expect(sniffed).toBe('pdf');
    const get = await p.fetch(`https://platform.test/v1/files/${fileRef}`, { headers: headers({ 'X-Platform-Claim': claim }) });
    expect(get.status).toBe(200);
    expect(get.headers.get('Content-Disposition')).toMatch(/^attachment/);
    expect(get.headers.get('x-content-type-options')).toBe('nosniff');
    expect(get.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(get.headers.get('cache-control')).toBe('private, no-store');
    const other = await p.fetch(`https://platform.test/v1/files/${fileRef}`, { headers: headers({ 'X-Platform-Claim': await claimFor('pdf', ['pdf.inspect'], 'user-2') }) });
    expect(other.status).toBe(404);
    const html = await p.handle({ method: 'POST', path: '/v1/files', headers: headers({ 'Idempotency-Key': 'k-2', 'X-Platform-Claim': claim }), body: '<html><script>x</script>' });
    const ref = (html.json() as { fileRef: string }).fileRef;
    expect((await p.fetch(`https://platform.test/v1/files/${ref}`, { headers: headers({ 'X-Platform-Claim': claim }) })).status).toBe(415);
  });

  it('PDF tools make a copy and never change the original', async () => {
    const p = createFakePlatform({ clock: () => now });
    const claim = await claimFor('pdf', ['pdf.fill']);
    const up = await p.handle({ method: 'POST', path: '/v1/files', headers: headers({ 'X-Platform-Claim': claim }), body: '%PDF-1.7 fake' });
    const { fileRef } = up.json() as { fileRef: string };
    const r = await p.handle({
      method: 'POST',
      path: '/v1/pdf',
      headers: { ...headers({ 'Idempotency-Key': 'k-2', 'X-Platform-Claim': claim }), 'content-type': 'application/json' },
      body: JSON.stringify({ fileRef, job: { op: 'fill', fields: [] } }),
    });
    expect(r.status).toBe(200);
    expect((r.json() as { fileRef: string }).fileRef).not.toBe(fileRef);
    expect(r.headers['x-platform-engine']).toBe('fake@1');
  });

  it('enforces the body cap, a daily quota and an injected signature check', async () => {
    const p = createFakePlatform({ clock: () => now, maxBodyBytes: 10, dailyQuota: 1, verify: (r) => (r.headers || {})['X-Platform-Signature'] === 'good' || 'unauthorized' });
    const claim = await claimFor('compose', []);
    const post = (key: string, body: string, sig = 'good') =>
      p.handle({ method: 'POST', path: '/v1/jobs', headers: { ...headers({ 'Idempotency-Key': key, 'X-Platform-Claim': claim, 'X-Platform-Signature': sig }), 'content-type': 'application/json' }, body });
    expect((await post('a', '{"op":"x"}', 'bad')).status).toBe(401);
    expect((await post('b', '{"op":"too-long-body"}')).status).toBe(413);
    expect((await post('c', '{"op":"x"}')).status).toBe(202);
    expect((await post('d', '{"op":"y"}')).status).toBe(429);
  });
});
