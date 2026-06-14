import { useCallback, useRef, useState } from 'react';

// Tiny Web Audio sound kit for games — no files, just short synthesized blips, so it
// adds zero assets and respects the dependency-free house rule. The AudioContext is
// created lazily on the first play (always inside a user gesture — games only make
// sound on input/collisions), and a per-user mute preference persists. Calls are
// fire-and-forget and never throw if audio is unavailable.

export type SoundName = 'eat' | 'hit' | 'score' | 'flip' | 'match' | 'win' | 'lose';

const TONES: Record<SoundName, { freq: number; dur: number; type: OscillatorType; slideTo?: number }> = {
  eat:   { freq: 660, dur: 0.08, type: 'square' },
  hit:   { freq: 240, dur: 0.06, type: 'triangle' },
  score: { freq: 880, dur: 0.10, type: 'sine' },
  flip:  { freq: 520, dur: 0.05, type: 'sine' },
  match: { freq: 720, dur: 0.14, type: 'triangle', slideTo: 980 },
  win:   { freq: 523, dur: 0.45, type: 'sine', slideTo: 1046 },
  lose:  { freq: 300, dur: 0.40, type: 'sawtooth', slideTo: 110 }
};

const MUTE_KEY = 'ds.game.muted.v1';
const readMuted = () => { try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; } };

export interface GameAudio {
  play: (name: SoundName) => void;
  muted: boolean;
  setMuted: (m: boolean) => void;
}

export const useGameAudio = (): GameAudio => {
  const [muted, setMutedState] = useState(readMuted);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const ctxRef = useRef<AudioContext | null>(null);

  const play = useCallback((name: SoundName) => {
    if (mutedRef.current || typeof window === 'undefined') return;
    try {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      let ctx = ctxRef.current;
      if (!ctx) { ctx = new Ctor(); ctxRef.current = ctx; }
      if (ctx.state === 'suspended') void ctx.resume();
      const t = TONES[name];
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = t.type;
      osc.frequency.setValueAtTime(t.freq, now);
      if (t.slideTo) osc.frequency.exponentialRampToValueAtTime(t.slideTo, now + t.dur);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.16, now + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + t.dur + 0.03);
    } catch {
      /* audio unavailable — silent, never fatal */
    }
  }, []);

  const setMuted = useCallback((m: boolean) => {
    setMutedState(m);
    try { localStorage.setItem(MUTE_KEY, m ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  return { play, muted, setMuted };
};
