/**
 * Nursery vision — what the camera phone sees, from tiny 64×48 frames.
 *
 *   frame → exposure-normalised luma → 16×12 cell motion (adaptive noise floor)
 *         ├─ zone scores: crib, outside the crib, each danger zone
 *         ├─ scene signature → "camera moved" / "view blocked"
 *         └─ light level → lights on / off
 *   + the phone's tilt sensor → "camera knocked over"
 *
 * Events are deliberately conservative: a parent walking in (a "visit") is
 * not a danger-zone alert, and whole-frame changes (lights, auto-exposure,
 * a bumped phone) never count as the baby moving.
 */

export const FRAME_W = 64;
export const FRAME_H = 48;
const CELL = 4;
export const GRID_W = FRAME_W / CELL; // 16
export const GRID_H = FRAME_H / CELL; // 12

/** A rectangle in the camera's own (unmirrored) frame, 0–1. */
export interface Zone {
  id: string;
  kind: 'crib' | 'danger' | 'activity';
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface VisionFrame {
  /** Whole-frame movement 0–100 (the classic motion score). */
  motion: number;
  /** Movement inside the crib zone 0–100 (null without a crib zone). */
  crib: number | null;
  /** Movement outside the crib and danger zones 0–100 (null without a crib zone). */
  outside: number | null;
  /** Danger zone id → movement 0–100. */
  zones: Record<string, number>;
  /** Mean luminance 0–255. */
  light: number;
  /** Share of the picture that changed, 0–1. */
  active: number;
}

export type VisionEventType = 'zone' | 'crib_out' | 'visit_start' | 'visit_end' | 'lights_on' | 'lights_off' | 'dark' | 'moved';

export interface VisionEvent {
  type: VisionEventType;
  zone?: string;
  name?: string;
  secs?: number;
  /** For 'moved': what gave it away. */
  via?: 'tilt' | 'view';
}

/** Per-minute summary for the nursery's history. */
export interface VisionMinute {
  motion: number;
  mmax: number;
  crib: number | null;
  outside: number | null;
  light: number;
  visit: boolean;
}

export function lumaOf(rgba: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  return out;
}

const mean = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : 0;
};

const median = (a: Float32Array) => {
  const s = Float32Array.from(a).sort();
  return s[(s.length / 2) | 0];
};

/**
 * The camera's exposure change between two frames: the median per-pixel
 * brightness ratio. Robust to anything covering less than half the picture
 * (a person walking in), so only a true exposure/lighting change moves it.
 */
export function exposureGain(prev: Float32Array, cur: Float32Array): number {
  const r = new Float32Array(cur.length);
  for (let i = 0; i < cur.length; i++) r[i] = (cur[i] + 4) / (prev[i] + 4);
  return median(r);
}

/** Cell-level absolute difference of two frames after removing the exposure change. */
export function cellDiff(prev: Float32Array, cur: Float32Array, gain = exposureGain(prev, cur)): Float32Array {
  const cells = new Float32Array(GRID_W * GRID_H);
  for (let y = 0; y < FRAME_H; y++) {
    const cy = (y / CELL) | 0;
    for (let x = 0; x < FRAME_W; x++) {
      const i = y * FRAME_W + x;
      cells[cy * GRID_W + ((x / CELL) | 0)] += Math.abs(cur[i] + 4 - gain * (prev[i] + 4));
    }
  }
  for (let i = 0; i < cells.length; i++) cells[i] /= CELL * CELL;
  return cells;
}

/** Cell indices covered by a zone (a cell counts when its centre is inside). */
export function zoneCells(z: Pick<Zone, 'x' | 'y' | 'w' | 'h'>): number[] {
  const out: number[] = [];
  for (let cy = 0; cy < GRID_H; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const px = (cx + 0.5) / GRID_W;
      const py = (cy + 0.5) / GRID_H;
      if (px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h) out.push(cy * GRID_W + cx);
    }
  }
  return out;
}

