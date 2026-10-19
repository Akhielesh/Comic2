/**
 * Motion + light from tiny downscaled frames (64×48) on the camera phone.
 * Exposure-normalized: the camera's auto-exposure brightening the whole frame
 * isn't "movement"; only changes relative to the frame's own mean count.
 */

export interface MotionSample {
  /** 0–100 movement score. */
  motion: number;
  /** Mean luminance 0–255. */
  light: number;
}

export function lumaOf(rgba: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    out[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
  }
  return out;
}

export function compareFrames(prev: Float32Array | null, cur: Float32Array): MotionSample {
  let mean = 0;
  for (let i = 0; i < cur.length; i++) mean += cur[i];
  mean /= cur.length || 1;
  if (!prev || prev.length !== cur.length) return { motion: 0, light: Math.round(mean) };
  let pmean = 0;
  for (let i = 0; i < prev.length; i++) pmean += prev[i];
  pmean /= prev.length || 1;
  let diff = 0;
  let changed = 0;
  for (let i = 0; i < cur.length; i++) {
    const d = Math.abs(cur[i] - mean - (prev[i] - pmean));
    diff += d;
    if (d > 18) changed++;
  }
  const meanDiff = diff / cur.length;
  const changedFrac = changed / cur.length;
  // Sensor noise sits ~1–3; a baby rolling over ~6–20 with 3–15% of pixels changed.
  const score = Math.max(0, Math.min(100, (meanDiff - 2.2) * 7 + changedFrac * 220));
  return { motion: Math.round(score), light: Math.round(mean) };
}

/** Smooths raw scores so a single noisy frame doesn't flip the state. */
export class MotionTracker {
  private ema = 0;
  private prev: Float32Array | null = null;

  push(rgba: Uint8ClampedArray): MotionSample {
    const cur = lumaOf(rgba);
    const s = compareFrames(this.prev, cur);
    this.prev = cur;
    this.ema = this.ema * 0.6 + s.motion * 0.4;
    return { motion: Math.round(this.ema), light: s.light };
  }
}
