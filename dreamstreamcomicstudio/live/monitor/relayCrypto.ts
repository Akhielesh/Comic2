/**
 * End-to-end relay pictures and sound (ADR 0006 D6.3, relay frame v1): when a viewer gets the
 * picture through our server, the server passes along bytes it can't read.
 *
 * The relay wire (relayWire.ts) keeps its 11-byte header in clear — kind, key flag, seq, ts,
 * codec — so the room can still route, resync, and send a hidden viewer the sound alone. Each
 * PART is sealed on its own with the nursery key (sealed.ts `sealFrame`, frame v1 = 22-byte
 * authenticated header ‖ AES-256-GCM):
 *
 *   kind 1 JPEG          header ‖ S(picture)
 *   kind 2 video         header ‖ S(picture)
 *   kind 3 video + sound header ‖ u16 |S(sound)| ‖ S(sound) ‖ S(picture)
 *   kind 4 sound         header ‖ S(sound)
 *
 * with flags bit 1 (`RELAY_SEALED`) set. `S(x)` starts 0x01 — never a JPEG's FF D8 — and the
 * room's sound-only cut (`audioOnly`) still works, since it only slices by the u16 length.
 * (That cut clears the flags, which is why a viewer goes by the camera, not the flag: a camera
 * that seals is never taken unsealed — `E2ePeers` in keys.ts.)
 *
 * Camera — `RelaySealer`: `send()` keeps relay.ts's synchronous contract (true = it will go,
 * false = it didn't: hold back until a key frame), seals in order off the encoder's path and
 * hands the sealed message to the socket. While the camera seals but has no current key, nothing
 * leaves for a moment; if the key still hasn't come after keys.ts KEY_FALLBACK_MS, the picture
 * and sound go as before end to end and the camera says so — a parent is never left with no
 * picture because of a key. Sequence numbers come from one counter per camera, seeded from the
 * clock plus a slot chosen per run, so a nonce never repeats under a key (and a second camera tab
 * on the same phone is held off by a Web Lock — `queueCameraLock`).
 *
 * Viewer — `RelayOpener`: opens each part in order (replayed or older-than-10-s frames are
 * dropped: sealed.ts `FrameReplay`), and hands relay.ts the plain message it has always decoded.
 * A camera that seals is taken plain only when it fell back: nothing sealed from it has opened
 * for RELAY_PLAIN_AFTER_MS (then the screen says it isn't end to end) — never mixed into a sealed
 * picture that works.
 */
import { FRAME_OVERHEAD, FRAME_STREAM, FrameReplay, openFrame, readFrameHeader, sealFrame, type NmkSource } from '../../packages/monitor-core/src/sealed';
import { isBareJpeg, KIND, MAX_AUDIO_BYTES, MAX_JPEG_BYTES, MAX_VIDEO_BYTES, RELAY_HEADER } from './relayWire';
import type { SealKey } from './keys';

/** Flags bit 1: this message's parts are sealed (relay frame v1). */
export const RELAY_SEALED = 0x02;

interface Parts {
  kind: number;
  head: Uint8Array;
  sound: Uint8Array | null;
  picture: Uint8Array | null;
}

/** A relay message's parts (no copy), or null when it isn't one. */
export function splitRelay(u: Uint8Array): Parts | null {
  if (u.length <= RELAY_HEADER || isBareJpeg(u)) return null;
  const kind = u[0];
  const head = u.subarray(0, RELAY_HEADER);
  const rest = u.subarray(RELAY_HEADER);
  switch (kind) {
    case KIND.jpeg:
    case KIND.video:
      return { kind, head, sound: null, picture: rest };
    case KIND.videoAudio: {
      if (rest.length < 2) return null;
      const n = (rest[0] << 8) | rest[1];
      if (rest.length < 2 + n + 1) return null;
      return { kind, head, sound: n ? rest.subarray(2, 2 + n) : null, picture: rest.subarray(2 + n) };
    }
    case KIND.audio:
      return { kind, head, sound: rest, picture: null };
    default:
      return null;
  }
}

