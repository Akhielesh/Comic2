// @vitest-environment node
//
// The conformance kit (plan §6; W1.4): its eleven checks pass on correct ports, and each one FAILS on a port that
// breaks its rule — a kit that cannot fail proves nothing. Then the fake platform (the in-memory /v1 every host tests
// against) enforces the wire's request rules.
import { createHmac } from 'node:crypto';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { EmailReview } from '../src/contract/email.js';
import { getCapability, isCapabilityId } from '../src/capabilities.js';
import type { CapabilityId } from '../src/capabilities.js';
import { CHAT_PRODUCT, COMIC_PRODUCT } from '../src/products.js';
import { CLAIM_PURPOSES, SERVICE_PREVIEW_CAPS } from '../src/gates/ports.js';
import type { ClaimPurpose as GatesClaimPurpose, MeterPort, ServicePreviewCap } from '../src/gates/ports.js';
import { createPlatformClient } from '../src/client/index.js';
import { PREVIEW_CAPABILITIES, USER_CLAIM_PURPOSES, WIRE_LIMITS, idempotencyScope, pseudonymousSub, signedRequestHeaders, verifyClaim } from '../src/wire/index.js';
import type { ClaimCapability, PreviewCapability, UserClaimPurpose } from '../src/wire/index.js';
import {
  CONFORMANCE_CHECKS,
  FAKE_APP_SECRET,
  FAKE_KEY_ID,
  FAKE_PLAN_KEY,
  FAKE_SUB_SECRET,
  FAKE_WIRE_CRYPTO,
  createFakeIdentity,
  createFakeLedger,
  createFakePlatform,
  createFakePorts,
  fakeClientConfig,
  fakeSub,
  runConformance,
  type ConformanceSubject,
} from '../src/testing/index.js';
import { base64urlEncode, canonicalJson, utf8Bytes } from '../src/audit/inputHash.js';

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
// Built on the wire (src/wire): every request but health and a poll-token read is checked by verifyRequest with the
// fake key ring, refusals are the wire's errorResponse, a job record id is idempotencyScope and its poll token is
// mintPollToken / verifyPollToken against the record's owner. The fake identity mints with the wire's own claim code.

const now = Date.UTC(2026, 10, 2, 9, 0, 0);
const SECRET = utf8Bytes(FAKE_APP_SECRET);
const claimFor = async (purpose: 'extract' | 'pdf' | 'compose', caps: string[], userId = 'user-1') =>
  createFakeIdentity({ session: { userId }, clock: () => now }).mintUserClaim(purpose, caps as never);

interface SignOptions {
  body?: string;
  claim?: string;
  key?: string;
  app?: string;
  secret?: Uint8Array;
  at?: number;
  contentType?: string;
  extra?: { [k: string]: string };
}
/** A request signed the way the platform client signs it (the wire's signedRequestHeaders), for raw handle() calls. */
const signed = async (method: 'GET' | 'POST', path: string, o: SignOptions = {}) => {
  const body = o.body === undefined ? null : utf8Bytes(o.body);
  const r = await signedRequestHeaders({
    app: o.app ?? 'dreamstream',
    keyId: FAKE_KEY_ID,
    secret: o.secret ?? SECRET,
    crypto: FAKE_WIRE_CRYPTO,
    method,
    target: path,
    timestamp: Math.floor((o.at ?? now) / 1000),
    body,
    claim: o.claim ?? null,
    idempotencyKey: method === 'POST' ? (o.key ?? 'k-1') : null,
  });
  if (r.ok === false) throw new Error(r.message);
  const headers: { [k: string]: string } = { ...r.headers, ...(o.contentType ? { 'content-type': o.contentType } : {}), ...(o.extra ?? {}) };
  return { method, path, headers, ...(o.body !== undefined ? { body: o.body } : {}) };
};
const errorOf = (r: { status: number; json(): unknown }) => [r.status, (r.json() as { error?: { code: string } }).error?.code];

