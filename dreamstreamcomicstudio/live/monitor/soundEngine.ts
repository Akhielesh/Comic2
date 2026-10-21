/**
 * NurseryEars — the camera phone's listening pipeline.
 *
 *   mic ─┬─ AnalyserNode ── cry analyser (pitch/rhythm, 10 Hz)
 *        │                 └ smoke/CO beep-pattern detector (20 Hz)
 *        └─ ds-ears (AudioWorklet, every sample)
 *             ├─ A-weighted Fast level → LevelMeter (dB, per-minute stats) + NoiseGuard
 *             └─ PCM (once the model is ready) → resample 16 kHz → YAMNet worker (every 0.48 s)
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
import { HowlDetector, type HowlFrame } from './voice';
import {
  aWeighting,
  createLevelKernel,
  earsWorkletSource,
  LEVEL_BLOCK_SEC,
  LevelMeter,
  NoiseGuard,
  type Calibration,
  type LevelBlock,
  type LiveLevel,
  type MinuteLevels,
  type NoiseEvent,
} from './soundLevel';
import { startTicker, type Ticker } from '../studio/ticker';

export type ModelState = 'off' | 'loading' | 'ready' | 'failed';

export interface EarsSnapshot extends BrainState {
  /** dB above the noise floor, 0–60. */
  level: number;
  cry: number;
  model: ModelState;
  modelProgress: number;
  /** Sound level meter, dB(A); null until the meter is running. */
  spl: LiveLevel | null;
}

const WINDOW = 15_360; // 0.96 s at 16 kHz — one YAMNet patch
const HOP = 7_680; // 0.48 s


export class NurseryEars {
  readonly cry = new CryDetector('medium');
  readonly alarm = new AlarmToneDetector();
  readonly brain = new SoundBrain();
  readonly meter: LevelMeter;
  readonly noise = new NoiseGuard();
  onEvents: ((e: BrainEvent[]) => void) | null = null;
  onModel: ((s: ModelState, progress: number) => void) | null = null;
  onNoise: ((e: NoiseEvent[]) => void) | null = null;
  onMinute: ((m: MinuteLevels) => void) | null = null;
  /** Acoustic feedback while a parent's voice plays in the nursery. */
  onHowl: ((h: HowlFrame) => void) | null = null;
  private readonly howl = new HowlDetector();
  private playback = false;

  private ctx: AudioContext | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private tap: AudioNode | null = null;
  private tapPort: MessagePort | null = null;
  private pcmOn = false;
  private sink: GainNode | null = null;
  private meterOn = false;
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

  constructor(calibration: Calibration | null = null) {
    this.meter = new LevelMeter(calibration);
    this.meter.onMinute = (m) => this.onMinute?.(m);
  }

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
        const now = Date.now();
        this.alarmOn = this.alarm.push(spec, binHz, now).active;
        if (this.playback) {
          const h = this.howl.push(spec, binHz, now);
          if (h.howl) {
            this.howl.reset();
            this.onHowl?.(h);
          }
        }
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

    void this.startTap();
    if (opts.ai) this.startModel();
    if (import.meta.env?.DEV) (globalThis as unknown as { __dsEars?: unknown }).__dsEars = this;
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
        this.setPcm(true);
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

  /** The per-sample tap: level meter always, PCM for the model when it's ready. */
  private async startTap(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx || !this.src || this.tap) return;
    this.resampler = new StreamResampler(ctx.sampleRate, 16_000);
    // The tap must reach the destination to be pulled; a muted gain keeps it silent.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);
    const sos = aWeighting(ctx.sampleRate);
    try {
      if (!ctx.audioWorklet) throw new Error('no worklet');
      const url = URL.createObjectURL(new Blob([earsWorkletSource()], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (this.stopped || this.tap) return;
      const node = new AudioWorkletNode(ctx, 'ds-ears', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        processorOptions: { sos, block: LEVEL_BLOCK_SEC },
      });
      node.port.onmessage = (e) => {
        const m = e.data as { t: 'lv'; b: LevelBlock[] } | { t: 'pcm'; d: Float32Array };
        if (m.t === 'lv') this.onLevel(m.b);
        else this.feed(m.d);
      };
      this.tap = node;
      this.tapPort = node.port;
    } catch {
      // Older Safari: ScriptProcessor still works everywhere (same kernel, main thread).
      if (this.stopped || this.tap) return;
      const kernel = createLevelKernel(sos, ctx.sampleRate, LEVEL_BLOCK_SEC);
      const sp = ctx.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0);
        const out: LevelBlock[] = [];
        kernel.process(ch, out);
        if (out.length) this.onLevel(out);
        if (this.pcmOn) this.feed(new Float32Array(ch));
      };
      this.tap = sp;
    }
    this.meterOn = true;
    this.src.connect(this.tap);
    this.tap.connect(this.sink);
    if (this.model === 'ready') this.setPcm(true);
  }

  private setPcm(on: boolean): void {
    this.pcmOn = on;
    this.tapPort?.postMessage({ pcm: on });
  }

  private onLevel(blocks: LevelBlock[]): void {
    const now = Date.now();
    this.meter.push(blocks, now);
    const ev = this.noise.push(this.meter.live(now).db, now);
    if (ev.length) this.onNoise?.(ev);
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
    // The tap keeps measuring the sound level; only the model's feed stops.
    this.setPcm(false);
  }

  /** A parent's voice / video call is playing on this phone's speaker. */
  setPlayback(on: boolean): void {
    this.playback = on;
    if (!on) this.howl.reset();
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
    const now = Date.now();
    return {
      ...this.brain.state(now),
      level: this.last.level,
      cry: this.last.cry,
      model: this.model,
      modelProgress: this.modelProgress,
      spl: this.meterOn ? this.meter.live(now) : null,
    };
  }

  /** Apply (or clear) this phone's sound-meter calibration. */
  setCalibration(c: Calibration | null): void {
    this.meter.calibration = c;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  stop(): void {
    this.stopped = true;
    this.tickers.forEach((t) => t.stop());
    this.tickers = [];
    this.stopModel();
    this.tap?.disconnect();
    this.tap = null;
    this.tapPort = null;
    this.meterOn = false;
    this.src?.disconnect();
    this.sink?.disconnect();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
}
