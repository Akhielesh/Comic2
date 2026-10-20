/**
 * NurseryEars — the camera phone's listening pipeline.
 *
 *   mic ─┬─ AnalyserNode ── cry analyser (pitch/rhythm, 10 Hz)
 *        │                 └ smoke/CO beep-pattern detector (20 Hz)
 *        └─ PCM tap (AudioWorklet) ── resample → 16 kHz ── YAMNet worker (every 0.48 s)
 *                                                            │
 *                         SoundBrain (fusion, events, mood) ◄┘
 *
 * Everything runs on the phone. Nothing is recorded or uploaded — only the
 * resulting events and a few numbers go to the family's devices.
 */

import { AlarmToneDetector } from './alarmTone';
import { CryDetector, analyzeFrame, type DetectorState } from './cryDetector';
import { RollingWindow, StreamResampler } from './resample';
import { SoundBrain, type BrainEvent, type BrainState } from './soundBrain';
import type { CatScores, Sensitivity } from './soundClasses';
import { startTicker, type Ticker } from '../studio/ticker';

export type ModelState = 'off' | 'loading' | 'ready' | 'failed';

export interface EarsSnapshot extends BrainState {
  /** dB above the noise floor, 0–60. */
  level: number;
  cry: number;
  model: ModelState;
  modelProgress: number;
}

const WINDOW = 15_360; // 0.96 s at 16 kHz — one YAMNet patch
const HOP = 7_680; // 0.48 s

const TAP_SRC = `
class DsPcmTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(2048);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('ds-pcm-tap', DsPcmTap);
`;

export class NurseryEars {
  readonly cry = new CryDetector('medium');
  readonly alarm = new AlarmToneDetector();
  readonly brain = new SoundBrain();
  onEvents: ((e: BrainEvent[]) => void) | null = null;
  onModel: ((s: ModelState, progress: number) => void) | null = null;

  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private tap: AudioNode | null = null;
  private sink: GainNode | null = null;
  private tickers: Ticker[] = [];
  private worker: Worker | null = null;
  private busy = false;
  private runId = 0;
  private pending: CatScores | null = null;
  private resampler: StreamResampler | null = null;
  private window = new RollingWindow(WINDOW);
  private motion = 0;
  private alarmOn = false;
  private last = { level: 0, cry: 0, heur: 'calm' as DetectorState };
  private model: ModelState = 'off';
  private modelProgress = 0;
  private stopped = false;

  /** Call inside the user's tap (iOS only lets audio start from a gesture). */
  async start(stream: MediaStream, opts: { ai: boolean }): Promise<void> {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    this.ctx = ctx;
    void ctx.resume().catch(() => undefined);
    // iOS suspends audio for phone calls / Siri; pick back up afterwards.
    ctx.onstatechange = () => {
      if (!this.stopped && ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch(() => undefined);
    };
    this.attach(stream);

    const an = this.analyser!;
    const time = new Float32Array(an.fftSize);
    const spec = new Float32Array(an.frequencyBinCount);
    const binHz = ctx.sampleRate / an.fftSize;

    this.tickers.push(
      startTicker(50, () => {
        an.getFloatFrequencyData(spec);
        this.alarmOn = this.alarm.push(spec, binHz, Date.now()).active;
      }),
      startTicker(100, () => {
        an.getFloatTimeDomainData(time);
        const now = Date.now();
        const out = this.cry.push(analyzeFrame(time, ctx.sampleRate), now);
        this.last = { level: out.level, cry: out.cryConfidence, heur: out.state };
        const scores = this.pending;
        this.pending = null;
        const events = this.brain.update({ level: out.level, heur: out.state, heurCryConf: out.cryConfidence, alarmTone: this.alarmOn, motion: this.motion, scores }, now);
        if (events.length) this.onEvents?.(events);
      }),
    );

    if (opts.ai) this.startModel();
  }

  /** Re-wire to a new mic track (after a camera flip or an interruption). */
  attach(stream: MediaStream): void {
    const ctx = this.ctx;
    if (!ctx || !stream.getAudioTracks().length) return;
    this.src?.disconnect();
    this.src = ctx.createMediaStreamSource(stream);
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0;
    }
    this.src.connect(this.analyser);
    if (this.tap) this.src.connect(this.tap);
  }

  private startModel(): void {
    if (this.worker || this.stopped) return;
    const ctx = this.ctx;
    if (!ctx || typeof Worker === 'undefined') return this.setModel('failed', 0);
    let worker: Worker;
    try {
      worker = new Worker(new URL('./yamnet.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return this.setModel('failed', 0);
    }
    this.worker = worker;
    this.setModel('loading', 0);
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { t: string; p?: number; cats?: CatScores | null };
      if (m.t === 'progress') this.setModel('loading', m.p ?? 0);
      else if (m.t === 'ready') {
        this.setModel('ready', 1);
        void this.startTap();
      } else if (m.t === 'failed') {
        this.setModel('failed', 0);
        this.stopModel();
      } else if (m.t === 'scores') {
        this.busy = false;
        if (m.cats) this.pending = m.cats;
      }
    };
    worker.onerror = () => {
      this.setModel('failed', 0);
      this.stopModel();
    };
    worker.postMessage({ t: 'load' });
  }

  private async startTap(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.src || this.tap) return;
    this.resampler = new StreamResampler(ctx.sampleRate, 16_000);
    // The tap must reach the destination to be pulled; a muted gain keeps it silent.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);
    const onChunk = (chunk: Float32Array) => this.feed(chunk);
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      const url = URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(ctx, 'ds-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => onChunk(e.data as Float32Array);
      this.tap = node;
    } catch {
      // Older Safari: ScriptProcessor still works everywhere.
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
      this.tap = sp;
    }
    this.src.connect(this.tap);
    this.tap.connect(this.sink);
  }

  private feed(chunk: Float32Array): void {
    if (!this.resampler || !this.worker) return;
    this.window.push(this.resampler.push(chunk));
    if (!this.window.full || this.window.fresh < HOP || this.busy) return;
    this.busy = true;
    const wave = this.window.take();
    this.worker.postMessage({ t: 'run', id: ++this.runId, wave }, [wave.buffer]);
  }

  private setModel(s: ModelState, p: number): void {
    this.model = s;
    this.modelProgress = p;
    this.onModel?.(s, p);
  }

  private stopModel(): void {
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.tap?.disconnect();
    this.tap = null;
  }

  setMotion(m: number): void {
    this.motion = m;
  }

  setSensitivity(s: Sensitivity): void {
    this.cry.sensitivity = s;
    this.brain.sensitivity = s;
  }

  suppress(ms: number): void {
    const now = Date.now();
    this.cry.suppress(ms, now);
    this.brain.suppress(ms, now);
  }

  snapshot(): EarsSnapshot {
    return { ...this.brain.state(Date.now()), level: this.last.level, cry: this.last.cry, model: this.model, modelProgress: this.modelProgress };
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  stop(): void {
    this.stopped = true;
    this.tickers.forEach((t) => t.stop());
    this.tickers = [];
    this.stopModel();
    this.src?.disconnect();
    this.sink?.disconnect();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
