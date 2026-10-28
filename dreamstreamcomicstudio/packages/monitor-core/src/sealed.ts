/**
 * End-to-end sealing with the Nursery Media Key (ADR 0006 D6.3): the key our servers never
 * hold. WebCrypto only, through a small structural interface, so the same code runs in
 * browsers, the Worker and React Native (with a WebCrypto polyfill passed to
 * `setCryptoProvider`). Swift (CryptoKit) and Kotlin (Tink/JCA) reproduce every vector in
 * fixtures/sealed byte for byte.
 *
 * Conventions (all of them are in the fixtures):
 * - Public keys: uncompressed SEC1 P-256 points (0x04 ‖ X ‖ Y, 65 bytes), base64url.
 * - Signatures: ECDSA P-256 / SHA-256 as raw r ‖ s (64 bytes), base64url.
 * - HKDF: HKDF-SHA256 with an EMPTY salt (RFC 5869: a string of zeros), info as UTF-8.
 * - AES-256-GCM with a 96-bit nonce and a 128-bit tag.
 *
 * NMK wrap v1 (to one device's ECDH key):
 *   blob = 0x01 ‖ ephPub(65) ‖ iv(12) ‖ AES-GCM(key, iv, NMK(32), aad = 0x01 ‖ ephPub)   126 bytes
 *   key  = HKDF(ECDH(eph, devicePub).x, info = "ds-nmk|<nid>|<e>|<devId>", 32)
 *
 * Relay frame v1 (one sealed part: a picture or a sound chunk):
 *   header (22) = ver u8 =1 | e u32 | cam u16 | seq u64 | ts u48 | flags u8      big-endian
 *   sealed      = header ‖ AES-GCM(frameKey, salt ‖ seq(8), body, aad = header ‖ nid)
 *   frameKey ‖ salt = HKDF(NMK_e, info = "frame|<camDev>", 36)   (32-byte key, 4-byte salt)
 *   `cam` is the stream within the camera (0 picture, 1 sound); flags bit 0 = key frame.
 *   `seq` is ONE counter per camera per epoch across its streams (`FrameCounter`), so a
 *   nonce never repeats under a key, even across a camera restart.
 *   The relay wire keeps its own 11-byte header in clear (kind, key flag, seq, codec) so the
 *   room can still route, and send hidden viewers the sound only — it seals each part
 *   (picture, sound) separately, so the room can drop the picture without reading anything.
 *
 * Sealed signaling (rtc.d = {e, iv, ct, f}):
 *   ct = AES-GCM(HKDF(NMK_e, "sig", 32), iv, JSON{d, from, to, ts}, aad = "<nid>|<from>|<to>")
 *
 * dev_hello signature: ECDSA by the device's signing key over
 *   "ds-hello|<nid>|<nonce>|<ts>|<ecdhPub>"     (devId = base64url(SHA-256(sigPub))[0:22])
 */
import { b64url, concat, fromB64url, fromUtf8, hex, readU64, readUint, utf8, writeU64, writeUint } from './bytes';
import type { SealedRtc } from './wire';

/* --------------------------------------------------------------- provider */

/** An opaque WebCrypto key. */
export type Key = object;

