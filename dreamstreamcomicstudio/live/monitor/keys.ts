/**
 * This browser's device keys and the nursery keys it holds (ADR 0006 D6.3, Phase 0).
 *
 * Device keys: one ECDSA and one ECDH P-256 pair per browser profile, made with WebCrypto as
 * NON-EXTRACTABLE keys and kept in IndexedDB `ds-keys` (store `device`, key `self`: the
 * CryptoKey objects themselves, which script can use but never read out). `devId` =
 * base64url(SHA-256(sigPub))[0:22]. WS-5's push registration reads `devId` from the same record
 * (`readDeviceId`).
 *
 * Nursery Media Key (NMK): 32 random bytes per epoch, made on a parent's or the camera's device
 * and handed to every admitted device as a WRAP (sealed.ts `wrapNmk`: ECDH to that device's key).
 * The room stores wraps it can't open; this browser stores only its own wraps (store `nmk`) and
 * holds the opened keys in memory. Losing them all is harmless: nothing is recorded, a parent's
 * or the camera's device starts a new epoch.
 *
 * Distribution (rooms that list `e2e1`; trust on first use until Phase 1's verified roster):
 *  - after `hello` this device sends `dev_hello` (its public keys, signed over the room's nonce);
 *  - the room answers with this device's stored wrap (`key_wrap`), or asks an online key holder
 *    to wrap one (`key_req` → `key_wrap`) — any device that holds the epoch answers;
 *  - no epoch yet (`hello.e === 0`): a parent's device or the camera sends `key_init`;
 *  - someone was removed: the room asks a holder to `key_rotate` to the devices that remain; the
 *    old epoch still opens for EPOCH_OVERLAP_MS (60 s), then it is forgotten;
 *  - a camera that holds nothing current and gets no wrap within FRESH_START_MS starts a new
 *    epoch itself — by design harmless: the room has the new holder wrap it to everyone else.
 *
 * Sticky end to end: once this device holds a nursery key it refuses unsealed signaling from
 * peers that seal (rtc.ts), and never plays an unsealed relay picture from a camera that seals
 * (relayCrypto.ts) — a server that strips capabilities can't downgrade either. Which cameras
 * seal is remembered per nursery (`E2E_PEERS_KEY`).
 */
import { b64url } from '../../packages/monitor-core/src/bytes';
import {
  generateDeviceKeys, newNmk, openSignal, sealSignal, signHello, unwrapNmk, wrapNmk, type Key,
} from '../../packages/monitor-core/src/sealed';
import { EPOCH_OVERLAP_MS, hasCap, parseKeyWrap, type KeyTarget, type SealedRtc } from '../../packages/monitor-core/src/wire';
import type { MonRtc } from './protocol';

/* ------------------------------------------------------------------ store */

export const KEYS_DB = 'ds-keys';
const DB_VERSION = 1;
const DEVICE_STORE = 'device';
const NMK_STORE = 'nmk';
const SELF = 'self';

/** This device's keys as stored: private keys are non-extractable CryptoKeys. */
export interface StoredDevice {
  devId: string;
  /** Public points, base64url (65 bytes). */
  sigPub: string;
  ecdhPub: string;
  sig: Key;
  ecdh: Key;
  created: number;
}

/** This device's own wrap of one nursery epoch (opened only with its ECDH key). */
export interface StoredWrap {
  nid: string;
  e: number;
  blob: string;
  at: number;
}

export interface KeyStore {
  /** The device keys, made with `make` the first time (another tab making them at the same moment wins). */
  device(make: () => Promise<StoredDevice>): Promise<StoredDevice>;
  wraps(nid: string): Promise<StoredWrap[]>;
  putWrap(w: StoredWrap): Promise<void>;
  /** Forget this nursery's wraps below epoch `below` (all of them with Infinity). */
  dropWraps(nid: string, below: number): Promise<void>;
  /** Kept only for this page (no IndexedDB): a reload makes a new device. */
  readonly ephemeral: boolean;
}

/** Keys for this page only (IndexedDB unavailable, and tests). */
export class MemoryKeyStore implements KeyStore {
  readonly ephemeral = true;
  private dev: Promise<StoredDevice> | null = null;
  private w = new Map<string, StoredWrap>();

