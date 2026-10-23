/**
 * The relay picture's wire format: one binary WebSocket message per video
 * frame (with the sound captured since the last one), JPEG frame or sound
 * chunk, camera → room → viewers. Pure, so every byte is tested
 * (relayWire.unit.test.ts); the room reads the same header with its own copy
 * (live-worker/src/relayWire.ts — the worker compiles separately).
 *
 *   offset 0  u8   kind    1 = JPEG, 2 = video, 3 = video + sound, 4 = sound only
 *          1  u8   flags   bit 0 = key frame (a viewer can start decoding here)
 *          2  u32  seq     per camera, +1 per message, wraps at 2^32
 *          6  u32  ts      the camera's clock, ms (wraps every ~49 days)
 *         10  u8   codec   0 = none (JPEG / sound only), 1 = H.264, 2 = VP8, 3 = VP9
 *         11  …    payload
 *
 *   kind 1: the JPEG · kind 2: the encoded frame ·
 *   kind 3: u16 sound length, the sound, then the encoded frame · kind 4: the sound.
 *   Sound is G.711 μ-law, 8 kHz mono (one byte a sample).
 *
 * Big-endian throughout. Older cameras send a bare JPEG (it starts FF D8, never
 * a valid kind), which every viewer still shows.
 */

export const RELAY_HEADER = 11;

export const KIND = { jpeg: 1, video: 2, videoAudio: 3, audio: 4 } as const;
export type RelayKindId = (typeof KIND)[keyof typeof KIND];

export type RelayCodec = 'avc' | 'vp8' | 'vp9';
export const CODEC_ID: Record<RelayCodec, number> = { avc: 1, vp8: 2, vp9: 3 };
const CODEC_BY_ID: Record<number, RelayCodec> = { 1: 'avc', 2: 'vp8', 3: 'vp9' };
export const RELAY_CODECS: readonly RelayCodec[] = ['avc', 'vp8', 'vp9'];

/** Largest messages the room forwards (it drops anything bigger). */
export const MAX_VIDEO_BYTES = 128 * 1024;
export const MAX_JPEG_BYTES = 256 * 1024;
export const MAX_AUDIO_BYTES = 16 * 1024;

export interface RelayFrame {
  kind: 'jpeg' | 'video' | 'audio';
  key: boolean;
  seq: number;
  /** Camera clock, ms (u32). */
  ts: number;
  codec: RelayCodec | null;
  /** The JPEG (kind jpeg) or the encoded video frame (kind video). */
  body: Uint8Array | null;
  /** μ-law 8 kHz sound that rides along (null when there is none). */
  audio: Uint8Array | null;
  /** A bare JPEG from an older camera (no header). */
  legacy?: boolean;
}

export interface PackInput {
  kind: 'jpeg' | 'video' | 'audio';
  key?: boolean;
  seq: number;
  ts: number;
  codec?: RelayCodec | null;
  body?: Uint8Array | null;
  audio?: Uint8Array | null;
}

/** u32 helpers: the next sequence number, and how far `a` is ahead of `b` (negative = behind). */
export const nextSeq = (s: number): number => (s + 1) >>> 0;
export const seqDiff = (a: number, b: number): number => ((a - b) | 0);
export const u32 = (n: number): number => Math.floor(n) >>> 0;

/** A bare JPEG (SOI marker) — what cameras before this format send. */
export const isBareJpeg = (b: Uint8Array): boolean => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

export function pack(m: PackInput): ArrayBuffer {
  const audio = m.kind === 'jpeg' ? null : m.audio && m.audio.length ? m.audio : null;
  const body = m.kind === 'audio' ? null : m.body ?? new Uint8Array(0);
  if (m.kind === 'audio' && !audio) throw new Error('sound-only message without sound');
  if (audio && audio.length > 0xffff) throw new Error('sound chunk too long');
  const kind = m.kind === 'jpeg' ? KIND.jpeg : m.kind === 'audio' ? KIND.audio : audio ? KIND.videoAudio : KIND.video;
  const audioField = kind === KIND.videoAudio ? 2 + audio!.length : kind === KIND.audio ? audio!.length : 0;
  const out = new Uint8Array(RELAY_HEADER + audioField + (body?.length ?? 0));
  const dv = new DataView(out.buffer);
  dv.setUint8(0, kind);
  dv.setUint8(1, m.key || m.kind === 'jpeg' ? 1 : 0);
  dv.setUint32(2, u32(m.seq));
  dv.setUint32(6, u32(m.ts));
  dv.setUint8(10, m.kind === 'jpeg' || !m.codec ? 0 : CODEC_ID[m.codec]);
  let at = RELAY_HEADER;
  if (kind === KIND.videoAudio) {
    dv.setUint16(at, audio!.length);
    at += 2;
  }
  if (audio) {
    out.set(audio, at);
    at += audio.length;
  }
  if (body && kind !== KIND.audio) out.set(body, at);
  return out.buffer;
}

/** Parse one relay message; null when it isn't one (or is cut short). */
export function unpack(buf: ArrayBuffer | Uint8Array): RelayFrame | null {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (isBareJpeg(u)) return { kind: 'jpeg', key: true, seq: 0, ts: 0, codec: null, body: u, audio: null, legacy: true };
  if (u.length < RELAY_HEADER) return null;
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  const kind = dv.getUint8(0);
  const key = (dv.getUint8(1) & 1) === 1;
  const seq = dv.getUint32(2);
  const ts = dv.getUint32(6);
  const codecId = dv.getUint8(10);
  const codec = CODEC_BY_ID[codecId] ?? null;
  const rest = u.subarray(RELAY_HEADER);
  switch (kind) {
    case KIND.jpeg:
      return rest.length ? { kind: 'jpeg', key: true, seq, ts, codec: null, body: rest, audio: null } : null;
    case KIND.video:
      return codec && rest.length ? { kind: 'video', key, seq, ts, codec, body: rest, audio: null } : null;
    case KIND.videoAudio: {
      if (!codec || rest.length < 2) return null;
      const n = dv.getUint16(RELAY_HEADER);
      if (rest.length < 2 + n + 1) return null;
      return { kind: 'video', key, seq, ts, codec, audio: n ? rest.subarray(2, 2 + n) : null, body: rest.subarray(2 + n) };
    }
    case KIND.audio:
      return rest.length ? { kind: 'audio', key: false, seq, ts, codec, body: null, audio: rest } : null;
    default:
      return null;
  }
}

/** WebCodecs strings. H.264 constrained baseline in Annex B, so every key frame carries SPS/PPS. */
export const CODEC_STRING: Record<RelayCodec, string> = { avc: 'avc1.42E01E', vp8: 'vp8', vp9: 'vp09.00.10.08' };

/** What a viewer can decode, as the room stores it (bit per codec; 0 = JPEG only). */
export const codecMask = (codecs: readonly RelayCodec[]): number => codecs.reduce((m, c) => m | (1 << (CODEC_ID[c] - 1)), 0);