interface Subtle {
  importKey(format: string, keyData: unknown, algorithm: unknown, extractable: boolean, usages: readonly string[]): Promise<Key>;
  exportKey(format: string, key: Key): Promise<unknown>;
  generateKey(algorithm: unknown, extractable: boolean, usages: readonly string[]): Promise<unknown>;
  deriveBits(algorithm: unknown, baseKey: Key, length: number): Promise<ArrayBuffer>;
  encrypt(algorithm: unknown, key: Key, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(algorithm: unknown, key: Key, data: Uint8Array): Promise<ArrayBuffer>;
  sign(algorithm: unknown, key: Key, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: unknown, key: Key, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  digest(algorithm: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
interface Provider {
  subtle: Subtle;
  getRandomValues(a: Uint8Array): Uint8Array;
}

let injected: Provider | null = null;

/** Use this WebCrypto implementation instead of `globalThis.crypto` (React Native polyfills, tests); null resets to it. */
export function setCryptoProvider(c: { subtle: unknown; getRandomValues: unknown } | null): void {
  injected = c as Provider | null;
}

function provider(): Provider {
  const c = injected ?? (globalThis as unknown as { crypto?: Provider }).crypto;
  if (!c?.subtle || typeof c.getRandomValues !== 'function') throw new Error('WebCrypto is not available');
  return c;
}
const subtle = (): Subtle => provider().subtle;

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  provider().getRandomValues(out);
  return out;
}

/* ----------------------------------------------------------------- labels */

/** Every derivation label, so Swift and Kotlin use the same strings. */
export const LABELS = {
  /** `ds-nmk|<nid>|<e>|<devId>`: the key that wraps an NMK to one device. */
  wrap: 'ds-nmk',
  /** `frame|<camDev>`: a camera's frame key and nonce salt (36 bytes). */
  frame: 'frame|',
  /** The sealed signaling key. */
  sig: 'sig',
  /** HMAC(NMK, "lan")[0:8]: the anonymous mDNS name (Phase 4). */
  lan: 'lan',
  /** Prefix of the dev_hello signature input. */
  hello: 'ds-hello',
  /** Phase 2 media sessions: HKDF(NMK, kind ‖ session) — reserved, not built yet. */
  peek: 'peek',
  listen: 'listen',
  clip: 'clip',
} as const;

export const NMK_BYTES = 32;
export const wrapInfo = (nid: string, e: number, devId: string): string => `${LABELS.wrap}|${nid}|${e}|${devId}`;

/** A fresh Nursery Media Key (32 random bytes) for a new epoch. */
export const newNmk = (): Uint8Array => randomBytes(NMK_BYTES);

/* ------------------------------------------------------------- primitives */

const ab = (b: ArrayBuffer): Uint8Array => new Uint8Array(b);

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return ab(await subtle().digest('SHA-256', data));
}

export async function hkdf(ikm: Uint8Array, info: string | Uint8Array, bytes: number): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return ab(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: typeof info === 'string' ? utf8(info) : info }, k, bytes * 8));
}

async function aesKey(raw: Uint8Array): Promise<Key> {
  return subtle().importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function gcmSeal(key: Key, iv: Uint8Array, plain: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
  return ab(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plain));
}