  device(make: () => Promise<StoredDevice>): Promise<StoredDevice> {
    if (!this.dev) {
      this.dev = make();
      this.dev.catch(() => (this.dev = null));
    }
    return this.dev;
  }

  async wraps(nid: string): Promise<StoredWrap[]> {
    return [...this.w.values()].filter((x) => x.nid === nid).sort((a, b) => a.e - b.e);
  }

  async putWrap(x: StoredWrap): Promise<void> {
    this.w.set(`${x.nid}|${x.e}`, { ...x });
  }

  async dropWraps(nid: string, below: number): Promise<void> {
    for (const [k, x] of this.w) if (x.nid === nid && x.e < below) this.w.delete(k);
  }
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** The browser's IndexedDB (`ds-keys`): device keys survive reloads; wraps are useless without them. */
export class IdbKeyStore implements KeyStore {
  readonly ephemeral = false;
  private db: Promise<IDBDatabase> | null = null;
  private dev: Promise<StoredDevice> | null = null;

  constructor(private idb: IDBFactory) {}

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        const r = this.idb.open(KEYS_DB, DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(DEVICE_STORE)) db.createObjectStore(DEVICE_STORE);
          if (!db.objectStoreNames.contains(NMK_STORE)) db.createObjectStore(NMK_STORE);
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('ds-keys: blocked'));
      });
      this.db.catch(() => (this.db = null));
    }
    return this.db;
  }

  private async tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return req(fn(db.transaction(store, mode).objectStore(store)));
  }

  device(make: () => Promise<StoredDevice>): Promise<StoredDevice> {
    if (!this.dev) {
      this.dev = (async () => {
        const have = await this.tx<StoredDevice | undefined>(DEVICE_STORE, 'readonly', (s) => s.get(SELF));
        if (have?.devId && have.sig && have.ecdh) return have;
        // Keys can't be made inside an IndexedDB transaction (it would commit while we wait):
        // make them, then add — if another tab added first, its keys win.
        const made = await make();
        try {
          await this.tx(DEVICE_STORE, 'readwrite', (s) => s.add(made, SELF));
          return made;
        } catch {
          const won = await this.tx<StoredDevice | undefined>(DEVICE_STORE, 'readonly', (s) => s.get(SELF));
          if (won?.devId) return won;
          throw new Error('ds-keys: could not store the device keys');
        }
      })();
      this.dev.catch(() => (this.dev = null));
    }
    return this.dev;
  }

  async wraps(nid: string): Promise<StoredWrap[]> {
    const all = await this.tx<StoredWrap[]>(NMK_STORE, 'readonly', (s) => s.getAll() as IDBRequest<StoredWrap[]>);
    return all.filter((x) => x?.nid === nid).sort((a, b) => a.e - b.e);
  }

  async putWrap(x: StoredWrap): Promise<void> {
    await this.tx(NMK_STORE, 'readwrite', (s) => s.put({ ...x }, `${x.nid}|${x.e}`));
  }

  async dropWraps(nid: string, below: number): Promise<void> {
    for (const x of await this.wraps(nid)) {
      if (x.e < below) await this.tx(NMK_STORE, 'readwrite', (s) => s.delete(`${x.nid}|${x.e}`));
    }
  }
}

let shared: KeyStore | null = null;

/** The store this browser uses: IndexedDB when it works, otherwise keys for this page only. */
export function keyStore(): KeyStore {
  if (shared) return shared;
  let idb: IDBFactory | undefined;
  try {
    idb = typeof indexedDB !== 'undefined' ? indexedDB : undefined;
  } catch { /* blocked (some private modes) */ }
  shared = idb ? new FallbackKeyStore(new IdbKeyStore(idb)) : new MemoryKeyStore();
  return shared;
}

/** For tests: use this store (null: back to the browser's). */
export function setKeyStore(s: KeyStore | null): void {
  shared = s;
  device = null;
}

