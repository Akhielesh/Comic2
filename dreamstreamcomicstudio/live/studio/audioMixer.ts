/**
 * ProgramAudioMixer — the audio half of the program mixer.
 *
 * The compositor's canvas gives the program its video track; this gives it ONE
 * stable audio track that is the live mix of host mic + every on-air guest.
 * Sources connect/disconnect mid-stream without touching the MediaRecorder
 * (the destination track never changes — exactly like the canvas trick).
 *
 * Track-level toggles still work: a muted source track simply contributes
 * silence. Browsers may start an AudioContext suspended until a user gesture;
 * `unlock()` is called on go-live (a click) so the program is never silent.
 */

export class ProgramAudioMixer {
  private ctx: AudioContext;
  private dest: MediaStreamAudioDestinationNode;
  private sources = new Map<string, { node: MediaStreamAudioSourceNode; gain: GainNode; analyser: AnalyserNode; stream: MediaStream }>();
  private levelBuf = new Uint8Array(128);

  constructor() {
    const Ctx = window.AudioContext || (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) throw new Error('WebAudio unavailable');
    this.ctx = new Ctx();
    this.dest = this.ctx.createMediaStreamDestination();
  }

  /** The mixed program audio track — hand this to the compositor's output. */
  get track(): MediaStreamTrack {
    return this.dest.stream.getAudioTracks()[0];
  }

  /** Resume a gesture-suspended context (call from a click handler). */
  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  /** Add (or replace) a named source. Only audio tracks are read. */
  addSource(id: string, stream: MediaStream, volume = 1): void {
    if (stream.getAudioTracks().length === 0) return;
    this.removeSource(id);
    try {
      const node = this.ctx.createMediaStreamSource(stream);
      const gain = this.ctx.createGain();
      gain.gain.value = volume;
      // Analyser taps the post-gain signal — it powers speaking indicators
      // and active-speaker focus without touching the mix.
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      node.connect(gain).connect(this.dest);
      gain.connect(analyser);
      this.sources.set(id, { node, gain, analyser, stream });
    } catch {
      /* stream ended between checks */
    }
  }

  removeSource(id: string): void {
    const s = this.sources.get(id);
    if (s) {
      try {
        s.node.disconnect();
        s.gain.disconnect();
        s.analyser.disconnect();
      } catch {
        /* already detached */
      }
      this.sources.delete(id);
    }
  }

  /** Instantaneous RMS level (0..~1) per source — who is talking right now.
   *  Muted tracks read ~0, so mic toggles are respected automatically. */
  levels(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, s] of this.sources) {
      try {
        s.analyser.getByteTimeDomainData(this.levelBuf);
        let sum = 0;
        for (let i = 0; i < this.levelBuf.length; i++) {
          const v = (this.levelBuf[i] - 128) / 128;
          sum += v * v;
        }
        out.set(id, Math.sqrt(sum / this.levelBuf.length));
      } catch {
        out.set(id, 0);
      }
    }
    return out;
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  close(): void {
    for (const id of Array.from(this.sources.keys())) this.removeSource(id);
    void this.ctx.close().catch(() => undefined);
  }
}