describe('createFakePlatform', () => {
  it('answers health without a signature and lists the app’s capabilities to a signed request, with kill switches', async () => {
    const p = createFakePlatform({ clock: () => now });
    expect((await p.handle({ method: 'GET', path: '/v1/health' })).json()).toEqual({ ok: true, contract: 1 });
    p.disable('doc.extract');
    const caps = (await p.handle(await signed('GET', '/v1/capabilities'))).json() as { capabilities: { id: string; disabled: boolean }[] };
    expect(caps.capabilities.find((c) => c.id === 'doc.extract')).toMatchObject({ disabled: true });
    expect(caps.capabilities.map((c) => c.id)).not.toContain('email.send');
  });

  it('runs the wire’s checks: unsigned, unknown app, wrong contract, tampered body or claim, stale clock, no Idempotency-Key, a body without a claim', async () => {
    const p = createFakePlatform({ clock: () => now });
    const claim = await claimFor('extract', ['doc.extract']);
    const send = (req: { method: string; path: string; headers: { [k: string]: string }; body?: string }) => p.handle(req);
    const good = await signed('POST', '/v1/extract', { body: 'notes', claim, contentType: 'text/plain' });
    expect((await send(good)).status).toBe(200);
    // Not signed at all: only the app and contract headers a pre-wire fake used to accept.
    expect(errorOf(await send({ method: 'POST', path: '/v1/extract', headers: { 'X-Platform-App': 'dreamstream', 'X-Platform-Contract': '1', 'Idempotency-Key': 'k-9', 'X-Platform-Claim': claim, 'content-type': 'text/plain' }, body: 'x' }))).toEqual([401, 'unauthorized']);
    expect(errorOf(await send(await signed('POST', '/v1/extract', { app: 'stranger', body: 'x', claim, key: 'k-2' })))).toEqual([401, 'unauthorized']);
    expect(errorOf(await send({ ...(await signed('POST', '/v1/extract', { body: 'x', claim, key: 'k-3' })), headers: { ...(await signed('POST', '/v1/extract', { body: 'x', claim, key: 'k-3' })).headers, 'X-Platform-Contract': '2' } }))).toEqual([400, 'invalid']);
    expect(errorOf(await send({ ...good, body: 'notez' }))).toEqual([401, 'unauthorized']);
    const otherKeyClaim = await createFakeIdentity({ session: { userId: 'user-1' }, clock: () => now, appSecret: 'another-app-secret-for-tests-only-0123456789' }).mintUserClaim('extract', ['doc.extract']);
    expect(errorOf(await send(await signed('POST', '/v1/extract', { body: 'x', claim: otherKeyClaim, key: 'k-4', contentType: 'text/plain' })))).toEqual([401, 'unauthorized']);
    expect(errorOf(await send(await signed('POST', '/v1/extract', { body: 'x', claim, key: 'k-5', at: now - 301000, contentType: 'text/plain' })))).toEqual([401, 'unauthorized']);
    const noKey = await signed('POST', '/v1/extract', { body: 'x', claim, key: 'k-6' });
    delete noKey.headers['Idempotency-Key'];
    expect(errorOf(await send(noKey))).toEqual([400, 'invalid']);
    // Signed as an empty POST (no claim needed), then sent with a body: the transport's Content-Length gives it away.
    expect(errorOf(await send({ ...(await signed('POST', '/v1/jobs', { key: 'k-7' })), body: '{"op":"x"}' }))).toEqual([401, 'unauthorized']);
    expect(p.requests.filter((r) => r.status >= 400)).toHaveLength(8);
  });

  it('binds a claim to its capability; service claims only preview; disabled capabilities answer 503', async () => {
    const p = createFakePlatform({ clock: () => now });
    const send = async (claim: string, key: string) => p.handle(await signed('POST', '/v1/extract?maxPages=3', { body: 'Meeting notes.', claim, key, contentType: 'text/plain' }));
    expect(errorOf(await send(await claimFor('pdf', ['pdf.inspect']), 'a'))).toEqual([403, 'forbidden']);
    expect(errorOf(await send(await claimFor('extract', ['doc.convert']), 'a2'))).toEqual([403, 'forbidden']);
    const ok = await send(await claimFor('extract', ['doc.extract']), 'b');
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ plainText: 'Meeting notes.', pageCount: 1, truncated: false });
    const service = await createFakeIdentity({ session: null, clock: () => now }).mintServiceClaim!('preview', ['doc.extract']);
    expect((await send(service, 'c')).status).toBe(200);
    expect(errorOf(await p.handle(await signed('POST', '/v1/jobs', { body: '{"op":"print"}', claim: service, key: 'c2', contentType: 'application/json' })))).toEqual([403, 'forbidden']);
    p.disable('doc.extract');
    expect(errorOf(await send(await claimFor('extract', ['doc.extract']), 'd'))).toEqual([503, 'disabled']);
  });

  it('scopes idempotency per caller (the job id is the wire’s idempotencyScope): same body replays, a different body is 409', async () => {
    const p = createFakePlatform({ clock: () => now });
    const job = async (userId: string, op: string) => p.handle(await signed('POST', '/v1/jobs', { body: JSON.stringify({ op }), claim: await claimFor('compose', [], userId), contentType: 'application/json' }));
    const a1 = await job('user-1', 'print');
    const a2 = await job('user-1', 'print');
    expect(a1.status).toBe(202);
    expect(a2.json()).toEqual(a1.json());
    expect(a1.json()).toMatchObject({ state: 'queued' });
    expect((a1.json() as { jobId: string }).jobId).toBe(await idempotencyScope(FAKE_WIRE_CRYPTO, { app: 'dreamstream', sub: fakeSub('user-1'), key: 'k-1' }));
    expect(errorOf(await job('user-1', 'other'))).toEqual([409, 'conflict']);
    const b = await job('user-2', 'print');
    expect(b.status).toBe(202);
    expect((b.json() as { jobId: string }).jobId).not.toBe((a1.json() as { jobId: string }).jobId);
  });

  it('a 202’s poll token reads that job without a signature, and only that job, only by GET, only until it expires', async () => {
    let clock = now;
    const p = createFakePlatform({ clock: () => clock });
    const create = async (userId: string, key: string) =>
      (await p.handle(await signed('POST', '/v1/jobs', { body: '{"op":"print"}', claim: await claimFor('compose', [], userId), key, contentType: 'application/json' }))).json() as { jobId: string; pollToken: string };
    const mine = await create('user-1', 'k-a');
    const theirs = await create('user-2', 'k-b');
    const poll = (jobId: string, t: string) => p.handle({ method: 'GET', path: `/v1/jobs/${jobId}?t=${encodeURIComponent(t)}` });
    expect((await poll(mine.jobId, mine.pollToken)).json()).toEqual({ state: 'succeeded', progress: 1, result: { op: 'print' } });
    expect(errorOf(await poll(theirs.jobId, mine.pollToken))).toEqual([403, 'forbidden']);
    const tampered = `${mine.pollToken.slice(0, -2)}${mine.pollToken.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
    expect(errorOf(await poll(mine.jobId, tampered))).toEqual([401, 'unauthorized']);
    expect(errorOf(await poll('no-such-job', mine.pollToken))).toEqual([404, 'not-found']);
    // A signed read by its owner works too; another user's claim sees nothing.
    expect((await p.handle(await signed('GET', `/v1/jobs/${mine.jobId}`, { claim: await claimFor('compose', []) }))).status).toBe(200);
    expect(errorOf(await p.handle(await signed('GET', `/v1/jobs/${mine.jobId}`, { claim: await claimFor('compose', [], 'user-2') })))).toEqual([404, 'not-found']);
    clock = now + 901000; // the default poll lifetime is 900 s
    expect(errorOf(await poll(mine.jobId, mine.pollToken))).toEqual([401, 'unauthorized']);
  });

  it('serves files as attachments only to their owner, and never HTML', async () => {
    const p = createFakePlatform({ clock: () => now });
    const claim = await claimFor('pdf', ['pdf.inspect']);
    const up = await p.handle(await signed('POST', '/v1/files', { body: '%PDF-1.7 fake', claim, extra: { 'X-Platform-File-Name': 'a.pdf' } }));
    const { fileRef, sniffed } = up.json() as { fileRef: string; sniffed: string };
    expect(sniffed).toBe('pdf');
    const get = await p.handle(await signed('GET', `/v1/files/${fileRef}`, { claim }));
    expect(get.status).toBe(200);
    expect(get.headers['content-disposition']).toMatch(/^attachment/);
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(get.headers['cache-control']).toBe('private, no-store');
    expect(errorOf(await p.handle(await signed('GET', `/v1/files/${fileRef}`, { claim: await claimFor('pdf', ['pdf.inspect'], 'user-2') })))).toEqual([404, 'not-found']);
    // A signed read without a claim names no owner: refused.
    expect(errorOf(await p.handle(await signed('GET', `/v1/files/${fileRef}`)))).toEqual([401, 'unauthorized']);
    const html = await p.handle(await signed('POST', '/v1/files', { body: '<html><script>x</script>', claim, key: 'k-2' }));
    const ref = (html.json() as { fileRef: string }).fileRef;
    expect(errorOf(await p.handle(await signed('GET', `/v1/files/${ref}`, { claim })))).toEqual([415, 'unsupported']);
  });

  it('PDF tools make a copy and never change the original; the claim must carry the operation’s capability', async () => {
    const p = createFakePlatform({ clock: () => now });
    const claim = await claimFor('pdf', ['pdf.fill']);
    const up = await p.handle(await signed('POST', '/v1/files', { body: '%PDF-1.7 fake', claim }));
    const { fileRef } = up.json() as { fileRef: string };
    const job = (op: string, key: string) => signed('POST', '/v1/pdf', { body: JSON.stringify({ fileRef, job: { op, fields: [] } }), claim, key, contentType: 'application/json' });
    const r = await p.handle(await job('fill', 'k-2'));
    expect(r.status).toBe(200);
    expect((r.json() as { fileRef: string }).fileRef).not.toBe(fileRef);
    expect(r.headers['x-platform-engine']).toBe('fake@1');
    expect(errorOf(await p.handle(await job('redact', 'k-3')))).toEqual([403, 'forbidden']);
    expect(errorOf(await p.handle(await job('explode', 'k-4')))).toEqual([400, 'invalid']);
  });

  it('enforces the body cap (before the claim), a daily quota and an extra host check', async () => {
    const p = createFakePlatform({ clock: () => now, maxBodyBytes: 10, dailyQuota: 1, verify: (r) => (r.headers || {})['X-Host-Ok'] === 'yes' || 'forbidden' });
    const claim = await claimFor('compose', []);
    const post = async (key: string, body: string, ok = 'yes') => p.handle(await signed('POST', '/v1/jobs', { body, claim, key, contentType: 'application/json', extra: { 'X-Host-Ok': ok } }));
    expect(errorOf(await post('a', '{"op":"x"}', 'no'))).toEqual([403, 'forbidden']);
    expect(errorOf(await post('b', '{"op":"too-long-body"}'))).toEqual([413, 'too-large']);
    expect((await post('c', '{"op":"x"}')).status).toBe(202);
    expect(errorOf(await post('d', '{"op":"y"}'))).toEqual([429, 'quota']);
  });

  it('the host’s real platform client works end to end against it (fakeClientConfig)', async () => {
    const p = createFakePlatform({ clock: () => now });
    const client = createPlatformClient(fakeClientConfig(p, { now: () => now }));
    expect(client.configError).toBeNull();
    const ex = await client.extract({ bytes: utf8Bytes('Quarterly notes.'), contentType: 'text/plain', claim: await claimFor('extract', ['doc.extract']), idempotencyKey: 'ex-1', maxPages: 5 });
    expect(ex).toMatchObject({ ok: true });
    const job = await client.jobs.create({ op: 'print', input: { pages: 2 }, claim: await claimFor('compose', []), idempotencyKey: 'job-1' });
    expect(job).toMatchObject({ ok: true, job: { state: 'queued' } });
    if (job.ok === false) return;
    const read = await client.jobs.get({ jobId: job.job.jobId, claim: await claimFor('compose', []) });
    expect(read).toMatchObject({ ok: true });
    // A request signed with another key is refused by the fake exactly as the gateway would.
    const wrong = createPlatformClient(fakeClientConfig(p, { now: () => now, secret: utf8Bytes('another-app-secret-for-tests-only-0123456789') }));
    expect(await wrong.jobs.create({ op: 'print', input: {}, claim: await claimFor('compose', []), idempotencyKey: 'job-2' })).toMatchObject({ ok: false, code: 'unauthorized' });
  });
});

describe('claim shapes are the wire’s (one definition)', () => {
  it('the fake identity’s claims are minted by the wire: they verify with verifyClaim and carry pseudonymousSub', async () => {
    const token = await claimFor('extract', ['doc.extract']);
    const v = await verifyClaim(token, { secret: SECRET, crypto: FAKE_WIRE_CRYPTO, now: () => now, app: 'dreamstream', purposes: ['extract'], capability: 'doc.extract' });
    expect(v).toMatchObject({ ok: true, claim: { v: 1, kind: 'user', app: 'dreamstream', product: 'chat', tier: 'free', purpose: 'extract', caps: ['doc.extract'], exp: Math.floor(now / 1000) + WIRE_LIMITS.claimTtlDefaultSeconds } });
    const sub = await pseudonymousSub(FAKE_WIRE_CRYPTO, utf8Bytes(FAKE_SUB_SECRET), 'user-1');
    expect(sub).toMatch(/^[0-9a-f]{32}$/);
    if (v.ok === true && v.claim.kind === 'user') expect(v.claim.sub).toBe(sub);
    expect(fakeSub('user-1')).toBe(sub);
    expect(createFakePorts().sub).toBe(sub);
    // The sub is not the old HMAC(appSecret, userId) shortcut, and the payload is in the wire's field order.
    expect(sub).not.toBe(createHmac('sha256', FAKE_APP_SECRET).update('user-1').digest('hex').slice(0, 32));
    expect(Object.keys(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')))).toEqual(['v', 'kind', 'app', 'product', 'sub', 'tier', 'purpose', 'caps', 'exp', 'jti']);
    const svc = await createFakeIdentity({ session: null, clock: () => now }).mintServiceClaim!('preview', ['doc.thumbnail']);
    expect(await verifyClaim(svc, { secret: SECRET, crypto: FAKE_WIRE_CRYPTO, now: () => now, app: 'dreamstream', purposes: ['preview'] })).toMatchObject({ ok: true, claim: { kind: 'service', purpose: 'preview', caps: ['doc.thumbnail'] } });
  });

  it('ClaimPurpose and the preview capabilities have one definition: gates/ports re-exports the wire’s', () => {
    expect(CLAIM_PURPOSES).toBe(USER_CLAIM_PURPOSES);
    expect(SERVICE_PREVIEW_CAPS).toBe(PREVIEW_CAPABILITIES);
    expectTypeOf<GatesClaimPurpose>().toEqualTypeOf<UserClaimPurpose>();
    expectTypeOf<ServicePreviewCap>().toEqualTypeOf<PreviewCapability>();
  });

  it('every PREVIEW_CAPABILITIES entry is a registered capability, and ClaimCapability is CapabilityId', () => {
    for (const cap of PREVIEW_CAPABILITIES) {
      expect(isCapabilityId(cap), cap).toBe(true);
      expect(getCapability(cap)?.id, cap).toBe(cap);
    }
    expectTypeOf<ClaimCapability>().toEqualTypeOf<CapabilityId>();
    expectTypeOf<PreviewCapability>().toMatchTypeOf<CapabilityId>();
  });
});
