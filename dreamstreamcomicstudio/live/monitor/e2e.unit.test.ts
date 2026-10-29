// @vitest-environment node
/**
 * End to end through our server (ADR 0006 D6.3, Phase 0 acceptance): device keys, the nursery
 * key's epochs and wraps, sealed signaling and sealed relay frames — with a stand-in room that
 * does what the contract says (it stores and forwards what it can't read), and the live Worker's
 * own relay header code, so the bytes the room sees are the bytes these tests check.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { audioOnly, readHead } from '../../live-worker/src/relayWire';
import { fromB64url } from '../../packages/monitor-core/src/bytes';
import { isSealedRtc, rtcPolicy, type KeyTarget } from '../../packages/monitor-core/src/wire';
import {
  ADOPT_WAIT_MS, E2ePeers, FRESH_START_MS, IdbKeyStore, keysGate, KEYS_GATE_MS, makeDevice, MemoryKeyStore, NurseryKeys, readDeviceId,
  type KeyRole, type KeyStore, type StoredDevice,
} from './keys';
import { holdCameraLock, openRelay, PartCounter, RELAY_SEALED, RelayOpener, RelaySealer, sealedFits, sealRelay, splitRelay } from './relayCrypto';
import { pack, unpack } from './relayWire';
import { FrameReplay } from '../../packages/monitor-core/src/sealed';

const NID = '7d0c2a8e-5b1f-4c3a-9e6d-1a2b3c4d5e6f';
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...new TextEncoder().encode('JFIF nursery picture'), 0xff, 0xd9]);
const hasSeq = (hay: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

/* -------------------------------------------------------- a stand-in room */

interface Member {
  keys: NurseryKeys;
  dev: StoredDevice;
  role: KeyRole;
  sent: Record<string, unknown>[];
  online: boolean;
}

/**
 * The contract (ADR WS-6 notes for WS-9): `hello` carries the epoch; `dev_hello` → the stored
 * wrap, or `key_req` to an online holder; `key_init` / `key_rotate` compare-and-set on the epoch,
 * then every device in it gets its `key_wrap` (the sender included) and anyone else online is
 * asked for with `key_req`; a lost race gets `key_conflict`.
 */
class Room {
  e = 0;
  wraps = new Map<string, string>(); // `${e}|${devId}` → blob
  roster = new Map<string, KeyTarget>();
  members = new Map<string, Member>();
  /** What crossed the room, as it saw it (for the "nothing readable" checks). */
  seen: string[] = [];

  async join(name: string, role: KeyRole, store: KeyStore = new MemoryKeyStore()): Promise<Member> {
    const dev = await store.device(() => makeDevice());
    const m: Member = {
      dev,
      role,
      sent: [],
      online: true,
      keys: undefined as unknown as NurseryKeys,
    };
    m.keys = new NurseryKeys({ nid: NID, device: dev, store, name, send: (msg) => void this.from(m, msg) });
    this.members.set(dev.devId, m);
    await m.keys.onHello({ caps: ['e2e1'], nonce: 'n-' + name, e: this.e }, role);
    await this.settle();
    return m;
  }

  private queue: Promise<void> = Promise.resolve();
  /** Until nothing more is in flight (a reply can queue another message). */
  async settle(): Promise<void> {
    let q: Promise<void>;
    do {
      q = this.queue;
      await q;
    } while (q !== this.queue);
  }

  private to(m: Member, msg: Record<string, unknown>): void {
    if (!m.online) return;
    this.seen.push(JSON.stringify(msg));
    this.queue = this.queue.then(() => m.keys.onMessage(msg as { t: string }).then(() => undefined));
  }

  private holder(e: number, not: string): Member | undefined {
    const all = [...this.members.values()].filter((x) => x.online && x.dev.devId !== not && this.wraps.has(`${e}|${x.dev.devId}`));
    return all.find((x) => x.role === 'camera') ?? all.find((x) => x.role === 'parent') ?? all[0];
  }

