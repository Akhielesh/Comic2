/**
 * `createFakePlatform()` (plan §5.8): an in-memory `/v1` gateway for every host's tests, built on the wire's own
 * verifier (src/wire), so a host's tests run the gateway's real request checks. No network, no timers, no engine.
 *
 * Every request but `GET /v1/health` and a poll-token read goes through `verifyRequest` with the fake's key ring:
 * the signing headers, the app allowlist and key id, `X-Platform-Contract: 1`, the timestamp skew, an
 * `Idempotency-Key` and a `Content-Length` on every POST, the body cap, a claim on every POST with a body (MAC, app,
 * time window, purpose, capability, product; service claims only for previews) and the request signature over the
 * body. The fake then acts only on the verified request's fields (app, owner, claim, Idempotency-Key). Refusals
 * answer with the wire's `errorResponse`.
 *
 * Idempotency is scoped per caller: the job or result record id is `idempotencyScope({app, sub or null, key})`; the
 * same body replays the same answer, a different body gets 409. A `202` carries a poll token (`mintPollToken`, bound
 * to the job record's app and sub), and `GET /v1/jobs/:id?t=` is checked with `verifyPollToken` against that record's
 * owner. Capability kill switches answer 503 and an optional per-caller daily quota 429.
 *
 * Hosts sign with the fake's key ring: `fakeClientConfig(platform)` is a `createPlatformClient` config for it, and
 * `createFakeIdentity()` mints claims under the same default secret.
 */
import type { CapabilityId } from '../capabilities.js';
import { getCapability } from '../capabilities.js';
import { platformFailure } from '../errors.js';
import type { PlatformErrorCode, PlatformFailure } from '../errors.js';
import { sha256Hex, utf8Bytes, utf8Decode } from '../audit/inputHash.js';
import { productsForApp } from '../products.js';
import type { PlatformApp } from '../products.js';
import type { PlatformClientConfig } from '../client/index.js';
import { USER_CLAIM_PURPOSES, errorResponse, idempotencyScope, mintPollToken, verifyPollToken, verifyRequest } from '../wire/index.js';
import type { ClaimPurpose, ClaimRequirement, PreflightOptions, UserClaimPurpose, WireCrypto } from '../wire/index.js';
import { FAKE_APP_SECRET, FAKE_KEY_ID, FAKE_WIRE_CRYPTO } from './fakePorts.js';

export interface FakeRequest {
  method: string;
  /** Path with an optional query (`/v1/extract?maxPages=3`); a full URL is accepted too. */
  path: string;
  headers?: { [name: string]: string };
  body?: string | Uint8Array;
}

export interface FakeResponse {
  status: number;
  headers: { [name: string]: string };
  body: Uint8Array;
  text(): string;
  json(): unknown;
}

/** The subset of a fetch `Response` hosts read (and the platform client's `FetchResponseLike`). */
export interface FakeFetchResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FakeRequestLogEntry {
  method: string;
  path: string;
  status: number;
  app?: string;
  sub?: string;
  code?: PlatformErrorCode;
}

export interface FakePlatformOptions {
  /** Apps allowed to call (default: dreamstream and atlas). */
  apps?: readonly PlatformApp[];
  /** Unix ms (default `Date.now`). */
  clock?: () => number;
  /** Capabilities switched off from the start (`DISABLED_CAPS`). */
  disabled?: readonly CapabilityId[];
  /** Calls per (app, caller) per UTC day before 429 (default unlimited). */
  dailyQuota?: number;
  /** Largest body in bytes (default 50 MB). */
  maxBodyBytes?: number;
  /**
   * The key ring: the secret for (app, key id), or nothing. Default: every allowed app signs with `FAKE_KEY_ID` and
   * `FAKE_APP_SECRET`. Only apps in `apps` are ever asked for.
   */
  keys?: (app: string, kid: string) => Uint8Array | null | undefined;
  /** The wire's crypto (default `FAKE_WIRE_CRYPTO`, pure and synchronous). */
  crypto?: WireCrypto;
  /** An extra host check after the wire's: false or a code refuses the request. */
  verify?: (request: FakeRequest) => boolean | PlatformErrorCode;
}

