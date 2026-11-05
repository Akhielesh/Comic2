// Page-turn sound (reader.md §6.5): synthesized with WebAudio — a short burst of noise through a
// sweeping band-pass with a quick swell and fade. No audio asset, no licence, $0. Off by default; the
// AudioContext is created in the gesture that turns sound on (primePaperSound), else on the first turn.

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

const audioCtor = (): AudioCtor | null => {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return w.AudioContext || w.webkitAudioContext || null;
};

const ensure = (): AudioContext | null => {
  if (ctx) return ctx;
  const Ctor = audioCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    const len = Math.floor(ctx.sampleRate * 0.3);
    noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    // Pinkish noise: softer than white, more like paper.
    let last = 0;
    for (let i = 0; i < len; i += 1) {
      const white = Math.random() * 2 - 1;
      last = 0.82 * last + 0.18 * white;
      data[i] = last * 2.4;
    }
    return ctx;
  } catch {
    ctx = null;
    return null;
  }
};

/** Play one page-turn swish. `soft` for a cancelled turn, `heavy` for the cover board. Never throws. */
export function playPageTurn(kind: 'turn' | 'soft' | 'heavy' = 'turn'): void {
  const ac = ensure();
  if (!ac || !noise) return;
  try {
    if (ac.state === 'suspended') void ac.resume();
    const t0 = ac.currentTime + 0.01;
    const pitch = 1 + (Math.random() * 0.16 - 0.08);
    const src = ac.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = pitch * (kind === 'heavy' ? 0.7 : 1);
    const band = ac.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 0.9;
    band.frequency.setValueAtTime(1600 * pitch, t0);
    band.frequency.exponentialRampToValueAtTime(3200 * pitch, t0 + 0.24);
    const gain = ac.createGain();
    const peak = kind === 'soft' ? 0.07 : kind === 'heavy' ? 0.2 : 0.16;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
    src.connect(band).connect(gain).connect(ac.destination);
    src.start(t0);
    src.stop(t0 + 0.3);
  } catch {
    /* audio unavailable — silent */
  }
}

/**
 * Create/resume the AudioContext inside the user's gesture that turned sound on: iOS Safari only lets
 * audio start from a gesture's call stack, and turns play later from animation frames.
 */
export function primePaperSound(): void {
  const ac = ensure();
  try {
    if (ac && ac.state === 'suspended') void ac.resume();
  } catch {
    /* audio unavailable — silent */
  }
}

/** Release the audio context (reader closed). */
export function closePaperSound(): void {
  try {
    void ctx?.close();
  } catch {
    /* closed */
  }
  ctx = null;
  noise = null;
}