/** Put parts back together as a relay message (the header copied, flags as given). */
export function joinRelay(head: Uint8Array, flags: number, kind: number, sound: Uint8Array | null, picture: Uint8Array | null): Uint8Array {
  const withSound = kind === KIND.videoAudio;
  const len = RELAY_HEADER + (withSound ? 2 + (sound?.length ?? 0) : kind === KIND.audio ? sound?.length ?? 0 : 0) + (kind === KIND.audio ? 0 : picture?.length ?? 0);
  const out = new Uint8Array(len);
  out.set(head.subarray(0, RELAY_HEADER));
  out[1] = flags & 0xff;
  let at = RELAY_HEADER;
  if (withSound) {
    const n = sound?.length ?? 0;
    if (n > 0xffff) throw new Error('relay: sound part too long');
    out[at] = n >> 8;
    out[at + 1] = n & 0xff;
    at += 2;
  }
  if (sound && (withSound || kind === KIND.audio)) {
    out.set(sound, at);
    at += sound.length;
  }
  if (picture && kind !== KIND.audio) out.set(picture, at);
  return out;
}

/** The size a message will have once sealed, and whether the room would still take it; null when it isn't a relay message. */
export function sealedFits(u: Uint8Array): { bytes: number; fits: boolean } | null {
  const p = splitRelay(u);
  if (!p) return null;
  const parts = (p.sound ? 1 : 0) + (p.picture ? 1 : 0);
  const bytes = u.length + parts * FRAME_OVERHEAD;
  const pic = p.picture ? p.picture.length + FRAME_OVERHEAD : 0;
  const snd = p.sound ? p.sound.length + FRAME_OVERHEAD : 0;
  const fits =
    p.kind === KIND.jpeg ? pic <= MAX_JPEG_BYTES :
    p.kind === KIND.audio ? snd <= MAX_AUDIO_BYTES :
    pic <= MAX_VIDEO_BYTES && snd <= Math.min(MAX_AUDIO_BYTES, 0xffff);
  return { bytes, fits };
}

/** Where the camera keeps its part counter's high-water mark (survives reloads). */
export interface SeqStore {
  load(): number;
  /** False: it couldn't be written. */
  save(n: number): boolean;
}

/** Part numbers reserved ahead per write: about a minute of the counter (it tracks the clock in µs). */
export const SEQ_BLOCK = 60_000_000;
/** Never above this (the frame header's seq must stay a safe integer). */
const MAX_SEQ = Number.MAX_SAFE_INTEGER - 2 ** 40;