export interface FakePlatform {
  handle(request: FakeRequest): Promise<FakeResponse>;
  /** A fetch-compatible function: pass it as the platform client's `fetch` (see `fakeClientConfig`). */
  fetch(url: string, init?: { method?: string; headers?: { [name: string]: string }; body?: string | Uint8Array | ArrayBuffer }): Promise<FakeFetchResponse>;
  disable(capability: CapabilityId): void;
  enable(capability: CapabilityId): void;
  readonly requests: FakeRequestLogEntry[];
  /** Files stored so far (sha256 → bytes is never exposed; only counts). */
  fileCount(): number;
}

interface StoredFile {
  ref: string;
  app: string;
  owner: string;
  bytes: Uint8Array;
  sniffed: string;
  name: string;
  /** The job that produced it, for `GET /v1/files/:ref?t=` (uploads have none). */
  jobId?: string;
}

interface JobRecord {
  id: string;
  app: string;
  /** The user claim's sub: the owner a poll token is checked against. */
  sub: string;
  op: string;
}

const MB = 1000000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SERVED: { [sniffed: string]: string } = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  zip: 'application/octet-stream',
};

/** Every purpose a claim can name (reads accept any; the owner check is what matters). */
const ALL_PURPOSES: readonly ClaimPurpose[] = [...USER_CLAIM_PURPOSES, 'preview'];
const USER_PURPOSES: readonly UserClaimPurpose[] = USER_CLAIM_PURPOSES;
const PDF_OPS = /^(inspect|fill|redact|organize)$/;

const sniff = (b: Uint8Array): string => {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  if (at(0, 0x25, 0x50, 0x44, 0x46)) return 'pdf';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp';
  if (at(0, 0x50, 0x4b, 0x03, 0x04)) return 'zip';
  return 'unknown';
};

const lower = (headers: { [name: string]: string } | undefined): { [name: string]: string } => {
  const out: { [name: string]: string } = {};
  if (headers) for (const k of Object.keys(headers)) out[k.toLowerCase()] = String(headers[k]);
  return out;
};

/** The `op` a `/v1/pdf` body names: it only picks which capability the claim must carry (checked by the wire). */
const pdfOpOf = (bytes: Uint8Array): string | null => {
  try {
    const body = JSON.parse(utf8Decode(bytes) || 'null') as { job?: { op?: unknown } } | null;
    const op = body && typeof body === 'object' && body.job && typeof body.job === 'object' ? body.job.op : undefined;
    return typeof op === 'string' && PDF_OPS.test(op) ? op : null;
  } catch {
    return null;
  }
};

/** What an endpoint accepts: the claim requirement for `verifyRequest`, and the capability its kill switch guards. */
interface Route {
  claim: ClaimRequirement;
  claimRequired?: boolean;
  capability?: CapabilityId;
}

const routeFor = (method: string, route: string, bytes: Uint8Array): Route | null => {
  if (method === 'GET') {
    if (route === '/v1/capabilities' || route === '/v1/notices') return { claim: { purposes: ALL_PURPOSES } };
    if (route.indexOf('/v1/jobs/') === 0 || route.indexOf('/v1/files/') === 0) return { claim: { purposes: ALL_PURPOSES }, claimRequired: true };
    return null;
  }
  if (method !== 'POST') return null;
  switch (route) {
    case '/v1/convert':
      return { claim: { purposes: ['extract', 'export', 'preview'], capability: 'doc.convert' }, capability: 'doc.convert' };
    case '/v1/extract':
      return { claim: { purposes: ['extract', 'preview'], capability: 'doc.extract' }, capability: 'doc.extract' };
    case '/v1/files':
      return { claim: { purposes: USER_PURPOSES } };
    case '/v1/pdf': {
      const op = pdfOpOf(bytes);
      const capability = op ? (`pdf.${op}` as CapabilityId) : undefined;
      return capability ? { claim: { purposes: ['pdf'], capability }, capability } : { claim: { purposes: ['pdf'] } };
    }
    case '/v1/render':
      return { claim: { purposes: ['render', 'export'], capability: 'richdoc.render' }, capability: 'richdoc.render' };
    case '/v1/jobs':
      return { claim: { purposes: USER_PURPOSES } };
    default:
      return null;
  }
};

