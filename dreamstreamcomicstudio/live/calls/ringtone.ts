// Call sounds, synthesized (no audio files): a gentle two-tone ring for an
// incoming call, a ringback while yours is ringing, a soft chime on connect
// and a falling tone when it ends. Kept quiet — these play in homes with
// sleeping babies.

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

/** Call from a tap so later sounds are allowed to play. */
export function unlockCallAudio(): void {
  audio();
}

function tone(freqs: number[], start: number, dur: number, gain: number): void {
  const ac = audio();
  if (!ac) return;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, ac.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, ac.currentTime + start + 0.02);
  g.gain.setValueAtTime(gain, ac.currentTime + start + dur - 0.05);
  g.gain.linearRampToValueAtTime(0, ac.currentTime + start + dur);
  g.connect(ac.destination);
  for (const f of freqs) {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    o.start(ac.currentTime + start);
    o.stop(ac.currentTime + start + dur + 0.02);
  }
}

export type RingKind = 'incoming' | 'ringback';

/** Loop a ring until the returned stop() is called. */
export function startRing(kind: RingKind): () => void {
  const play = () => {
    if (kind === 'incoming') {
      // Two short trills, like a phone, at a living-room level.
      for (let i = 0; i < 2; i++) {
        tone([660, 880], i * 0.45, 0.18, 0.09);
        tone([587, 784], i * 0.45 + 0.2, 0.18, 0.09);
      }
      try {
        navigator.vibrate?.([400, 200, 400]);
      } catch { /* no vibration */ }
    } else {
      tone([440, 480], 0, 1.6, 0.05); // the familiar ringback
    }
  };
  play();
  const t = window.setInterval(play, kind === 'incoming' ? 2600 : 4000);
  return () => {
    window.clearInterval(t);
    try {
      navigator.vibrate?.(0);
    } catch { /* no vibration */ }
  };
}

export function chime(kind: 'connected' | 'ended'): void {
  if (kind === 'connected') {
    tone([784], 0, 0.12, 0.06);
    tone([1047], 0.12, 0.16, 0.06);
  } else {
    tone([659], 0, 0.14, 0.06);
    tone([440], 0.15, 0.22, 0.06);
  }
}