/** Normalised scene layout (16×12 cell means, zero-mean / unit-variance). */
export function signature(luma: Float32Array): Float32Array {
  const cells = new Float32Array(GRID_W * GRID_H);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) cells[((y / CELL) | 0) * GRID_W + ((x / CELL) | 0)] += luma[y * FRAME_W + x];
  }
  const m = mean(cells);
  let v = 0;
  for (let i = 0; i < cells.length; i++) {
    cells[i] -= m;
    v += cells[i] * cells[i];
  }
  const sd = Math.sqrt(v / cells.length) || 1;
  for (let i = 0; i < cells.length; i++) cells[i] /= sd;
  return cells;
}

export function correlation(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s / a.length;
}

const stdOf = (a: Float32Array, m: number) => {
  let v = 0;
  for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2;
  return Math.sqrt(v / (a.length || 1));
};

/* -------------------------------------------------------------- tuning */

const ZONE_ON = 22; // zone score that counts as "something moving there"
const ZONE_HOLD_MS = 1200;
const ZONE_COOLDOWN_MS = 2 * 60_000;
const CRIB_OUT_HOLD_MS = 2000;
const CRIB_OUT_RECENT_MS = 15_000;
const CRIB_OUT_COOLDOWN_MS = 5 * 60_000;
const VISIT_ACTIVE = 0.22; // a person fills a good part of the picture
const VISIT_WINDOW_MS = 2000; // …in most frames of the last 2 s
const VISIT_MIN_FRAMES = 5;
const ADULT_QUIET_MS = 5000; // zone alerts wait this long after adult-sized movement
const VISIT_END_MS = 45_000;
/** Exposure ratio over ~3 s that means the room's lighting changed. */
const LIGHT_RATIO = 1.9;
const LIGHT_COOLDOWN_MS = 30_000;
const DARK_LIGHT = 12;
const DARK_STD = 4;
const DARK_HOLD_MS = 5000;
const SCENE_MIN_CORR = 0.45;
const SCENE_HOLD_MS = 8000;
const SCENE_SETTLE_MS = 10_000;
const TILT_DEG = 20;
const TILT_HOLD_MS = 2500;
const MOVED_COOLDOWN_MS = 3 * 60_000;

export class VisionWatch {
  private zones: Zone[] = [];
  private cribCells: number[] = [];
  private outsideCells: number[] = [];
  private dangerCells = new Map<string, number[]>();
  private prev: Float32Array | null = null;
  private ema = 0;

  // event state
  private zoneSince = new Map<string, number>();
  private zoneLast = new Map<string, number>();
  private cribActiveAt = -Infinity;
  private outSince = 0;
  private cribOutLast = -Infinity;
  private visitOn = false;
  private bigAt: number[] = [];
  private lastBigAt = -Infinity;
  private visitStart = 0;
  private visitQuietSince = 0;
  private hintAt = -Infinity;
  private lightHist: { at: number; luma: Float32Array }[] = [];
  private lightLast: Record<'on' | 'off', number> = { on: -Infinity, off: -Infinity };
  private darkSince = 0;
  private darkOn = false;
  private sceneRef: Float32Array | null = null;
  private sceneStableSince = 0;
  private sceneOffSince = 0;
  private tiltRef: { b: number; g: number } | null = null;
  private tiltOffSince = 0;
  private tiltStableSince = 0;
  private movedLast = -Infinity;

  // minute accumulators
  private acc = { n: 0, motion: 0, mmax: 0, crib: 0, outside: 0, light: 0, visit: false };

  setZones(zones: Zone[]): void {
    this.zones = zones.filter((z) => z.w > 0.02 && z.h > 0.02).slice(0, 6);
    const crib = this.zones.find((z) => z.kind === 'crib');
    this.cribCells = crib ? zoneCells(crib) : [];
    this.dangerCells = new Map(this.zones.filter((z) => z.kind === 'danger').map((z) => [z.id, zoneCells(z)]));
    const taken = new Set([...this.cribCells, ...[...this.dangerCells.values()].flat()]);
    this.outsideCells = crib ? Array.from({ length: GRID_W * GRID_H }, (_, i) => i).filter((i) => !taken.has(i)) : [];
  }