  private ask(target: KeyTarget): void {
    if (this.wraps.has(`${this.e}|${target.devId}`)) {
      const m = this.members.get(target.devId);
      if (m) this.to(m, { t: 'key_wrap', devId: target.devId, e: this.e, blob: this.wraps.get(`${this.e}|${target.devId}`) });
      return;
    }
    const h = this.e ? this.holder(this.e, target.devId) : undefined;
    if (h) this.to(h, { t: 'key_req', e: this.e, ...target });
  }

  private from(m: Member, msg: Record<string, unknown>): void {
    this.seen.push(JSON.stringify(msg));
    this.queue = this.queue.then(async () => {
      switch (msg.t) {
        case 'dev_hello': {
          const t = { devId: String(msg.devId), ecdhPub: String(msg.ecdhPub), name: String(msg.name) };
          this.roster.set(t.devId, t);
          if (this.e) this.ask(t);
          break;
        }
        case 'key_wrap': {
          const key = `${msg.e}|${msg.devId}`;
          this.wraps.set(key, String(msg.blob));
          const target = this.members.get(String(msg.devId));
          if (target && msg.e === this.e) this.to(target, msg);
          break;
        }
        case 'key_init':
        case 'key_rotate': {
          const e = Number(msg.e);
          if (msg.t === 'key_init' ? this.e !== 0 : e !== this.e + 1) {
            this.to(m, { t: 'key_conflict', e: this.e });
            break;
          }
          this.e = e;
          const got = new Set<string>();
          for (const w of msg.wraps as { devId: string; blob: string }[]) {
            this.wraps.set(`${e}|${w.devId}`, w.blob);
            got.add(w.devId);
            const target = this.members.get(w.devId);
            if (target) this.to(target, { t: 'key_wrap', devId: w.devId, e, blob: w.blob });
          }
          // Anyone else here (still in the roster) is wrapped by the new holder.
          for (const [id, t] of this.roster) if (!got.has(id) && this.members.get(id)?.online) this.to(m, { t: 'key_req', e, ...t });
          break;
        }
      }
    });
  }

  /** A member is removed: gone from the roster, and the camera makes the next epoch for the rest. */
  remove(devId: string): void {
    this.roster.delete(devId);
    const gone = this.members.get(devId);
    if (gone) gone.online = false;
    const h = this.holder(this.e, devId);
    if (h) this.to(h, { t: 'key_rotate', e: this.e + 1, devs: [...this.roster.values()].filter((t) => t.devId !== h.dev.devId) });
  }
}

/* ------------------------------------------------------------- the tests */

