/**
 * Smart vision (beta): what the camera can tell about the baby from an
 * on-device object detector (COCO classes) and a body-pose model, about once
 * a second — posture (lying / sitting / standing), rolling over, what they're
 * holding, risky objects within reach, a soft toy in the crib, and which
 * activity zone they're in (play gym, bouncer…).
 *
 * Honest limits, stated in the app: both models were trained mostly on older
 * children and adults, a single camera angle can't always tell sitting from
 * lying, and nothing here detects breathing or safe-sleep position. Every
 * finding must persist for several seconds before it's reported, and each
 * kind of event has a cooldown so the log stays readable.
 *
 * Safe-sleep note (AAP 2022): keep the crib empty — no soft toys, pillows or
 * bumpers. The detector can see teddy bears, not blankets or pillows.
 *
 * Calibrated on real infant photos (overhead changing-pad shots, tummy time,
 * a swaddled sleeping baby among plush toys): the object detector often
 * misses infants while the pose model finds them, so the baby is located from
 * the pose when needed; an image-angle rule alone calls an overhead, lying
 * baby "standing", so lying is decided first from context — the camera
 * looking down (phone tilt), the baby's head on a detected bed / couch, or an
 * age (tracker birthday) before babies sit or stand (CDC: sits without
 * support ~9 months; we allow from 5).
 */

import type { Zone } from './vision';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Detection {
  label: string;
  score: number;
  box: Box;
}
export interface Landmark {
  x: number;
  y: number;
  /** Visibility 0–1. */
  v: number;
}
export interface SceneFrame {
  objects: Detection[];
  /** BlazePose 33-point landmarks per person, normalized to the frame. */
  poses: Landmark[][];
}

export type Posture = 'lying' | 'sitting' | 'standing';

export interface SceneState {
  baby: boolean;
  posture: Posture | null;
  /** 'Crib', an activity zone's name, or null. */
  where: string | null;
  holding: string | null;
  /** Risky objects within reach right now. */
  near: string[];
  /** Someone bigger is with the baby. */
  adult: boolean;
  faceVisible: boolean | null;
}

export type SceneEvent =
  | { type: 'posture'; posture: Posture; where: string | null }
  | { type: 'stood_in_crib' }
  | { type: 'rolled' }
  | { type: 'holding'; label: string }
  | { type: 'object_near'; label: string; sharp: boolean; why: string }
  | { type: 'soft_toy'; inCrib: boolean }
  | { type: 'in_zone'; name: string }
  | { type: 'left_zone'; name: string; secs: number };

/** COCO objects worth a warning when they're within the baby's reach. */
export const RISKY: Record<string, { why: string; sharp?: boolean }> = {
  scissors: { why: 'sharp', sharp: true },
  knife: { why: 'sharp', sharp: true },
  fork: { why: 'sharp', sharp: true },
  cup: { why: 'hot drinks can scald' },
  'wine glass': { why: 'glass can break' },
  'cell phone': { why: 'cords and small parts' },
  remote: { why: 'button batteries are dangerous if swallowed' },
  'hair drier': { why: 'cord and heat' },
  'potted plant': { why: 'soil and leaves can be swallowed' },
  cat: { why: 'a pet close to the baby' },
  dog: { why: 'a pet close to the baby' },
};
/** Things a baby may happily hold. */
export const TOYS = new Set(['teddy bear', 'sports ball', 'book', 'bottle', 'spoon', 'toothbrush', 'frisbee', 'kite']);
const SOFT = new Set(['teddy bear']);

/** Before this age (days) a baby is reported lying only. */
export const SIT_FROM_DAYS = 150;
/** The camera looks this steeply down (°, from the phone's tilt) → overhead view. */
export const OVERHEAD_DEG = 50;

export interface SceneContext {
  /** The baby's birthday (ms), from the tracker. */
  bornAt?: number | null;
  /** How far below horizontal the camera points (°), from the phone's tilt sensor. */
  downAngle?: number | null;
}

/**
 * Camera pitch below horizontal (°) from DeviceOrientation β/γ: the back
 * camera of a phone lying screen-up looks straight down (90°), an upright
 * phone looks level (0°). The front camera looks the other way.
 */
export function downAngle(beta: number, gamma: number, front = false): number {
  const r = Math.PI / 180;
  const a = Math.asin(Math.max(-1, Math.min(1, Math.cos(beta * r) * Math.cos(gamma * r)))) / r;
  return front ? -a : a;
}

/** YYYY-MM-DD → ms at local midnight, or null. */
export function birthAt(birth: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth ?? '');
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  return Number.isFinite(t) ? t : null;
}

const L = { nose: 0, eyeL: 2, eyeR: 5, shL: 11, shR: 12, wrL: 15, wrR: 16, hipL: 23, hipR: 24, kneeL: 25, kneeR: 26, ankL: 27, ankR: 28 } as const;

