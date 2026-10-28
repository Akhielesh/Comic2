// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { b64url, fromB64url, hex } from './bytes';
import {
  deviceId,
  FRAME_OVERHEAD,
  FRAME_STREAM,
  FrameCounter,
  FrameReplay,
  generateDeviceKeys,
  importEcdhPrivate,
  importEcdhPublic,
  lanName,
  newNmk,
  openFrame,
  openSignal,
  packFrameHeader,
  readFrameHeader,
  sealFrame,
  sealSignal,
  setCryptoProvider,
  signalPlaintext,
  signHello,
  unwrapNmk,
  verifyHello,
  wrapNmk,
  type EcJwk,
  type FrameHeader,
} from './sealed';
import type { SealedRtc } from './wire';

/** Why an open failed (null when it didn't) — also for the app's non-strict typecheck, which can't narrow `ok`. */
const reasonOf = (r: { ok: boolean }): string | null => (r.ok ? null : ((r as { reason?: string }).reason ?? null));
const fx = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/sealed/${name}`, import.meta.url), 'utf8')) as T;

interface Device {
  sig: EcJwk;
  ecdh: EcJwk;
  sigPub: string;
  ecdhPub: string;
  devId: string;
}
const keys = fx<{ nid: string; nmk: Record<string, string>; devices: Record<'camera' | 'viewer' | 'watch', Device>; ephemeral: EcJwk[] }>('keys.json');
const nmk = (e: number) => fromB64url(keys.nmk[String(e)])!;
const { camera, viewer, watch } = keys.devices;

afterEach(() => setCryptoProvider(null));

describe('golden vectors (CryptoKit and Tink reproduce these byte for byte)', () => {
  it('devId is the hash of the signing key', async () => {
    const { cases } = fx<{ cases: { sigPub: string; devId: string }[] }>('devid.json');
    for (const c of cases) expect(await deviceId(c.sigPub)).toBe(c.devId);
  });

  it('NMK wraps: same bytes from the same ephemeral key and IV; opens only for its device and context', async () => {
    type WrapCase = { name: string; ctx: { nid: string; e: number; devId: string }; nmk: string; recipient: 'viewer' | 'watch'; recipientEcdhPub: string; ephemeral: EcJwk; iv: string; sharedSecretHex: string; blob: string };
    const { cases, reject } = fx<{ cases: WrapCase[]; reject: { name: string; blob: string; ctx: WrapCase['ctx']; recipient: 'viewer' | 'watch' }[] }>('wrap.json');
    for (const c of cases) {
      expect(await wrapNmk(fromB64url(c.nmk)!, c.recipientEcdhPub, c.ctx, { ephemeral: c.ephemeral, iv: fromB64url(c.iv)! }), c.name).toBe(c.blob);
      const priv = await importEcdhPrivate(keys.devices[c.recipient].ecdh);
      expect(b64url((await unwrapNmk(c.blob, priv, c.ctx))!)).toBe(c.nmk);
      // The shared secret is symmetric: the recipient derives what the wrapper did.
      const eph = await importEcdhPublic(fromB64url(c.blob)!.slice(1, 66));
      const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: eph as CryptoKey }, priv as CryptoKey, 256));
      expect(hex(shared)).toBe(c.sharedSecretHex);
    }
    for (const r of reject) expect(await unwrapNmk(r.blob, await importEcdhPrivate(keys.devices[r.recipient].ecdh), r.ctx), r.name).toBeNull();
  });

  it('relay frames: exact bytes, and every tampering refused', async () => {
    type FrameCase = { name: string; ctx: { nid: string; camDev: string }; nmkEpoch: number; hdr: FrameHeader; headerHex: string; nonceHex: string; body: string; sealed: string };
    const f = fx<{ saltHex: string; cases: FrameCase[]; reject: { name: string; sealed: string; ctx: FrameCase['ctx']; reason: string }[] }>('frame.json');
    for (const c of f.cases) {
      expect(hex(packFrameHeader(c.hdr))).toBe(c.headerHex);
      expect(c.nonceHex).toBe(f.saltHex + c.headerHex.slice(14, 30));
      const sealed = await sealFrame(nmk(c.nmkEpoch), c.ctx, c.hdr, fromB64url(c.body)!);
      expect(b64url(sealed), c.name).toBe(c.sealed);
      expect(sealed.length).toBe(fromB64url(c.body)!.length + FRAME_OVERHEAD);
      const open = await openFrame(nmk(c.nmkEpoch), c.ctx, sealed);
      expect(open.ok ? b64url((open as { body: Uint8Array }).body) : null).toBe(c.body);
    }
    for (const r of f.reject) {
      const open = await openFrame(nmk(1), r.ctx, fromB64url(r.sealed)!);
      expect(open.ok, r.name).toBe(false);
      expect(reasonOf(open), r.name).toBe(r.reason);
    }
  });

  it('sealed signaling: exact ciphertext from the exact plaintext; opens only for its addressee', async () => {
    type SigCase = { name: string; nid: string; e: number; fromDev: string; toDev: string; ts: number; d: unknown; plaintext: string; sealed: SealedRtc };
    const s = fx<{ cases: SigCase[]; reject: { name: string; sealed: SealedRtc; toDev: string; reason: string }[] }>('signal.json');
    for (const c of s.cases) {
      expect(new TextDecoder().decode(signalPlaintext(c.d, c.fromDev, c.toDev, c.ts))).toBe(c.plaintext);
      const sealed = await sealSignal(nmk(c.e), { nid: c.nid, e: c.e, fromDev: c.fromDev, toDev: c.toDev }, c.d, { iv: fromB64url(c.sealed.iv)!, now: c.ts });
      expect(sealed, c.name).toEqual(c.sealed);
      const open = await openSignal(nmk(c.e), { nid: c.nid, toDev: c.toDev, fromDev: c.fromDev }, c.sealed, { now: c.ts + 1_000 });
      expect(open).toEqual({ ok: true, d: c.d, from: c.fromDev, ts: c.ts });
    }
    for (const r of s.reject) {
      const open = await openSignal((e) => (keys.nmk[String(e)] ? nmk(e) : null), { nid: keys.nid, toDev: r.toDev }, r.sealed, { now: s.cases[0].ts });
      expect(reasonOf(open), r.name).toBe(r.reason);
    }
  });

  it('dev_hello signatures verify; a swapped ECDH key, another nonce or a borrowed devId do not', async () => {
    type HelloCase = { name: string; nid: string; nonce: string; devId: string; sigPub: string; ecdhPub: string; ts: number; sig: string };
    const h = fx<{ cases: HelloCase[]; reject: HelloCase[] }>('hello.json');
    for (const c of h.cases) expect(await verifyHello(c, c.nid, c.nonce)).toBe(true);
    for (const r of h.reject) expect(await verifyHello(r, r.nid, r.nonce), r.name).toBe(false);
  });

  it('the anonymous LAN name', async () => {
    const { cases } = fx<{ cases: { nmk: string; name: string }[] }>('lan.json');
    for (const c of cases) expect(await lanName(fromB64url(c.nmk)!)).toBe(c.name);
    expect(cases[0].name).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('device keys and wraps', () => {
  it('generates non-extractable keys with a 22-character devId', async () => {
    const d = await generateDeviceKeys();
    expect(d.devId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(d.devId).toBe(await deviceId(d.sigPub));
    expect(d.ecdhPub.length).toBe(65);
    await expect(crypto.subtle.exportKey('jwk', d.ecdh.privateKey as CryptoKey)).rejects.toThrow();
  });

  it('round-trips a fresh NMK to a fresh device; every wrap is different', async () => {
    const d = await generateDeviceKeys();
    const k = newNmk();
    const ctx = { nid: keys.nid, e: 7, devId: d.devId };
    const a = await wrapNmk(k, d.ecdhPub, ctx);
    const b = await wrapNmk(k, d.ecdhPub, ctx);
    expect(a).not.toBe(b);
    expect(await unwrapNmk(a, d.ecdh.privateKey, ctx)).toEqual(k);
    expect(await unwrapNmk(b, d.ecdh.privateKey, ctx)).toEqual(k);
    await expect(wrapNmk(new Uint8Array(16), d.ecdhPub, ctx)).rejects.toThrow(/32 bytes/);
    await expect(wrapNmk(k, 'B' + 'A'.repeat(10), ctx)).rejects.toThrow();
  });

  it('signs and verifies a hello for a fresh device, optionally bounding its clock', async () => {
    const d = await generateDeviceKeys();
    const ecdhPub = b64url(d.ecdhPub);
    const sig = await signHello(d.sig.privateKey, 'n1', 'nonce', 1_000, ecdhPub);
    const m = { devId: d.devId, sigPub: b64url(d.sigPub), ecdhPub, ts: 1_000, sig };
    expect(await verifyHello(m, 'n1', 'nonce')).toBe(true);
    expect(await verifyHello({ ...m, ts: 1_001 }, 'n1', 'nonce')).toBe(false);
    expect(await verifyHello(m, 'n1', 'nonce', { now: 1_000 + 6 * 60_000, maxSkewMs: 5 * 60_000 })).toBe(false);
    expect(await verifyHello({ ...m, sig: 'x' }, 'n1', 'nonce')).toBe(false);
  });
});

describe('relay frames in use', () => {
  const ctx = { nid: keys.nid, camDev: camera.devId };
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb, ...Array.from({ length: 2000 }, (_, i) => (i * 31) & 255), 0xff, 0xd9]);

  it('what the room forwards is not a JPEG and does not contain one (acceptance: no FF D8)', async () => {
    const counter = new FrameCounter(0, () => 1_000);
    for (let i = 0; i < 50; i++) {
      const sealed = await sealFrame(nmk(1), ctx, { e: 1, cam: FRAME_STREAM.picture, seq: counter.next(), ts: 1_000 + i, flags: 1 }, jpeg);
      expect(sealed[0]).toBe(1);
      expect(sealed[0] === 0xff && sealed[1] === 0xd8).toBe(false);
      expect(hex(sealed).includes(hex(jpeg.subarray(0, 64)))).toBe(false);
    }
  });

  it('drops replays and old frames, per stream, against the camera’s own clock', async () => {
    const replay = new FrameReplay();
    const skew = -5 * 60_000; // the camera's clock runs five minutes slow: still fine
    const seal = (seq: number, ts: number, cam: number = FRAME_STREAM.picture) => sealFrame(nmk(1), ctx, { e: 1, cam, seq, ts: ts + skew + 10 * 60_000, flags: 0 }, jpeg);
    const now = 10 * 60_000;
    const f1 = await seal(100, now);
    expect((await openFrame(nmk(1), ctx, f1, replay, now + 50)).ok).toBe(true);
    const again = await openFrame(nmk(1), ctx, f1, replay, now + 60);
    expect(reasonOf(again)).toBe('replay');
    // The sound stream keeps its own window (same counter, interleaved).
    expect((await openFrame(nmk(1), ctx, await seal(101, now + 10, FRAME_STREAM.sound), replay, now + 70)).ok).toBe(true);
    expect((await openFrame(nmk(1), ctx, await seal(102, now + 20), replay, now + 80)).ok).toBe(true);
    // Held back 12 s by someone in the middle: dropped.
    const late = await openFrame(nmk(1), ctx, await seal(103, now + 30), replay, now + 30 + 12_000);
    expect(reasonOf(late)).toBe('stale');
    // Delivered on time again: shown.
    expect((await openFrame(nmk(1), ctx, await seal(104, now + 13_000), replay, now + 13_050)).ok).toBe(true);
  });

  it('settles within two minutes when the camera clock jumps', async () => {
    const replay = new FrameReplay();
    let seq = 1;
    const at = async (now: number, camClock: number) => (await openFrame(nmk(1), ctx, await sealFrame(nmk(1), ctx, { e: 1, cam: 0, seq: seq++, ts: camClock, flags: 0 }, jpeg), replay, now)).ok;
    expect(await at(1_000_000, 1_000_000)).toBe(true);
    expect(await at(1_001_000, 1_001_000 - 30_000)).toBe(false); // clock stepped back 30 s
    let ok = false;
    for (let t = 1_002_000; t < 1_002_000 + 130_000 && !ok; t += 1_000) ok = await at(t, t - 30_000);
    expect(ok).toBe(true);
  });

  it('after a rotation a removed device holding the old epoch can’t open new frames', async () => {
    const e2 = await sealFrame(nmk(2), ctx, { e: 2, cam: 0, seq: 1, ts: 1, flags: 0 }, jpeg);
    const removed = (e: number) => (e === 1 ? nmk(1) : null);
    const r = await openFrame(removed, ctx, e2);
    expect(reasonOf(r)).toBe('epoch');
    // Relabelling the frame as epoch 1 doesn't help: the header is authenticated.
    const relabelled = e2.slice();
    relabelled[4] = 1;
    const r2 = await openFrame(removed, ctx, relabelled);
    expect(reasonOf(r2)).toBe('auth');
    // Remaining devices open both epochs during the 60 s overlap.
    const both = (e: number) => nmk(e);
    expect((await openFrame(both, ctx, e2)).ok).toBe(true);
  });

  it('headers: every field round-trips; nonsense is refused', () => {
    const h = { e: 0xffffffff, cam: 0xffff, seq: Number.MAX_SAFE_INTEGER, ts: 2 ** 48 - 1, flags: 255 };
    const packed = packFrameHeader(h);
    expect(packed.length).toBe(22);
    expect(readFrameHeader(new Uint8Array([...packed, ...new Uint8Array(16)]))).toEqual(h);
    expect(() => packFrameHeader({ ...h, seq: -1 })).toThrow();
    expect(() => packFrameHeader({ ...h, ts: 2 ** 48 })).toThrow();
    expect(readFrameHeader(new Uint8Array(37))).toBeNull();
  });

  it('the frame counter never repeats: within a run, across a restart, with a clock that steps back', () => {
    let clock = 5_000;
    const a = new FrameCounter(0, () => clock);
    const s1 = a.next();
    clock = 4_000; // stepped back
    const s2 = a.next();
    expect(s2).toBeGreaterThan(s1);
    clock = 6_000; // restart a second later: a fresh counter starts above the old one
    expect(new FrameCounter(0, () => clock).next()).toBeGreaterThan(s2);
    expect(s1).toBe(5_000_000);
  });
});

describe('sealed signaling in use', () => {
  const ctx = { nid: keys.nid, e: 1, fromDev: viewer.devId, toDev: camera.devId };
  const offer = { sdp: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\na=candidate:1 1 udp 1 192.168.1.20 5000 typ host\r\n' }, pc: 'p1' };

  it('what the room forwards has no SDP, candidates or addresses (acceptance)', async () => {
    const sealed = await sealSignal(nmk(1), ctx, offer);
    const wire = JSON.stringify({ t: 'rtc', to: 'sid', d: sealed });
    expect(wire).not.toMatch(/sdp|candidate|fingerprint|192\.168|offer/);
  });

  it('refuses replays, stale signals and the wrong sender', async () => {
    const now = 1_000_000;
    const sealed = await sealSignal(nmk(1), ctx, offer, { now });
    const seen = new Set<string>();
    expect((await openSignal(nmk(1), { nid: keys.nid, toDev: camera.devId }, sealed, { now, seen })).ok).toBe(true);
    const again = await openSignal(nmk(1), { nid: keys.nid, toDev: camera.devId }, sealed, { now, seen });
    expect(reasonOf(again)).toBe('replay');
    const stale = await openSignal(nmk(1), { nid: keys.nid, toDev: camera.devId }, sealed, { now: now + 11 * 60_000 });
    expect(reasonOf(stale)).toBe('stale');
    const wrongFrom = await openSignal(nmk(1), { nid: keys.nid, toDev: camera.devId, fromDev: watch.devId }, sealed, { now });
    expect(reasonOf(wrongFrom)).toBe('mismatch');
    const noKey = await openSignal(() => null, { nid: keys.nid, toDev: camera.devId }, sealed, { now });
    expect(reasonOf(noKey)).toBe('epoch');
    const junk = await openSignal(nmk(1), { nid: keys.nid, toDev: camera.devId }, { ...sealed, iv: 'zz' }, { now });
    expect(reasonOf(junk)).toBe('format');
  });
});

describe('crypto provider', () => {
  it('uses an injected WebCrypto (React Native polyfills) and falls back to the global one', async () => {
    let calls = 0;
    setCryptoProvider({
      subtle: new Proxy(crypto.subtle, {
        get(target, prop) {
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? (...args: unknown[]) => (calls++, v.apply(target, args)) : v;
        },
      }),
      getRandomValues: (a: Uint8Array) => crypto.getRandomValues(a),
    });
    await lanName(nmk(1));
    expect(calls).toBeGreaterThan(0);
    setCryptoProvider(null);
    const before = calls;
    await lanName(nmk(1));
    expect(calls).toBe(before);
  });

  it('says so plainly when there is no WebCrypto at all', async () => {
    setCryptoProvider({ subtle: null, getRandomValues: null });
    await expect(lanName(nmk(1))).rejects.toThrow('WebCrypto is not available');
  });
});
