// @vitest-environment node
//
// The never-throwing platform client (plan §5.8, W1.5). A fake gateway verifies every request the client sends with
// the wire's own verifier, so these tests prove the client signs exactly what it sends. Covered: network errors →
// {ok:false, code:'engine-failed', retryable:true}; the 413 / 415 / 504 mapping; a POST without an Idempotency-Key,
// or a body POST without a claim, refused before anything is sent; a changed ?maxPages= refused by the gateway;
// malformed answers; injected crypto, clock and fetch that fail; and the injected types accepting the platform's own
// fetch and WebCrypto under strict TypeScript.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  deriveWireKey,
  encodeWarnings,
  errorResponse,
  mintServiceClaim,
  mintUserClaim,
  sealToken,
  signedRequestHeaders,
  utf8Decode,
  utf8Encode,
  verifyRequest,
  wireCryptoFromSubtle,
} from '../wire/index.js';
import type { FetchInitLike, FetchLike, FetchResponseLike, PreflightOptions, SubtleCryptoLike, WireCrypto, WireFailure } from '../wire/index.js';
import { createPlatformClient, jobPollUrl, verifyCallback } from './index.js';
import type { PlatformClient, PlatformClientConfig } from './index.js';

// ── Harness ─────────────────────────────────────────────────────────────────────────────────────────────────────

const nodeCrypto: WireCrypto = {
  sha256: (d) => new Uint8Array(createHash('sha256').update(d).digest()),
  hmacSha256: (k, d) => new Uint8Array(createHmac('sha256', k).update(d).digest()),
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
};
const webCrypto = wireCryptoFromSubtle(webcrypto.subtle as unknown as SubtleCryptoLike, (a) => webcrypto.getRandomValues(a));

const SECRET = new Uint8Array(createHash('sha256').update('fixture secret: client tests').digest());
const NOW_S = 1793610000;
const clock = () => NOW_S * 1000;
const ORIGIN = 'https://platform.test';
const SUB = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PDF = utf8Encode('%PDF-1.7\n% synthetic\n');

interface Call {
  url: string;
  init: FetchInitLike;
}

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

/** A Response the way the platform's fetch returns one (Node 22's own Response). */
const respond = (a: Answer): FetchResponseLike => {
  const body = a.body === undefined ? null : typeof a.body === 'string' ? a.body : Buffer.from(a.body);
  return new Response(a.status === 204 ? null : body, { status: a.status, headers: a.headers });
};

const json = (status: number, value: unknown, headers: Record<string, string> = {}): Answer => ({
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(value),
});

/**
 * A gateway: checks each request with the wire's verifier (as the real one will) and answers with `handler`, or with
 * the platform error body for a refused request.
 */
const gateway = (handler: (call: Call, body: Uint8Array) => Answer | Promise<Answer>, opts: Partial<PreflightOptions> = {}) => {
  const calls: Call[] = [];
  const refusals: WireFailure[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    expect(url.startsWith(`${ORIGIN}/`)).toBe(true);
    const target = url.slice(ORIGIN.length);
    const body = init.body ? new Uint8Array(init.body) : new Uint8Array(0);
    const headers = { ...init.headers, ...(init.method === 'POST' ? { 'Content-Length': String(body.length) } : {}) };
    const v = await verifyRequest({ method: init.method, target, headers }, body, {
      crypto: nodeCrypto,
      now: clock,
      keys: (app, kid) => (app === 'dreamstream' && kid === 'ds-1' ? SECRET : undefined),
      claim: { purposes: ['compose', 'render', 'extract', 'pdf', 'export', 'job-read', 'preview'] },
      maxBodyBytes: 50000000,
      ...opts,
    });
    if (v.ok === false) {
      refusals.push(v);
      const e = errorResponse(v, 'req-refused');
      return respond({ status: e.status, headers: { 'Content-Type': 'application/json' }, body: e.body });
    }
    return respond(await handler({ url, init }, body));
  };
  return { fetch, calls, refusals };
};

const configFor = (fetch: FetchLike, over: Partial<PlatformClientConfig> = {}): PlatformClientConfig => ({
  baseUrl: ORIGIN,
  app: 'dreamstream',
  keyId: 'ds-1',
  secret: SECRET,
  crypto: nodeCrypto,
  fetch,
  now: clock,
  ...over,
});

let claimToken = '';
let serviceToken = '';
const claim = async () => {
  if (!claimToken) {
    const r = await mintUserClaim(
      { secret: SECRET, crypto: nodeCrypto, now: clock },
      { app: 'dreamstream', product: 'chat', sub: SUB, tier: 'creator', purpose: 'extract', caps: ['doc.extract'], jti: 'jti-client' },
    );
    if (r.ok === false) throw new Error(r.message);
    claimToken = r.token;
  }
  return claimToken;
};
const svcClaim = async () => {
  if (!serviceToken) {
    const r = await mintServiceClaim({ secret: SECRET, crypto: nodeCrypto, now: clock }, { app: 'dreamstream', product: 'chat', caps: ['doc.convert'], jti: 'jti-svc' });
    if (r.ok === false) throw new Error(r.message);
    serviceToken = r.token;
  }
  return serviceToken;
};