/* ------------------------------------------------------------ geometry */

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const inside = (p: { x: number; y: number }, b: Box, pad = 0) =>
  p.x >= b.x - b.w * pad && p.x <= b.x + b.w * (1 + pad) && p.y >= b.y - b.h * pad && p.y <= b.y + b.h * (1 + pad);
const area = (b: Box) => b.w * b.h;

function mid(kp: Landmark[], a: number, b: number, minV: number): { x: number; y: number } | null {
  const pa = kp[a];
  const pb = kp[b];
  const ok = [pa, pb].filter((p) => p && p.v >= minV);
  if (!ok.length) return null;
  return { x: ok.reduce((s, p) => s + p.x, 0) / ok.length, y: ok.reduce((s, p) => s + p.y, 0) / ok.length };
}

/**
 * Posture from one pose. Assumes the usual nursery setup — a camera above
 * and to the side of the crib. Torso lying across the image → lying; upright
 * torso with legs extended down to feet inside the frame → standing; upright
 * with the thighs foreshortened (knees near hip height) → sitting. Legs
 * extended but the feet out of the frame is null: from straight above, a baby
 * lying on their back looks exactly like that. Null too when shoulders/hips
 * aren't visible enough to say.
 */
export function classifyPosture(kp: Landmark[], opts: { lyingOnly?: boolean } = {}): { posture: Posture | null; conf: number } {
  if (!kp || kp.length < 29) return { posture: null, conf: 0 };
  const s = mid(kp, L.shL, L.shR, 0.5);
  const h = mid(kp, L.hipL, L.hipR, 0.5);
  // Too young to sit, or seen from straight above: if we can see the baby, they're lying down.
  if (opts.lyingOnly) return s || (kp[L.nose]?.v ?? 0) >= 0.6 ? { posture: 'lying', conf: 0.8 } : { posture: null, conf: 0 };
  if (!s || !h) return { posture: null, conf: 0 };
  const dx = h.x - s.x;
  const dy = h.y - s.y;
  const torso = Math.hypot(dx, dy);
  if (torso < 0.03) return { posture: null, conf: 0 };
  const angle = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI; // 0 = upright in the image
  if (angle >= 55) return { posture: 'lying', conf: Math.min(1, 0.6 + (angle - 55) / 50) };
  if (dy <= 0) return { posture: 'lying', conf: 0.55 }; // hips above shoulders: upside down in the image
  const knee = mid(kp, L.kneeL, L.kneeR, 0.5);
  const ankle = mid(kp, L.ankL, L.ankR, 0.45);
  const legsDown = !!knee && knee.y - h.y > 0.35 * torso;
  // The pose model guesses feet outside the frame; standing needs them seen.
  if (legsDown && ankle && ankle.y <= 0.97 && ankle.y - h.y > 0.9 * torso) {
    return { posture: 'standing', conf: Math.min(1, 0.6 + (ankle.y - h.y - 0.9 * torso) / torso) };
  }
  if (legsDown && knee!.y - h.y > 0.45 * torso) return { posture: null, conf: 0.3 };
  if (angle <= 35) return { posture: 'sitting', conf: knee ? 0.75 : 0.6 };
  return { posture: null, conf: 0.3 };
}

export function faceVisible(kp: Landmark[]): boolean | null {
  if (!kp || kp.length < 6) return null;
  const nose = kp[L.nose]?.v ?? 0;
  const eye = Math.max(kp[L.eyeL]?.v ?? 0, kp[L.eyeR]?.v ?? 0);
  return nose >= 0.6 && eye >= 0.5;
}

/**
 * Which detected person is the baby: the one in the crib or an activity
 * zone, else (with several people) the smallest. Others count as adults.
 */
export function pickBaby(persons: Detection[], zones: Zone[]): { baby: Detection | null; adults: Detection[] } {
  if (!persons.length) return { baby: null, adults: [] };
  const placed = zones.filter((z) => z.kind === 'crib' || z.kind === 'activity');
  const inZone = persons.filter((p) => placed.some((z) => inside(center(p.box), z)));
  const pool = inZone.length ? inZone : persons;
  // It's a baby monitor: a lone person is the baby (an overhead shot fills the frame).
  const baby = [...pool].sort((a, b) => area(a.box) - area(b.box))[0];
  const adults = persons.filter((p) => p !== baby && (area(p.box) > area(baby.box) * 1.6 || area(p.box) > 0.12));
  return { baby, adults };
}

/* --------------------------------------------------------------- watch */