describe('device keys (web)', () => {
  it('signaling never waits on a storage that hangs: the keys if they come, nothing after a moment', async () => {
    vi.useFakeTimers();
    try {
      const k = { id: 1 };
      await expect(keysGate(Promise.resolve(k))).resolves.toBe(k);
      const hung = keysGate(new Promise<typeof k | null>(() => undefined));
      let got: unknown = 'pending';
      void hung.then((v) => (got = v));
      await vi.advanceTimersByTimeAsync(KEYS_GATE_MS - 1);
      expect(got).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(got).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('private keys are non-extractable; devId is the hash of the signing key', async () => {
    const d = await makeDevice();
    expect(d.devId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((d.sig as CryptoKey).extractable).toBe(false);
    expect((d.ecdh as CryptoKey).extractable).toBe(false);
    await expect(crypto.subtle.exportKey('jwk', d.ecdh as CryptoKey)).rejects.toThrow();
    expect(fromB64url(d.sigPub)).toHaveLength(65);
  });

  it('IndexedDB ds-keys: made once per browser — a second tab making them at the same moment gets the first one’s', async () => {
    const idb = fakeIdb();
    const a = new IdbKeyStore(idb);
    const b = new IdbKeyStore(idb);
    const [da, db] = await Promise.all([a.device(() => makeDevice()), b.device(() => makeDevice())]);
    expect(db.devId).toBe(da.devId);
    // Reloaded: the same keys (the CryptoKeys themselves are stored, still non-extractable).
    const again = await new IdbKeyStore(idb).device(() => makeDevice());
    expect(again.devId).toBe(da.devId);
    expect((again.ecdh as CryptoKey).extractable).toBe(false);
    // Push registration (WS-5) reads the id without ever making keys.
    expect(await readDeviceId(idb)).toBe(da.devId);
    expect(await readDeviceId(fakeIdb())).toBeNull();
    await a.putWrap({ nid: NID, e: 1, blob: 'x', at: 1 });
    await a.putWrap({ nid: NID, e: 2, blob: 'y', at: 2 });
    await a.putWrap({ nid: 'other', e: 1, blob: 'z', at: 3 });
    expect((await b.wraps(NID)).map((w) => w.e)).toEqual([1, 2]);
    await b.dropWraps(NID, 2);
    expect((await a.wraps(NID)).map((w) => w.blob)).toEqual(['y']);
  });
});

describe('the nursery key: first epoch, wraps and rotation', () => {
  beforeEach(() => vi.useRealTimers());

  it('the camera starts the first epoch; a parent’s phone gets it from the camera (the room only stores wraps)', async () => {
    const room = new Room();
    const cam = await room.join('cam', 'camera');
    expect(room.e).toBe(1);
    expect(cam.keys.holds()).toBe(true);
    const mom = await room.join('mom', 'parent');
    expect(mom.keys.epoch).toBe(1);
    // Both hold the same key, and the room never saw it: only wraps to each device.
    const k1 = cam.keys.sealing()!.nmk;
    expect(mom.keys.sealing()!.nmk).toEqual(k1);
    const hex = Buffer.from(k1).toString('hex');
    const b64 = Buffer.from(k1).toString('base64url');
    expect(room.seen.join('\n')).not.toContain(hex);
    expect(room.seen.join('\n')).not.toContain(b64);
    // dev_hello signs the room's nonce and the ECDH key.
    const hello = JSON.parse(room.seen.find((s) => s.includes('"dev_hello"'))!);
    expect(hello).toMatchObject({ t: 'dev_hello', devId: cam.dev.devId, platform: 'web' });
    expect(hello.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
  });

  it('two devices racing to start: one wins, the other is wrapped by it', async () => {
    const room = new Room();
    const store = new MemoryKeyStore();
    const dev = await store.device(() => makeDevice());
    const sent: Record<string, unknown>[] = [];
    const late = new NurseryKeys({ nid: NID, device: dev, store, name: 'late', send: (m) => sent.push(m) });
    const cam = await room.join('cam', 'camera');
    // The late parent also saw e: 0 and tried to start one; the room says epoch 1 exists.
    await late.onHello({ caps: ['e2e1'], nonce: 'n', e: 0 }, 'parent');
    expect(sent.map((m) => m.t)).toEqual(['dev_hello', 'key_init']);
    await late.onMessage({ t: 'key_conflict', e: 1 });
    expect(late.holds()).toBe(false);
    // The room then has the camera (a holder) wrap it for the late device.
    const camOut: Record<string, unknown>[] = [];
    const holder = new NurseryKeys({ nid: NID, device: cam.dev, store: new MemoryKeyStore(), name: 'c', send: (m) => camOut.push(m) });
    await holder.onMessage({ t: 'key_wrap', devId: cam.dev.devId, e: 1, blob: room.wraps.get(`1|${cam.dev.devId}`)! });
    await holder.onMessage({ t: 'key_req', e: 1, devId: dev.devId, ecdhPub: dev.ecdhPub });
    expect(camOut).toHaveLength(1);
    await late.onMessage(camOut[0] as { t: string });
    expect(late.sealing()!.nmk).toEqual(cam.keys.sealing()!.nmk);
    // A holder never wraps an epoch it doesn't have.
    await holder.onMessage({ t: 'key_req', e: 7, devId: dev.devId, ecdhPub: dev.ecdhPub });
    expect(camOut).toHaveLength(1);
  });

  it('removal rotates the key: the rest get epoch 2, the removed device can’t open what comes after (old epoch kept 60 s)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-28T22:00:00Z'));
    const room = new Room();
    const cam = await room.join('cam', 'camera');
    const mom = await room.join('mom', 'parent');
    const nan = await room.join('nan', 'viewer');
    const ctx = { nid: NID, camDev: cam.dev.devId };
    const counter = new PartCounter(0);
    const before = await sealRelay(new Uint8Array(pack({ kind: 'jpeg', seq: 1, ts: 1, body: JPEG })), cam.keys.sealing()!, ctx, counter);
    room.remove(nan.dev.devId);
    await room.settle();
    await vi.advanceTimersByTimeAsync(0);
    await room.settle();
    expect(room.e).toBe(2);
    expect(cam.keys.epoch).toBe(2);
    expect(mom.keys.epoch).toBe(2);
    expect(nan.keys.epoch).toBe(1);
    const after = await sealRelay(new Uint8Array(pack({ kind: 'jpeg', seq: 2, ts: 2, body: JPEG })), cam.keys.sealing()!, ctx, counter);
    // The removed nanny's device: nothing after the rotation opens.
    const nanOpen = await openRelay(after!, nan.keys.nmkFor, ctx, new FrameReplay());
    expect(nanOpen).toMatchObject({ ok: false, reason: 'epoch' });
    // Mom opens it; and the picture sealed just before still opens for 60 s, not after.
    expect((await openRelay(after!, mom.keys.nmkFor, ctx, new FrameReplay())).ok).toBe(true);
    expect((await openRelay(before!, mom.keys.nmkFor, ctx, new FrameReplay())).ok).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(await openRelay(before!, mom.keys.nmkFor, ctx, new FrameReplay())).toMatchObject({ ok: false, reason: 'epoch' });
    // Wraps for the nanny's device were never made at epoch 2.
    expect(room.wraps.has(`2|${nan.dev.devId}`)).toBe(false);
    vi.useRealTimers();
  });

  it('keys survive a reload (only the wrap is stored) and work before the room answers', async () => {
    const room = new Room();
    const store = new MemoryKeyStore();
    const cam = await room.join('cam', 'camera', store);
    const k = cam.keys.sealing()!;
    const again = new NurseryKeys({ nid: NID, device: cam.dev, store, name: 'cam', send: () => undefined });
    await again.load();
    expect(again.holds()).toBe(true);
    expect(again.sealing()).toEqual(k);
    expect((await store.wraps(NID)).map((w) => w.e)).toEqual([1]);
  });

  it('a room on a newer epoch: never seal with the old key — wait for the wrap; a camera that gets none starts afresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const store = new MemoryKeyStore();
    const dev = await store.device(() => makeDevice());
    const sent: Record<string, unknown>[] = [];
    const k = new NurseryKeys({ nid: NID, device: dev, store, name: 'cam', send: (m) => sent.push(m) });
    await k.onHello({ caps: ['e2e1'], nonce: 'n', e: 0 }, 'camera');
    await vi.advanceTimersByTimeAsync(ADOPT_WAIT_MS); // no echo, no refusal: accepted
    expect(k.epoch).toBe(1);
    sent.length = 0;
    // Back after a night offline: the room is on epoch 3, and nobody answers for us.
    await k.onHello({ caps: ['e2e1'], nonce: 'n2', e: 3 }, 'camera');
    expect(k.sealing()).toBeNull();
    expect(k.holds()).toBe(true); // still sticky
    await vi.advanceTimersByTimeAsync(FRESH_START_MS);
    await vi.waitFor(() => expect(sent.some((m) => m.t === 'key_rotate')).toBe(true));
    const rot = sent.find((m) => m.t === 'key_rotate') as { e: number; wraps: { devId: string }[] };
    expect(rot.e).toBe(4);
    expect(rot.wraps.map((w) => w.devId)).toEqual([dev.devId]);
    k.close();
    vi.useRealTimers();
  });

  it('a room whose storage was reset (epoch 0) starts over; a room without e2e1 leaves the keys dormant', async () => {
    const store = new MemoryKeyStore();
    const dev = await store.device(() => makeDevice());
    const sent: Record<string, unknown>[] = [];
    const k = new NurseryKeys({ nid: NID, device: dev, store, name: 'p', send: (m) => sent.push(m) });
    await k.onHello({ caps: ['view'], nonce: 'n' }, 'parent');
    expect(sent).toEqual([]);
    expect(k.active).toBe(false);
    await k.onHello({ caps: ['e2e1'], nonce: 'n', e: 0 }, 'viewer');
    // A viewer never starts the key.
    expect(sent.map((m) => m.t)).toEqual(['dev_hello']);
  });

  it('only a wrap for this device, that opens, is taken', async () => {
    const store = new MemoryKeyStore();
    const dev = await store.device(() => makeDevice());
    const k = new NurseryKeys({ nid: NID, device: dev, store, name: 'p', send: () => undefined });
    await k.onMessage({ t: 'key_wrap', devId: dev.devId, e: 1, blob: 'AQ' + 'A'.repeat(166) });
    await k.onMessage({ t: 'key_wrap', devId: 'someone-elses-device1', e: 1, blob: 'AAAA' });
    expect(k.holds()).toBe(false);
  });
});

describe('sealed signaling', () => {
  it('an offer and candidates go through the room unreadable, and open only for the camera they’re for', async () => {
    const room = new Room();
    const cam = await room.join('cam', 'camera');
    const mom = await room.join('mom', 'parent');
    const offer = { sdp: { type: 'offer' as const, sdp: 'v=0\r\no=- 1 2 IN IP4 192.168.1.20\r\na=fingerprint:sha-256 AB:CD\r\n' }, pc: 'p1', vid: 'v1', q: 'hd' as const };
    const sealed = await mom.keys.seal(cam.dev.devId, offer);
    expect(isSealedRtc(sealed)).toBe(true);
    const wire = JSON.stringify({ t: 'rtc', to: 'camsid', d: sealed });
    expect(wire).not.toMatch(/sdp|candidate|fingerprint|192\.168/);
    const opened = await cam.keys.open(sealed!);
    expect(opened).toEqual({ d: offer, from: mom.dev.devId });
    // A replay of the same sealed message is refused.
    expect(await cam.keys.open(sealed!)).toBeNull();
    // Candidates batch the same way.
    const ices = await cam.keys.seal(mom.dev.devId, { ices: [{ candidate: 'candidate:1 1 udp 2122260223 192.168.1.9 50000 typ host' }, null], pc: 'p1' });
    expect(JSON.stringify(ices)).not.toMatch(/candidate|192\.168/);
    expect((await mom.keys.open(ices!))!.d.ices).toHaveLength(2);
    // Addressed to the camera: the nanny's device can't open it even with the key.
    const nan = await room.join('nan', 'viewer');
    const forCam = await mom.keys.seal(cam.dev.devId, offer);
    expect(await nan.keys.open(forCam!)).toBeNull();
  });

  it('sticky: a device holding the key refuses unsealed signaling', () => {
    expect(rtcPolicy(true, { sdp: { type: 'offer', sdp: 'o' } })).toBe('refuse');
    expect(rtcPolicy(false, { sdp: { type: 'offer', sdp: 'o' } })).toBe('plain');
  });
});

describe('sealed relay frames', () => {
  let cam: Member;
  let mom: Member;
  let ctx: { nid: string; camDev: string };
  beforeEach(async () => {
    const room = new Room();
    cam = await room.join('cam', 'camera');
    mom = await room.join('mom', 'parent');
    ctx = { nid: NID, camDev: cam.dev.devId };
  });

  it('the room sees no JPEG (no FF D8 at any part, no picture bytes) — and still routes it', async () => {
    const plain = new Uint8Array(pack({ kind: 'jpeg', seq: 7, ts: 1000, body: JPEG }));
    const sealed = (await sealRelay(plain, cam.keys.sealing()!, ctx, new PartCounter(0)))!;
    expect(sealed[0]).toBe(1); // kind JPEG, in clear
    expect(sealed[1] & RELAY_SEALED).toBe(RELAY_SEALED);
    const parts = splitRelay(sealed)!;
    expect(parts.picture![0]).toBe(1); // frame v1, not FF D8
    expect(hasSeq(sealed, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
    expect(hasSeq(sealed, new TextEncoder().encode('JFIF'))).toBe(false);
    // The live Worker reads the header as before.
    expect(readHead(sealed.slice().buffer)).toMatchObject({ kind: 1, seq: 7, legacy: false });
    const r = await openRelay(sealed, mom.keys.nmkFor, ctx, new FrameReplay());
    expect(r.ok && unpack(r.plain)).toMatchObject({ kind: 'jpeg', seq: 7, body: JPEG });
  });

  it('video + sound: the room can still cut the sound out for a hidden viewer, and it opens', async () => {
    const sound = Uint8Array.from({ length: 320 }, (_, i) => (i * 7) & 0xff);
    const body = Uint8Array.from({ length: 900 }, (_, i) => (i * 13) & 0xff);
    const plain = new Uint8Array(pack({ kind: 'video', key: true, seq: 3, ts: 5, codec: 'avc', body, audio: sound }));
    const sealed = (await sealRelay(plain, cam.keys.sealing()!, ctx, new PartCounter(0)))!;
    expect(readHead(sealed.slice().buffer)).toMatchObject({ kind: 3, key: true, codec: 1 });
    const replay = new FrameReplay();
    const full = await openRelay(sealed, mom.keys.nmkFor, ctx, replay);
    expect(full.ok && unpack(full.plain)).toMatchObject({ kind: 'video', key: true, codec: 'avc', body, audio: sound });
    // The room's sound-only cut (it clears the flags): still sealed, still opens — as sound only.
    const cut = new Uint8Array(audioOnly(sealed.slice().buffer)!);
    expect(cut[1]).toBe(0);
    const r = await openRelay(cut, mom.keys.nmkFor, ctx, new FrameReplay());
    expect(r.ok && unpack(r.plain)).toMatchObject({ kind: 'audio', audio: sound });
    // A picture swapped into the sound's place never opens.
    const swapped = Uint8Array.from(cut);
    expect(await openRelay(swapped.fill(0, 11, 20), mom.keys.nmkFor, ctx, new FrameReplay())).toMatchObject({ ok: false });
  });

  it('replayed and stale frames are dropped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const counter = new PartCounter(0);
    const k = cam.keys.sealing()!;
    const seal = (seq: number) => sealRelay(new Uint8Array(pack({ kind: 'jpeg', seq, ts: seq, body: JPEG })), k, ctx, counter);
    const opener = new RelayOpener({ nid: NID, camDevId: () => cam.dev.devId, nmk: mom.keys.nmkFor });
    const m1 = (await seal(1))!;
    vi.advanceTimersByTime(40);
    const m2 = (await seal(2))!;
    expect(await opener.open(m1.slice().buffer)).not.toBeNull();
    expect(await opener.open(m2.slice().buffer)).not.toBeNull();
    // The same message again (the room replaying it): dropped.
    expect(await opener.open(m1.slice().buffer)).toBeNull();
    expect(opener.lastDrop).toBe('replay');
    // A frame the room held back 15 s: dropped as stale.
    vi.advanceTimersByTime(40);
    const held = (await seal(3))!;
    vi.advanceTimersByTime(15_000);
    const fresh = (await seal(4))!;
    expect(await opener.open(fresh.slice().buffer)).not.toBeNull();
    expect(await opener.open(held.slice().buffer)).toBeNull();
    expect(opener.lastDrop).toMatch(/replay|stale/);
    expect(opener.endToEnd()).toBe(true);
    vi.useRealTimers();
  });

  it('a camera that seals is never taken unsealed (no noise, no picture the server made); a camera that doesn’t, as always', async () => {
    const plainSound = pack({ kind: 'audio', seq: 1, ts: 1, audio: Uint8Array.from([1, 2, 3, 4]) });
    const sealing = new RelayOpener({ nid: NID, camDevId: () => cam.dev.devId, nmk: mom.keys.nmkFor });
    expect(await sealing.open(plainSound)).toBeNull();
    expect(await sealing.open(pack({ kind: 'jpeg', seq: 1, ts: 1, body: JPEG }))).toBeNull();
    expect(await sealing.open(JPEG.slice().buffer)).toBeNull(); // a bare JPEG
    const legacy = new RelayOpener({ nid: NID, camDevId: () => null, nmk: mom.keys.nmkFor });
    expect(new Uint8Array((await legacy.open(plainSound))!)).toEqual(new Uint8Array(plainSound));
    // Flagged sealed but from a camera we don't know seals: never played.
    const flagged = new Uint8Array(plainSound);
    flagged[1] |= RELAY_SEALED;
    expect(await legacy.open(flagged.buffer)).toBeNull();
  });

  it('without the key (a device not yet given one, or removed): sealed frames are dropped, never decoded as plain', async () => {
    const stranger = new RelayOpener({ nid: NID, camDevId: () => cam.dev.devId, nmk: () => null });
    const sealed = (await sealRelay(new Uint8Array(pack({ kind: 'audio', seq: 1, ts: 1, audio: Uint8Array.from([9, 9, 9]) })), cam.keys.sealing()!, ctx, new PartCounter(0)))!;
    expect(await stranger.open(sealed.slice().buffer)).toBeNull();
    expect(stranger.lastDrop).toBe('epoch');
  });
});

describe('RelaySealer: relay.ts’s send, sealed', () => {
  const plainJpeg = () => pack({ kind: 'jpeg', seq: 1, ts: 1, body: JPEG });

  it('seals in order and keeps the synchronous contract and its back-pressure', async () => {
    const room = new Room();
    const cam = await room.join('cam', 'camera');
    const out: Uint8Array[] = [];
    let buffered = 0;
    const s = new RelaySealer({ nid: NID, devId: () => cam.dev.devId, key: () => cam.keys.sealing(), required: () => true, send: (b) => (out.push(new Uint8Array(b)), true), buffered: () => buffered });
    expect(s.mode).toBe('sealed');
    for (let i = 1; i <= 5; i++) expect(s.send(pack({ kind: 'jpeg', seq: i, ts: i, body: JPEG }), 64 * 1024)).toBe(true);
    await s.flush();
    expect(out.map((u) => readHead(u.slice().buffer)!.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(out.every((u) => (u[1] & RELAY_SEALED) !== 0 && !hasSeq(u, Uint8Array.from([0xff, 0xd8, 0xff])))).toBe(true);
    buffered = 64 * 1024;
    expect(s.send(plainJpeg(), 64 * 1024)).toBe(false);
  });

  it('a camera that seals but has no key yet sends nothing; one that doesn’t seal sends as before', async () => {
    const sent: ArrayBuffer[] = [];
    const none = new RelaySealer({ nid: NID, devId: () => 'Pc-8NnpwUqWczWkTBOEIP5', key: () => null, required: () => true, send: (b) => (sent.push(b), true), buffered: () => 0 });
    expect(none.mode).toBeNull();
    expect(none.send(plainJpeg(), 1e6)).toBe(false);
    expect(sent).toEqual([]);
    const plain = new RelaySealer({ nid: NID, devId: () => null, key: () => null, required: () => false, send: (b) => (sent.push(b), true), buffered: () => 0 });
    expect(plain.send(plainJpeg(), 1e6)).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('too big for the room once sealed: not sent (the encoder starts over on a key frame); a socket that refuses later: onLost', async () => {
    const room = new Room();
    const cam = await room.join('cam', 'camera');
    let lost = 0;
    const s = new RelaySealer({ nid: NID, devId: () => cam.dev.devId, key: () => cam.keys.sealing(), required: () => true, send: () => false, buffered: () => 0, onLost: () => lost++ });
    const big = new Uint8Array(128 * 1024 - 10);
    expect(sealedFits(new Uint8Array(pack({ kind: 'video', key: true, seq: 1, ts: 1, codec: 'avc', body: big })))!.fits).toBe(false);
    expect(s.send(pack({ kind: 'video', key: true, seq: 1, ts: 1, codec: 'avc', body: big }), 1e9)).toBe(false);
    expect(s.send(plainJpeg(), 1e9)).toBe(true);
    await s.flush();
    expect(lost).toBe(1);
  });

  it('part numbers never repeat within a run, even many in one millisecond', () => {
    const c = new PartCounter(5, () => 1000);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(c.next());
    expect(seen.size).toBe(2000);
    expect(new PartCounter(5, () => 1000).next()).toBe(1_000_005);
  });

  it('one camera per nursery per browser (Web Locks); without Web Locks, never blocked', async () => {
    const held = new Set<string>();
    const locks = {
      request: (name: unknown, _o: unknown, cb: unknown) => {
        const n = String(name);
        if (held.has(n)) return Promise.resolve((cb as (l: unknown) => unknown)(null));
        held.add(n);
        return Promise.resolve((cb as (l: unknown) => Promise<unknown>)({ name: n })).finally(() => held.delete(n));
      },
    };
    const first = await holdCameraLock(NID, locks);
    expect(first).toBeTypeOf('function');
    expect(await holdCameraLock(NID, locks)).toBeNull();
    first!();
    await Promise.resolve();
    await Promise.resolve();
    expect(await holdCameraLock(NID, locks)).toBeTypeOf('function');
    expect(await holdCameraLock(NID, undefined)).toBeTypeOf('function');
  });
});

describe('E2ePeers: which cameras seal, remembered', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('a camera that sealed once is held to it, even if a later room stops saying so', () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const p = new E2ePeers(NID, storage);
    expect(p.devIdOf('camdev1')).toBeNull();
    expect(p.devIdOf('camdev1', 'Pc-8NnpwUqWczWkTBOEIP5')).toBe('Pc-8NnpwUqWczWkTBOEIP5');
    const later = new E2ePeers(NID, storage);
    expect(later.seals('camdev1')).toBe(true);
    expect(later.devIdOf('camdev1', undefined)).toBe('Pc-8NnpwUqWczWkTBOEIP5');
    expect(later.seals('old-camera')).toBe(false);
    expect(new E2ePeers('other', storage).seals('camdev1')).toBe(false);
  });
});

/* --------------------------------------------- a tiny IndexedDB stand-in */

/** Just what keys.ts uses: open/upgrade, get/getAll/add/put/delete, one transaction at a time. */
function fakeIdb(): IDBFactory {
  const stores = new Map<string, Map<string, unknown>>();
  let created = false;
  const request = <T>(fn: () => T): IDBRequest<T> => {
    const r = { onsuccess: null as null | (() => void), onerror: null as null | (() => void), result: undefined as T | undefined, error: null as unknown };
    queueMicrotask(() => {
      try {
        r.result = fn();
        r.onsuccess?.();
      } catch (e) {
        r.error = e;
        r.onerror?.();
      }
    });
    return r as unknown as IDBRequest<T>;
  };
  const db = {
    objectStoreNames: { contains: (n: string) => stores.has(n) },
    createObjectStore: (n: string) => stores.set(n, new Map()),
    transaction: (n: string) => ({
      objectStore: () => {
        const s = stores.get(n)!;
        return {
          get: (k: string) => request(() => structuredClone(s.get(k))),
          getAll: () => request(() => [...s.values()].map((v) => structuredClone(v))),
          add: (v: unknown, k: string) =>
            request(() => {
              if (s.has(k)) throw new Error('ConstraintError');
              s.set(k, v);
              return k;
            }),
          put: (v: unknown, k: string) => request(() => (s.set(k, v), k)),
          delete: (k: string) => request(() => void s.delete(k)),
        };
      },
    }),
  };
  return {
    open: () => {
      const r = { onsuccess: null as null | (() => void), onerror: null, onupgradeneeded: null as null | (() => void), onblocked: null, result: db };
      queueMicrotask(() => {
        if (!created) {
          created = true;
          r.onupgradeneeded?.();
        }
        r.onsuccess?.();
      });
      return r;
    },
  } as unknown as IDBFactory;
}
