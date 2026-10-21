// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FRAME_H, FRAME_W, VisionWatch, zoneCells, type VisionEvent, type Zone } from './vision';

// Deterministic pseudo-random numbers so the scene is the same every run.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A textured nursery: gradients + furniture-like blocks, so the layout is distinctive. */
function scene(shift = 0): Float32Array {
  const l = new Float32Array(FRAME_W * FRAME_H);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const sx = x + shift;
      l[y * FRAME_W + x] = 90 + 40 * Math.sin(sx / 6) + 30 * Math.cos(y / 5) + ((sx >> 3) % 2 ? 25 : -25);
    }
  }
  return l;
}

type Blob = { x: number; y: number; w: number; h: number; v: number };

function frame(base: Float32Array, r: () => number, opts: { blobs?: Blob[]; gain?: number; noise?: number } = {}): Uint8ClampedArray {
  const out = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);
  const gain = opts.gain ?? 1;
  const noise = opts.noise ?? 3;
  for (let i = 0; i < base.length; i++) {
    let v = base[i] * gain;
    const x = i % FRAME_W;
    const y = (i / FRAME_W) | 0;
    for (const b of opts.blobs ?? []) if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) v = b.v;
    v += (r() - 0.5) * 2 * noise;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

const CRIB: Zone = { id: 'crib', kind: 'crib', name: 'Crib', x: 0.3, y: 0.3, w: 0.4, h: 0.5 };
const WINDOW: Zone = { id: 'win', kind: 'danger', name: 'the window', x: 0.8, y: 0.05, w: 0.18, h: 0.4 };

/** Run frames at 4 fps; `blobAt(t)` decides what moves. */
function play(w: VisionWatch, secs: number, t0: number, make: (t: number, i: number) => Uint8ClampedArray) {
  const events: (VisionEvent & { at: number })[] = [];
  const frames = [];
  let t = t0;
  for (let i = 0; i < secs * 4; i++, t += 250) {
    const r = w.push(make(t, i), t);
    frames.push(r.frame);
    for (const e of r.events) events.push({ ...e, at: t });
  }
  return { events, frames, t };
}

// A small wiggling blob (baby-sized) at a position in grid pixels.
const wiggle = (x: number, y: number, i: number): Blob => ({ x: x + (i % 2) * 3, y: y + ((i >> 1) % 2) * 2, w: 6, h: 5, v: i % 2 ? 230 : 20 });