  get inVisit(): boolean {
    return this.visitOn;
  }

  /** Sound hints that an adult is in the room (voices, footsteps, door). */
  hintPresence(now: number): void {
    this.hintAt = now;
  }

  /** Phone tilt (deviceorientation β/γ, degrees). */
  pushTilt(beta: number | null, gamma: number | null, now: number): VisionEvent[] {
    if (beta == null || gamma == null) return [];
    const out: VisionEvent[] = [];
    if (!this.tiltRef) {
      this.tiltRef = { b: beta, g: gamma };
      this.tiltStableSince = now;
      return out;
    }
    const off = Math.max(Math.abs(beta - this.tiltRef.b), Math.abs(gamma - this.tiltRef.g));
    if (off > TILT_DEG) {
      if (!this.tiltOffSince) this.tiltOffSince = now;
      if (now - this.tiltOffSince >= TILT_HOLD_MS) {
        if (now - this.movedLast > MOVED_COOLDOWN_MS) {
          this.movedLast = now;
          out.push({ type: 'moved', via: 'tilt' });
        }
        // The new position becomes the reference once it settles.
        this.tiltRef = { b: beta, g: gamma };
        this.tiltOffSince = 0;
      }
    } else {
      this.tiltOffSince = 0;
      // Slowly follow tiny drift (phone settling on a soft surface).
      this.tiltRef.b += (beta - this.tiltRef.b) * 0.02;
      this.tiltRef.g += (gamma - this.tiltRef.g) * 0.02;
    }
    return out;
  }

  /** One frame (RGBA 64×48). Returns the frame analysis + any events. */
  push(rgba: Uint8ClampedArray, now: number): { frame: VisionFrame; events: VisionEvent[] } {
    const cur = lumaOf(rgba);
    const light = mean(cur);
    const events: VisionEvent[] = [];
    let frame: VisionFrame = { motion: 0, crib: this.cribCells.length ? 0 : null, outside: this.cribCells.length ? 0 : null, zones: {}, light: Math.round(light), active: 0 };

    if (this.prev) {
      const gain = exposureGain(this.prev, cur);
      const cells = cellDiff(this.prev, cur, gain);
      // Adaptive noise floor: most of the picture is still, so the median cell is noise.
      const sorted = Array.from(cells).sort((a, b) => a - b);
      const noise = sorted[(sorted.length / 2) | 0];
      const on = Math.max(5, noise * 2.5 + 1.5);
      let active = 0;
      for (const c of cells) if (c > on) active++;
      const activeFrac = active / cells.length;
      // A zone's score counts both the share of it that moved and how much moved
      // in absolute terms (≥ 2 cells) — a toddler is small in a large zone.
      const scoreOf = (idx: number[]) => {
        if (!idx.length) return 0;
        let a = 0;
        let s = 0;
        for (const i of idx) {
          if (cells[i] > on) a++;
          s += Math.max(0, cells[i] - on);
        }
        const share = (a / idx.length) * 220;
        const amount = a >= 2 ? a * 15 : 0;
        return Math.min(100, Math.round(Math.max(share, amount) + (s / idx.length) * 4));
      };
      const all = Math.min(100, Math.round(activeFrac * 220 + (mean(cells) - noise) * 3));
      this.ema = this.ema * 0.6 + Math.max(0, all) * 0.4;
      const zones: Record<string, number> = {};
      for (const [id, idx] of this.dangerCells) zones[id] = scoreOf(idx);
      frame = {
        motion: Math.round(this.ema),
        crib: this.cribCells.length ? scoreOf(this.cribCells) : null,
        outside: this.cribCells.length ? scoreOf(this.outsideCells) : null,
        zones,
        light: Math.round(light),
        active: Math.round(activeFrac * 100) / 100,
      };
      events.push(...this.visits(frame, now));
      events.push(...this.zoneEvents(frame, now));
      events.push(...this.scene(cur, frame, now));
    }
    events.push(...this.lights(cur, light, now));
    this.prev = cur;

    const a = this.acc;
    a.n++;
    a.motion += frame.motion;
    a.mmax = Math.max(a.mmax, frame.motion);
    a.crib += frame.crib ?? 0;
    a.outside += frame.outside ?? 0;
    a.light += frame.light;
    a.visit ||= this.visitOn;
    return { frame, events };
  }