/** IndexedDB, falling back to page-only keys the moment it fails (a private window, a full disk). */
class FallbackKeyStore implements KeyStore {
  private mem: MemoryKeyStore | null = null;
  constructor(private idb: IdbKeyStore) {}
  get ephemeral(): boolean {
    return !!this.mem;
  }
  private async run<T>(f: (s: KeyStore) => Promise<T>): Promise<T> {
    if (this.mem) return f(this.mem);
    try {
      return await f(this.idb);
    } catch {
      this.mem = new MemoryKeyStore();
      return f(this.mem);
    }
  }
  device(make: () => Promise<StoredDevice>) {
    return this.run((s) => s.device(make));
  }
  wraps(nid: string) {
    return this.run((s) => s.wraps(nid));
  }
  putWrap(w: StoredWrap) {
    return this.run((s) => s.putWrap(w));
  }
  dropWraps(nid: string, below: number) {
    return this.run((s) => s.dropWraps(nid, below));
  }
}

/** Make a device's keys: non-extractable private keys, public points as base64url. */
export async function makeDevice(now = Date.now()): Promise<StoredDevice> {
  const k = await generateDeviceKeys(false);
  return { devId: k.devId, sigPub: b64url(k.sigPub), ecdhPub: b64url(k.ecdhPub), sig: k.sig.privateKey, ecdh: k.ecdh.privateKey, created: now };
}

let device: Promise<StoredDevice> | null = null;

/** This browser's device keys (made once; null when this browser has no WebCrypto). */
export function deviceKeys(): Promise<StoredDevice | null> {
  if (!device) {
    device = keyStore().device(() => makeDevice());
    device.catch(() => (device = null));
  }
  return device.catch(() => null);
}

/** Loading keys never holds up a call: signaling waits for them at most this long (a storage that hangs). */
export const KEYS_GATE_MS = 3000;