describe('VisionWatch', () => {
  it('ignores sensor noise in a still room', () => {
    const w = new VisionWatch();
    const r = rng(1);
    const base = scene();
    const { events, frames } = play(w, 20, 0, () => frame(base, r, { noise: 6 }));
    expect(events).toEqual([]);
    expect(Math.max(...frames.slice(4).map((f) => f.motion))).toBeLessThan(6);
  });

  it('separates crib movement from the rest of the room', () => {
    const w = new VisionWatch();
    w.setZones([CRIB, WINDOW]);
    const r = rng(2);
    const base = scene();
    const { events, frames } = play(w, 6, 0, (_t, i) => frame(base, r, { blobs: [wiggle(28, 20, i)] }));
    const f = frames[frames.length - 1];
    expect(f.crib).toBeGreaterThan(20);
    expect(f.outside).toBeLessThan(5);
    expect(f.zones.win).toBe(0);
    expect(events).toEqual([]);
  });

  it('alerts once for movement in a danger zone, with a cooldown', () => {
    const w = new VisionWatch();
    w.setZones([CRIB, WINDOW]);
    const r = rng(3);
    const base = scene();
    const { events } = play(w, 10, 0, (_t, i) => frame(base, r, { blobs: [wiggle(54, 6, i)] }));
    expect(events.map((e) => e.type)).toEqual(['zone']);
    expect(events[0]).toMatchObject({ zone: 'win', name: 'the window' });
    expect(events[0].at).toBeLessThan(2500);
  });

  it('flags a climb-out: movement spilling from the crib to outside it', () => {
    const w = new VisionWatch();
    w.setZones([CRIB]);
    const r = rng(4);
    const base = scene();
    let { t } = play(w, 4, 0, (_t, i) => frame(base, r, { blobs: [wiggle(28, 20, i)] }));
    const out = play(w, 4, t, (_t, i) => frame(base, r, { blobs: [wiggle(4, 36, i)] }));
    expect(out.events.map((e) => e.type)).toEqual(['crib_out']);
    // Movement outside with no crib activity before it is just the room.
    const w2 = new VisionWatch();
    w2.setZones([CRIB]);
    t = play(w2, 20, 0, () => frame(base, r)).t;
    expect(play(w2, 4, t, (_t, i) => frame(base, r, { blobs: [wiggle(4, 36, i)] })).events).toEqual([]);
  });

  it('treats an adult walking in as a visit, not a danger-zone alert', () => {
    const w = new VisionWatch();
    w.setZones([CRIB, WINDOW]);
    const r = rng(5);
    const base = scene();
    // A big shape crossing the room (≈ a third of the picture) for 6 s.
    const person = (i: number): Blob => ({ x: 30 + (i % 3) * 6, y: 0, w: 22, h: 48, v: i % 2 ? 200 : 40 });
    let res = play(w, 6, 0, (_t, i) => frame(base, r, { blobs: [person(i)] }));
    expect(res.events.map((e) => e.type)).toEqual(['visit_start']);
    expect(w.inVisit).toBe(true);
    // Still in the visit: the window zone doesn't alert.
    res = play(w, 3, res.t, (_t, i) => frame(base, r, { blobs: [wiggle(54, 6, i)] }));
    expect(res.events).toEqual([]);
    // 50 s of stillness ends the visit with its length.
    res = play(w, 50, res.t, () => frame(base, r));
    expect(res.events.map((e) => e.type)).toEqual(['visit_end']);
    expect(res.events[0].secs).toBeGreaterThanOrEqual(5); // the adult was in view ~6 s
  });

  it('notices lights on and off without calling it movement', () => {
    const w = new VisionWatch();
    w.setZones([CRIB, WINDOW]);
    const r = rng(6);
    const base = scene();
    let res = play(w, 8, 0, () => frame(base, r, { gain: 0.25 }));
    res = play(w, 8, res.t, () => frame(base, r, { gain: 1 }));
    expect(res.events.map((e) => e.type)).toEqual(['lights_on']);
    expect(Math.max(...res.frames.slice(2).map((f) => f.crib ?? 0))).toBeLessThan(10);
    res = play(w, 70, res.t, () => frame(base, r, { gain: 0.2 }));
    expect(res.events.map((e) => e.type)).toEqual(['lights_off']);
  });

  it('reports when the camera goes completely blind', () => {
    const w = new VisionWatch();
    const r = rng(7);
    const base = scene();
    let res = play(w, 4, 0, () => frame(base, r));
    res = play(w, 8, res.t, () => frame(new Float32Array(FRAME_W * FRAME_H), r, { noise: 1 }));
    // Lit → black is also a lights-off moment; the blind warning follows after 5 s.
    expect(res.events.map((e) => e.type)).toEqual(['lights_off', 'dark']);
  });

  it('detects a moved camera from the picture, and from the tilt sensor', () => {
    const w = new VisionWatch();
    const r = rng(8);
    let res = play(w, 12, 0, () => frame(scene(), r));
    const shifted = scene(9);
    res = play(w, 12, res.t, () => frame(shifted, r));
    expect(res.events.map((e) => `${e.type}:${e.via}`)).toEqual(['moved:view']);

    const t = new VisionWatch();
    expect(t.pushTilt(80, 2, 0)).toEqual([]);
    expect(t.pushTilt(81, 3, 1000)).toEqual([]);
    expect(t.pushTilt(20, 40, 2000)).toEqual([]);
    expect(t.pushTilt(20, 40, 5000)).toEqual([{ type: 'moved', via: 'tilt' }]);
    // Settled in the new position: no repeat.
    expect(t.pushTilt(21, 40, 9000)).toEqual([]);
  });

  it('summarises each minute', () => {
    const w = new VisionWatch();
    w.setZones([CRIB]);
    const r = rng(9);
    const base = scene();
    play(w, 10, 0, (_t, i) => frame(base, r, { blobs: [wiggle(28, 20, i)] }));
    const m = w.minute();
    expect(m?.crib).toBeGreaterThan(10);
    expect(m?.light).toBeGreaterThan(50);
    expect(w.minute()).toBeNull();
  });

  it('maps zones onto grid cells', () => {
    expect(zoneCells({ x: 0, y: 0, w: 1, h: 1 })).toHaveLength(192);
    expect(zoneCells({ x: 0, y: 0, w: 0.25, h: 0.25 })).toHaveLength(12);
  });
});