const EXTRACT_RESULT = {
  plainText: 'Hello\fpage two',
  sections: [{ id: 's1', title: 'Intro', kind: 'heading', content: 'Hello', pageNumber: 1 }],
  pageCount: 2,
  truncated: false,
  engine: 'unpdf@2.1.0',
};
const pollToken = async (jobId: string) =>
  sealToken(nodeCrypto, await deriveWireKey(nodeCrypto, SECRET, 'poll'), { v: 1, kind: 'poll', app: 'dreamstream', kid: 'ds-1', sub: SUB, jobId, exp: NOW_S + 900 });

/** Every call the client makes, with valid input, keyed by name. */
const everyCall = async (client: PlatformClient) => {
  const c = await claim();
  return {
    convert: () => client.convert({ bytes: PDF, contentType: 'application/pdf', fileName: 'a.pdf', targetFormat: 'pdf', claim: c, idempotencyKey: 'k-convert' }),
    extract: () => client.extract({ bytes: PDF, contentType: 'application/pdf', maxPages: 24, claim: c, idempotencyKey: 'k-extract' }),
    uploadFile: () => client.uploadFile({ bytes: PDF, fileName: 'a.pdf', claim: c, idempotencyKey: 'k-upload' }),
    downloadFile: () => client.downloadFile({ fileRef: 'file-1', claim: c }),
    pdf: () => client.pdf({ fileRef: 'file-1', job: { op: 'inspect' }, claim: c, idempotencyKey: 'k-pdf' }),
    render: () => client.render({ kind: 'docx', spec: { v: 1, title: 'T', sections: [] }, claim: c, idempotencyKey: 'k-render' }),
    'jobs.create': () => client.jobs.create({ op: 'print_book', input: { title: 'T' }, claim: c, idempotencyKey: 'k-job' }),
    'jobs.get': () => client.jobs.get({ jobId: 'job-1', claim: c }),
  };
};

// ── Signing end to end ──────────────────────────────────────────────────────────────────────────────────────────

