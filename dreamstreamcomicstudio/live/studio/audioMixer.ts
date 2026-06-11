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
  private sources = new Map<string, { node: MediaStreamAudioSourceNode; gain: GainNode; stream: MediaStream }>();

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
      node.connect(gain).connect(this.dest);
      this.sources.set(id, { node, gain, stream });
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
      } catch {
        /* already detached */
      }
      this.sources.delete(id);
    }
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  close(): void {
    for (const id of Array.from(this.sources.keys())) this.removeSource(id);
    void this.ctx.close().catch(() => undefined);
  }
}
