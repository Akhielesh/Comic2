/**
 * `createFakePlatform()` (plan §5.8): an in-memory `/v1` gateway for every host's tests. It answers the wire's
 * endpoints with the platform's error body and headers, enforces the request rules a host can get wrong, and keeps
 * everything in memory: no network, no timers, no engine.
 *
 * Checked on every request: the app allowlist, `X-Platform-Contract: 1`, an `Idempotency-Key` on every POST, a claim
 * on every POST with a body (decoded, app- and capability-bound, unexpired; service claims only for previews), the
 * body cap, capability kill switches, and a per-caller daily quota. Idempotency is scoped per (app, sub or 'svc',
 * key): the same body replays the same answer, a different body gets 409.
 *
 * The HMAC request signature is the wire's (W1.5) business: pass `verify` to check it here as well. Without `verify`
 * the fake trusts the signature headers, never the claim's contents.
 */
import type { CapabilityId } from '../capabilities.js';
import { getCapability } from '../capabilities.js';
import { platformErrorBody, PLATFORM_ERRORS } from '../errors.js';
import type { PlatformErrorCode } from '../errors.js';
import { base64urlDecode, sha256Hex, utf8Bytes, utf8Decode } from '../audit/inputHash.js';
import { productsForApp } from '../products.js';
import type { PlatformApp } from '../products.js';
import { SERVICE_PREVIEW_CAPS } from '../gates/ports.js';

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

/** The subset of a fetch `Response` hosts read. */
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
  /** Extra request verification (the wire's HMAC signature): false or a code refuses the request. */
  verify?: (request: FakeRequest) => boolean | PlatformErrorCode;
}

export interface FakePlatform {
  handle(request: FakeRequest): Promise<FakeResponse>;
  /** A fetch-compatible function for clients that take an injected `fetch`. */
  fetch(url: string, init?: { method?: string; headers?: { [name: string]: string }; body?: string | Uint8Array }): Promise<FakeFetchResponse>;
  disable(capability: CapabilityId): void;
  enable(capability: CapabilityId): void;
  readonly requests: FakeRequestLogEntry[];
  /** Files stored so far (sha256 → bytes is never exposed; only counts). */
  fileCount(): number;
}

interface Claim {
  v: 1;
  kind: 'user' | 'service';
  app: string;
  product?: string;
  sub?: string;
  purpose: string;
  caps: string[];
  exp: number;
}

interface StoredFile {
  ref: string;
  app: string;
  owner: string;
  bytes: Uint8Array;
  sniffed: string;
  name: string;
}

const MB = 1000000;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SERVED: { [sniffed: string]: string } = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  zip: 'application/octet-stream',
};

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

const decodeClaim = (claim: string): Claim | null => {
  const dot = claim.indexOf('.');
  if (dot < 1 || claim.length > 4096) return null;
  const raw = base64urlDecode(claim.slice(0, dot));
  const text = raw ? utf8Decode(raw) : null;
  if (!text) return null;
  try {
    const c = JSON.parse(text) as Claim;
    if (!c || c.v !== 1 || (c.kind !== 'user' && c.kind !== 'service') || typeof c.app !== 'string' || !Array.isArray(c.caps) || typeof c.exp !== 'number') return null;
    if (c.kind === 'user' && typeof c.sub !== 'string') return null;
    return c;
  } catch {
    return null;
  }
};

/** The capability a POST endpoint needs. */
const capabilityFor = (route: string, body: unknown): string | null => {
  if (route === '/v1/convert') return 'doc.convert';
  if (route === '/v1/extract') return 'doc.extract';
  if (route === '/v1/pdf') {
    const op = body && typeof body === 'object' && (body as { job?: { op?: unknown } }).job ? (body as { job: { op?: unknown } }).job.op : undefined;
    return typeof op === 'string' && /^(inspect|fill|redact|organize)$/.test(op) ? `pdf.${op}` : null;
  }
  if (route === '/v1/render') return 'richdoc.render';
  return null;
};