async function gcmOpen(key: Key, iv: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null> {
  try {
    return ab(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, sealed));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ device keys */

export interface EcJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d?: string;
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

const asBytes = (v: Uint8Array | string, what: string): Uint8Array => {
  const b = typeof v === 'string' ? fromB64url(v) : v;
  if (!b) throw new Error(`${what}: not base64url`);
  return b;
};

/** The uncompressed point of a JWK's public part. */
export function pointFromJwk(jwk: EcJwk): Uint8Array {
  const x = fromB64url(jwk.x);
  const y = fromB64url(jwk.y);
  if (!x || !y || x.length !== 32 || y.length !== 32) throw new Error('jwk: bad point');
  return concat(Uint8Array.of(4), x, y);
}

export function jwkFromPoint(point: Uint8Array | string): EcJwk {
  const p = asBytes(point, 'point');
  if (p.length !== 65 || p[0] !== 4) throw new Error('point: not an uncompressed P-256 point');
  return { kty: 'EC', crv: 'P-256', x: b64url(p.subarray(1, 33)), y: b64url(p.subarray(33)) };
}

export const importEcdhPublic = (point: Uint8Array | string): Promise<Key> => subtle().importKey('raw', checkPoint(asBytes(point, 'ecdhPub')), ECDH, true, []);
export const importEcdhPrivate = (jwk: EcJwk, extractable = false): Promise<Key> => subtle().importKey('jwk', { ...jwk, ext: extractable }, ECDH, extractable, ['deriveBits']);
export const importSigPublic = (point: Uint8Array | string): Promise<Key> => subtle().importKey('raw', checkPoint(asBytes(point, 'sigPub')), ECDSA, true, ['verify']);
export const importSigPrivate = (jwk: EcJwk, extractable = false): Promise<Key> => subtle().importKey('jwk', { ...jwk, ext: extractable }, ECDSA, extractable, ['sign']);

function checkPoint(p: Uint8Array): Uint8Array {
  if (p.length !== 65 || p[0] !== 4) throw new Error('not an uncompressed P-256 point');
  return p;
}

export async function exportPoint(publicKey: Key): Promise<Uint8Array> {
  return ab((await subtle().exportKey('raw', publicKey)) as ArrayBuffer);
}

/** devId = base64url(SHA-256(sigPub))[0:22] — 132 bits, stable for the life of the key. */
export async function deviceId(sigPub: Uint8Array | string): Promise<string> {
  return b64url(await sha256(checkPoint(asBytes(sigPub, 'sigPub')))).slice(0, 22);
}

export interface KeyPair {
  privateKey: Key;
  publicKey: Key;
}

export interface DeviceKeys {
  sig: KeyPair;
  ecdh: KeyPair;
  /** Public points, 65 bytes each. */
  sigPub: Uint8Array;
  ecdhPub: Uint8Array;
  devId: string;
}

/**
 * A device's two key pairs (ADR D6.3). Private keys are non-extractable unless asked
 * (web: keep them in IndexedDB as CryptoKeys; native apps use the Secure Enclave / Keystore).
 */
export async function generateDeviceKeys(extractable = false): Promise<DeviceKeys> {
  const sig = (await subtle().generateKey(ECDSA, extractable, ['sign', 'verify'])) as KeyPair;
  const ecdh = (await subtle().generateKey(ECDH, extractable, ['deriveBits'])) as KeyPair;
  const sigPub = await exportPoint(sig.publicKey);
  const ecdhPub = await exportPoint(ecdh.publicKey);
  return { sig, ecdh, sigPub, ecdhPub, devId: await deviceId(sigPub) };
}

/* -------------------------------------------------------------- NMK wraps */

export const WRAP_VERSION = 1;
export const WRAP_BYTES = 1 + 65 + 12 + NMK_BYTES + 16;

export interface WrapCtx {
  nid: string;
  e: number;
  /** The recipient device. */
  devId: string;
}

/**
 * Wrap the NMK to one device's ECDH public key. `ephemeral` and `iv` exist for the golden
 * vectors only — leave them out: a fresh ephemeral key per wrap is what makes it safe.
 */
export async function wrapNmk(nmk: Uint8Array, ecdhPub: Uint8Array | string, ctx: WrapCtx, vector: { ephemeral?: EcJwk; iv?: Uint8Array } = {}): Promise<string> {
  if (nmk.length !== NMK_BYTES) throw new Error('wrapNmk: the NMK is 32 bytes');
  const recipient = await importEcdhPublic(ecdhPub);
  let ephPriv: Key;
  let ephPub: Uint8Array;
  if (vector.ephemeral) {
    ephPriv = await importEcdhPrivate(vector.ephemeral);
    ephPub = pointFromJwk(vector.ephemeral);
  } else {
    const pair = (await subtle().generateKey(ECDH, false, ['deriveBits'])) as KeyPair;
    ephPriv = pair.privateKey;
    ephPub = await exportPoint(pair.publicKey);
  }
  const shared = ab(await subtle().deriveBits({ name: 'ECDH', public: recipient }, ephPriv, 256));
  const key = await aesKey(await hkdf(shared, wrapInfo(ctx.nid, ctx.e, ctx.devId), 32));
  const iv = vector.iv ?? randomBytes(12);
  const head = concat(Uint8Array.of(WRAP_VERSION), ephPub);
  return b64url(concat(head, iv, await gcmSeal(key, iv, nmk, head)));
}

/** The NMK from a wrap made for this device, or null (wrong device, wrong context, tampered). */
export async function unwrapNmk(blob: string | Uint8Array, ecdhPrivate: Key, ctx: WrapCtx): Promise<Uint8Array | null> {
  const b = typeof blob === 'string' ? fromB64url(blob) : blob;
  if (!b || b.length !== WRAP_BYTES || b[0] !== WRAP_VERSION) return null;
  const head = b.subarray(0, 66);
  try {
    const eph = await importEcdhPublic(b.slice(1, 66));
    const shared = ab(await subtle().deriveBits({ name: 'ECDH', public: eph }, ecdhPrivate, 256));
    const key = await aesKey(await hkdf(shared, wrapInfo(ctx.nid, ctx.e, ctx.devId), 32));
    const nmk = await gcmOpen(key, b.slice(66, 78), b.slice(78), head.slice());
    return nmk && nmk.length === NMK_BYTES ? nmk : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------- relay frames */

export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 22;
export const FRAME_TAG_BYTES = 16;
/** Bytes a sealed part adds to its body. */
export const FRAME_OVERHEAD = FRAME_HEADER_BYTES + FRAME_TAG_BYTES;
export const FRAME_FLAG_KEY = 1;
/** Streams within one camera's frame key (`cam`). */
export const FRAME_STREAM = { picture: 0, sound: 1 } as const;
/** Viewers drop frames older than this (relative to the freshest the camera has sent). */
export const FRAME_MAX_AGE_MS = 10_000;

export interface FrameHeader {
  /** NMK epoch. */
  e: number;
  /** Stream within the camera: `FRAME_STREAM`. */
  cam: number;
  /** One counter per camera per epoch, across its streams (`FrameCounter`). */
  seq: number;
  /** The camera's clock (ms). */
  ts: number;
  /** Bit 0: key frame. */
  flags: number;
}

export interface FrameCtx {
  nid: string;
  /** The camera's devId. */
  camDev: string;
}

export function packFrameHeader(h: FrameHeader): Uint8Array {
  if (!Number.isInteger(h.e) || h.e < 0 || h.e > 0xffffffff) throw new Error('frame: bad epoch');
  if (!Number.isInteger(h.cam) || h.cam < 0 || h.cam > 0xffff) throw new Error('frame: bad stream');
  if (!Number.isSafeInteger(h.seq) || h.seq < 0) throw new Error('frame: bad seq');
  if (!Number.isSafeInteger(h.ts) || h.ts < 0 || h.ts >= 2 ** 48) throw new Error('frame: bad ts');
  const out = new Uint8Array(FRAME_HEADER_BYTES);
  out[0] = FRAME_VERSION;
  writeUint(out, 1, 4, h.e);
  writeUint(out, 5, 2, h.cam);
  writeU64(out, 7, h.seq);
  writeUint(out, 15, 6, h.ts);
  out[21] = h.flags & 0xff;
  return out;
}

/** The header of a sealed part (not yet authenticated), or null when it isn't one. */
export function readFrameHeader(b: Uint8Array): FrameHeader | null {
  if (b.length < FRAME_OVERHEAD || b[0] !== FRAME_VERSION) return null;
  const seq = readU64(b, 7);
  if (seq == null) return null;
  return { e: readUint(b, 1, 4), cam: readUint(b, 5, 2), seq, ts: readUint(b, 15, 6), flags: b[21] };
}

interface FrameKeys {
  key: Key;
  salt: Uint8Array;
}
/** Per NMK object: derived once per camera. Keep one Uint8Array per epoch to benefit. */
const frameKeyCache = new WeakMap<Uint8Array, Map<string, Promise<FrameKeys>>>();

export function frameKeys(nmk: Uint8Array, camDev: string): Promise<FrameKeys> {
  let byCam = frameKeyCache.get(nmk);
  if (!byCam) frameKeyCache.set(nmk, (byCam = new Map()));
  let k = byCam.get(camDev);
  if (!k) {
    k = hkdf(nmk, LABELS.frame + camDev, 36).then(async (okm) => ({ key: await aesKey(okm.slice(0, 32)), salt: okm.slice(32, 36) }));
    byCam.set(camDev, k);
    const cam = byCam;
    k.catch(() => cam.delete(camDev)); // a failed derivation isn't remembered
  }
  return k;
}

const frameNonce = (salt: Uint8Array, hdr: Uint8Array): Uint8Array => concat(salt, hdr.subarray(7, 15));
const frameAad = (hdr: Uint8Array, nid: string): Uint8Array => concat(hdr, utf8(nid));

/** Seal one part (a JPEG, an encoded frame or a sound chunk): header ‖ ciphertext ‖ tag. */
export async function sealFrame(nmk: Uint8Array, ctx: FrameCtx, hdr: FrameHeader, body: Uint8Array): Promise<Uint8Array> {
  const head = packFrameHeader(hdr);
  const { key, salt } = await frameKeys(nmk, ctx.camDev);
  return concat(head, await gcmSeal(key, frameNonce(salt, head), body, frameAad(head, ctx.nid)));
}

export type FrameOpen =
  | { ok: true; hdr: FrameHeader; body: Uint8Array }
  | { ok: false; reason: 'format' | 'epoch' | 'auth' | 'replay' | 'stale'; hdr?: FrameHeader };

/** The NMK for an epoch, or a lookup (current and, for 60 s after a rotation, the previous one). */
export type NmkSource = Uint8Array | ((e: number) => Uint8Array | null | undefined);

/**
 * Open a sealed part. With `replay`, frames whose seq isn't higher than the last one seen on
 * that stream, or that are more than 10 s older than the camera's freshest, are dropped.
 */
export async function openFrame(nmk: NmkSource, ctx: FrameCtx, sealed: Uint8Array, replay?: FrameReplay, now = Date.now()): Promise<FrameOpen> {
  const hdr = readFrameHeader(sealed);
  if (!hdr) return { ok: false, reason: 'format' };
  const key = typeof nmk === 'function' ? nmk(hdr.e) : nmk;
  if (!key) return { ok: false, reason: 'epoch', hdr };
  if (replay && !replay.fresh(hdr)) return { ok: false, reason: 'replay', hdr };
  const head = sealed.subarray(0, FRAME_HEADER_BYTES);
  const { key: k, salt } = await frameKeys(key, ctx.camDev);
  const body = await gcmOpen(k, frameNonce(salt, head), sealed.slice(FRAME_HEADER_BYTES), frameAad(head.slice(), ctx.nid));
  if (!body) return { ok: false, reason: 'auth', hdr };
  if (replay && !replay.accept(hdr, now)) return { ok: false, reason: 'stale', hdr };
  return { ok: true, hdr, body };
}

/**
 * A camera's frame sequence: one counter across its streams, seeded from the clock in
 * microseconds so it keeps rising across restarts (a repeated seq under the same key would
 * repeat a nonce). Up to 1,000 parts per millisecond before it runs ahead of the clock.
 */
export class FrameCounter {
  private last: number;
  private readonly clock: () => number;

  constructor(last = 0, clock: () => number = () => Date.now()) {
    this.last = Math.max(0, Math.floor(last));
    this.clock = clock;
  }

  next(): number {
    this.last = Math.max(this.last + 1, Math.floor(this.clock()) * 1000);
    return this.last;
  }
}

/**
 * A viewer's replay and age window for one camera. Ages are measured against the camera's
 * own clock — the smallest delay seen recently stands for "live" — so a camera phone whose
 * clock is minutes off still works, while frames held back by more than 10 s are dropped.
 * The baseline renews every minute, so a camera clock that jumps settles within two minutes.
 * Reset it when the camera reconnects or the epoch changes.
 */
export class FrameReplay {
  private readonly last = new Map<string, number>();
  private minCur = Infinity;
  private minPrev = Infinity;
  private windowStart = -Infinity;
  private readonly maxAgeMs: number;

  constructor(maxAgeMs = FRAME_MAX_AGE_MS) {
    this.maxAgeMs = maxAgeMs;
  }

  private key(h: FrameHeader): string {
    return `${h.e}:${h.cam}`;
  }

  /** The seq is new on its stream (checked before decrypting, so replays cost nothing). */
  fresh(h: FrameHeader): boolean {
    const last = this.last.get(this.key(h));
    return last === undefined || h.seq > last;
  }

  /** After authentication: record it, unless it is stale. */
  accept(h: FrameHeader, now: number): boolean {
    if (now - this.windowStart >= 60_000) {
      this.minPrev = this.minCur;
      this.minCur = Infinity;
      this.windowStart = now;
    }
    const delay = now - h.ts;
    this.minCur = Math.min(this.minCur, delay);
    const base = Math.min(this.minCur, this.minPrev);
    if (delay - base > this.maxAgeMs) return false;
    this.last.set(this.key(h), h.seq);
    return true;
  }

  reset(): void {
    this.last.clear();
    this.minCur = this.minPrev = Infinity;
    this.windowStart = -Infinity;
  }
}

/* -------------------------------------------------------- sealed signaling */

const sigKeyCache = new WeakMap<Uint8Array, Promise<Key>>();
function sigKey(nmk: Uint8Array): Promise<Key> {
  let k = sigKeyCache.get(nmk);
  if (!k) {
    k = hkdf(nmk, LABELS.sig, 32).then(aesKey);
    sigKeyCache.set(nmk, k);
    k.catch(() => sigKeyCache.delete(nmk));
  }
  return k;
}

export interface SignalCtx {
  nid: string;
  e: number;
  fromDev: string;
  toDev: string;
}

const signalAad = (nid: string, from: string, to: string): Uint8Array => utf8(`${nid}|${from}|${to}`);

/** The exact plaintext sealed for a signal (exported for the vectors). */
export const signalPlaintext = (d: unknown, from: string, to: string, ts: number): Uint8Array => utf8(JSON.stringify({ d, from, to, ts }));

/** Seal a signaling payload (an offer, answer, candidates, hello/bye — the whole `rtc.d`). */
export async function sealSignal(nmk: Uint8Array, ctx: SignalCtx, d: unknown, opts: { iv?: Uint8Array; now?: number } = {}): Promise<SealedRtc> {
  const iv = opts.iv ?? randomBytes(12);
  const ts = Math.floor(opts.now ?? Date.now());
  const ct = await gcmSeal(await sigKey(nmk), iv, signalPlaintext(d, ctx.fromDev, ctx.toDev, ts), signalAad(ctx.nid, ctx.fromDev, ctx.toDev));
  return { e: ctx.e, iv: b64url(iv), ct: b64url(ct), f: ctx.fromDev };
}

export type SignalOpen =
  | { ok: true; d: unknown; from: string; ts: number }
  | { ok: false; reason: 'format' | 'epoch' | 'auth' | 'mismatch' | 'stale' | 'replay' };

/** Signals are refused when their clock is this far from ours (either way). */
export const SIGNAL_MAX_SKEW_MS = 10 * 60_000;

/**
 * Open a sealed signal addressed to `toDev`. `fromDev`, when given, must be the sender.
 * `seen` (a set of ivs this session) refuses an exact replay within the time window.
 */
export async function openSignal(
  nmk: NmkSource,
  ctx: { nid: string; toDev: string; fromDev?: string },
  sealed: SealedRtc,
  opts: { now?: number; maxSkewMs?: number; seen?: Set<string> } = {},
): Promise<SignalOpen> {
  const iv = fromB64url(sealed?.iv);
  const ct = fromB64url(sealed?.ct);
  if (!iv || iv.length !== 12 || !ct || ct.length < 16 || typeof sealed.f !== 'string') return { ok: false, reason: 'format' };
  if (ctx.fromDev && sealed.f !== ctx.fromDev) return { ok: false, reason: 'mismatch' };
  const key = typeof nmk === 'function' ? nmk(sealed.e) : nmk;
  if (!key) return { ok: false, reason: 'epoch' };
  if (opts.seen?.has(sealed.iv)) return { ok: false, reason: 'replay' };
  const plain = await gcmOpen(await sigKey(key), iv, ct, signalAad(ctx.nid, sealed.f, ctx.toDev));
  if (!plain) return { ok: false, reason: 'auth' };
  let inner: { d?: unknown; from?: unknown; to?: unknown; ts?: unknown };
  try {
    inner = JSON.parse(fromUtf8(plain) ?? '');
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (inner?.from !== sealed.f || inner.to !== ctx.toDev) return { ok: false, reason: 'mismatch' };
  if (typeof inner.ts !== 'number' || Math.abs((opts.now ?? Date.now()) - inner.ts) > (opts.maxSkewMs ?? SIGNAL_MAX_SKEW_MS)) return { ok: false, reason: 'stale' };
  opts.seen?.add(sealed.iv);
  return { ok: true, d: inner.d, from: sealed.f, ts: inner.ts };
}

/* -------------------------------------------------------------- dev_hello */

/** What a device signs in `dev_hello`: the room's nonce, and the ECDH key it wants wraps for. */
export const helloSigInput = (nid: string, nonce: string, ts: number, ecdhPub: string): Uint8Array => utf8(`${LABELS.hello}|${nid}|${nonce}|${ts}|${ecdhPub}`);

export async function signHello(sigPrivate: Key, nid: string, nonce: string, ts: number, ecdhPub: string): Promise<string> {
  return b64url(ab(await subtle().sign(SIGN, sigPrivate, helloSigInput(nid, nonce, ts, ecdhPub))));
}

/**
 * Check a `dev_hello`: the devId is the hash of its signing key, and the signature covers
 * this room's nonce and the ECDH key. (The nonce makes it fresh; `maxSkewMs` optionally
 * also bounds `ts`, which is off by default so a phone with a wrong clock can still join.)
 */
export async function verifyHello(
  m: { devId: string; sigPub: string; ecdhPub: string; ts: number; sig: string },
  nid: string,
  nonce: string,
  opts: { now?: number; maxSkewMs?: number } = {},
): Promise<boolean> {
  try {
    if ((await deviceId(m.sigPub)) !== m.devId) return false;
    if (opts.maxSkewMs != null && Math.abs((opts.now ?? Date.now()) - m.ts) > opts.maxSkewMs) return false;
    checkPoint(asBytes(m.ecdhPub, 'ecdhPub'));
    const sig = fromB64url(m.sig);
    if (!sig || sig.length !== 64) return false;
    return await subtle().verify(SIGN, await importSigPublic(m.sigPub), sig, helloSigInput(nid, nonce, m.ts, m.ecdhPub));
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------- LAN */

/** The anonymous mDNS instance name (Phase 4): HMAC-SHA256(NMK, "lan")[0:8] as hex. */
export async function lanName(nmk: Uint8Array): Promise<string> {
  const k = await subtle().importKey('raw', nmk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(ab(await subtle().sign('HMAC', k, utf8(LABELS.lan))).subarray(0, 8));
}