/** The high-water mark in localStorage, per nursery (the frame key is per nursery key and camera device). */
export function relaySeqStore(nid: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage !== 'undefined' ? localStorage : null): SeqStore {
  const key = `ds-relay-seq-${nid}`;
  return {
    load: () => {
      try {
        const n = Number(storage?.getItem(key));
        return Number.isSafeInteger(n) && n > 0 && n < MAX_SEQ ? n : 0;
      } catch {
        return 0;
      }
    },
    save: (n) => {
      try {
        if (!storage) return false;
        storage.setItem(key, String(n));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * The camera's part counter: one across its streams, rising with the clock (µs) from a slot
 * picked per run. With a `store`, blocks of numbers are reserved ahead and written down before
 * any is used, and each run starts above the last reservation — so a reload never reuses a
 * number under the same key, even after the phone's clock steps back (`durable`). Without one
 * (or a storage that refuses writes), two runs could only collide if they picked the same slot
 * and walked the same clock — the camera lock keeps a second tab from sealing then.
 */
export class PartCounter {
  private last = 0;
  private hi = 0;
  /** The current reservation was written down (a reload can't reuse these numbers). */
  durable = false;
  constructor(
    private readonly slot = Math.floor(Math.random() * 1000),
    private readonly clock: () => number = () => Date.now(),
    private readonly store: SeqStore | null = null,
  ) {
    if (store) this.last = this.reserve(Math.floor(clock()) * 1000 + slot) - 1;
  }

  /** Reserve the block from `from` (or above the last reservation anyone wrote), written first. */
  private reserve(from: number): number {
    const base = Math.max(from, this.store!.load());
    this.hi = base + SEQ_BLOCK;
    this.durable = this.store!.save(this.hi);
    return base;
  }

  next(): number {
    let n = Math.max(this.last + 1, Math.floor(this.clock()) * 1000 + this.slot);
    if (this.store && n >= this.hi) n = this.reserve(n);
    this.last = n;
    return n;
  }
}

/** Seal a plain relay message's parts; null when it isn't one. */
export async function sealRelay(plain: Uint8Array, key: SealKey, ctx: { nid: string; camDev: string }, counter: PartCounter, now = Date.now()): Promise<Uint8Array | null> {
  const p = splitRelay(plain);
  if (!p) return null;
  const keyFrame = (p.head[1] & 1) === 1 || p.kind === KIND.jpeg;
  const ts = Math.max(0, Math.floor(now));
  const seal = (stream: number, body: Uint8Array, flags: number) => sealFrame(key.nmk, ctx, { e: key.e, cam: stream, seq: counter.next(), ts, flags }, body);
  const sound = p.sound ? await seal(FRAME_STREAM.sound, p.sound, 0) : null;
  const picture = p.picture ? await seal(FRAME_STREAM.picture, p.picture, keyFrame ? 1 : 0) : null;
  return joinRelay(p.head, p.head[1] | RELAY_SEALED, p.kind, sound, picture);
}

export type DropReason = 'format' | 'epoch' | 'auth' | 'replay' | 'stale' | 'plain';
export type RelayOpen = { ok: true; plain: Uint8Array; e: number } | { ok: false; reason: DropReason };

/**
 * Open a sealed relay message: every part must open under the camera's key, on the stream its
 * place says (a picture where the picture goes) — or the whole message is dropped.
 */
export async function openRelay(u: Uint8Array, nmk: NmkSource, ctx: { nid: string; camDev: string }, replay: FrameReplay, now = Date.now()): Promise<RelayOpen> {
  const p = splitRelay(u);
  if (!p) return { ok: false, reason: isBareJpeg(u) ? 'plain' : 'format' };
  let e = -1;
  let key = false;
  const open = async (part: Uint8Array, stream: number): Promise<Uint8Array | RelayOpen> => {
    const hdr = readFrameHeader(part);
    if (!hdr || hdr.cam !== stream) return { ok: false, reason: hdr ? 'auth' : (p.head[1] & RELAY_SEALED) ? 'format' : 'plain' };
    const r = await openFrame(nmk, ctx, part, replay, now);
    if (r.ok === false) return { ok: false, reason: r.reason };
    e = r.hdr.e;
    if (stream === FRAME_STREAM.picture) key = (r.hdr.flags & 1) === 1;
    return r.body;
  };
  let sound: Uint8Array | null = null;
  let picture: Uint8Array | null = null;
  if (p.sound) {
    const r = await open(p.sound, FRAME_STREAM.sound);
    if (!(r instanceof Uint8Array)) return r;
    sound = r;
  }
  if (p.picture) {
    const r = await open(p.picture, FRAME_STREAM.picture);
    if (!(r instanceof Uint8Array)) return r;
    picture = r;
  }
  // The key-frame flag the camera authenticated wins over the one in clear.
  const flags = (p.head[1] & ~(RELAY_SEALED | 1)) | (p.picture ? (key ? 1 : 0) : 0);
  return { ok: true, plain: joinRelay(p.head, flags, p.kind, sound, picture), e };
}

/* ----------------------------------------------------------- the camera */

export interface RelaySealerDeps {
  nid: string;
  /** This camera's device key id. */
  devId: () => string | null;
  /** The key to seal with now (keys.ts `sealing()`). */
  key: () => SealKey | null;
  /** This camera seals (the room lists `e2e1`, or it holds a nursery key): no key → nothing leaves … */
  required: () => boolean;
  /**
   * … unless it has been without a current key for keys.ts KEY_FALLBACK_MS: then the picture and
   * sound go as before end to end (and the camera says so) — never no picture because of a key.
   */
  fallback?: () => boolean;
  /** client.sendBinary. */
  send: (buf: ArrayBuffer, maxBuffered: number) => boolean;
  buffered: () => number;
  /** A message counted as sent couldn't go after all: the viewers need a key frame. */
  onLost?: () => void;
  now?: () => number;
  /** The part counter's high-water mark across reloads (`relaySeqStore`). */
  seqStore?: SeqStore;
}

/**
 * relay.ts's `send` for a camera that seals: same contract (synchronous true/false, with the
 * same back-pressure), sealing in order behind it.
 */
export class RelaySealer {
  private chain: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly counter: PartCounter;
  private readonly now: () => number;
  /** Sealed messages sent (for the camera's status line). */
  sealed = 0;
  /** Plain messages sent (a room or a camera that doesn't seal). */
  plain = 0;
  /** Of those, sent plain only because this camera seals but has no key (`fallback`). */
  fellBack = 0;

  constructor(private d: RelaySealerDeps) {
    this.now = d.now ?? (() => Date.now());
    this.counter = new PartCounter(undefined, this.now, d.seqStore ?? null);
  }

  /** Its part numbers are written down ahead: sealing stays nonce-safe across reloads and tabs. */
  get durable(): boolean {
    return this.counter.durable;
  }

  /**
   * What goes out now: sealed; plain (a room or camera that doesn't seal); `fallback` (it seals but
   * has had no key for a while: plain, said so); null (it seals and is getting the key — a moment).
   */
  get mode(): 'sealed' | 'plain' | 'fallback' | null {
    if (this.d.key() && this.d.devId()) return 'sealed';
    if (!this.d.required()) return 'plain';
    return this.d.fallback?.() ? 'fallback' : null;
  }

  send = (buf: ArrayBuffer, maxBuffered: number): boolean => {
    const key = this.d.key();
    const devId = this.d.devId();
    if (!key || !devId) {
      const fallback = this.d.required();
      if (fallback && !this.d.fallback?.()) return false;
      const ok = this.d.send(buf, maxBuffered);
      if (ok) {
        this.plain += 1;
        if (fallback) this.fellBack += 1;
      }
      return ok;
    }
    const u = new Uint8Array(buf);
    const fit = sealedFits(u);
    if (!fit || !fit.fits) return false;
    if (this.d.buffered() + this.queued >= maxBuffered) return false;
    this.queued += fit.bytes;
    const nid = this.d.nid;
    this.chain = this.chain
      .then(async () => {
        let out: Uint8Array | null = null;
        try {
          out = await sealRelay(u, key, { nid, camDev: devId }, this.counter, this.now());
        } catch {
          out = null;
        }
        this.queued -= fit.bytes;
        // Back-pressure was judged when it was accepted: send it now (dropping it would break the picture).
        if (out && this.d.send(out.buffer as ArrayBuffer, Number.MAX_SAFE_INTEGER)) this.sealed += 1;
        else this.d.onLost?.();
      })
      .catch(() => undefined);
    return true;
  };

  /** Wait for everything accepted so far to go (tests). */
  flush(): Promise<void> {
    return this.chain;
  }
}

type Locks = { request?: (...a: unknown[]) => Promise<unknown> };
const browserLocks = (): Locks | undefined => (typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: Locks }).locks : undefined);

/** This tab's claim to be the nursery's camera on this browser (`queueCameraLock`). */
export interface CameraLock {
  /** This tab is the camera (always, without Web Locks). */
  readonly held: boolean;
  /** Another tab of this browser is the camera right now: this one takes over the moment it goes. */
  readonly waiting: boolean;
  /** The camera stopped: let the next tab have it (and never take it later). */
  release(): void;
}

/**
 * The camera lock, held while the camera runs: taken at once when it's free, otherwise queued
 * behind the tab that holds it — yesterday's frozen camera tab, one left on its setup screen, the
 * installed app next to a browser tab — and taken over the moment that one goes. (A lock tried
 * once and forgotten would keep this tab from sealing for its whole life.) `onChange`: held or
 * waiting changed.
 */
export function queueCameraLock(nid: string, onChange: () => void, locks: Locks | undefined = browserLocks()): CameraLock {
  let held = false;
  let waiting = false;
  let released = false;
  let let_go: () => void = () => undefined;
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const handle: CameraLock = {
    get held() {
      return held;
    },
    get waiting() {
      return waiting;
    },
    release() {
      if (released) return;
      released = true;
      held = waiting = false;
      ac?.abort();
      let_go();
    },
  };
  if (!locks?.request) {
    held = true;
    return handle;
  }
  const name = `ds-camera-${nid}`;
  const take = (lock: unknown): Promise<void> | undefined => {
    if (!lock || released) return undefined;
    held = true;
    waiting = false;
    onChange();
    return new Promise<void>((r) => (let_go = r));
  };
  void locks
    .request(name, { ifAvailable: true }, (lock: unknown) => {
      if (lock) return take(lock);
      if (released) return undefined;
      // Another tab is the camera: wait our turn (no ifAvailable) — not give up.
      waiting = true;
      onChange();
      void locks.request!(name, ac ? { signal: ac.signal } : {}, take).catch(() => undefined);
      return undefined;
    })
    .catch(() => {
      // Web Locks that don't work: never blocked.
      if (released) return;
      held = true;
      waiting = false;
      onChange();
    });
  return handle;
}

/* ----------------------------------------------------------- the viewer */

/**
 * A camera that seals sends its picture plain only when it has no key (keys.ts `fallback`). A
 * viewer takes that plain picture once nothing sealed from the camera has opened for this long —
 * never mixed into a sealed picture that works (where a plain frame can only be the room's).
 */
export const RELAY_PLAIN_AFTER_MS = 6000;

/** A plain relay message: not flagged sealed, and no part of it is a sealed frame (the room's sound cut clears the flag). */
function plainRelay(u: Uint8Array): boolean {
  if (isBareJpeg(u)) return true;
  if (u.length > RELAY_HEADER && (u[1] & RELAY_SEALED) !== 0) return false;
  const p = splitRelay(u);
  if (!p) return false;
  return !(p.sound && readFrameHeader(p.sound)) && !(p.picture && readFrameHeader(p.picture));
}

export interface RelayOpenerDeps {
  nid: string;
  /** The camera's device key id when it seals (sticky: keys.ts `E2ePeers`); null for a camera that doesn't. */
  camDevId: () => string | null;
  /** This device's nursery keys by epoch (keys.ts `nmkFor`). */
  nmk: NmkSource;
  now?: () => number;
}

/**
 * The viewer's side: a camera that seals is only ever taken sealed (opened, or dropped — never
 * played as if it were plain); a camera that doesn't is taken as it always was.
 */
export class RelayOpener {
  private chain: Promise<unknown> = Promise.resolve();
  private replay = new FrameReplay();
  private replayFor: string | null = null;
  private readonly now: () => number;
  /** Messages opened end to end, and dropped (no key, replayed, stale, tampered or unsealed). */
  opened = 0;
  dropped = 0;
  /** When a sealed message last opened (the relay pill says end to end only while they do). */
  lastOpenAt: number | null = null;
  /** Why the last message was dropped (diagnostics). */
  lastDrop: DropReason | null = null;
  /** When a plain picture from a camera that seals was last taken (it fell back: said on screen). */
  lastPlainAt: number | null = null;
  /** When this camera's messages started arriving (the plain fallback waits from here too). */
  private since: number | null = null;

  constructor(private d: RelayOpenerDeps) {
    this.now = d.now ?? (() => Date.now());
  }

  /** A different camera, or it reconnected: a fresh replay window. */
  reset(): void {
    this.replay.reset();
    this.replayFor = null;
    this.lastOpenAt = null;
    this.lastPlainAt = null;
    this.since = null;
  }

  /** The picture through our server is end to end right now (a sealed message opened in the last 10 s). */
  endToEnd(now = this.now()): boolean {
    return this.lastOpenAt != null && now - this.lastOpenAt < 10_000;
  }

  /** A camera that seals is sending without its key right now (fell back): not end to end — say so. */
  fellBack(now = this.now()): boolean {
    return !this.endToEnd(now) && this.lastPlainAt != null && now - this.lastPlainAt < 10_000;
  }

  /** A binary message from the room → the plain relay message to decode, or null (dropped). In order. */
  open(data: Blob | ArrayBuffer): Promise<ArrayBuffer | null> {
    const run = this.chain.then(async () => {
      const ab = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
      return this.openNow(new Uint8Array(ab));
    });
    this.chain = run.catch(() => undefined);
    return run.catch(() => null);
  }

  private async openNow(u: Uint8Array): Promise<ArrayBuffer | null> {
    const cam = this.d.camDevId();
    const flagged = u.length > RELAY_HEADER && !isBareJpeg(u) && (u[1] & RELAY_SEALED) !== 0;
    if (!cam) {
      // A camera that doesn't seal: as always — but a sealed message we can't place is never played.
      if (flagged) return this.drop('format');
      return u.slice().buffer;
    }
    if (this.replayFor !== cam) {
      this.replay.reset();
      this.replayFor = cam;
      this.since = null;
    }
    const now = this.now();
    this.since ??= now;
    if (plainRelay(u)) {
      // It fell back (no key on the camera): taken once nothing sealed has opened for a while.
      const quietSince = this.lastOpenAt ?? this.since;
      if (now - quietSince < RELAY_PLAIN_AFTER_MS) return this.drop('plain');
      this.lastPlainAt = now;
      return u.slice().buffer;
    }
    const r = await openRelay(u, this.d.nmk, { nid: this.d.nid, camDev: cam }, this.replay, this.now());
    if (r.ok === false) return this.drop(r.reason);
    this.opened += 1;
    this.lastOpenAt = this.now();
    return r.plain.slice().buffer;
  }

  private drop(reason: DropReason): null {
    this.dropped += 1;
    this.lastDrop = reason;
    return null;
  }
}
