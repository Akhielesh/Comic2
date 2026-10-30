// @vitest-environment node
//
// The wire (plan §5.8, §9, W1.5): golden vectors under two injected crypto adapters (node:crypto and WebCrypto), and
// every refusal the row lists — a tampered body, claim or key, skew over 300 s, an expired claim, exp more than
// 300 s ahead, a wrong purpose, a changed ?maxPages=, a service claim beyond preview (at mint and at verify), a POST
// without an Idempotency-Key and a body POST without a claim.
import { createHash, createHmac, randomBytes, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  PLATFORM_HEADERS,
  WIRE_LIMITS,
  base64urlDecode,
  base64urlEncode,
  canonicalPath,
  canonicalQuery,
  constantTimeEqual,
  constantTimeEqualText,
  decodeSecret,
  deriveWireKey,
  encodeQuery,
  encodeWarnings,
  failureFromResponse,
  formatCanonicalRequest,
  fromHex,
  idempotencyScope,
  isBytes,
  isUsableSecret,
  mintPollToken,
  mintServiceClaim,
  mintUserClaim,
  parseCostMicros,
  parseErrorBody,
  parseWarnings,
  preflightRequest,
  pseudonymousSub,
  readHeader,
  sealToken,
  signRequest,
  signedRequestHeaders,
  toHex,
  utf8Decode,
  utf8Encode,
  verifyClaim,
  verifyPollToken,
  verifyRequest,
  verifyRequestSignature,
  verifySignature,
  wireCryptoFromSubtle,
} from './index.js';
import type { ClaimPurpose, PreflightOptions, SubtleCryptoLike, UserClaimInput, WireCrypto } from './index.js';