  /** Close the minute's accumulators. */
  minute(): VisionMinute | null {
    const a = this.acc;
    if (!a.n) return null;
    const hasCrib = this.cribCells.length > 0;
    const out: VisionMinute = {
      motion: Math.round(a.motion / a.n),
      mmax: a.mmax,
      crib: hasCrib ? Math.round(a.crib / a.n) : null,
      outside: hasCrib ? Math.round(a.outside / a.n) : null,
      light: Math.round(a.light / a.n),
      visit: a.visit,
    };
    this.acc = { n: 0, motion: 0, mmax: 0, crib: 0, outside: 0, light: 0, visit: this.visitOn };
    return out;
  }

  private visits(f: VisionFrame, now: number): VisionEvent[] {
    const big = f.active >= VISIT_ACTIVE && f.active < 0.9; // ≥ 0.9 = the whole picture changed (lights, bump)
    if (big) {
      this.bigAt.push(now);
      this.lastBigAt = now;
    }
    while (this.bigAt.length && this.bigAt[0] < now - VISIT_WINDOW_MS) this.bigAt.shift();
    const heard = now - this.hintAt < 10_000 && (f.outside ?? f.motion) >= ZONE_ON;
    if (!this.visitOn) {
      if (this.bigAt.length >= VISIT_MIN_FRAMES || heard) {
        this.visitOn = true;
        this.visitStart = this.bigAt[0] ?? now;
        this.visitQuietSince = 0;
        return [{ type: 'visit_start' }];
      }
      return [];
    }
    const quiet = f.active < 0.05 && now - this.hintAt > 10_000;
    if (!quiet) {
      this.visitQuietSince = 0;
      return [];
    }
    if (!this.visitQuietSince) this.visitQuietSince = now;
    if (now - this.visitQuietSince < VISIT_END_MS) return [];
    this.visitOn = false;
    this.bigAt = [];
    return [{ type: 'visit_end', secs: Math.round((this.visitQuietSince - this.visitStart) / 1000) }];
  }

  private zoneEvents(f: VisionFrame, now: number): VisionEvent[] {
    const out: VisionEvent[] = [];
    // Localised movement only, and not while an adult-sized shape was just moving.
    const localised = f.active < 0.5 && now - this.lastBigAt > ADULT_QUIET_MS;
    if (f.crib != null && f.crib >= ZONE_ON) this.cribActiveAt = now;
    for (const z of this.zones) {
      if (z.kind !== 'danger') continue;
      const s = f.zones[z.id] ?? 0;
      if (s >= ZONE_ON && localised && !this.visitOn) {
        const since = this.zoneSince.get(z.id) || now;
        this.zoneSince.set(z.id, since);
        if (now - since >= ZONE_HOLD_MS && now - (this.zoneLast.get(z.id) ?? -Infinity) > ZONE_COOLDOWN_MS) {
          this.zoneLast.set(z.id, now);
          out.push({ type: 'zone', zone: z.id, name: z.name });
        }
      } else this.zoneSince.delete(z.id);
    }
    // Climb-out: movement spills from the crib to outside it, with no adult around.
    if (f.outside != null && f.crib != null && f.outside >= ZONE_ON && localised && !this.visitOn && now - this.cribActiveAt < CRIB_OUT_RECENT_MS) {
      if (!this.outSince) this.outSince = now;
      if (now - this.outSince >= CRIB_OUT_HOLD_MS && now - this.cribOutLast > CRIB_OUT_COOLDOWN_MS) {
        this.cribOutLast = now;
        out.push({ type: 'crib_out' });
      }
    } else this.outSince = 0;
    return out;
  }

