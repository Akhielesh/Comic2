/**
 * The relay picture's message header, as the room reads it (mirror of
 * live/monitor/relayWire.ts — the client compiles separately; relayWire.test.ts
 * checks both read the same bytes). The room never decodes a picture: it reads
 * the 11-byte header to route, throttle and resync, and passes the bytes on.
 *
 *   u8 kind (1 JPEG · 2 video · 3 video + sound · 4 sound only) · u8 flags (bit 0 key)
 *   · u32 seq · u32 ts (ms) · u8 codec (0 none · 1 H.264 · 2 VP8 · 3 VP9) · payload
 *   kind 3 payload: u16 sound length, sound, video.
 *
 * A bare JPEG (FF D8 FF…) is what cameras before this format send.
 */

export const RELAY_HEADER = 11;
export const KIND_JPEG = 1;
export const KIND_VIDEO = 2;
export const KIND_VIDEO_AUDIO = 3;
export const KIND_AUDIO = 4;

/** Per-kind size caps (bytes, whole message). */
export const MAX_VIDEO = 128 * 1024;
export const MAX_JPEG = 256 * 1024;
export const MAX_AUDIO = 16 * 1024;

export interface RelayHead {
  kind: 1 | 2 | 3 | 4;
  key: boolean;
  seq: number;
  /** 0 none, 1 H.264, 2 VP8, 3 VP9. */
  codec: number;
  /** A bare JPEG from an older camera (no header). */
  legacy: boolean;
}

export const isBareJpeg = (u: Uint8Array): boolean => u.length >= 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff;

/** The header, validated against the per-kind size caps; null = drop the message. */
export function readHead(buf: ArrayBuffer): RelayHead | null {
  const u = new Uint8Array(buf);
  if (isBareJpeg(u)) return u.length <= MAX_JPEG ? { kind: KIND_JPEG, key: true, seq: 0, codec: 0, legacy: true } : null;
  if (u.length <= RELAY_HEADER) return null;
  const dv = new DataView(buf);
  const kind = dv.getUint8(0);
  const key = (dv.getUint8(1) & 1) === 1;
  const seq = dv.getUint32(2);
  const codec = dv.getUint8(10);
  if (codec > 3) return null;
  if (kind === KIND_JPEG) return u.length <= MAX_JPEG + RELAY_HEADER ? { kind, key: true, seq, codec: 0, legacy: false } : null;
  if (kind === KIND_VIDEO || kind === KIND_VIDEO_AUDIO) {
    if (!codec) return null;
    let video = u.length - RELAY_HEADER;
    if (kind === KIND_VIDEO_AUDIO) {
      const n = u.length >= RELAY_HEADER + 2 ? dv.getUint16(RELAY_HEADER) : -1;
      if (n < 0 || n > MAX_AUDIO || RELAY_HEADER + 2 + n >= u.length) return null;
      video -= 2 + n;
    }
    return video <= MAX_VIDEO ? { kind, key, seq, codec, legacy: false } : null;
  }
  if (kind === KIND_AUDIO) return u.length <= MAX_AUDIO + RELAY_HEADER ? { kind, key: false, seq, codec, legacy: false } : null;
  return null;
}

/** The sound out of a video + sound message, as a sound-only one (same seq, ts, codec); null when it has none. */
export function audioOnly(buf: ArrayBuffer): ArrayBuffer | null {
  const u = new Uint8Array(buf);
  if (u.length < RELAY_HEADER + 2 || u[0] !== KIND_VIDEO_AUDIO) return null;
  const n = new DataView(buf).getUint16(RELAY_HEADER);
  if (!n || RELAY_HEADER + 2 + n > u.length) return null;
  const out = new Uint8Array(RELAY_HEADER + n);
  out.set(u.subarray(0, RELAY_HEADER));
  out[0] = KIND_AUDIO;
  out[1] = 0;
  out.set(u.subarray(RELAY_HEADER + 2, RELAY_HEADER + 2 + n), RELAY_HEADER);
  return out.buffer;
}

/** A JPEG for viewers from before this format: the bare image, no header. */
export function bareJpeg(buf: ArrayBuffer): ArrayBuffer {
  const u = new Uint8Array(buf);
  return u[0] === KIND_JPEG ? buf.slice(RELAY_HEADER) : buf;
}

/** How far u32 sequence number `a` is ahead of `b` (negative = behind), across the wrap. */
export const seqDiff = (a: number, b: number): number => (a - b) | 0;