// ── Fixtures and adapters ───────────────────────────────────────────────────────────────────────────────────────

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../../fixtures/wire/${name}.json`, import.meta.url), 'utf8')) as T;

interface HmacFixture {
  secret: string;
  app: string;
  keyId: string;
  vectors: {
    name: string;
    method: string;
    target: string;
    timestamp: string;
    body: { hex?: string; utf8?: string };
    claim: string | null;
    idempotencyKey: string | null;
    canonicalPath: string;
    canonicalQuery: string;
    bodySha256Hex: string;
    canonical: string;
    signature: string;
  }[];
}
interface ClaimsFixture {
  secret: string;
  claimKeyHex: string;
  now: number;
  sub: { subSecret: string; subKeyHex: string; userId: string; sub: string };
  vectors: { name: string; mint: 'user' | 'service'; input: Record<string, unknown>; payload: Record<string, unknown>; token: string }[];
}
interface PollFixture {
  secret: string;
  pollKeyHex: string;
  now: number;
  vectors: { name: string; input: Record<string, unknown>; payload: Record<string, unknown>; token: string }[];
}

const HMAC = fixture<HmacFixture>('hmac');
const CLAIMS = fixture<ClaimsFixture>('claims');
const POLL = fixture<PollFixture>('poll');

/** A Node host's adapter: node:crypto, synchronous. */
const nodeCrypto: WireCrypto = {
  sha256: (d) => new Uint8Array(createHash('sha256').update(d).digest()),
  hmacSha256: (k, d) => new Uint8Array(createHmac('sha256', k).update(d).digest()),
  randomBytes: (n) => new Uint8Array(randomBytes(n)),
};
/** A browser / Worker host's adapter: WebCrypto, asynchronous. */
const webCrypto = wireCryptoFromSubtle(webcrypto.subtle as unknown as SubtleCryptoLike, (a) => webcrypto.getRandomValues(a));
const ADAPTERS: [string, WireCrypto][] = [
  ['node:crypto', nodeCrypto],
  ['WebCrypto', webCrypto],
];

const SECRET = base64urlDecode(HMAC.secret)!;
const OTHER_SECRET = new Uint8Array(32).fill(7);
const NOW_S = CLAIMS.now;
const at = (seconds: number) => () => seconds * 1000;
const bodyOf = (b: { hex?: string; utf8?: string }) => (b.hex !== undefined ? fromHex(b.hex)! : utf8Encode(b.utf8!));
const SUB = CLAIMS.sub.sub;

const userInput = (over: Partial<UserClaimInput> = {}): UserClaimInput => ({
  app: 'dreamstream',
  product: 'chat',
  sub: SUB,
  tier: 'creator',
  purpose: 'extract',
  caps: ['doc.extract'],
  jti: 'jti-test',
  ...over,
});
const keys = (secret = SECRET, now = at(NOW_S)) => ({ secret, crypto: nodeCrypto, now });
const verifyOpts = (over: Partial<{ purposes: ClaimPurpose[]; capability: string; products: string[]; now: () => number; secret: Uint8Array; app: string }> = {}) => ({
  ...keys(over.secret, over.now),
  app: over.app ?? 'dreamstream',
  purposes: over.purposes ?? (['extract', 'preview'] as ClaimPurpose[]),
  ...(over.capability !== undefined ? { capability: over.capability } : {}),
  ...(over.products !== undefined ? { products: over.products } : {}),
});

/** A claim sealed by hand under the real claim key: what a buggy or compromised minter could produce. */
const forgeClaim = async (payload: Record<string, unknown>, secret = SECRET) => sealToken(nodeCrypto, await deriveWireKey(nodeCrypto, secret, 'claim'), payload);
const forgePoll = async (payload: Record<string, unknown>, secret = SECRET) => sealToken(nodeCrypto, await deriveWireKey(nodeCrypto, secret, 'poll'), payload);
const userPayload = (over: Record<string, unknown> = {}) => ({ ...CLAIMS.vectors[0].payload, ...over });

// ── Bytes ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('byte helpers (no TextEncoder, no Buffer)', () => {
  it('UTF-8 matches the platform encoder, astral planes and lone surrogates included', () => {
    const wellFormed = ['', 'ascii', 'café', 'Ünïcödé — 漫画', '🦸‍♀️ hero', 'a\u{10FFFF}b'];
    for (const text of [...wellFormed, 'lone \ud800 high', 'lone \udc00 low', 'end \ud83e']) {
      expect(toHex(utf8Encode(text)), text).toBe(Buffer.from(text, 'utf8').toString('hex'));
    }
    for (const text of wellFormed) expect(utf8Decode(utf8Encode(text))).toBe(text);
  });

  it('UTF-8 decoding is strict: overlong forms, surrogates, truncation and stray continuation bytes are refused', () => {
    for (const bad of ['c080', 'e080af', 'eda080', 'f4908080', 'e282', '80', 'ff']) expect(utf8Decode(fromHex(bad)!), bad).toBeNull();
    expect(utf8Decode(fromHex('e282ac')!)).toBe('€');
  });

  it('base64url matches the platform encoder for every length and refuses non-canonical text', () => {
    for (let n = 0; n <= 70; n++) {
      const bytes = new Uint8Array(randomBytes(n));
      const text = base64urlEncode(bytes);
      expect(text).toBe(Buffer.from(bytes).toString('base64url'));
      expect(toHex(base64urlDecode(text)!)).toBe(toHex(bytes));
    }
    // Padding, the standard alphabet, an impossible length, and non-zero bits after the last byte.
    for (const bad of ['AA==', 'ab+/', 'A', 'AB', 'AAB', 'a b']) expect(base64urlDecode(bad), bad).toBeNull();
    expect(base64urlDecode('AA')).toEqual(new Uint8Array([0]));
    expect(base64urlDecode('AAA')).toEqual(new Uint8Array([0, 0]));
  });

  it('constant-time equality answers like ordinary equality', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(a, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(constantTimeEqual(a, new Uint8Array([1, 2]))).toBe(false);
    expect(constantTimeEqualText('abc', 'abc')).toBe(true);
    expect(constantTimeEqualText('abc', 'abd')).toBe(false);
    expect(constantTimeEqualText('abc', 'ab')).toBe(false);
  });

  it('accepts bytes and secrets made in another realm (a vm context) and Buffers, and nothing else', async () => {
    const foreign = runInNewContext('new Uint8Array([37, 80, 68, 70, 45])') as Uint8Array;
    expect(foreign instanceof Uint8Array).toBe(false);
    expect(isBytes(foreign)).toBe(true);
    expect(isBytes(Buffer.from('x'))).toBe(true);
    for (const not of [[1, 2], 'ab', new Uint16Array(2), new ArrayBuffer(2), null]) expect(isBytes(not)).toBe(false);
    expect(isUsableSecret(runInNewContext('new Uint8Array(32)'))).toBe(true);
    const req = { method: 'POST', target: '/v1/files', timestamp: NOW_S, claim: CLAIMS.vectors[0].token, idempotencyKey: 'k1' };
    const a = await signRequest(nodeCrypto, SECRET, { ...req, body: foreign });
    const b = await signRequest(nodeCrypto, SECRET, { ...req, body: new Uint8Array([37, 80, 68, 70, 45]) });
    expect(a.ok && b.ok && a.signature === b.signature).toBe(true);
  });

  it('decodeSecret reads a base64url secret of at least 32 bytes and nothing shorter', () => {
    expect(decodeSecret(HMAC.secret)).toEqual(SECRET);
    expect(decodeSecret(base64urlEncode(new Uint8Array(31)))).toBeNull();
    expect(decodeSecret('not base64url!')).toBeNull();
  });
});

// ── Golden vectors ──────────────────────────────────────────────────────────────────────────────────────────────

describe.each(ADAPTERS)('golden vectors (%s)', (_name, crypto) => {
  it('request signatures: every canonical string and signature in fixtures/wire/hmac.json', async () => {
    expect(HMAC.vectors.length).toBeGreaterThanOrEqual(6);
    for (const v of HMAC.vectors) {
      const r = await signRequest(crypto, SECRET, {
        method: v.method,
        target: v.target,
        timestamp: v.timestamp,
        body: bodyOf(v.body),
        claim: v.claim,
        idempotencyKey: v.idempotencyKey,
      });
      expect(r, v.name).toMatchObject({ ok: true, canonical: v.canonical, signature: v.signature });
      if (r.ok === false) continue;
      expect(r.fields.path, v.name).toBe(v.canonicalPath);
      expect(r.fields.query, v.name).toBe(v.canonicalQuery);
      expect(r.fields.bodySha256Hex, v.name).toBe(v.bodySha256Hex);
      expect(formatCanonicalRequest(r.fields)).toBe(v.canonical);
      const back = await verifySignature(crypto, SECRET, { method: v.method, target: v.target, timestamp: v.timestamp, body: bodyOf(v.body), claim: v.claim, idempotencyKey: v.idempotencyKey }, v.signature);
      expect(back.ok, v.name).toBe(true);
    }
  });

  it('claims: the claim key, the pseudonymous sub, every minted token and its verification', async () => {
    expect(toHex(await deriveWireKey(crypto, base64urlDecode(CLAIMS.secret)!, 'claim'))).toBe(CLAIMS.claimKeyHex);
    expect(toHex(await deriveWireKey(crypto, base64urlDecode(CLAIMS.sub.subSecret)!, 'sub'))).toBe(CLAIMS.sub.subKeyHex);
    expect(await pseudonymousSub(crypto, base64urlDecode(CLAIMS.sub.subSecret)!, CLAIMS.sub.userId)).toBe(CLAIMS.sub.sub);
    const ring = { secret: base64urlDecode(CLAIMS.secret)!, crypto, now: at(CLAIMS.now) };
    for (const v of CLAIMS.vectors) {
      const minted =
        v.mint === 'user' ? await mintUserClaim(ring, v.input as unknown as UserClaimInput) : await mintServiceClaim(ring, v.input as never);
      expect(minted, v.name).toEqual({ ok: true, token: v.token, claim: v.payload });
      const checked = await verifyClaim(v.token, { ...ring, app: 'dreamstream', purposes: [v.payload.purpose as ClaimPurpose] });
      expect(checked, v.name).toEqual({ ok: true, claim: v.payload });
    }
  });

  it('poll tokens: the poll key, every minted token and its verification', async () => {
    const secret = base64urlDecode(POLL.secret)!;
    expect(toHex(await deriveWireKey(crypto, secret, 'poll'))).toBe(POLL.pollKeyHex);
    for (const v of POLL.vectors) {
      const minted = await mintPollToken({ secret, crypto, now: at(POLL.now) }, v.input as never);
      expect(minted, v.name).toEqual({ ok: true, token: v.token, payload: v.payload });
      const checked = await verifyPollToken(v.token, { keys: () => secret, crypto, now: at(POLL.now), jobId: v.payload.jobId as string, method: 'GET' });
      expect(checked, v.name).toEqual({ ok: true, payload: v.payload });
    }
  });
});

// ── Canonical form ──────────────────────────────────────────────────────────────────────────────────────────────

describe('canonical query and path', () => {
  it('sorts parameters by key and RFC 3986-encodes them, reading + as a space', () => {
    expect(canonicalQuery('maxPages=24&lang=en')).toBe('lang=en&maxPages=24');
    expect(canonicalQuery('?lang=en&maxPages=24')).toBe('lang=en&maxPages=24');
    expect(canonicalQuery('q=a+b')).toBe(canonicalQuery('q=a%20b'));
    expect(canonicalQuery('q=a%2Bb')).toBe('q=a%2Bb');
    expect(canonicalQuery('q=a%2Bb')).not.toBe(canonicalQuery('q=a+b'));
    expect(canonicalQuery('a&b=')).toBe('a=&b=');
    expect(canonicalQuery('a=1&&b=2&')).toBe('a=1&b=2');
    expect(canonicalQuery("k=!'()*~")).toBe('k=%21%27%28%29%2A~');
    expect(canonicalQuery('')).toBe('');
    expect(encodeQuery({ maxPages: 24, lang: 'en', skip: undefined })).toBe('lang=en&maxPages=24');
  });

  it('refuses what it cannot sign unambiguously: a repeated key, a bad escape, invalid UTF-8, an empty key, a fragment, raw non-ASCII', () => {
    for (const bad of ['maxPages=24&maxPages=300', 'a=%zz', 'a=%4', 'a=%C3%28', '=v', 'a=1#frag', 'a=café', 'a=b c']) expect(canonicalQuery(bad), bad).toBeNull();
    const many = (n: number) => Array.from({ length: n }, (_x, i) => `k${i}=1`).join('&');
    expect(canonicalQuery(many(WIRE_LIMITS.queryParamsMax))).not.toBeNull();
    expect(canonicalQuery(many(WIRE_LIMITS.queryParamsMax + 1))).toBeNull();
    expect(canonicalQuery(`a=${'x'.repeat(WIRE_LIMITS.queryMax)}`)).toBeNull();
  });

  it('normalises path escapes and refuses dot segments, empty segments and non-path characters', () => {
    expect(canonicalPath('/v1/files/%61bc%2fdef')).toBe('/v1/files/abc%2Fdef');
    expect(canonicalPath('/v1/jobs/job-1')).toBe('/v1/jobs/job-1');
    expect(canonicalPath('/')).toBe('/');
    for (const bad of ['v1/jobs', '/v1/../admin', '/v1/%2e%2E/admin', '/v1/./x', '/v1//x', '/v1/x/', '/v1/a b', '/v1/a%zz', '/v1/a%2', '/v1/<x>', '/v1/é']) {
      expect(canonicalPath(bad), bad).toBeNull();
    }
  });
});

// ── Request signatures ──────────────────────────────────────────────────────────────────────────────────────────

describe('request signatures', () => {
  const extract = HMAC.vectors[1];
  const base = { method: extract.method, target: extract.target, timestamp: extract.timestamp, body: bodyOf(extract.body), claim: extract.claim, idempotencyKey: extract.idempotencyKey };
  const verify = (over: Partial<typeof base>, secret = SECRET, signature = extract.signature) => verifySignature(nodeCrypto, secret, { ...base, ...over }, signature);

  it('verifies the request exactly as signed, and with its query parameters in any order', async () => {
    expect((await verify({})).ok).toBe(true);
    expect((await verify({ target: '/v1/extract?lang=en&maxPages=24' })).ok).toBe(true);
  });

  it('changing ?maxPages= after signing breaks the signature', async () => {
    expect(await verify({ target: '/v1/extract?maxPages=300&lang=en' })).toMatchObject({ ok: false, code: 'unauthorized', reason: 'bad-signature' });
    expect(await verify({ target: '/v1/extract?lang=en' })).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(HMAC.vectors[2].signature).not.toBe(extract.signature);
    // Smuggling a second maxPages is refused outright, not silently resolved.
    expect(await verify({ target: '/v1/extract?maxPages=24&lang=en&maxPages=300' })).toMatchObject({ ok: false, code: 'invalid', reason: 'query' });
  });

  it('a tampered body, claim, key, Idempotency-Key, timestamp, method or path is rejected', async () => {
    const body = bodyOf(extract.body).slice();
    body[body.length - 1] ^= 1;
    expect(await verify({ body })).toMatchObject({ ok: false, code: 'unauthorized', reason: 'bad-signature' });
    expect(await verify({ claim: CLAIMS.vectors[1].token })).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verify({ claim: null })).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verify({}, OTHER_SECRET)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verify({ idempotencyKey: 'extract-0002' })).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verify({ timestamp: String(Number(extract.timestamp) + 1) })).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verify({ method: 'GET' })).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verify({ target: '/v1/convert?lang=en&maxPages=24' })).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('a signature that differs in one character, or is not a base64url MAC, is rejected', async () => {
    const sig = extract.signature;
    const flipped = sig.slice(0, 10) + (sig[10] === 'A' ? 'B' : 'A') + sig.slice(11);
    expect(await verify({}, SECRET, flipped)).toMatchObject({ ok: false, reason: 'bad-signature' });
    // The same 32 bytes, encoded with non-zero spare bits: a different string, so refused.
    const last = sig[42];
    const sibling = 'AEIMQUYcgkosw048'.indexOf(last) >= 0 ? String.fromCharCode(last.charCodeAt(0) + 1) : 'A';
    expect(await verify({}, SECRET, sig.slice(0, 42) + sibling)).toMatchObject({ ok: false });
    expect(await verify({}, SECRET, `${sig}=`)).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verify({}, SECRET, '')).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('a signer refuses a short secret, a bad Idempotency-Key and a malformed claim', async () => {
    expect(await signRequest(nodeCrypto, new Uint8Array(31), base)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await signRequest(nodeCrypto, SECRET, { ...base, idempotencyKey: 'has space' })).toMatchObject({ ok: false, reason: 'idempotency-key' });
    expect(await signRequest(nodeCrypto, SECRET, { ...base, idempotencyKey: 'x'.repeat(129) })).toMatchObject({ ok: false, reason: 'idempotency-key' });
    expect(await signRequest(nodeCrypto, SECRET, { ...base, claim: 'not a token' })).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('the job record id is scoped per caller: two users with the same key never share a job', async () => {
    const a = await idempotencyScope(nodeCrypto, { app: 'dreamstream', sub: SUB, key: 'k1' });
    const b = await idempotencyScope(nodeCrypto, { app: 'dreamstream', sub: 'f'.repeat(32), key: 'k1' });
    const svc = await idempotencyScope(nodeCrypto, { app: 'dreamstream', sub: null, key: 'k1' });
    const otherApp = await idempotencyScope(nodeCrypto, { app: 'atlas', sub: SUB, key: 'k1' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([a, b, svc, otherApp]).size).toBe(4);
    expect(await idempotencyScope(nodeCrypto, { app: 'dreamstream', sub: SUB, key: 'k1' })).toBe(a);
    expect(a).toBe(createHash('sha256').update(`platform-job-v1\ndreamstream\n${SUB}\nk1`).digest('hex'));
    expect(await idempotencyScope(nodeCrypto, { app: 'dreamstream', sub: SUB, key: 'bad key' })).toBeNull();
  });
});

// ── Claims ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('claims', () => {
  it('a user claim carries its tier, purpose, caps and an exp within 300 s; a random jti when none is given', async () => {
    const r = await mintUserClaim(keys(), userInput({ tier: 'atlas-beta', jti: undefined }));
    expect(r).toMatchObject({ ok: true, claim: { kind: 'user', tier: 'atlas-beta', purpose: 'extract', caps: ['doc.extract'], exp: NOW_S + WIRE_LIMITS.claimTtlDefaultSeconds } });
    if (r.ok === false) return;
    expect(r.claim.jti).toMatch(/^[0-9a-f]{32}$/);
    expect(await verifyClaim(r.token, verifyOpts())).toEqual({ ok: true, claim: r.claim });
    // Without randomBytes and without a jti, minting refuses rather than inventing one.
    const noRandom = { sha256: nodeCrypto.sha256, hmacSha256: nodeCrypto.hmacSha256 };
    expect(await mintUserClaim({ ...keys(), crypto: noRandom }, userInput({ jti: undefined }))).toMatchObject({ ok: false, code: 'invalid', reason: 'input' });
  });

  it('minting refuses bad input: a tier, purpose or sub out of the contract, and a lifetime over 300 s', async () => {
    expect(await mintUserClaim(keys(), userInput({ tier: 'enterprise' as never }))).toMatchObject({ ok: false, code: 'invalid', reason: 'input' });
    expect(await mintUserClaim(keys(), userInput({ purpose: 'preview' as never }))).toMatchObject({ ok: false, reason: 'input' });
    expect(await mintUserClaim(keys(), userInput({ sub: 'user-0001' }))).toMatchObject({ ok: false, reason: 'input' });
    expect(await mintUserClaim(keys(), userInput({ ttlSeconds: 301 }))).toMatchObject({ ok: false, code: 'invalid', reason: 'exp-too-far' });
    expect(await mintUserClaim(keys(), userInput({ ttlSeconds: 300 }))).toMatchObject({ ok: true, claim: { exp: NOW_S + 300 } });
    expect(await mintUserClaim(keys(new Uint8Array(16)), userInput())).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('a tampered claim is rejected: payload, MAC, or signed with another key', async () => {
    const token = CLAIMS.vectors[0].token;
    const [body, mac] = token.split('.');
    const tampered = base64urlEncode(utf8Encode(JSON.stringify(userPayload({ tier: 'admin' }))));
    expect(await verifyClaim(`${tampered}.${mac}`, verifyOpts())).toMatchObject({ ok: false, code: 'unauthorized', reason: 'bad-signature' });
    const macFlip = mac.slice(0, 5) + (mac[5] === 'x' ? 'y' : 'x') + mac.slice(6);
    expect(await verifyClaim(`${body}.${macFlip}`, verifyOpts())).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyClaim(token, verifyOpts({ secret: OTHER_SECRET }))).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyClaim(await forgeClaim(userPayload(), OTHER_SECRET), verifyOpts())).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('the MAC is checked before the payload is read, and a token over the cap is refused before any crypto', async () => {
    // Not JSON, but correctly MACed: malformed. Not JSON and wrongly MACed: bad-signature (the MAC came first).
    const key = await deriveWireKey(nodeCrypto, SECRET, 'claim');
    const garbage = base64urlEncode(utf8Encode('not json'));
    const sealed = `${garbage}.${base64urlEncode(new Uint8Array(createHmac('sha256', key).update(garbage).digest()))}`;
    expect(await verifyClaim(sealed, verifyOpts())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verifyClaim(`${garbage}.${'A'.repeat(43)}`, verifyOpts())).toMatchObject({ ok: false, reason: 'bad-signature' });
    const spy = vi.fn(nodeCrypto.hmacSha256);
    const r = await verifyClaim(`${'a'.repeat(WIRE_LIMITS.claimTokenMax)}.${'A'.repeat(43)}`, { ...verifyOpts(), crypto: { ...nodeCrypto, hmacSha256: spy } });
    expect(r).toMatchObject({ ok: false, reason: 'malformed' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('an expired claim is rejected (exp must be after now)', async () => {
    const token = CLAIMS.vectors[0].token;
    const exp = CLAIMS.vectors[0].payload.exp as number;
    expect((await verifyClaim(token, verifyOpts({ now: at(exp - 1) }))).ok).toBe(true);
    expect(await verifyClaim(token, verifyOpts({ now: at(exp) }))).toMatchObject({ ok: false, code: 'unauthorized', reason: 'expired' });
    expect(await verifyClaim(token, verifyOpts({ now: at(exp + 3600) }))).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('a claim whose exp is more than 300 s ahead is rejected, even with a valid MAC', async () => {
    expect((await verifyClaim(await forgeClaim(userPayload({ exp: NOW_S + 300 })), verifyOpts())).ok).toBe(true);
    expect(await verifyClaim(await forgeClaim(userPayload({ exp: NOW_S + 301 })), verifyOpts())).toMatchObject({
      ok: false,
      code: 'unauthorized',
      reason: 'exp-too-far',
    });
    expect(await verifyClaim(await forgeClaim(userPayload({ exp: NOW_S + 86400 })), verifyOpts())).toMatchObject({ ok: false, reason: 'exp-too-far' });
  });

  it('a wrong purpose, a missing capability, another product or another app is rejected', async () => {
    const token = CLAIMS.vectors[0].token; // purpose extract, caps [doc.extract], product chat
    expect(await verifyClaim(token, verifyOpts({ purposes: ['render', 'pdf'] }))).toMatchObject({ ok: false, code: 'forbidden', reason: 'wrong-purpose' });
    expect(await verifyClaim(token, verifyOpts({ capability: 'doc.convert' }))).toMatchObject({ ok: false, code: 'forbidden', reason: 'capability' });
    expect((await verifyClaim(token, verifyOpts({ capability: 'doc.extract' }))).ok).toBe(true);
    expect(await verifyClaim(token, verifyOpts({ products: ['comic'] }))).toMatchObject({ ok: false, code: 'forbidden', reason: 'wrong-product' });
    expect(await verifyClaim(token, verifyOpts({ app: 'atlas' }))).toMatchObject({ ok: false, code: 'unauthorized', reason: 'wrong-app' });
    expect(await verifyClaim(token, { ...verifyOpts(), purposes: [] })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('a payload outside the contract is malformed: an unknown key, a user claim with purpose preview, a wrong version', async () => {
    expect(await verifyClaim(await forgeClaim(userPayload({ admin: true })), verifyOpts())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verifyClaim(await forgeClaim(userPayload({ purpose: 'preview' })), verifyOpts())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verifyClaim(await forgeClaim(userPayload({ v: 2 })), verifyOpts())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verifyClaim(await forgeClaim(userPayload({ tier: 'root' })), verifyOpts())).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('service claims carry only preview capabilities: minting refuses others', async () => {
    const svc = (caps: string[], purpose?: string) => mintServiceClaim(keys(), { app: 'dreamstream', product: 'chat', caps: caps as never, jti: 'jti-svc', ...(purpose ? { purpose: purpose as never } : {}) });
    expect(await svc(['doc.convert', 'doc.extract', 'doc.thumbnail'])).toMatchObject({ ok: true, claim: { kind: 'service', purpose: 'preview' } });
    for (const cap of ['pdf.redact', 'pdf.inspect', 'richdoc.render', 'print.book']) {
      expect(await svc(['doc.extract', cap]), cap).toMatchObject({ ok: false, code: 'invalid', reason: 'service-scope' });
    }
    expect(await svc(['doc.extract'], 'render')).toMatchObject({ ok: false, reason: 'service-scope' });
    expect(await svc([])).toMatchObject({ ok: false, reason: 'input' });
  });

  it('service claims carry only preview capabilities: verifying refuses a correctly MACed one that reaches further', async () => {
    const svc = CLAIMS.vectors[2].payload;
    const ok = await verifyClaim(await forgeClaim({ ...svc }), verifyOpts({ purposes: ['preview'] }));
    expect(ok).toMatchObject({ ok: true, claim: { kind: 'service' } });
    expect(await verifyClaim(await forgeClaim({ ...svc, caps: ['doc.convert', 'pdf.redact'] }), verifyOpts({ purposes: ['preview'] }))).toMatchObject({
      ok: false,
      code: 'forbidden',
      reason: 'service-scope',
    });
    expect(await verifyClaim(await forgeClaim({ ...svc, purpose: 'pdf' }), verifyOpts({ purposes: ['pdf', 'preview'] }))).toMatchObject({
      ok: false,
      code: 'forbidden',
      reason: 'service-scope',
    });
    // A user-only purpose never accepts a service claim either.
    expect(await verifyClaim(await forgeClaim({ ...svc }), verifyOpts({ purposes: ['extract'] }))).toMatchObject({ ok: false, reason: 'wrong-purpose' });
  });

  it('the pseudonymous sub is 32 hex characters, stable per user, and differs between users and secrets', async () => {
    const subSecret = base64urlDecode(CLAIMS.sub.subSecret)!;
    const a = await pseudonymousSub(nodeCrypto, subSecret, 'user-0001');
    expect(a).toBe(CLAIMS.sub.sub);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(await pseudonymousSub(nodeCrypto, subSecret, 'user-0002')).not.toBe(a);
    expect(await pseudonymousSub(nodeCrypto, OTHER_SECRET, 'user-0001')).not.toBe(a);
    // Domain-separated: not the plain HMAC of the user id under the secret.
    expect(a).not.toBe(createHmac('sha256', subSecret).update('user-0001').digest('hex').slice(0, 32));
    expect(await pseudonymousSub(nodeCrypto, subSecret, '')).toBeNull();
  });
});

// ── Poll tokens ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('poll tokens', () => {
  const v = POLL.vectors[0];
  const opts = (over: Partial<{ jobId: string; method: string; now: () => number; keys: () => Uint8Array | undefined }> = {}) => ({
    keys: over.keys ?? ((app: string, kid: string) => (app === 'dreamstream' && kid === 'ds-fixture-1' ? SECRET : undefined)),
    crypto: nodeCrypto,
    now: over.now ?? at(POLL.now),
    jobId: over.jobId ?? (v.payload.jobId as string),
    method: over.method ?? 'GET',
  });

  it('is bound to its job, allows GET only, and is refused for an unknown key', async () => {
    expect((await verifyPollToken(v.token, opts())).ok).toBe(true);
    expect(await verifyPollToken(v.token, opts({ jobId: 'job-0002' }))).toMatchObject({ ok: false, code: 'forbidden', reason: 'wrong-job' });
    expect(await verifyPollToken(v.token, opts({ method: 'POST' }))).toMatchObject({ ok: false, code: 'forbidden', reason: 'method' });
    expect(await verifyPollToken(v.token, opts({ keys: () => undefined }))).toMatchObject({ ok: false, code: 'unauthorized', reason: 'unknown-key' });
  });

  it('expires, lives at most an hour (at mint and at verify), and is rejected when tampered', async () => {
    const exp = v.payload.exp as number;
    expect(await verifyPollToken(v.token, opts({ now: at(exp) }))).toMatchObject({ ok: false, reason: 'expired' });
    const ring = { secret: SECRET, crypto: nodeCrypto, now: at(POLL.now) };
    expect(await mintPollToken(ring, { ...(v.input as never), ttlSeconds: 3601 })).toMatchObject({ ok: false, code: 'invalid', reason: 'exp-too-far' });
    expect(await verifyPollToken(await forgePoll({ ...v.payload, exp: POLL.now + 3601 }), opts())).toMatchObject({ ok: false, reason: 'exp-too-far' });
    expect((await verifyPollToken(await forgePoll({ ...v.payload, exp: POLL.now + 3600 }), opts())).ok).toBe(true);
    const [, mac] = v.token.split('.');
    const otherJob = base64urlEncode(utf8Encode(JSON.stringify({ ...v.payload, jobId: 'job-0002' })));
    expect(await verifyPollToken(`${otherJob}.${mac}`, opts({ jobId: 'job-0002' }))).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyPollToken(await forgePoll(v.payload, OTHER_SECRET), opts())).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('a claim is never a poll token, and a token sealed with the claim key never verifies', async () => {
    expect(await verifyPollToken(CLAIMS.vectors[0].token, opts())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await verifyPollToken(await forgeClaim(v.payload), opts())).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyClaim(v.token, verifyOpts())).toMatchObject({ ok: false, reason: 'bad-signature' });
  });
});

// ── Signed requests: headers, preflight, signature ──────────────────────────────────────────────────────────────

describe('signed requests (headers, preflight and signature)', () => {
  const RING = (app: string, kid: string) => (app === 'dreamstream' && kid === 'ds-fixture-1' ? SECRET : undefined);
  const options = (over: Partial<PreflightOptions> = {}): PreflightOptions => ({
    crypto: nodeCrypto,
    now: at(NOW_S),
    keys: RING,
    claim: { purposes: ['extract', 'preview'], capability: 'doc.extract' },
    maxBodyBytes: WIRE_LIMITS.maxRequestBytes,
    ...over,
  });
  const body = utf8Encode('%PDF-1.7 synthetic');
  const sign = async (over: Record<string, unknown> = {}) => {
    const r = await signedRequestHeaders({
      app: 'dreamstream',
      keyId: 'ds-fixture-1',
      secret: SECRET,
      crypto: nodeCrypto,
      method: 'POST',
      target: '/v1/extract?maxPages=24',
      timestamp: NOW_S,
      body,
      claim: CLAIMS.vectors[0].token,
      idempotencyKey: 'extract-0001',
      ...over,
    } as never);
    if (r.ok === false) throw new Error(`sign failed: ${r.reason}`);
    return { ...r.headers, 'Content-Length': String(body.length) } as Record<string, string>;
  };
  const request = (headers: Record<string, string>, target = '/v1/extract?maxPages=24', method = 'POST') => ({ method, target, headers });

  it('a request built by signedRequestHeaders verifies, owned by the claim sub', async () => {
    const h = await sign();
    expect(h).toMatchObject({ 'X-Platform-App': 'dreamstream', 'X-Platform-Key-Id': 'ds-fixture-1', 'X-Platform-Contract': '1', 'Idempotency-Key': 'extract-0001' });
    const r = await verifyRequest(request(h), body, options());
    expect(r).toMatchObject({ ok: true, app: 'dreamstream', kid: 'ds-fixture-1', owner: SUB, idempotencyKey: 'extract-0001', claim: { tier: 'creator' } });
    // Headers read case-insensitively from a plain record and from a Headers object.
    const lower: Record<string, string> = {};
    for (const [k, val] of Object.entries(h)) lower[k.toLowerCase()] = val;
    expect((await verifyRequest(request(lower), body, options())).ok).toBe(true);
    expect((await verifyRequest({ method: 'POST', target: '/v1/extract?maxPages=24', headers: new Headers(h) }, body, options())).ok).toBe(true);
    expect(readHeader(lower, 'X-PLATFORM-APP')).toBe('dreamstream');
  });

  it('skew over 300 s is rejected in both directions; exactly 300 s is accepted', async () => {
    expect((await verifyRequest(request(await sign({ timestamp: NOW_S - 300 })), body, options())).ok).toBe(true);
    expect((await verifyRequest(request(await sign({ timestamp: NOW_S + 300 })), body, options())).ok).toBe(true);
    expect(await verifyRequest(request(await sign({ timestamp: NOW_S - 301 })), body, options())).toMatchObject({ ok: false, code: 'unauthorized', reason: 'skew' });
    expect(await verifyRequest(request(await sign({ timestamp: NOW_S + 301 })), body, options())).toMatchObject({ ok: false, reason: 'skew' });
  });

  it('a POST without an Idempotency-Key is refused by the signer and by the verifier', async () => {
    expect(await signedRequestHeaders({ app: 'dreamstream', keyId: 'ds-fixture-1', secret: SECRET, crypto: nodeCrypto, method: 'POST', target: '/v1/extract', timestamp: NOW_S, body, claim: CLAIMS.vectors[0].token })).toMatchObject({
      ok: false,
      code: 'invalid',
      reason: 'idempotency-key',
    });
    const h = await sign();
    delete h['Idempotency-Key'];
    expect(await verifyRequest(request(h), body, options())).toMatchObject({ ok: false, code: 'invalid', reason: 'idempotency-key' });
  });

  it('a POST that carries a body without a claim is refused by the signer and by the verifier, before any body check', async () => {
    expect(
      await signedRequestHeaders({ app: 'dreamstream', keyId: 'ds-fixture-1', secret: SECRET, crypto: nodeCrypto, method: 'POST', target: '/v1/extract', timestamp: NOW_S, body, idempotencyKey: 'k1' }),
    ).toMatchObject({ ok: false, reason: 'claim-required' });
    // Signed without a claim by hand: the signature is fine, the claim is not there.
    const signed = await signRequest(nodeCrypto, SECRET, { method: 'POST', target: '/v1/extract?maxPages=24', timestamp: NOW_S, body, idempotencyKey: 'k1' });
    if (signed.ok === false) throw new Error('sign');
    const h: Record<string, string> = {
      'X-Platform-App': 'dreamstream',
      'X-Platform-Key-Id': 'ds-fixture-1',
      'X-Platform-Timestamp': String(NOW_S),
      'X-Platform-Signature': signed.signature,
      'X-Platform-Contract': '1',
      'Idempotency-Key': 'k1',
      'Content-Length': String(body.length),
    };
    const pre = await preflightRequest(request(h), options());
    expect(pre).toMatchObject({ ok: false, code: 'unauthorized', reason: 'claim-required' });
    // An empty-bodied POST may go without a claim; a GET that must know its owner may not.
    expect(await preflightRequest(request({ ...h, 'Content-Length': '0' }), options())).toMatchObject({ ok: true, owner: 'svc' });
    expect(await preflightRequest(request(h, '/v1/jobs/job-0001', 'GET'), options({ claimRequired: true }))).toMatchObject({ ok: false, reason: 'claim-required' });
  });

  it('the claim is checked at preflight: wrong purpose, expired, beyond 300 s, another app, a service claim on preview', async () => {
    const withClaim = async (claim: string) => verifyRequest(request(await sign({ claim })), body, options());
    expect(await withClaim(await forgeClaim(userPayload({ purpose: 'render' })))).toMatchObject({ ok: false, code: 'forbidden', reason: 'wrong-purpose' });
    expect(await withClaim(await forgeClaim(userPayload({ exp: NOW_S })))).toMatchObject({ ok: false, reason: 'expired' });
    expect(await withClaim(await forgeClaim(userPayload({ exp: NOW_S + 301 })))).toMatchObject({ ok: false, reason: 'exp-too-far' });
    expect(await withClaim(await forgeClaim(userPayload({ app: 'atlas' })))).toMatchObject({ ok: false, reason: 'wrong-app' });
    expect(await withClaim(await forgeClaim(userPayload({ caps: [] })))).toMatchObject({ ok: false, reason: 'capability' });
    const svc = await forgeClaim({ ...CLAIMS.vectors[2].payload, caps: ['doc.extract'], exp: NOW_S + 60 });
    expect(await withClaim(svc)).toMatchObject({ ok: true, owner: 'svc', claim: { kind: 'service' } });
  });

  it('a tampered body, a body of another length, a swapped claim or another key fails the signature phase', async () => {
    const h = await sign();
    const other = body.slice();
    other[0] ^= 1;
    expect(await verifyRequest(request(h), other, options())).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyRequest(request(h), body.slice(1), options())).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyRequest(request({ ...h, 'X-Platform-Claim': await forgeClaim(userPayload({ jti: 'other' })) }), body, options())).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
    const otherKey = await signedRequestHeaders({ app: 'dreamstream', keyId: 'ds-fixture-1', secret: OTHER_SECRET, crypto: nodeCrypto, method: 'POST', target: '/v1/extract?maxPages=24', timestamp: NOW_S, body, claim: CLAIMS.vectors[0].token, idempotencyKey: 'extract-0001' });
    if (otherKey.ok === false) throw new Error('sign');
    expect(await verifyRequest(request({ ...otherKey.headers, 'Content-Length': String(body.length) }), body, options())).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(await verifyRequest(request(h, '/v1/extract?maxPages=300'), body, options())).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('phase 2 accepts the hash computed while streaming, and phase 1 never needs the body', async () => {
    const h = await sign();
    const hashSpy = vi.fn(nodeCrypto.sha256);
    const pre = await preflightRequest(request(h), options({ crypto: { ...nodeCrypto, sha256: hashSpy } }));
    expect(pre.ok).toBe(true);
    if (pre.ok === false) return;
    expect(hashSpy).not.toHaveBeenCalled();
    expect(await verifyRequestSignature(pre, nodeCrypto, { sha256Hex: createHash('sha256').update(body).digest('hex') })).toEqual({ ok: true });
    expect(await verifyRequestSignature(pre, nodeCrypto, { sha256Hex: '0'.repeat(64) })).toMatchObject({ ok: false, reason: 'bad-signature' });
  });

  it('refuses unsigned, unknown-key, wrong-contract, oversized and unmeasured requests before the claim', async () => {
    const h = await sign();
    const without = (name: string) => {
      const c = { ...h };
      delete c[name];
      return c;
    };
    expect(await preflightRequest(request(without('X-Platform-Signature')), options())).toMatchObject({ ok: false, code: 'unauthorized', reason: 'missing-header' });
    expect(await preflightRequest(request({ ...h, 'X-Platform-Key-Id': 'ds-old' }), options())).toMatchObject({ ok: false, reason: 'unknown-key' });
    expect(await preflightRequest(request({ ...h, 'X-Platform-App': 'atlas' }), options())).toMatchObject({ ok: false, reason: 'unknown-key' });
    expect(await preflightRequest(request(h), options({ keys: () => new Uint8Array(8) }))).toMatchObject({ ok: false, reason: 'unknown-key' });
    expect(await preflightRequest(request({ ...h, 'X-Platform-Contract': '2' }), options())).toMatchObject({ ok: false, code: 'invalid', reason: 'contract' });
    expect(await preflightRequest(request(h), options({ maxBodyBytes: body.length - 1 }))).toMatchObject({ ok: false, code: 'too-large', reason: 'too-large' });
    expect(await preflightRequest(request(without('Content-Length')), options())).toMatchObject({ ok: false, reason: 'length-required' });
    expect(await preflightRequest(request({ ...h, 'X-Platform-Signature': 'x' }), options())).toMatchObject({ ok: false, reason: 'malformed' });
    expect(await preflightRequest(request(h), options({ claim: 'none' }))).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('signs and verifies a GET (no body, no key), and the GET is refused with a forged claim', async () => {
    const g = await signedRequestHeaders({ app: 'dreamstream', keyId: 'ds-fixture-1', secret: SECRET, crypto: nodeCrypto, method: 'GET', target: '/v1/jobs/job-0001', timestamp: NOW_S, claim: CLAIMS.vectors[0].token });
    if (g.ok === false) throw new Error('sign');
    expect(g.headers['Idempotency-Key']).toBeUndefined();
    expect(await verifyRequest(request(g.headers, '/v1/jobs/job-0001', 'GET'), null, options({ claim: { purposes: ['extract'] } }))).toMatchObject({ ok: true, owner: SUB });
    const forged = { ...g.headers, [PLATFORM_HEADERS.claim]: await forgeClaim(userPayload(), OTHER_SECRET) };
    expect(await verifyRequest(request(forged, '/v1/jobs/job-0001', 'GET'), null, options({ claim: { purposes: ['extract'] } }))).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

// ── Errors and response headers ─────────────────────────────────────────────────────────────────────────────────

describe('errors and response headers', () => {
  const html = utf8Encode('<html><body>413 Request Entity Too Large</body></html>');

  it('maps 413, 415 and 504 by status when an edge proxy answered without a platform body', () => {
    expect(failureFromResponse(413, html)).toMatchObject({ ok: false, code: 'too-large', retryable: false, status: 413 });
    expect(failureFromResponse(415, null)).toMatchObject({ ok: false, code: 'unsupported', retryable: false, status: 415 });
    expect(failureFromResponse(504, new Uint8Array(0))).toMatchObject({ ok: false, code: 'timeout', retryable: true, status: 504 });
    expect(failureFromResponse(429, null)).toMatchObject({ code: 'quota', retryable: true });
    expect(failureFromResponse(418, null)).toMatchObject({ code: 'invalid', retryable: false });
    expect(failureFromResponse(500, null)).toMatchObject({ code: 'engine-failed', retryable: true });
  });

  it('a platform error body names the code and request id; retryable follows the code', () => {
    const body = utf8Encode(JSON.stringify({ error: { code: 'input-rejected', message: 'zip bomb', retryable: true, requestId: 'req-1' } }));
    expect(failureFromResponse(422, body, 'req-header')).toMatchObject({ code: 'input-rejected', message: 'zip bomb', retryable: false, requestId: 'req-1', status: 422 });
    expect(failureFromResponse(503, utf8Encode('{"error":{"code":"not-a-code"}}'), 'req-2')).toMatchObject({ code: 'disabled', requestId: 'req-2' });
    expect(parseErrorBody('{"error":{"code":"quota","message":"slow down","requestId":"bad id!"}}')).toEqual({ code: 'quota', message: 'slow down', retryable: true, requestId: '' });
    expect(parseErrorBody('[]')).toBeNull();
    expect(parseErrorBody(utf8Encode('x'.repeat(70000)))).toBeNull();
  });

  it('reads X-Platform-Warnings and X-Platform-Cost-Micros defensively', () => {
    expect(parseWarnings(encodeWarnings(['font substituted', 'page 3 truncated']))).toEqual(['font substituted', 'page 3 truncated']);
    expect(parseWarnings('%E0%A4%A')).toEqual([]);
    expect(parseWarnings(encodeURIComponent('{"a":1}'))).toEqual([]);
    expect(parseWarnings(encodeURIComponent(JSON.stringify([1, 'ok', null])))).toEqual(['ok']);
    expect(parseWarnings(encodeWarnings(new Array(50).fill('w')))).toHaveLength(WIRE_LIMITS.warningsMax);
    expect(parseCostMicros('1234')).toBe(1234);
    for (const bad of ['-1', '1.5', '01', '', 'x', null]) expect(parseCostMicros(bad), String(bad)).toBeUndefined();
  });
});