/** Seconds a finding must hold before it's reported. */
const HOLD = { posture: 6, stood: 4, holding: 3, near: 3, zone: 8, rolledFace: 5, rolledAway: 8, soft: 6 };
/** Minutes between repeats of the same event. */
const COOLDOWN = { posture: 2, stood: 10, rolled: 10, holding: 5, near: 10, soft: 120, zone: 5 };

class Hold<T> {
  private v: T | null = null;
  private since = 0;
  /** The value once it has held for `secs`, else null. */
  step(v: T | null, now: number, secs: number): T | null {
    if (v !== this.v) {
      this.v = v;
      this.since = now;
    }
    return v != null && now - this.since >= secs * 1000 ? v : null;
  }
  get value(): T | null {
    return this.v;
  }
  get startedAt(): number {
    return this.since;
  }
}

/** A box around a pose's visible landmarks (padded) — the baby when the detector misses them. */
export function poseBox(kp: Landmark[], minV = 0.5): Box | null {
  const pts = kp.filter((p) => p && p.v >= minV);
  if (pts.length < 6) return null;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.max(0, Math.min(...xs));
  const y0 = Math.max(0, Math.min(...ys));
  const x1 = Math.min(1, Math.max(...xs));
  const y1 = Math.min(1, Math.max(...ys));
  const px = (x1 - x0) * 0.15;
  const py = (y1 - y0) * 0.15;
  return { x: Math.max(0, x0 - px), y: Math.max(0, y0 - py), w: Math.min(1, x1 + px) - Math.max(0, x0 - px), h: Math.min(1, y1 + py) - Math.max(0, y0 - py) };
}

const SURFACES = new Set(['bed', 'couch']);

export class SceneWatch {
  private zones: Zone[] = [];
  private ctx: SceneContext = {};
  private posture = new Hold<Posture>();
  private reported: Posture | null = null;
  private holding = new Hold<string>();
  private nearHolds = new Map<string, Hold<string>>();
  private zone = new Hold<string>();
  private inZone: { name: string; since: number } | null = null;
  private soft = new Hold<string>();
  private face = new Hold<boolean>();
  private faceWasVisible = false;
  private last = new Map<string, number>();

  setZones(zones: Zone[]): void {
    this.zones = zones;
  }

  setContext(ctx: SceneContext): void {
    this.ctx = { ...this.ctx, ...ctx };
  }

  /** Lying is the only posture to report: too young to sit, or the camera looks straight down. */
  lyingOnly(now: number): boolean {
    const young = this.ctx.bornAt != null && now >= this.ctx.bornAt && now - this.ctx.bornAt < SIT_FROM_DAYS * 86_400_000;
    const overhead = this.ctx.downAngle != null && this.ctx.downAngle >= OVERHEAD_DEG;
    return young || overhead;
  }

  private cool(key: string, minutes: number, now: number): boolean {
    if (now - (this.last.get(key) ?? -Infinity) < minutes * 60_000) return false;
    this.last.set(key, now);
    return true;
  }