describe.each([
  ['node:crypto', nodeCrypto],
  ['WebCrypto', webCrypto],
] as [string, WireCrypto][])('the client signs what it sends (%s)', (_name, crypto) => {
  it('extract: a signed POST with the canonical query, the claim, the key and the exact body; the answer parsed', async () => {
    const gw = gateway(() => json(200, EXTRACT_RESULT, { 'X-Platform-Engine': 'unpdf@2.1.0', 'X-Platform-Warnings': encodeWarnings(['page 2 is a scan']), 'X-Platform-Cost-Micros': '1500', 'X-Request-Id': 'req-9' }));
    const client = createPlatformClient(configFor(gw.fetch, { crypto, requestId: () => 'req-9' }));
    const r = await client.extract({ bytes: PDF, contentType: 'application/pdf', maxPages: 24, claim: await claim(), idempotencyKey: 'extract-1' });
    expect(gw.refusals).toEqual([]);
    // Bytes from another realm (a vm context) are bytes too.
    const foreign = runInNewContext(`new Uint8Array([${Array.from(PDF).join(',')}])`) as Uint8Array;
    expect(await client.extract({ bytes: foreign, contentType: 'application/pdf', maxPages: 24, claim: await claim(), idempotencyKey: 'extract-1' })).toMatchObject({ ok: true });
    expect(r).toEqual({ ok: true, result: EXTRACT_RESULT, meta: { status: 200, engine: 'unpdf@2.1.0', warnings: ['page 2 is a scan'], costMicros: 1500, requestId: 'req-9' } });
    expect(gw.calls).toHaveLength(2);
    expect(gw.calls[1].init.headers['X-Platform-Signature']).toBe(gw.calls[0].init.headers['X-Platform-Signature']);
    const { url, init } = gw.calls[0];
    expect(url).toBe(`${ORIGIN}/v1/extract?maxPages=24`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(new Uint8Array(init.body!)).toEqual(PDF);
    expect(init.headers).toMatchObject({
      'X-Platform-App': 'dreamstream',
      'X-Platform-Key-Id': 'ds-1',
      'X-Platform-Timestamp': String(NOW_S),
      'X-Platform-Contract': '1',
      'X-Platform-Claim': await claim(),
      'Idempotency-Key': 'extract-1',
      'X-Request-Id': 'req-9',
      'Content-Type': 'application/pdf',
    });
    expect(init.headers['X-Platform-Signature']).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('every endpoint passes the gateway verifier', async () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    const sha = createHash('sha256').update(PDF).digest('hex');
    const gw = gateway(async ({ url, init }) => {
      const path = url.slice(ORIGIN.length).split('?')[0];
      if (path === '/v1/convert') return { status: 200, headers: { 'Content-Type': 'application/pdf' }, body: PDF };
      if (path === '/v1/extract') return json(200, EXTRACT_RESULT);
      if (path === '/v1/files') return json(201, { fileRef: 'file-1', sha256: sha, bytes: PDF.length, sniffed: 'application/pdf' });
      if (path === '/v1/files/file-1') return { status: 200, headers: { 'Content-Type': 'application/pdf' }, body: PDF };
      if (path === '/v1/pdf') return json(200, { fileRef: 'file-2', report: { pages: 3 } });
      if (path === '/v1/render') return { status: 200, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, body: zip };
      if (path === '/v1/jobs' && init.method === 'POST') return json(202, { jobId: 'job-1', pollToken: await pollToken('job-1'), state: 'queued' });
      if (path === '/v1/jobs/job-1') return json(200, { state: 'running', progress: 0.5 });
      return { status: 404 };
    });
    const calls = await everyCall(createPlatformClient(configFor(gw.fetch, { crypto })));
    for (const [name, run] of Object.entries(calls)) expect(await run(), name).toMatchObject({ ok: true });
    expect(gw.refusals).toEqual([]);
    expect(gw.calls.every((c) => c.init.redirect === 'error')).toBe(true);
  });
});

describe('a signed request cannot be changed on the way', () => {
  it('a proxy that rewrites ?maxPages= after signing gets the gateway refusal, as an unauthorized failure', async () => {
    const gw = gateway(() => json(200, EXTRACT_RESULT));
    const rewriting: FetchLike = (url, init) => gw.fetch(url.replace('maxPages=24', 'maxPages=300'), init);
    const r = await createPlatformClient(configFor(rewriting)).extract({ bytes: PDF, contentType: 'application/pdf', maxPages: 24, claim: await claim(), idempotencyKey: 'k1' });
    expect(r).toMatchObject({ ok: false, code: 'unauthorized', retryable: false, status: 401, requestId: 'req-refused' });
    expect(gw.refusals).toMatchObject([{ reason: 'bad-signature' }]);
  });

  it('different maxPages values are different signed requests', async () => {
    const gw = gateway(() => json(200, EXTRACT_RESULT));
    const client = createPlatformClient(configFor(gw.fetch));
    await client.extract({ bytes: PDF, contentType: 'application/pdf', maxPages: 24, claim: await claim(), idempotencyKey: 'k1' });
    await client.extract({ bytes: PDF, contentType: 'application/pdf', maxPages: 300, claim: await claim(), idempotencyKey: 'k1' });
    expect(gw.calls[1].url).toBe(`${ORIGIN}/v1/extract?maxPages=300`);
    expect(gw.calls[0].init.headers['X-Platform-Signature']).not.toBe(gw.calls[1].init.headers['X-Platform-Signature']);
    expect(gw.refusals).toEqual([]);
  });
});

// ── Refusals before sending ─────────────────────────────────────────────────────────────────────────────────────

describe('refused before anything is sent', () => {
  it('a POST without an Idempotency-Key, on every POST endpoint', async () => {
    const fetch = vi.fn<FetchLike>();
    const client = createPlatformClient(configFor(fetch));
    const c = await claim();
    for (const key of [undefined, '', 'has space', 'x'.repeat(129), 'ünïcode']) {
      const results = [
        await client.convert({ bytes: PDF, contentType: 'application/pdf', fileName: 'a.pdf', targetFormat: 'pdf', claim: c, idempotencyKey: key as string }),
        await client.extract({ bytes: PDF, contentType: 'application/pdf', claim: c, idempotencyKey: key as string }),
        await client.uploadFile({ bytes: PDF, fileName: 'a.pdf', claim: c, idempotencyKey: key as string }),
        await client.pdf({ fileRef: 'file-1', job: { op: 'inspect' }, claim: c, idempotencyKey: key as string }),
        await client.render({ kind: 'pdf', spec: {}, claim: c, idempotencyKey: key as string }),
        await client.jobs.create({ op: 'print_book', input: {}, claim: c, idempotencyKey: key as string }),
      ];
      for (const r of results) expect(r, String(key)).toMatchObject({ ok: false, code: 'invalid', retryable: false, reason: 'idempotency-key' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a POST that carries a body without a claim, on every POST endpoint', async () => {
    const fetch = vi.fn<FetchLike>();
    const client = createPlatformClient(configFor(fetch));
    for (const missing of [undefined, '']) {
      const results = [
        await client.convert({ bytes: PDF, contentType: 'application/pdf', fileName: 'a.pdf', targetFormat: 'pdf', claim: missing as string, idempotencyKey: 'k1' }),
        await client.extract({ bytes: PDF, contentType: 'application/pdf', claim: missing as string, idempotencyKey: 'k1' }),
        await client.uploadFile({ bytes: PDF, fileName: 'a.pdf', claim: missing as string, idempotencyKey: 'k1' }),
        await client.pdf({ fileRef: 'file-1', job: { op: 'inspect' }, claim: missing as string, idempotencyKey: 'k1' }),
        await client.render({ kind: 'pdf', spec: {}, claim: missing as string, idempotencyKey: 'k1' }),
        await client.jobs.create({ op: 'print_book', input: {}, claim: missing as string, idempotencyKey: 'k1' }),
      ];
      for (const r of results) expect(r).toMatchObject({ ok: false, code: 'invalid', reason: 'claim-required' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('bad arguments, a body over 50 MB and a bad config are refused without a request', async () => {
    const fetch = vi.fn<FetchLike>();
    const client = createPlatformClient(configFor(fetch));
    const c = await claim();
    for (const maxPages of [0, 301, 1.5, -1]) {
      expect(await client.extract({ bytes: PDF, contentType: 'application/pdf', maxPages, claim: c, idempotencyKey: 'k1' }), String(maxPages)).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(await client.convert({ bytes: PDF, contentType: 'application/pdf', fileName: 'bad\nname', targetFormat: 'pdf', claim: c, idempotencyKey: 'k1' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await client.convert({ bytes: PDF, contentType: 'text/plain\r\nX-Evil: 1', fileName: 'a.pdf', targetFormat: 'pdf', claim: c, idempotencyKey: 'k1' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await client.convert({ bytes: PDF, contentType: 'application/pdf', fileName: 'a.pdf', targetFormat: 'docx' as never, claim: c, idempotencyKey: 'k1' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await client.downloadFile({ fileRef: '../etc/passwd' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await client.jobs.get({ jobId: 'job/1' })).toMatchObject({ ok: false, code: 'invalid' });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await client.jobs.create({ op: 'print_book', input: cyclic, claim: c, idempotencyKey: 'k1' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await client.render({ kind: 'pdf', spec: { n: BigInt(1) } as never, claim: c, idempotencyKey: 'k1' })).toMatchObject({ ok: false, code: 'invalid' });
    const huge = new Uint8Array(50000001);
    expect(await client.uploadFile({ bytes: huge, fileName: 'big.pdf', claim: c, idempotencyKey: 'k1' })).toMatchObject({ ok: false, code: 'too-large', retryable: false });
    for (const bad of [{ baseUrl: 'http://platform.test' }, { baseUrl: 'https://platform.test/v1' }, { secret: new Uint8Array(16) }, { app: 'Bad App' }, { keyId: '' }, { fetch: undefined as never }]) {
      const broken = createPlatformClient(configFor(fetch, bad));
      expect(broken.configError, JSON.stringify(Object.keys(bad))).not.toBeNull();
      expect(await broken.extract({ bytes: PDF, contentType: 'application/pdf', claim: c, idempotencyKey: 'k1' })).toMatchObject({ ok: false, code: 'invalid' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ── Failures ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('failures come back as results', () => {
  it('a network error is {ok:false, code:engine-failed, retryable:true} on every call', async () => {
    const throwing: FetchLike[] = [
      () => Promise.reject(new TypeError('fetch failed: ECONNRESET')),
      () => {
        throw new TypeError('synchronous failure');
      },
      () => Promise.reject(new TypeError('redirect mode is set to error')),
      () => Promise.reject('not even an Error'),
    ];
    for (const fetch of throwing) {
      const calls = await everyCall(createPlatformClient(configFor(fetch)));
      for (const [name, run] of Object.entries(calls)) {
        const r = await run();
        expect(r, name).toMatchObject({ ok: false, code: 'engine-failed', retryable: true, reason: 'network' });
      }
    }
  });

  it('a body cut off mid-read is a network error too', async () => {
    const fetch: FetchLike = async () => ({ status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), arrayBuffer: () => Promise.reject(new Error('terminated')) });
    const r = await createPlatformClient(configFor(fetch)).extract({ bytes: PDF, contentType: 'application/pdf', claim: await claim(), idempotencyKey: 'k1' });
    expect(r).toMatchObject({ ok: false, code: 'engine-failed', retryable: true, reason: 'network' });
  });

  it('413, 415 and 504 map to too-large, unsupported and timeout, with or without a platform error body', async () => {
    const cases: [Answer, Record<string, unknown>][] = [
      [{ status: 413, headers: { 'Content-Type': 'text/html' }, body: '<html>413 Request Entity Too Large</html>' }, { code: 'too-large', retryable: false, status: 413 }],
      [{ status: 415, body: 'Unsupported Media Type' }, { code: 'unsupported', retryable: false, status: 415 }],
      [{ status: 504 }, { code: 'timeout', retryable: true, status: 504 }],
      [{ status: 504, headers: { 'Content-Type': 'text/html' }, body: '<html>Gateway Time-out</html>' }, { code: 'timeout', retryable: true }],
      [json(413, { error: { code: 'too-large', message: 'over 50 MB', retryable: false, requestId: 'req-413' } }), { code: 'too-large', message: 'over 50 MB', requestId: 'req-413' }],
      [json(415, { error: { code: 'unsupported', message: 'Office formats arrive in wave 4', retryable: false, requestId: 'req-415' } }), { code: 'unsupported', requestId: 'req-415' }],
      [json(504, { error: { code: 'timeout', message: 'over 25 s', retryable: true, requestId: 'req-504' } }), { code: 'timeout', retryable: true }],
      [json(422, { error: { code: 'input-rejected', message: 'zip bomb', retryable: false, requestId: 'r' } }), { code: 'input-rejected', retryable: false }],
      [{ status: 429, headers: { 'X-Request-Id': 'req-429' } }, { code: 'quota', retryable: true, requestId: 'req-429' }],
      [{ status: 503 }, { code: 'disabled', retryable: true }],
      [{ status: 302, headers: { Location: 'https://elsewhere.test/' } }, { code: 'engine-failed' }],
    ];
    for (const [answer, expected] of cases) {
      const gw = gateway(() => answer);
      const c = createPlatformClient(configFor(gw.fetch));
      const conv = await c.convert({ bytes: PDF, contentType: 'application/pdf', fileName: 'a.pdf', targetFormat: 'pdf', claim: await svcClaim(), idempotencyKey: 'k1' });
      expect(conv, `${answer.status} convert`).toMatchObject({ ok: false, reason: 'gateway', ...expected });
      const ext = await c.extract({ bytes: PDF, contentType: 'application/pdf', claim: await claim(), idempotencyKey: 'k1' });
      expect(ext, `${answer.status} extract`).toMatchObject({ ok: false, ...expected });
    }
  });

  it('a malformed answer is a response failure, never a throw', async () => {
    const answers: Answer[] = [
      { status: 200, headers: { 'Content-Type': 'application/json' }, body: 'not json' },
      json(200, { ...EXTRACT_RESULT, pageCount: -1 }),
      json(200, { ...EXTRACT_RESULT, sections: [{ id: 's1' }] }),
      json(200, { ...EXTRACT_RESULT, plainText: 7 }),
      json(200, null),
      { status: 200, headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([0xff, 0xfe]) },
      json(201, EXTRACT_RESULT),
    ];
    for (const answer of answers) {
      const r = await createPlatformClient(configFor(gateway(() => answer).fetch)).extract({ bytes: PDF, contentType: 'application/pdf', claim: await claim(), idempotencyKey: 'k1' });
      expect(r, String(answer.body)).toMatchObject({ ok: false, code: 'engine-failed', reason: 'response' });
    }
  });

  it('an answer over the size cap is refused, before reading when Content-Length says so', async () => {
    const read = vi.fn(async () => new ArrayBuffer(10));
    const declared: FetchLike = async () => ({ status: 200, headers: new Headers({ 'Content-Length': '999999', 'Content-Type': 'application/pdf' }), arrayBuffer: read });
    const r = await createPlatformClient(configFor(declared, { maxResponseBytes: 1000 })).downloadFile({ fileRef: 'file-1' });
    expect(r).toMatchObject({ ok: false, reason: 'response' });
    expect(read).not.toHaveBeenCalled();
    const undeclared = gateway(() => ({ status: 200, headers: { 'Content-Type': 'application/pdf' }, body: new Uint8Array(2000) }));
    expect(await createPlatformClient(configFor(undeclared.fetch, { maxResponseBytes: 1000 })).downloadFile({ fileRef: 'file-1' })).toMatchObject({ ok: false, reason: 'response' });
  });

  it('a failing injected crypto, clock or request-id maker is an internal failure, not a throw', async () => {
    const fetch = vi.fn<FetchLike>();
    const c = await claim();
    const broken: Partial<PlatformClientConfig>[] = [
      { crypto: { sha256: () => Promise.reject(new Error('no digest')), hmacSha256: nodeCrypto.hmacSha256 } },
      { crypto: { sha256: nodeCrypto.sha256, hmacSha256: () => new Uint8Array(4) } },
      {
        crypto: {
          sha256: nodeCrypto.sha256,
          hmacSha256: () => {
            throw new Error('no hmac');
          },
        },
      },
      {
        now: () => {
          throw new Error('no clock');
        },
      },
      { now: () => NaN },
      {
        requestId: () => {
          throw new Error('no ids');
        },
      },
    ];
    for (const over of broken) {
      const r = await createPlatformClient(configFor(fetch, over)).extract({ bytes: PDF, contentType: 'application/pdf', claim: c, idempotencyKey: 'k1' });
      expect(r).toMatchObject({ ok: false, code: 'engine-failed', retryable: false, reason: 'internal' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never throws, whatever it is handed', async () => {
    const gw = gateway(() => json(200, {}));
    const client = createPlatformClient(configFor(gw.fetch));
    const junk: unknown[] = [undefined, null, 0, 'x', [], {}, { bytes: 'not bytes' }, { bytes: new Uint8Array(0) }, { fileRef: 5 }, { jobId: null }, { kind: 'exe' }, { op: 'Bad Op' }];
    const methods: ((input: never) => Promise<unknown>)[] = [
      client.convert,
      client.extract,
      client.uploadFile,
      client.downloadFile,
      client.pdf,
      client.render,
      client.jobs.create,
      client.jobs.get,
    ];
    for (const method of methods) {
      for (const input of junk) {
        const r = await method(input as never);
        expect(r).toMatchObject({ ok: false });
      }
    }
    // An input or a config whose every property read throws (a hostile proxy): still a result, never a throw.
    const hostile = new Proxy({}, { get: () => { throw new Error('hostile getter'); } });
    for (const method of methods) expect(await method(hostile as never)).toMatchObject({ ok: false, code: 'engine-failed', reason: 'internal' });
    expect(await verifyCallback(hostile as never, hostile as never)).toMatchObject({ ok: false, reason: 'internal' });
    const fromHostile = createPlatformClient(hostile as never);
    expect(fromHostile.configError).toBe('the client config cannot be read');
    expect(await fromHostile.extract({} as never)).toMatchObject({ ok: false, code: 'invalid' });
    expect(createPlatformClient(null as never).configError).not.toBeNull();
    expect(await createPlatformClient(null as never).extract({} as never)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await verifyCallback(null as never, null as never)).toMatchObject({ ok: false });
  });
});

// ── Answers ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('answers are checked against the contract', () => {
  const run = async (answer: Answer | ((call: Call, body: Uint8Array) => Answer | Promise<Answer>), call: (c: PlatformClient) => Promise<unknown>) => {
    const gw = gateway(typeof answer === 'function' ? answer : () => answer);
    return call(createPlatformClient(configFor(gw.fetch)));
  };

  it('convert: a PDF must be a PDF; HTML and text pass through with their type; the established headers are sent', async () => {
    const conv = (c: PlatformClient) => c.convert({ bytes: PDF, contentType: 'application/msword', fileName: 'Résumé (final).doc', targetFormat: 'html', claim: serviceToken, idempotencyKey: 'k1' });
    await svcClaim();
    expect(await run({ status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: '<p>hi</p>' }, conv)).toMatchObject({ ok: true, contentType: 'text/html' });
    expect(await run({ status: 200, headers: { 'Content-Type': 'application/pdf' }, body: 'not a pdf' }, conv)).toMatchObject({ ok: false, reason: 'response' });
    expect(await run({ status: 200, headers: { 'Content-Type': 'image/svg+xml' }, body: '<svg/>' }, conv)).toMatchObject({ ok: false, reason: 'response' });
    expect(await run(json(202, { jobId: 'j', pollToken: 'x.y' }), conv)).toMatchObject({ ok: false, reason: 'response' });
    let seen: FetchInitLike | undefined;
    await run((call) => {
      seen = call.init;
      return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'hi' };
    }, conv);
    expect(seen!.headers).toMatchObject({ 'X-Atlas-File-Name': 'R%C3%A9sum%C3%A9%20%28final%29.doc', 'X-Atlas-Target-Format': 'html', 'Content-Type': 'application/msword' });
    // The longest allowed name, all non-ASCII, percent-encodes to 1,530 characters and is still sent.
    const longName = 'é'.repeat(255);
    const long = await run((call) => {
      seen = call.init;
      return { status: 200, headers: { 'Content-Type': 'text/plain' }, body: 'hi' };
    }, (c) => c.convert({ bytes: PDF, contentType: 'application/msword', fileName: longName, targetFormat: 'html', claim: serviceToken, idempotencyKey: 'k2' }));
    expect(long).toMatchObject({ ok: true });
    expect(seen!.headers['X-Atlas-File-Name']).toBe('%C3%A9'.repeat(255));
    expect(await run({ status: 200 }, (c) => c.convert({ bytes: PDF, contentType: 'x', fileName: 'é'.repeat(256), targetFormat: 'html', claim: serviceToken, idempotencyKey: 'k3' }))).toMatchObject({
      ok: false,
      code: 'invalid',
    });
  });

  it('uploadFile: the answer must name the SHA-256 of exactly the bytes sent', async () => {
    const sha = createHash('sha256').update(PDF).digest('hex');
    const up = async (c: PlatformClient) => c.uploadFile({ bytes: PDF, fileName: 'a.pdf', claim: await claim(), idempotencyKey: 'k1' });
    expect(await run(json(201, { fileRef: 'file-1', sha256: sha, bytes: PDF.length, sniffed: 'application/pdf' }), up)).toMatchObject({
      ok: true,
      file: { fileRef: 'file-1', sha256: sha, bytes: PDF.length },
    });
    expect(await run(json(201, { fileRef: 'file-1', sha256: 'f'.repeat(64), bytes: PDF.length, sniffed: 'application/pdf' }), up)).toMatchObject({ ok: false, reason: 'response' });
    expect(await run(json(201, { fileRef: '../x', sha256: sha, bytes: PDF.length, sniffed: 'application/pdf' }), up)).toMatchObject({ ok: false, reason: 'response' });
  });

  it('downloadFile never hands back HTML or SVG', async () => {
    const dl = (c: PlatformClient) => c.downloadFile({ fileRef: 'file-1' });
    expect(await run({ status: 200, headers: { 'Content-Type': 'application/pdf' }, body: PDF }, dl)).toMatchObject({ ok: true, contentType: 'application/pdf' });
    for (const type of ['text/html', 'TEXT/HTML; charset=utf-8', 'image/svg+xml']) {
      expect(await run({ status: 200, headers: { 'Content-Type': type }, body: '<x/>' }, dl), type).toMatchObject({ ok: false, reason: 'response' });
    }
  });

  it('pdf and render: a result or a 202 job, and render bytes must be the kind asked for', async () => {
    const c = await claim();
    const pdfCall = (cl: PlatformClient) => cl.pdf({ fileRef: 'file-1', job: { op: 'redact', marks: [{ page: 1, text: 'secret' }] }, claim: c, idempotencyKey: 'k1' });
    expect(await run(json(200, { fileRef: 'file-2', report: { removed: 1 } }), pdfCall)).toMatchObject({ ok: true, kind: 'done', fileRef: 'file-2', report: { removed: 1 } });
    const token = await pollToken('job-7');
    expect(await run(json(202, { jobId: 'job-7', pollToken: token }), pdfCall)).toMatchObject({ ok: true, kind: 'job', jobId: 'job-7', pollToken: token });
    expect(await run(json(202, { jobId: 'job-7' }), pdfCall)).toMatchObject({ ok: false, reason: 'response' });
    const docx = (cl: PlatformClient) => cl.render({ kind: 'docx', spec: { v: 1 }, claim: c, idempotencyKey: 'k1' });
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]);
    const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(await run({ status: 200, headers: { 'Content-Type': docxType }, body: zip }, docx)).toMatchObject({ ok: true, kind: 'file', contentType: docxType });
    expect(await run({ status: 200, headers: { 'Content-Type': 'application/pdf' }, body: PDF }, docx)).toMatchObject({ ok: false, reason: 'response' });
    expect(await run({ status: 200, headers: { 'Content-Type': docxType }, body: PDF }, docx)).toMatchObject({ ok: false, reason: 'response' });
    expect(await run(json(202, { jobId: 'job-8', pollToken: token }), docx)).toMatchObject({ ok: true, kind: 'job', jobId: 'job-8' });
  });

  it('jobs: create gives a poll token, get gives a status, and the poll URL is the only browser call', async () => {
    const c = await claim();
    const token = await pollToken('job-1');
    expect(await run(json(202, { jobId: 'job-1', pollToken: token, state: 'queued' }), (cl) => cl.jobs.create({ op: 'print_book', input: { pages: 3 }, claim: c, idempotencyKey: 'k1' }))).toMatchObject({
      ok: true,
      job: { jobId: 'job-1', pollToken: token, state: 'queued' },
    });
    const get = (cl: PlatformClient) => cl.jobs.get({ jobId: 'job-1', claim: c });
    expect(await run(json(200, { state: 'succeeded', progress: 1, result: { fileRef: 'file-3' } }), get)).toMatchObject({ ok: true, job: { state: 'succeeded', progress: 1, result: { fileRef: 'file-3' } } });
    expect(await run(json(200, { state: 'failed', progress: 0.2, error: { code: 'engine-failed', message: 'exit 137' } }), get)).toMatchObject({ ok: true, job: { state: 'failed', error: { code: 'engine-failed' } } });
    for (const bad of [{ state: 'exploded', progress: 0 }, { state: 'running', progress: 2 }, { state: 'running' }, { state: 'failed', progress: 0, error: 'boom' }]) {
      expect(await run(json(200, bad), get), JSON.stringify(bad)).toMatchObject({ ok: false, reason: 'response' });
    }
    const client = createPlatformClient(configFor(vi.fn<FetchLike>()));
    expect(client.jobs.pollUrl('job-1', token)).toBe(`${ORIGIN}/v1/jobs/job-1?t=${token}`);
    expect(jobPollUrl(`${ORIGIN}/`, 'job-1', token)).toBe(`${ORIGIN}/v1/jobs/job-1?t=${token}`);
    expect(client.jobs.pollUrl('../admin', token)).toBeNull();
    expect(client.jobs.pollUrl('job-1', 'not a token')).toBeNull();
    expect(jobPollUrl('javascript:alert(1)', 'job-1', token)).toBeNull();
  });
});

// ── Callbacks ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('verifyCallback', () => {
  const event = { type: 'platform.job.completed', jobId: 'job-1', app: 'dreamstream', state: 'succeeded', resultRef: 'file-9', finishedAt: '2026-11-02T09:00:00.123Z' };
  const opts = { keys: (app: string, kid: string) => (app === 'dreamstream' && kid === 'ds-1' ? SECRET : undefined), crypto: nodeCrypto, now: clock };
  const signedCallback = async (payload: unknown, over: Record<string, unknown> = {}) => {
    const body = utf8Encode(JSON.stringify(payload));
    const h = await signedRequestHeaders({ app: 'dreamstream', keyId: 'ds-1', secret: SECRET, crypto: nodeCrypto, method: 'POST', target: '/platform/callback', timestamp: NOW_S, body, idempotencyKey: 'cb-job-1', callback: true, ...over } as never);
    if (h.ok === false) throw new Error(h.message);
    return { method: 'POST', target: '/platform/callback', headers: { ...h.headers, 'Content-Length': String(body.length) }, body };
  };

  it('accepts the gateway-signed completion event and nothing tampered or unsigned', async () => {
    const req = await signedCallback(event);
    expect(await verifyCallback(req, opts)).toEqual({ ok: true, event, app: 'dreamstream', kid: 'ds-1' });
    const tampered = { ...req, body: utf8Encode(utf8Decode(req.body)!.replace('succeeded', 'failed')) };
    expect(await verifyCallback({ ...tampered, headers: { ...req.headers, 'Content-Length': String(tampered.body.length) } }, opts)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyCallback({ ...req, headers: { ...req.headers, 'X-Platform-Signature': 'A'.repeat(43) } }, opts)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyCallback(req, { ...opts, now: () => (NOW_S + 301) * 1000 })).toMatchObject({ ok: false, reason: 'skew' });
    expect(await verifyCallback(await signedCallback({ ...event, extra: 1 }), opts)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await verifyCallback(await signedCallback({ ...event, app: 'atlas' }), opts)).toMatchObject({ ok: false, reason: 'wrong-app' });
    expect(await signedRequestHeaders({ app: 'dreamstream', keyId: 'ds-1', secret: SECRET, crypto: nodeCrypto, method: 'POST', target: '/platform/callback', timestamp: NOW_S, body: req.body, idempotencyKey: 'k', callback: true, claim: await claim() })).toMatchObject({
      ok: false,
      reason: 'malformed',
    });
  });
});

// ── Types: the platform's own fetch and WebCrypto plug in under strict TypeScript ───────────────────────────────

describe('injected types', () => {
  const temps: string[] = [];
  afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
  });
  const SRC = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  const APP = fileURLToPath(new URL('../../../..', import.meta.url)).replace(/[\\/]$/, '');
  const tsc = join(APP, 'node_modules/typescript/bin/tsc');

  it(
    'globalThis.fetch and crypto.subtle satisfy FetchLike and SubtleCryptoLike (DOM lib, and Node types), strict',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'platform-wire-types-'));
      temps.push(dir);
      const source = (ext: string) => `
import { createPlatformClient } from '${SRC}/client/index${ext}';
import { wireCryptoFromSubtle } from '${SRC}/wire/index${ext}';
import type { FetchLike, SubtleCryptoLike } from '${SRC}/wire/index${ext}';
const f: FetchLike = fetch;
const s: SubtleCryptoLike = crypto.subtle;
export const client = createPlatformClient({
  baseUrl: 'https://platform.test', app: 'dreamstream', keyId: 'ds-1', secret: new Uint8Array(32),
  crypto: wireCryptoFromSubtle(crypto.subtle, (a) => crypto.getRandomValues(a)), fetch, now: Date.now,
});
export const both = [f, s];
`;
      writeFileSync(join(dir, 'dom.ts'), source('.js'));
      writeFileSync(join(dir, 'node.mts'), source('.js'));
      const project = (name: string, file: string, options: Record<string, unknown>) => {
        const config = join(dir, `${name}.tsconfig.json`);
        writeFileSync(config, JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: true, target: 'ES2022', ...options }, files: [join(dir, file)] }));
        return spawnSync(process.execPath, [tsc, '-p', config], { cwd: APP, encoding: 'utf8', timeout: 120000 });
      };
      // A browser or Worker host: the DOM library, no Node types.
      const dom = project('dom', 'dom.ts', { lib: ['ES2022', 'DOM'], types: [], module: 'ESNext', moduleResolution: 'bundler' });
      expect(dom.stdout + dom.stderr).toBe('');
      expect(dom.status).toBe(0);
      // A Node host (the backend): Node's global fetch and WebCrypto, Node16 resolution.
      const node = project('node', 'node.mts', { lib: ['ES2022'], types: ['node'], typeRoots: [join(APP, 'node_modules/@types')], module: 'Node16', moduleResolution: 'Node16' });
      expect(node.stdout + node.stderr).toBe('');
      expect(node.status).toBe(0);
    },
    180000,
  );
});