export const createFakePlatform = (options: FakePlatformOptions = {}): FakePlatform => {
  const apps: readonly string[] = options.apps || ['dreamstream', 'atlas'];
  const clock = options.clock || (() => Date.now());
  const maxBody = options.maxBodyBytes === undefined ? 50 * MB : options.maxBodyBytes;
  const disabled: string[] = (options.disabled || []).slice();
  const requests: FakeRequestLogEntry[] = [];
  const idempotency: { [key: string]: { bodyHash: string; response: FakeResponse } } = {};
  const files: { [ref: string]: StoredFile } = {};
  const jobs: { [id: string]: { app: string; owner: string; op: string; pollToken: string } } = {};
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
  const error = (code: PlatformErrorCode, message: string, requestId: string) => json(PLATFORM_ERRORS[code].status, platformErrorBody(code, message, requestId), requestId);

  const handle = async (request: FakeRequest): Promise<FakeResponse> => {
    const h = lower(request.headers);
    const requestId = h['x-request-id'] && KEY.test(h['x-request-id']) ? h['x-request-id'] : `req-${++seq}`;
    const method = String(request.method || 'GET').toUpperCase();
    const full = String(request.path || '').replace(/^https?:\/\/[^/]+/, '');
    const q = full.indexOf('?');
    const route = q === -1 ? full : full.slice(0, q);
    const query: { [k: string]: string } = {};
    if (q !== -1) {
      for (const part of full.slice(q + 1).split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        try {
          query[decodeURIComponent(eq === -1 ? part : part.slice(0, eq))] = decodeURIComponent(eq === -1 ? '' : part.slice(eq + 1));
        } catch {
          // a malformed escape is just an absent parameter
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

    // Open endpoints.
    if (method === 'GET' && route === '/v1/health') return done(json(200, { ok: true, contract: 1 }, requestId));

    // Every other request names its app and speaks contract 1.
    const app = h['x-platform-app'];
    if (!app || apps.indexOf(app) === -1) return fail('unauthorized', 'Unknown app.');
    log.app = app;
    if (h['x-platform-contract'] !== '1') return fail('invalid', 'X-Platform-Contract must be 1.');
    if (options.verify) {
      const v = options.verify(request);
      if (v !== true) return fail(typeof v === 'string' ? v : 'unauthorized', 'The request signature did not verify.');
    }

    if (method === 'GET' && route === '/v1/capabilities') {
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
    if (method === 'GET' && route === '/v1/notices') return done(respond(200, 'Third-party notices (fake platform).', { 'content-type': 'text/plain; charset=utf-8' }, requestId));

    // Reads need the same app and caller: a job's poll token, or a claim with the same subject.
    const reader = (): string | null => {
      const c = h['x-platform-claim'] ? decodeClaim(h['x-platform-claim']) : null;
      if (!c || c.app !== app || c.exp <= Math.floor(clock() / 1000)) return null;
      return c.kind === 'user' ? (c.sub as string) : 'svc';
    };
    if (method === 'GET' && route.indexOf('/v1/jobs/') === 0) {
      const job = jobs[route.slice('/v1/jobs/'.length)];
      const allowed = !!job && job.app === app && (query.t !== undefined ? query.t === job.pollToken : reader() === job.owner);
      if (!job || !allowed) return fail('not-found', 'No such job.');
      return done(json(200, { state: 'succeeded', progress: 1, result: { op: job.op } }, requestId));
    }
    if (method === 'GET' && route.indexOf('/v1/files/') === 0) {
      const file = files[route.slice('/v1/files/'.length)];
      if (!file || file.app !== app || reader() !== file.owner) return fail('not-found', 'No such file.');
      const type = SERVED[file.sniffed];
      if (!type || file.sniffed === 'zip') return fail('unsupported', 'That file type is never served.');
      return done(
        respond(200, file.bytes, {
          'content-type': type,
          'content-disposition': `attachment; filename="${file.name.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'cache-control': 'private, no-store',
        }, requestId),
      );
    }

    if (method !== 'POST') return fail('not-found', 'No such endpoint.');
    const known = ['/v1/convert', '/v1/extract', '/v1/files', '/v1/pdf', '/v1/render', '/v1/jobs'];
    if (known.indexOf(route) === -1) return fail('not-found', 'No such endpoint.');

    // POST rules: an idempotency key always; a claim whenever there is a body; the body cap before reading it.
    const key = h['idempotency-key'];
    if (!key || !KEY.test(key)) return fail('invalid', 'Every POST needs an Idempotency-Key of at most 128 characters of [A-Za-z0-9._:-].');
    const bytes = request.body === undefined ? new Uint8Array(0) : typeof request.body === 'string' ? utf8Bytes(request.body) : request.body;
    const declared = h['content-length'] !== undefined ? Number(h['content-length']) : bytes.length;
    if (!(declared <= maxBody) || bytes.length > maxBody) return fail('too-large', 'The body is over the cap.');
    const claimText = h['x-platform-claim'];
    if (bytes.length > 0 && !claimText) return fail('unauthorized', 'A POST with a body needs a claim.');
    const claim = claimText ? decodeClaim(claimText) : null;
    if (claimText && !claim) return fail('unauthorized', 'The claim is malformed.');
    if (claim) {
      if (claim.app !== app) return fail('forbidden', 'The claim is for another app.');
      if (claim.exp <= Math.floor(clock() / 1000)) return fail('unauthorized', 'The claim has expired.');
    }
    const owner = claim && claim.kind === 'user' ? (claim.sub as string) : 'svc';
    log.sub = owner;

    const isJson = (h['content-type'] || '').indexOf('application/json') === 0;
    let parsed: unknown;
    if (isJson) {
      try {
        parsed = JSON.parse(utf8Decode(bytes) || 'null');
      } catch {
        return fail('invalid', 'The body is not valid JSON.');
      }
    }
    const cap = capabilityFor(route, parsed);
    if (cap) {
      if (!claim || claim.caps.indexOf(cap) === -1) return fail('forbidden', `The claim does not allow ${cap}.`);
      if (claim.kind === 'service' && (claim.purpose !== 'preview' || (SERVICE_PREVIEW_CAPS as readonly string[]).indexOf(cap) === -1)) {
        return fail('forbidden', 'A service claim may only preview.');
      }
      if (disabled.indexOf(cap) !== -1) return fail('disabled', `${cap} is switched off right now.`);
    } else if (claim && claim.kind === 'service') return fail('forbidden', 'A service claim may only preview.');

    const scope = `${app}|${owner}|${key}`;
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
    const type = (h['content-type'] || '').split(';')[0].trim();

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
        files[ref] = { ref, app, owner, bytes, sniffed, name: h['x-platform-file-name'] || 'file' };
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
        const id = `job-${++seq}`;
        const pollToken = `pt-${sha256Hex(`${id}|${bodyHash}`).slice(0, 32)}`;
        jobs[id] = { app, owner, op, pollToken };
        return store(json(202, { jobId: id, pollToken }, requestId));
      }
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
    fetch: async (url, init = {}) => toFetch(await handle({ method: init.method || 'GET', path: url, headers: init.headers, body: init.body })),
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
