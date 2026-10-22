import { describe, expect, it } from 'vitest';
import { codecMask, isBareJpeg, KIND, nextSeq, pack, RELAY_HEADER, seqDiff, unpack } from './relayWire';

const bytes = (...n: number[]) => new Uint8Array(n);

describe('relay wire format', () => {
  it('round-trips a key video frame with sound', () => {
    const video = bytes(0, 0, 0, 1, 0x67, 9, 8, 7);
    const audio = bytes(0xff, 0x7f, 0x00, 0x80);
    const buf = pack({ kind: 'video', key: true, seq: 42, ts: 123456, codec: 'avc', body: video, audio });
    const u = new Uint8Array(buf);
    // The header, byte by byte.
    expect([...u.subarray(0, RELAY_HEADER)]).toEqual([KIND.videoAudio, 1, 0, 0, 0, 42, 0, 1, 0xe2, 0x40, 1]);
    expect([...u.subarray(RELAY_HEADER, RELAY_HEADER + 2)]).toEqual([0, 4]);
    const m = unpack(buf)!;
    expect(m).toMatchObject({ kind: 'video', key: true, seq: 42, ts: 123456, codec: 'avc' });
    expect([...m.audio!]).toEqual([...audio]);
    expect([...m.body!]).toEqual([...video]);
  });

  it('round-trips a delta frame without sound, JPEG and sound-only', () => {
    const d = unpack(pack({ kind: 'video', seq: 7, ts: 1, codec: 'vp8', body: bytes(1, 2, 3) }))!;
    expect(d).toMatchObject({ kind: 'video', key: false, codec: 'vp8', audio: null });
    expect(new Uint8Array(pack({ kind: 'video', seq: 7, ts: 1, codec: 'vp8', body: bytes(1) }))[0]).toBe(KIND.video);
    const j = unpack(pack({ kind: 'jpeg', seq: 8, ts: 2, body: bytes(9, 9), audio: bytes(1) }))!;
    // JPEG carries no sound and is always a key frame.
    expect(j).toMatchObject({ kind: 'jpeg', key: true, codec: null, audio: null });
    expect([...j.body!]).toEqual([9, 9]);
    const a = unpack(pack({ kind: 'audio', seq: 9, ts: 3, codec: 'vp9', audio: bytes(5, 6, 7) }))!;
    expect(a).toMatchObject({ kind: 'audio', key: false, codec: 'vp9', body: null });
    expect([...a.audio!]).toEqual([5, 6, 7]);
    expect(() => pack({ kind: 'audio', seq: 1, ts: 1 })).toThrow();
  });

  it('wraps the sequence number and timestamp at 2^32', () => {
    expect(nextSeq(0xffffffff)).toBe(0);
    expect(nextSeq(41)).toBe(42);
    const m = unpack(pack({ kind: 'video', seq: 0xffffffff + 3, ts: 2 ** 32 + 5, codec: 'vp8', body: bytes(1) }))!;
    expect(m.seq).toBe(2);
    expect(m.ts).toBe(5);
    // Ordering across the wrap: 1 comes after 0xfffffffe.
    expect(seqDiff(1, 0xfffffffe)).toBe(3);
    expect(seqDiff(0xfffffffe, 1)).toBe(-3);
    expect(seqDiff(100, 70)).toBe(30);
  });

  it('reads a bare JPEG from an older camera and rejects junk', () => {
    const legacy = unpack(bytes(0xff, 0xd8, 0xff, 0xe0, 1, 2))!;
    expect(legacy).toMatchObject({ kind: 'jpeg', legacy: true, key: true });
    expect(isBareJpeg(bytes(0xff, 0xd8, 0xff))).toBe(true);
    expect(isBareJpeg(bytes(KIND.jpeg, 0xd8, 0xff))).toBe(false);
    expect(unpack(bytes(1, 2, 3))).toBeNull(); // shorter than a header
    expect(unpack(new Uint8Array(RELAY_HEADER).fill(0))).toBeNull(); // kind 0
    const noCodec = new Uint8Array(pack({ kind: 'video', seq: 1, ts: 1, codec: 'vp8', body: bytes(1) }));
    noCodec[10] = 9;
    expect(unpack(noCodec)).toBeNull(); // video needs a known codec
    const cut = new Uint8Array(pack({ kind: 'video', seq: 1, ts: 1, codec: 'avc', body: bytes(1, 2), audio: bytes(1, 2, 3) }));
    expect(unpack(cut.subarray(0, RELAY_HEADER + 4))).toBeNull(); // sound length past the end
    expect(unpack(pack({ kind: 'jpeg', seq: 1, ts: 1, body: new Uint8Array(0) }))).toBeNull();
  });

  it('reads from a view into a bigger buffer', () => {
    const inner = new Uint8Array(pack({ kind: 'video', key: true, seq: 5, ts: 6, codec: 'avc', body: bytes(1, 2), audio: bytes(3) }));
    const outer = new Uint8Array(inner.length + 10);
    outer.set(inner, 5);
    expect(unpack(outer.subarray(5, 5 + inner.length))).toMatchObject({ seq: 5, ts: 6, key: true });
  });

  it('describes what a viewer decodes as a bit mask', () => {
    expect(codecMask([])).toBe(0);
    expect(codecMask(['avc'])).toBe(1);
    expect(codecMask(['avc', 'vp8', 'vp9'])).toBe(7);
    expect(codecMask(['vp9'])).toBe(4);
  });
});