  push(f: SceneFrame, now: number): { state: SceneState; events: SceneEvent[] } {
    const events: SceneEvent[] = [];
    const persons = f.objects.filter((o) => o.label === 'person' && o.score >= 0.4);
    const picked = pickBaby(persons, this.zones);
    let baby = picked.baby;
    const adults = picked.adults;
    // The detector often misses small babies; the pose model usually doesn't.
    if (!baby) {
      const free = f.poses.map((kp) => poseBox(kp)).find((b) => b && !adults.some((a) => inside(center(b), a.box)));
      if (free) baby = { label: 'person', score: 0.5, box: free };
    }
    const crib = this.zones.find((z) => z.kind === 'crib');
    const activity = this.zones.filter((z) => z.kind === 'activity');
    const state: SceneState = { baby: !!baby, posture: null, where: null, holding: null, near: [], adult: adults.length > 0, faceVisible: null };

    if (!baby) {
      // Nobody to describe: let everything lapse.
      this.posture.step(null, now, HOLD.posture);
      this.holding.step(null, now, HOLD.holding);
      this.face.step(null, now, 0);
      this.endZone(now, events);
      return { state, events };
    }

    const bc = center(baby.box);
    const zoneHit = activity.find((z) => inside(bc, z));
    state.where = zoneHit ? zoneHit.name : crib && inside(bc, crib) ? 'Crib' : null;

    // The pose that belongs to the baby: the one whose shoulders/hips fall inside the baby's box.
    const pose = f.poses.find((kp) => {
      const t = mid(kp, L.shL, L.shR, 0.3) ?? mid(kp, L.hipL, L.hipR, 0.3);
      return t && inside(t, baby.box, 0.1);
    });

    // Posture. Head resting on a detected bed / couch → lying, whatever the image angle says.
    const nose = pose && pose[L.nose]?.v >= 0.5 ? pose[L.nose] : null;
    const onSurface = f.objects.some((o) => SURFACES.has(o.label) && o.score >= 0.4 && (nose ? inside(nose, o.box) : inside(bc, o.box)));
    const lyingOnly = this.lyingOnly(now);
    // Swaddled babies often get no pose at all. Too young to sit (or seen from above) and not in someone's arms → lying.
    const held = adults.some((a) => inside(bc, a.box));
    const pc = pose ? classifyPosture(pose, { lyingOnly: lyingOnly || onSurface }) : lyingOnly && !held ? { posture: 'lying' as const, conf: 0.6 } : { posture: null, conf: 0 };
    const p = this.posture.step(pc.conf >= 0.6 ? pc.posture : null, now, HOLD.posture);
    state.posture = this.posture.value;
    if (p && p !== this.reported) {
      this.reported = p;
      if (this.cool(`posture:${p}`, COOLDOWN.posture, now)) events.push({ type: 'posture', posture: p, where: state.where });
      if (p === 'standing' && state.where === 'Crib' && !lyingOnly && this.cool('stood', COOLDOWN.stood, now)) events.push({ type: 'stood_in_crib' });
    }

    // Rolling: lying, face seen for a while, then turned away from the camera.
    const fv = pose ? faceVisible(pose) : null;
    state.faceVisible = fv;
    const steadyFace = this.face.step(fv, now, fv ? HOLD.rolledFace : HOLD.rolledAway);
    if (steadyFace === true) this.faceWasVisible = true;
    if (steadyFace === false && this.faceWasVisible && this.reported === 'lying' && state.posture === 'lying') {
      this.faceWasVisible = false;
      if (this.cool('rolled', COOLDOWN.rolled, now)) events.push({ type: 'rolled' });
    }

    // Objects near or in hand.
    const wrists = pose ? [pose[L.wrL], pose[L.wrR]].filter((w) => w && w.v >= 0.4) : [];
    let inHand: string | null = null;
    const nearNow = new Set<string>();
    for (const o of f.objects) {
      if (o.label === 'person' || o.score < 0.35) continue;
      const oc = center(o.box);
      const held = wrists.some((w) => inside(w, o.box, 0.15));
      if (held && (TOYS.has(o.label) || RISKY[o.label])) inHand = inHand ?? o.label;
      const close = inside(oc, baby.box, 0.25) || (state.where === 'Crib' && crib != null && inside(oc, crib));
      if (RISKY[o.label] && (close || held)) nearNow.add(o.label);
      // Soft toys in the crib with the baby, or within reach of a lying baby anywhere (no crib zone needed).
      const inCrib = state.where === 'Crib' && crib != null && inside(oc, crib);
      if (SOFT.has(o.label) && (inCrib || (this.posture.value === 'lying' && inside(oc, baby.box, 0.5)))) {
        if (this.soft.step(o.label, now, HOLD.soft) && this.cool('soft', COOLDOWN.soft, now)) events.push({ type: 'soft_toy', inCrib });
      }
    }
    if (![...f.objects].some((o) => SOFT.has(o.label))) this.soft.step(null, now, HOLD.soft);

    const h = this.holding.step(inHand, now, HOLD.holding);
    state.holding = this.holding.value;
    if (h && this.cool(`holding:${h}`, COOLDOWN.holding, now)) events.push({ type: 'holding', label: h });

    for (const label of new Set([...nearNow, ...this.nearHolds.keys()])) {
      let hold = this.nearHolds.get(label);
      if (!hold) this.nearHolds.set(label, (hold = new Hold<string>()));
      const v = hold.step(nearNow.has(label) ? label : null, now, HOLD.near);
      if (!nearNow.has(label)) {
        this.nearHolds.delete(label);
        continue;
      }
      if (v && this.cool(`near:${label}`, COOLDOWN.near, now)) events.push({ type: 'object_near', label, sharp: !!RISKY[label].sharp, why: RISKY[label].why });
    }
    state.near = [...nearNow];

    // Activity zones.
    const z = this.zone.step(zoneHit?.name ?? null, now, HOLD.zone);
    if (z && this.inZone?.name !== z) {
      this.endZone(now, events);
      this.inZone = { name: z, since: this.zone.startedAt };
      if (this.cool(`zone:${z}`, COOLDOWN.zone, now)) events.push({ type: 'in_zone', name: z });
    } else if (!zoneHit && this.inZone && now - this.zone.startedAt >= HOLD.zone * 1000) {
      this.endZone(now, events);
    }
    return { state, events };
  }

  private endZone(now: number, events: SceneEvent[]): void {
    if (!this.inZone) return;
    const secs = Math.round((now - this.inZone.since) / 1000);
    if (secs >= 30) events.push({ type: 'left_zone', name: this.inZone.name, secs });
    this.inZone = null;
  }
}
