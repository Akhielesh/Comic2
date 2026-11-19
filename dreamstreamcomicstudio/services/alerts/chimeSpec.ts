// The two chimes (notify SPEC §5.5), as numbers. A soft glass marimba: each note is a sine fundamental plus quiet
// partials; each partial rises linearly from 0 over the note's attack, then decays exponentially
// (setTargetAtTime(0, t + attack, tau × tauScale)). Everything sums into one master gain,
//   volume step × CHIME_TARGET_PEAK × norm      (norm = 1 / the raw sum's peak, so both chimes peak alike)
// which is -14 dBFS at Normal and -20 dBFS at Soft, and fades linearly to 0 over the last 20 ms. chime.ts schedules
// exactly this; chimeSpec.test.ts renders it and checks the levels. These are the approved previews (ready.wav,
// needsYou.wav): "Ready" is a rising fifth (A-flat 5 to E-flat 6, "done"), "Needs you" a lower rising minor third
// (C5 to E-flat 5, "hm?"). Both in A-flat major, so they sound like one family; no fundamental sits on Stream Studio's
// 740 Hz tone, its 784 to 1047 Hz call, or the classic generator's old 987.77 Hz beep.

import type { AlertVolume, ChimeTier } from './types';

export interface ChimeNote {
  /** Start, seconds from the chime's start. */
  at: number;
  freq: number;
  gain: number;
  /** Linear attack, seconds. */
  attack: number;
  /** Decay time constant, seconds. */
  tau: number;
}

export interface ChimePartial {
  /** Multiple of the note's frequency. */
  mult: number;
  gain: number;
  /** Multiplies the note's tau (higher partials die sooner: the mallet's tick). */
  tauScale: number;
}

export interface ChimeSpec {
  /** Seconds; every oscillator stops here. */
  length: number;
  notes: readonly ChimeNote[];
  partials: readonly ChimePartial[];
  /** The peak of the raw sum (before the master gain), measured by the render. */
  rawSumPeak: number;
  /** 1 / rawSumPeak. */
  norm: number;
}

/** -14 dBFS at Normal. */
export const CHIME_TARGET_PEAK = Math.pow(10, -14 / 20);
/** Soft is 6 dB under Normal. */
export const CHIME_VOLUME: Readonly<Record<AlertVolume, number>> = Object.freeze({ soft: 0.5, normal: 1 });
/** The master's linear fade to silence at the end, seconds. */
export const CHIME_FADE_S = 0.02;

export const CHIMES: Readonly<Record<ChimeTier, ChimeSpec>> = Object.freeze({
  ready: {
    length: 0.52,
    notes: [
      { at: 0, freq: 830.61, gain: 1, attack: 0.006, tau: 0.1 },
      { at: 0.1, freq: 1244.51, gain: 0.8, attack: 0.006, tau: 0.11 }
    ],
    partials: [
      { mult: 1, gain: 1, tauScale: 1 },
      { mult: 2, gain: 0.16, tauScale: 0.6 },
      { mult: 4, gain: 0.08, tauScale: 0.25 }
    ],
    rawSumPeak: 1.154242,
    norm: 0.866369
  },
  needsYou: {
    length: 0.6,
    notes: [
      { at: 0, freq: 523.25, gain: 0.9, attack: 0.012, tau: 0.13 },
      { at: 0.15, freq: 622.25, gain: 1, attack: 0.012, tau: 0.14 }
    ],
    partials: [
      { mult: 1, gain: 1, tauScale: 1 },
      { mult: 2, gain: 0.1, tauScale: 0.6 }
    ],
    rawSumPeak: 1.277011,
    norm: 0.783079
  }
});

/** The master gain for a chime at a volume. */
export const chimeMasterGain = (tier: ChimeTier, volume: AlertVolume): number =>
  (CHIME_VOLUME[volume] ?? CHIME_VOLUME.normal) * CHIME_TARGET_PEAK * CHIMES[tier].norm;