/** `ready`, or null once `ms` has passed without it — for what must not wait on storage forever. */
export function keysGate<T>(ready: Promise<T | null>, ms = KEYS_GATE_MS): Promise<T | null> {
  return Promise.race([ready, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** This device's id for push registration (WS-5), or null before it has keys. Never makes keys. */
export async function readDeviceId(idb: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined): Promise<string | null> {
  if (!idb) return null;
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = idb.open(KEYS_DB, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(DEVICE_STORE)) d.createObjectStore(DEVICE_STORE);
        if (!d.objectStoreNames.contains(NMK_STORE)) d.createObjectStore(NMK_STORE);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const rec = await req<StoredDevice | undefined>(db.transaction(DEVICE_STORE, 'readonly').objectStore(DEVICE_STORE).get(SELF));
    return rec?.devId ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- sticky peers */

export const E2E_PEERS_KEY = (nid: string) => `ds-e2e-cams-${nid}`;

/**
 * Cameras of a nursery that seal (their room `dev` → device key id), remembered on this device:
 * once a camera has sealed, its unsealed signaling and relay pictures are refused — even if a
 * later room stops saying it seals.
 */
export class E2ePeers {
  private map: Record<string, string>;
  constructor(private nid: string, private storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null) {
    let m: Record<string, string> = {};
    try {
      const raw = JSON.parse(this.storage?.getItem(E2E_PEERS_KEY(nid)) || '{}') as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string' && /^[A-Za-z0-9_-]{22}$/.test(v)) m[k] = v;
      }
    } catch {
      m = {};
    }
    this.map = m;
  }

  /** The camera's device key id: what the room says now, else what it said before. */
  devIdOf(dev: string | null | undefined, roomSays?: string | null): string | null {
    if (!dev) return roomSays ?? null;
    if (roomSays && /^[A-Za-z0-9_-]{22}$/.test(roomSays) && this.map[dev] !== roomSays) {
      this.map[dev] = roomSays;
      try {
        this.storage?.setItem(E2E_PEERS_KEY(this.nid), JSON.stringify(this.map));
      } catch { /* storage full */ }
    }
    return this.map[dev] ?? null;
  }

  /** This camera seals (it said so, now or before): never take an unsealed picture from it. */
  seals(dev: string | null | undefined): boolean {
    return !!dev && !!this.map[dev];
  }
}

/* --------------------------------------------------- the nursery's keys */

/** Who this socket is: a camera, or a viewer with its role (guests count as viewers). */
export type KeyRole = 'camera' | 'parent' | 'caregiver' | 'viewer';

/** A parent's device or the camera may start the nursery's first epoch. */
const MAY_INIT = new Set<KeyRole>(['camera', 'parent']);
/** A room that doesn't say its epoch: wait this long for a wrap before starting one. */
export const INIT_WAIT_MS = 4000;
/** A camera that holds nothing current starts a new epoch if no wrap comes within this. */
export const FRESH_START_MS = 10_000;
/** A key_init / key_rotate the room neither echoed nor refused counts as accepted after this. */
export const ADOPT_WAIT_MS = 3000;
/** Sealed signaling within this of our clock opens (relay frames measure the camera's clock instead). */
export const SIGNAL_SKEW_MS = 60 * 60_000;

export interface NurseryKeysOpts {
  nid: string;
  device: StoredDevice;
  store: KeyStore;
  /** To the room (JSON messages). */
  send: (m: Record<string, unknown>) => void;
  /** Shown to parents in the device list. */
  name: string;
  now?: () => number;
  /** A key arrived, an epoch became current, or one expired. */
  onChange?: () => void;
}

interface Held {
  nmk: Uint8Array;
  /** After a newer epoch became current: when this one stops opening anything. */
  until: number | null;
}

/** What a sealer needs: the current epoch's key. */
export interface SealKey {
  e: number;
  nmk: Uint8Array;
}

/**
 * One nursery's keys on this device for one screen (camera or viewer): handles the room's key
 * messages, holds the epochs, and seals / opens signaling. Dormant until a room lists `e2e1`,
 * except that keys already held keep sealing (sticky).
 */
export class NurseryKeys {
  readonly nid: string;
  readonly devId: string;
  private ring = new Map<number, Held>();
  private cur: number | null = null;
  /** The room's epoch, when it said (hello.e, key_conflict): never seal with an older one. */
  private roomE: number | null = null;
  private pending: { e: number; nmk: Uint8Array; timer: ReturnType<typeof setTimeout> | undefined } | null = null;
  private waitTimer: ReturnType<typeof setTimeout> | undefined;
  private role: KeyRole = 'viewer';
  private live = false;
  private loaded: Promise<void> | null = null;
  private seenIvs = new Set<string>();
  private readonly now: () => number;

  constructor(private o: NurseryKeysOpts) {
    this.nid = o.nid;
    this.devId = o.device.devId;
    this.now = o.now ?? (() => Date.now());
  }

  /** Open this device's stored wraps for the nursery (once): its keys work before the room answers — even with no room. */
  load(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        let list: StoredWrap[] = [];
        try {
          list = await this.o.store.wraps(this.nid);
        } catch { /* nothing stored */ }
        // The newest one that opens is current; older ones aren't needed (their overlap is long over).
        for (const w of list.sort((a, b) => b.e - a.e)) {
          const nmk = await unwrapNmk(w.blob, this.o.device.ecdh, { nid: this.nid, e: w.e, devId: this.devId });
          if (!nmk) continue;
          if (this.cur == null || w.e > this.cur) this.adoptNow(w.e, nmk);
          break;
        }
      })();
    }
    return this.loaded;
  }

  /** The room listed `e2e1` on this connection. */
  get active(): boolean {
    return this.live;
  }

  /** This device holds a key for the nursery (any epoch): unsealed signaling from sealing peers is refused. */
  holds(): boolean {
    return this.cur != null;
  }

  /** The epoch this device seals with now, if any. */
  get epoch(): number | null {
    return this.cur;
  }

  /**
   * The key to seal with: the current epoch — unless the room has said a newer one is current
   * (we were offline through a rotation: wait for our wrap rather than seal with a key the
   * others have dropped).
   */
  sealing(): SealKey | null {
    if (this.cur == null) return null;
    if (this.roomE != null && this.roomE > this.cur) return null;
    const h = this.ring.get(this.cur);
    return h ? { e: this.cur, nmk: h.nmk } : null;
  }

  /** The key for epoch `e` if it still opens (current, pending, or within 60 s of a newer one). */
  nmkFor = (e: number): Uint8Array | null => {
    if (this.pending?.e === e) return this.pending.nmk;
    const h = this.ring.get(e);
    if (!h) return null;
    if (h.until != null && this.now() >= h.until) {
      this.ring.delete(e);
      return null;
    }
    return h.nmk;
  };

  /**
   * A new room connection said hello. With `e2e1`: send `dev_hello`, then start the nursery's
   * first epoch (a parent or the camera, when the room has none) or wait for this device's wrap.
   */
  async onHello(h: { caps?: unknown; nonce?: unknown; e?: unknown }, role: KeyRole): Promise<void> {
    this.role = role;
    clearTimeout(this.waitTimer);
    this.live = Array.isArray(h.caps) && hasCap(h.caps as string[], 'e2e1') && typeof h.nonce === 'string' && !!h.nonce;
    if (!this.live) return;
    await this.load();
    const roomE = typeof h.e === 'number' && Number.isInteger(h.e) && h.e >= 0 ? h.e : null;
    if (roomE === 0 && this.cur != null) {
      // The room has no epoch (its storage was reset): what we hold is stale — start over.
      this.ring.clear();
      this.cur = null;
      void this.o.store.dropWraps(this.nid, Infinity).catch(() => undefined);
      this.o.onChange?.();
    }
    this.roomE = roomE;
    const ts = Math.floor(this.now());
    const sig = await signHello(this.o.device.sig, this.nid, h.nonce as string, ts, this.o.device.ecdhPub);
    this.o.send({ t: 'dev_hello', devId: this.devId, sigPub: this.o.device.sigPub, ecdhPub: this.o.device.ecdhPub, name: this.o.name, platform: 'web', ts, sig });
    const current = this.cur != null && (roomE == null || this.cur >= roomE);
    if (current) return;
    if (roomE === 0) {
      if (MAY_INIT.has(role)) await this.init();
      return;
    }
    if (roomE == null && MAY_INIT.has(role)) {
      // A room that doesn't say: start one if no wrap arrives (a conflict tells us one exists).
      this.waitTimer = setTimeout(() => void (this.cur == null && !this.pending ? this.init() : undefined), INIT_WAIT_MS);
      return;
    }
    if (roomE != null && role === 'camera') {
      // The camera must be able to seal: if no holder answers for us, start afresh.
      this.waitTimer = setTimeout(() => {
        if (this.sealing() || this.pending || this.roomE == null) return;
        void this.rotate(this.roomE + 1, []);
      }, FRESH_START_MS);
    }
  }

  /** The room's key messages; false when `m` isn't one. */
  async onMessage(m: { t: string } & Record<string, unknown>): Promise<boolean> {
    switch (m.t) {
      case 'key_wrap': {
        const w = parseKeyWrap(m);
        if (!w || w.devId !== this.devId) return true;
        const nmk = await unwrapNmk(w.blob, this.o.device.ecdh, { nid: this.nid, e: w.e, devId: this.devId });
        if (!nmk) return true;
        if (this.pending?.e === w.e) this.clearPending();
        await this.adopt(w.e, nmk, w.blob);
        return true;
      }
      case 'key_req': {
        const e = Number(m.e);
        const nmk = Number.isInteger(e) ? this.nmkFor(e) : null;
        if (!nmk || typeof m.devId !== 'string' || typeof m.ecdhPub !== 'string') return true;
        try {
          const blob = await wrapNmk(nmk, m.ecdhPub, { nid: this.nid, e, devId: m.devId });
          this.o.send({ t: 'key_wrap', devId: m.devId, e, blob });
        } catch { /* not a key we can wrap to */ }
        return true;
      }
      case 'key_rotate': {
        // The room asks this device to make the next epoch (`devs`); a holder's own rotation carries `wraps`.
        if (!Array.isArray(m.devs)) return true;
        const e = Number(m.e);
        if (!Number.isInteger(e) || e < 1) return true;
        await this.rotate(e, (m.devs as unknown[]).filter((d): d is KeyTarget => !!d && typeof (d as KeyTarget).devId === 'string' && typeof (d as KeyTarget).ecdhPub === 'string'));
        return true;
      }
      case 'key_conflict': {
        const e = Number(m.e);
        if (Number.isInteger(e) && e >= 0) this.roomE = e;
        this.clearPending();
        this.o.onChange?.();
        return true;
      }
      default:
        return false;
    }
  }

  /** Start the nursery's first epoch (compare-and-set at the room). */
  private async init(): Promise<void> {
    if (this.pending || this.cur != null) return;
    const nmk = newNmk();
    const blob = await wrapNmk(nmk, this.o.device.ecdhPub, { nid: this.nid, e: 1, devId: this.devId });
    this.setPending(1, nmk, blob);
    this.o.send({ t: 'key_init', e: 1, wraps: [{ devId: this.devId, blob }] });
  }

  /** Make epoch `e` for `devs` (and this device), and offer it to the room (compare-and-set). */
  private async rotate(e: number, devs: KeyTarget[]): Promise<void> {
    if (this.pending && this.pending.e >= e) return;
    if (this.cur != null && this.cur >= e) return;
    const nmk = newNmk();
    const wraps: { devId: string; blob: string }[] = [];
    let mine = '';
    const targets = [...devs.filter((d) => d.devId !== this.devId), { devId: this.devId, ecdhPub: this.o.device.ecdhPub }];
    for (const d of targets.slice(0, 64)) {
      try {
        const blob = await wrapNmk(nmk, d.ecdhPub, { nid: this.nid, e, devId: d.devId });
        wraps.push({ devId: d.devId, blob });
        if (d.devId === this.devId) mine = blob;
      } catch { /* a bad key: that device asks again */ }
    }
    if (!mine) return;
    this.setPending(e, nmk, mine);
    this.o.send({ t: 'key_rotate', e, wraps });
  }

  private setPending(e: number, nmk: Uint8Array, blob: string): void {
    this.clearPending();
    // Accepted when the room hands our own wrap back; a room that doesn't echo — no refusal in 3 s.
    const timer = setTimeout(() => {
      if (this.pending?.e !== e) return;
      this.pending = null;
      void this.adopt(e, nmk, blob);
    }, ADOPT_WAIT_MS);
    this.pending = { e, nmk, timer };
    this.o.onChange?.();
  }

  private clearPending(): void {
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
  }

  private adoptNow(e: number, nmk: Uint8Array): boolean {
    const was = this.cur;
    if (was != null && e < was) {
      // An older epoch (a late wrap): it may still open frames during the overlap, never current.
      if (!this.ring.has(e)) this.ring.set(e, { nmk, until: this.now() + EPOCH_OVERLAP_MS });
      return false;
    }
    this.ring.set(e, { nmk, until: null });
    if (was != null && was !== e) {
      const old = this.ring.get(was);
      if (old) old.until = this.now() + EPOCH_OVERLAP_MS;
    }
    this.cur = e;
    if (this.roomE == null || this.roomE < e) this.roomE = e;
    // Anything past its overlap goes now.
    for (const [k, h] of this.ring) if (h.until != null && this.now() >= h.until) this.ring.delete(k);
    return true;
  }

  private async adopt(e: number, nmk: Uint8Array, blob: string): Promise<void> {
    const became = this.adoptNow(e, nmk);
    if (became) {
      try {
        await this.o.store.putWrap({ nid: this.nid, e, blob, at: this.now() });
        await this.o.store.dropWraps(this.nid, e);
      } catch { /* kept in memory for this page */ }
    }
    this.o.onChange?.();
  }

  /* ---------------------------------------------------- sealed signaling */

  /** Seal `d` for a peer's device (null: no current key — the caller decides what to do). */
  async seal(peerDevId: string, d: MonRtc): Promise<SealedRtc | null> {
    const k = this.sealing();
    if (!k) return null;
    return sealSignal(k.nmk, { nid: this.nid, e: k.e, fromDev: this.devId, toDev: peerDevId }, d, { now: this.now() });
  }

  /** Open sealed signaling addressed to this device (null: refuse it — wrong key, replay, tampered). */
  async open(sealed: SealedRtc): Promise<{ d: MonRtc; from: string } | null> {
    if (this.seenIvs.size > 4000) this.seenIvs.clear();
    const r = await openSignal(this.nmkFor, { nid: this.nid, toDev: this.devId }, sealed, { now: this.now(), maxSkewMs: SIGNAL_SKEW_MS, seen: this.seenIvs });
    if (!r.ok || !r.d || typeof r.d !== 'object') return null;
    return { d: r.d as MonRtc, from: r.from };
  }

  /** The screen closed. */
  close(): void {
    clearTimeout(this.waitTimer);
    this.clearPending();
  }
}
