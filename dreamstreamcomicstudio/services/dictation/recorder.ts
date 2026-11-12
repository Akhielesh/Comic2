// Microphone capture for on-device dictation. Streams raw PCM into a growing
// Float32 buffer at 16 kHz (Whisper's native rate) so we can transcribe partial
// audio while recording and the full take on stop — no MediaRecorder containers,
// no decode step, no audio ever leaving the page.
//
// The microphone is never left on: if anything after getUserMedia fails (the audio
// graph, a context that will not start), every track is stopped before the error is
// thrown, and stop() always stops every track and closes the context. When the browser
// ends a track itself (permission revoked, the device unplugged), `onEnded` says so,
// so the take never keeps saying "Listening" with nothing captured.

import { DictationError } from './errors';

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
 * An AudioContext made inside the person's tap, so browsers that only start audio from a gesture
 * (iOS Safari) let it run later, after a model download. Null where it cannot be made.
 */
export const createAudioContext = (): AudioContext | null => {
  try {
    return typeof AudioContext === 'undefined' ? null : new AudioContext();
  } catch {
    return null;
  }
};

const RESUME_WAIT_MS = 1500;

/** Resume a suspended context; give up after a short wait (a context that never starts captures nothing). */
const resumeContext = async (ctx: AudioContext): Promise<void> => {
  if (ctx.state !== 'suspended') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ctx.resume(), new Promise<void>((r) => (timer = setTimeout(r, RESUME_WAIT_MS)))]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

export interface PcmRecorderOptions {
  /** A context made in the tap (createAudioContext). The recorder owns it from here and closes it on stop. */
  context?: AudioContext | null;
  /**
   * The browser ended the microphone on its own (permission revoked in site settings, the device unplugged):
   * capture has stopped, so the take must end too. Never called for our own stop().
   */
  onEnded?: () => void;
}

/**
 * Start capturing the microphone. `onLevel` receives a 0..1 loudness roughly every
 * 50ms for the live waveform. Throws if the user denies mic permission, and throws
 * `audio-suspended` (after stopping the tracks) if the audio context will not start.
 */
export const startPcmRecorder = async (onLevel?: (level: number) => void, opts: PcmRecorderOptions = {}): Promise<PcmRecorder> => {
  let ctx: AudioContext | null = opts.context ?? null;
  const closeContext = () => {
    try {
      if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => undefined);
    } catch {
      /* already closed */
    }
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    });
  } catch (e) {
    closeContext();
    throw e;
  }
  const tracks = stream.getTracks();
  // The track's own `ended`: fired by the browser only, never by our stop() (and removed before it anyway).
  let endedFired = false;
  const onTrackEnded = () => {
    if (endedFired) return;
    endedFired = true;
    opts.onEnded?.();
  };
  const unwatchTracks = () =>
    tracks.forEach((t) => {
      try {
        t.removeEventListener?.('ended', onTrackEnded);
      } catch {
        /* nothing to remove */
      }
    });
  const stopTracks = () => {
    unwatchTracks();
    tracks.forEach((t) => {
      try {
        t.stop();
      } catch {
        /* already ended */
      }
    });
  };
  let source: MediaStreamAudioSourceNode;
  try {
    ctx ??= new AudioContext();
    await resumeContext(ctx);
    if (ctx.state !== 'running') throw new DictationError('audio-suspended', `AudioContext is ${ctx.state}`);
    source = ctx.createMediaStreamSource(stream);
  } catch (e) {
    stopTracks();
    closeContext();
    throw e;
  }
  const live = ctx as AudioContext;
  const chunks: Float32Array[] = [];
  let length = 0;
  let stopped = false;

  // ScriptProcessorNode is deprecated but universally supported and exactly fits
  // "hand me raw PCM on the main thread" — an AudioWorklet adds a module round-trip
  // for no quality gain at dictation workloads.
  let proc: ScriptProcessorNode;
  let sink: GainNode;
  try {
    proc = live.createScriptProcessor(4096, 1, 1);
    sink = live.createGain();
  } catch (e) {
    stopTracks();
    closeContext();
    throw e;
  }
  proc.onaudioprocess = (e) => {
    if (stopped) return;
    const data = e.inputBuffer.getChannelData(0);
    const copy = resample(data, live.sampleRate, TARGET_SAMPLE_RATE);
    chunks.push(copy);
    length += copy.length;
    if (onLevel) {
      let sum = 0;
      for (let i = 0; i < data.length; i += 8) sum += data[i] * data[i];
      onLevel(Math.min(1, Math.sqrt(sum / (data.length / 8)) * 4));
    }
  };
  source.connect(proc);
  for (const t of tracks) {
    try {
      t.addEventListener?.('ended', onTrackEnded);
    } catch {
      /* a track without events: the take still ends on Done, the limit or a hidden tab */
    }
  }
  // Keep the node pulling samples without echoing the mic to the speakers.
  sink.gain.value = 0;
  proc.connect(sink);
  sink.connect(live.destination);

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
      if (!stopped) {
        stopped = true;
        try {
          proc.disconnect();
          source.disconnect();
          sink.disconnect();
        } catch {
          /* already torn down */
        }
        stopTracks();
        closeContext();
      }
      return merge();
    }
  };
};
