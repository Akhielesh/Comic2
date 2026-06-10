// Microphone capture for on-device dictation. Streams raw PCM into a growing
// Float32 buffer at 16 kHz (Whisper's native rate) so we can transcribe partial
// audio while recording and the full take on stop — no MediaRecorder containers,
// no decode step, no audio ever leaving the page.

export interface PcmRecorder {
  /** Audio captured so far, mono Float32 @ 16 kHz. */
  snapshot(): Float32Array;
  /** Seconds of audio captured so far. */
  duration(): number;
  /** Stop capture and release the microphone. Returns the final buffer. */
  stop(): Float32Array;
}

export const TARGET_SAMPLE_RATE = 16000;

/** Linear-interpolation resample — plenty for speech recognition input. */
const resample = (input: Float32Array, from: number, to: number): Float32Array => {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
};

export const dictationSupported = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== 'undefined';

/**
 * Start capturing the microphone. `onLevel` receives a 0..1 loudness roughly every
 * 50ms for the live waveform. Throws if the user denies mic permission.
 */
export const startPcmRecorder = async (onLevel?: (level: number) => void): Promise<PcmRecorder> => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const chunks: Float32Array[] = [];
  let length = 0;
  let stopped = false;

  // ScriptProcessorNode is deprecated but universally supported and exactly fits
  // "hand me raw PCM on the main thread" — an AudioWorklet adds a module round-trip
  // for no quality gain at dictation workloads.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  proc.onaudioprocess = (e) => {
    if (stopped) return;
    const data = e.inputBuffer.getChannelData(0);
    const copy = resample(data, ctx.sampleRate, TARGET_SAMPLE_RATE);
    chunks.push(copy);
    length += copy.length;
    if (onLevel) {
      let sum = 0;
      for (let i = 0; i < data.length; i += 8) sum += data[i] * data[i];
      onLevel(Math.min(1, Math.sqrt(sum / (data.length / 8)) * 4));
    }
  };
  source.connect(proc);
  // Keep the node pulling samples without echoing the mic to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  proc.connect(sink);
  sink.connect(ctx.destination);

  const merge = (): Float32Array => {
    const out = new Float32Array(length);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  };

  return {
    snapshot: merge,
    duration: () => length / TARGET_SAMPLE_RATE,
    stop: () => {
      stopped = true;
      try {
        proc.disconnect();
        source.disconnect();
        sink.disconnect();
      } catch {
        /* already torn down */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      return merge();
    }
  };
};
