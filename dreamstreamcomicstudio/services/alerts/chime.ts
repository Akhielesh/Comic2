// Plays one chime on the alert core's audio context (notify SPEC §5.5, §5.6): resume, schedule exactly the numbers in
// chimeSpec.ts, and suspend once the last oscillator ends. No context (no press yet, sound off, signed out) or a
// context the browser keeps suspended means no sound, silently: the toast and the title count still carry the alert.

import { audioContext, beginPlay, endPlay } from './audio';
import { CHIMES, CHIME_FADE_S, chimeMasterGain } from './chimeSpec';
import type { AlertVolume, ChimeTier } from './types';

export interface PlayChimeOptions {
  /** Seconds from now (the Play button plays Ready, then Needs you, in one gesture). */
  after?: number;
}

/** Plays a chime; resolves whether it was scheduled. Never throws. */
export async function playChime(tier: ChimeTier, volume: AlertVolume, opts: PlayChimeOptions = {}): Promise<boolean> {
  const ctx = audioContext();
  const spec = CHIMES[tier];
  if (!ctx || !spec) return false;
  beginPlay();
  let scheduled = false;
  try {
    await ctx.resume();
    if (ctx.state !== 'running' || audioContext() !== ctx) return false;
    const start = ctx.currentTime + Math.max(0, Number.isFinite(opts.after) ? (opts.after as number) : 0);
    const end = start + spec.length;
    const master = ctx.createGain();
    const level = chimeMasterGain(tier, volume);
    master.gain.setValueAtTime(level, start);
    master.gain.setValueAtTime(level, end - CHIME_FADE_S);
    master.gain.linearRampToValueAtTime(0, end);
    master.connect(ctx.destination);
    const oscillators: OscillatorNode[] = [];
    for (const note of spec.notes) {
      const t = start + note.at;
      for (const p of spec.partials) {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(note.freq * p.mult, t);
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(note.gain * p.gain, t + note.attack);
        env.gain.setTargetAtTime(0, t + note.attack, note.tau * p.tauScale);
        osc.connect(env);
        env.connect(master);
        osc.start(t);
        osc.stop(end);
        oscillators.push(osc);
      }
    }
    // Every oscillator stops at `end`; the last one to be told ends the chime.
    const last = oscillators[oscillators.length - 1];
    if (last) last.onended = () => endPlay();
    scheduled = !!last;
    return scheduled;
  } catch {
    return false;
  } finally {
    if (!scheduled) endPlay();
  }
}