  private lights(cur: Float32Array, light: number, now: number): VisionEvent[] {
    const out: VisionEvent[] = [];
    this.lightHist.push({ at: now, luma: cur });
    while (this.lightHist.length && this.lightHist[0].at < now - 3000) this.lightHist.shift();
    if (this.lightHist.length >= 3) {
      // The room's lighting, not a person in light clothes: a whole-picture exposure ratio.
      const g = exposureGain(this.lightHist[0].luma, cur);
      if (g >= LIGHT_RATIO && light > 50 && now - this.lightLast.on > LIGHT_COOLDOWN_MS) {
        this.lightLast.on = now;
        this.lightHist = [{ at: now, luma: cur }];
        out.push({ type: 'lights_on' });
      } else if (g <= 1 / LIGHT_RATIO && light < 45 && now - this.lightLast.off > LIGHT_COOLDOWN_MS) {
        this.lightLast.off = now;
        this.lightHist = [{ at: now, luma: cur }];
        out.push({ type: 'lights_off' });
      }
    }
    // Completely black and featureless: lights out with no night-light, or the lens covered.
    const blind = light < DARK_LIGHT && stdOf(cur, light) < DARK_STD;
    if (blind) {
      if (!this.darkSince) this.darkSince = now;
      if (!this.darkOn && now - this.darkSince >= DARK_HOLD_MS) {
        this.darkOn = true;
        out.push({ type: 'dark' });
      }
    } else {
      this.darkSince = 0;
      this.darkOn = false;
    }
    return out;
  }

  private scene(cur: Float32Array, f: VisionFrame, now: number): VisionEvent[] {
    // Only judge the layout in a lit, settled picture.
    if (f.light < 25 || f.active > 0.1 || this.visitOn) {
      this.sceneStableSince = 0;
      return [];
    }
    if (!this.sceneStableSince) this.sceneStableSince = now;
    const sig = signature(cur);
    if (!this.sceneRef) {
      if (now - this.sceneStableSince >= SCENE_SETTLE_MS) this.sceneRef = sig;
      return [];
    }
    if (correlation(sig, this.sceneRef) >= SCENE_MIN_CORR) {
      this.sceneOffSince = 0;
      // Follow slow changes (daylight moving across the room).
      for (let i = 0; i < sig.length; i++) this.sceneRef[i] += (sig[i] - this.sceneRef[i]) * 0.01;
      return [];
    }
    if (!this.sceneOffSince) this.sceneOffSince = now;
    if (now - this.sceneOffSince < SCENE_HOLD_MS) return [];
    this.sceneRef = sig;
    this.sceneOffSince = 0;
    if (now - this.movedLast < MOVED_COOLDOWN_MS) return [];
    this.movedLast = now;
    return [{ type: 'moved', via: 'view' }];
  }
}

/* ------------------------------------------------------------- display */

export const VISION_INFO: Record<VisionEventType, { headline: string; tone: 'live' | 'warn' | 'info' | 'ok' }> = {
  zone: { headline: 'Movement in {zone}', tone: 'live' },
  crib_out: { headline: 'Movement outside the crib — {baby} may be climbing out', tone: 'live' },
  visit_start: { headline: 'Someone came into the nursery', tone: 'info' },
  visit_end: { headline: 'Visit ended', tone: 'info' },
  lights_on: { headline: 'Lights turned on in the nursery', tone: 'info' },
  lights_off: { headline: 'Lights turned off in the nursery', tone: 'info' },
  dark: { headline: 'Camera can’t see — room completely dark or lens covered', tone: 'warn' },
  moved: { headline: 'Camera was moved — check it still sees the crib', tone: 'warn' },
};

export const newZoneId = () => Math.random().toString(36).slice(2, 8);