/** A key ring for `apps`: each signs with `FAKE_KEY_ID` and `secret` (default `FAKE_APP_SECRET`). Tests only. */
export const fakeKeyRing = (apps: readonly string[] = ['dreamstream', 'atlas'], secret: string = FAKE_APP_SECRET): ((app: string, kid: string) => Uint8Array | null) => {
  const bytes = utf8Bytes(secret);
  return (app, kid) => (apps.indexOf(app) !== -1 && kid === FAKE_KEY_ID ? bytes : null);
};

/**
 * A `createPlatformClient` config that talks to `platform` with the fake key ring's default key: the host's real
 * client, signing and all, against the fake gateway. Override `now` with the fake's clock when it is not real time.
 */
export const fakeClientConfig = (platform: FakePlatform, over: Partial<PlatformClientConfig> = {}): PlatformClientConfig => ({
  baseUrl: 'https://platform.test',
  app: 'dreamstream',
  keyId: FAKE_KEY_ID,
  secret: utf8Bytes(FAKE_APP_SECRET),
  crypto: FAKE_WIRE_CRYPTO,
  fetch: platform.fetch,
  now: () => Date.now(),
  ...over,
});

export const createFakePlatform = (options: FakePlatformOptions = {}): FakePlatform => {
  const apps: readonly string[] = options.apps || ['dreamstream', 'atlas'];
  const clock = options.clock || (() => Date.now());
  const crypto = options.crypto || FAKE_WIRE_CRYPTO;
  const ring = options.keys || fakeKeyRing(apps);
  const keys = (app: string, kid: string): Uint8Array | null | undefined => (apps.indexOf(app) !== -1 ? ring(app, kid) : null);
  const maxBody = options.maxBodyBytes === undefined ? 50 * MB : options.maxBodyBytes;
  const disabled: string[] = (options.disabled || []).slice();
  const requests: FakeRequestLogEntry[] = [];
  const idempotency: { [scope: string]: { bodyHash: string; response: FakeResponse } } = {};
  const files: { [ref: string]: StoredFile } = {};
  const jobs: { [id: string]: JobRecord } = {};
  const quota: { [key: string]: number } = {};
  let seq = 0;

  const respond = (status: number, body: string | Uint8Array, headers: { [k: string]: string }, requestId: string): FakeResponse => {
    const bytes = typeof body === 'string' ? utf8Bytes(body) : body;
    return {
      status,
      headers: { 'x-request-id': requestId, ...headers },
      body: bytes,
      text: () => utf8Decode(bytes) || '',
      json: () => JSON.parse(utf8Decode(bytes) || 'null'),
    };
  };
  const json = (status: number, value: unknown, requestId: string, headers: { [k: string]: string } = {}) =>
    respond(status, JSON.stringify(value), { 'content-type': 'application/json', ...headers }, requestId);
  /** A refusal as the gateway answers it: the wire's `errorResponse`. */
  const refusal = (failure: PlatformFailure, requestId: string): FakeResponse => {
    const r = errorResponse(failure, requestId);
    return respond(r.status, r.body, { 'content-type': 'application/json' }, requestId);
  };
  const error = (code: PlatformErrorCode, message: string, requestId: string) => refusal(platformFailure(code, message), requestId);

  const handle = async (request: FakeRequest): Promise<FakeResponse> => {
    const h = lower(request.headers);
    const requestId = h['x-request-id'] && REQUEST_ID.test(h['x-request-id']) ? h['x-request-id'] : `req-${++seq}`;
    const method = String(request.method || 'GET').toUpperCase();
    const target = String(request.path || '').replace(/^https?:\/\/[^/]+/, '');
    const q = target.indexOf('?');
    const route = q === -1 ? target : target.slice(0, q);
    const query: { [k: string]: string } = {};
    if (q !== -1) {
      for (const part of target.slice(q + 1).split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        try {
          query[decodeURIComponent((eq === -1 ? part : part.slice(0, eq)).replace(/\+/g, ' '))] = decodeURIComponent((eq === -1 ? '' : part.slice(eq + 1)).replace(/\+/g, ' '));
        } catch {
          // a malformed escape is just an absent parameter (a signed request with one is refused by the wire)
        }
      }
    }
    const log: FakeRequestLogEntry = { method, path: route, status: 0 };
    requests.push(log);
    const done = (r: FakeResponse, code?: PlatformErrorCode): FakeResponse => {
      log.status = r.status;
      if (code) log.code = code;
      return r;
    };
    const fail = (code: PlatformErrorCode, message: string) => done(error(code, message, requestId), code);
    const refuse = (failure: PlatformFailure) => done(refusal(failure, requestId), failure.code);

    // Open endpoint.
    if (method === 'GET' && route === '/v1/health') return done(json(200, { ok: true, contract: 1 }, requestId));

    // A browser's poll: GET with a poll token and nothing else, checked against the job record's own owner.
    if (method === 'GET' && query.t !== undefined && (route.indexOf('/v1/jobs/') === 0 || route.indexOf('/v1/files/') === 0)) {
      const isJob = route.indexOf('/v1/jobs/') === 0;
      const file = isJob ? undefined : files[route.slice('/v1/files/'.length)];
      const job = isJob ? jobs[route.slice('/v1/jobs/'.length)] : file && file.jobId ? jobs[file.jobId] : undefined;
      if (!job) return fail('not-found', isJob ? 'No such job.' : 'No such file.');
      const v = await verifyPollToken(query.t, { keys, crypto, now: clock, jobId: job.id, owner: { app: job.app, sub: job.sub }, method });
      if (v.ok === false) return refuse(v);
      log.app = job.app;
      log.sub = job.sub;
      return isJob ? done(json(200, { state: 'succeeded', progress: 1, result: { op: job.op } }, requestId)) : serveFile(file as StoredFile);
    }

    // Everything else is a signed request: the wire's two phases, with the body already in memory.
    const bytes = request.body === undefined ? new Uint8Array(0) : typeof request.body === 'string' ? utf8Bytes(request.body) : request.body;
    const headers: { [name: string]: string } = { ...h };
    // Content-Length comes from the transport when the caller (fetch) did not set it.
    if (method === 'POST' && headers['content-length'] === undefined) headers['content-length'] = String(bytes.length);
    const spec = routeFor(method, route, bytes);
    // A claim's product must be one the signing app serves (the wire also checks that the claim names that app).
    const signingApp = headers['x-platform-app'];
    const products = signingApp && apps.indexOf(signingApp) !== -1 ? productsForApp(signingApp as PlatformApp).map((p) => p.id as string) : [];
    const opts: PreflightOptions = {
      crypto,
      now: clock,
      keys,
      claim: { ...(spec ? spec.claim : { purposes: ALL_PURPOSES }), products },
      claimRequired: spec ? spec.claimRequired === true : false,
      maxBodyBytes: maxBody,
    };
    const v = await verifyRequest({ method, target, headers }, bytes, opts);
    if (v.ok === false) return refuse(v);
    const app = v.app;
    const owner = v.owner;
    const claim = v.claim;
    log.app = app;
    log.sub = owner;
    if (options.verify) {
      const extra = options.verify(request);
      if (extra !== true) return fail(typeof extra === 'string' ? extra : 'unauthorized', 'The host check refused the request.');
    }
    if (!spec) return fail('not-found', 'No such endpoint.');

    if (method === 'GET') {
      if (route === '/v1/capabilities') {
        const ids: string[] = [];
        for (const p of productsForApp(app as PlatformApp)) for (const c of p.capabilities) if (ids.indexOf(c) === -1) ids.push(c);
        return done(
          json(
            200,
            {
              app,
              capabilities: ids.map((id) => {
                const c = getCapability(id);
                return { id, kind: c ? c.kind : 'render', wave: c ? c.wave : 1, maturity: c ? c.maturity : 'adopt', disabled: disabled.indexOf(id) !== -1 };
              }),
            },
            requestId,
          ),
        );
      }
      if (route === '/v1/notices') return done(respond(200, 'Third-party notices (fake platform).', { 'content-type': 'text/plain; charset=utf-8' }, requestId));
      if (route.indexOf('/v1/jobs/') === 0) {
        const job = jobs[route.slice('/v1/jobs/'.length)];
        if (!job || job.app !== app || job.sub !== owner) return fail('not-found', 'No such job.');
        return done(json(200, { state: 'succeeded', progress: 1, result: { op: job.op } }, requestId));
      }
      const file = files[route.slice('/v1/files/'.length)];
      if (!file || file.app !== app || file.owner !== owner) return fail('not-found', 'No such file.');
      return serveFile(file);
    }

    // A POST: the wire has checked the Idempotency-Key, the body cap, the claim (purpose, capability, product) and
    // the signature over these bytes. What is left is the platform's own business.
    if (spec.capability && disabled.indexOf(spec.capability) !== -1) return fail('disabled', `${spec.capability} is switched off right now.`);
    if (route === '/v1/pdf' && !spec.capability) return fail('invalid', 'The PDF job names no known operation.');
    const scope = await idempotencyScope(crypto, { app, sub: claim && claim.kind === 'user' ? claim.sub : null, key: v.idempotencyKey || '' });
    if (scope === null) return fail('invalid', 'The request has no idempotency scope.');
    const bodyHash = sha256Hex(bytes);
    const seen = idempotency[scope];
    if (seen) return done(seen.bodyHash === bodyHash ? seen.response : error('conflict', 'This Idempotency-Key was used with a different body.', requestId), seen.bodyHash === bodyHash ? undefined : 'conflict');

    if (options.dailyQuota !== undefined) {
      const day = `${app}|${owner}|${Math.floor(clock() / 86400000)}`;
      quota[day] = (quota[day] || 0) + 1;
      if (quota[day] > options.dailyQuota) return fail('quota', 'The daily quota is used up.');
    }

    const store = (response: FakeResponse, code?: PlatformErrorCode): FakeResponse => {
      if (response.status < 500) idempotency[scope] = { bodyHash, response };
      return done(response, code);
    };
    const engine = { 'x-platform-engine': 'fake@1' };
    const type = (headers['content-type'] || '').split(';')[0].trim();
    let parsed: unknown;
    if (type === 'application/json') {
      try {
        parsed = JSON.parse(utf8Decode(bytes) || 'null');
      } catch {
        return store(error('invalid', 'The body is not valid JSON.', requestId), 'invalid');
      }
    }

    switch (route) {
      case '/v1/convert': {
        if (type !== 'text/plain') return store(error('unsupported', 'This format converts from wave 4.', requestId), 'unsupported');
        return store(respond(200, bytes, { 'content-type': 'text/plain; charset=utf-8', ...engine }, requestId));
      }
      case '/v1/extract': {
        const maxPages = query.maxPages === undefined ? 24 : Number(query.maxPages);
        if (!(maxPages >= 1 && maxPages <= 300 && maxPages % 1 === 0)) return store(error('invalid', 'maxPages must be 1 to 300.', requestId), 'invalid');
        if (type !== 'text/plain') return store(error('unsupported', 'The fake extracts plain text only.', requestId), 'unsupported');
        const text = utf8Decode(bytes);
        if (text === null) return store(error('input-rejected', 'The text is not UTF-8.', requestId), 'input-rejected');
        return store(json(200, { plainText: text, sections: [{ id: 's1', title: '', kind: 'text', content: text, pageNumber: 1 }], pageCount: 1, truncated: false, engine: 'fake@1' }, requestId, engine));
      }
      case '/v1/files': {
        const ref = `f-${sha256Hex(`${app}|${owner}|${bodyHash}`).slice(0, 24)}`;
        const sniffed = sniff(bytes);
        files[ref] = { ref, app, owner, bytes, sniffed, name: headers['x-platform-file-name'] || 'file' };
        return store(json(200, { fileRef: ref, sha256: bodyHash, bytes: bytes.length, sniffed }, requestId));
      }
      case '/v1/pdf': {
        const ref = parsed && typeof parsed === 'object' ? (parsed as { fileRef?: unknown }).fileRef : undefined;
        const file = typeof ref === 'string' ? files[ref] : undefined;
        if (!file || file.app !== app || file.owner !== owner) return store(error('not-found', 'No such file.', requestId), 'not-found');
        if (file.sniffed !== 'pdf') return store(error('unsupported', 'That file is not a PDF.', requestId), 'unsupported');
        const copy = `f-${sha256Hex(`${file.ref}|copy|${bodyHash}`).slice(0, 24)}`;
        files[copy] = { ...file, ref: copy, name: `copy-${file.name}` };
        return store(json(200, { fileRef: copy, report: { op: (parsed as { job: { op: string } }).job.op, original: 'unchanged' } }, requestId, engine));
      }
      case '/v1/render':
        return store(error('unsupported', 'Server rendering arrives in wave 4.', requestId), 'unsupported');
      default: {
        const op = parsed && typeof parsed === 'object' ? (parsed as { op?: unknown }).op : undefined;
        if (typeof op !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(op)) return store(error('invalid', 'A job needs an op.', requestId), 'invalid');
        if (!claim || claim.kind !== 'user') return store(error('forbidden', 'A job belongs to a user.', requestId), 'forbidden');
        // The job record id is the caller's idempotency scope; its poll token is bound to the record's app and sub.
        const minted = await mintPollToken({ secret: v.secret, crypto, now: clock }, { app, kid: v.kid, sub: claim.sub, jobId: scope });
        if (minted.ok === false) return store(refusal(minted, requestId), minted.code);
        jobs[scope] = { id: scope, app, sub: claim.sub, op };
        return store(json(202, { jobId: scope, pollToken: minted.token, state: 'queued' }, requestId));
      }
    }

    function serveFile(file: StoredFile): FakeResponse {
      const type = SERVED[file.sniffed];
      if (!type || file.sniffed === 'zip') return fail('unsupported', 'That file type is never served.');
      return done(
        respond(
          200,
          file.bytes,
          {
            'content-type': type,
            'content-disposition': `attachment; filename="${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
            'x-content-type-options': 'nosniff',
            'content-security-policy': "sandbox; default-src 'none'",
            'cache-control': 'private, no-store',
          },
          requestId,
        ),
      );
    }
  };

  const toFetch = (r: FakeResponse): FakeFetchResponse => ({
    status: r.status,
    ok: r.status >= 200 && r.status < 300,
    headers: { get: (name: string) => (r.headers[name.toLowerCase()] !== undefined ? r.headers[name.toLowerCase()] : null) },
    text: async () => r.text(),
    json: async () => r.json(),
    arrayBuffer: async () => r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.byteLength) as ArrayBuffer,
  });

  return {
    handle,
    fetch: async (url, init = {}) => {
      const body = init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : init.body;
      return toFetch(await handle({ method: init.method || 'GET', path: url, headers: init.headers, body }));
    },
    disable: (capability) => {
      if (disabled.indexOf(capability) === -1) disabled.push(capability);
    },
    enable: (capability) => {
      const i = disabled.indexOf(capability);
      if (i !== -1) disabled.splice(i, 1);
    },
    requests,
    fileCount: () => Object.keys(files).length,
  };
};
