/**
 * Streaming band-limited resampler (any rate → 16 kHz for the sound model).
 *
 * Windowed-sinc interpolation at fractional input positions, with the cutoff
 * just under the OUTPUT Nyquist so downsampling never aliases (a 48 kHz mic
 * squeezed to 16 kHz otherwise folds hiss and cry harmonics back into the
 * band the model listens to). 16 taps per output sample — about 0.3 M
 * multiply-adds per second at 48 kHz, negligible on any phone.
 */

const HALF = 8;

export class StreamResampler {
  private readonly ratio: number;
  private readonly fc: number;
  private buf = new Float32Array(0);
  /** Absolute input index of buf[0]. */
  private bufStart = 0;
  /** Absolute (fractional) input position of the next output sample. */
  private next = 0;

  constructor(readonly inRate: number, readonly outRate = 16_000) {
    this.ratio = inRate / outRate;
    // Cycles per input sample; 0.92 leaves a guard band below the new Nyquist.
    this.fc = Math.min(0.5, 0.5 / this.ratio) * 0.92;
  }

  push(x: Float32Array): Float32Array {
    if (this.ratio === 1) return x.slice();
    const merged = new Float32Array(this.buf.length + x.length);
    merged.set(this.buf);
    merged.set(x, this.buf.length);
    this.buf = merged;
    const end = this.bufStart + this.buf.length;
    const out: number[] = [];
    const twoFc = 2 * this.fc;
    while (this.next + HALF < end) {
      const p = this.next;
      const i0 = Math.floor(p);
      let acc = 0;
      let wsum = 0;
      for (let k = i0 - HALF + 1; k <= i0 + HALF; k++) {
        const idx = k - this.bufStart;
        const v = idx >= 0 ? this.buf[idx] : 0;
        const t = p - k;
        const arg = Math.PI * twoFc * t;
        const sinc = arg === 0 ? 1 : Math.sin(arg) / arg;
        const win = 0.5 * (1 + Math.cos((Math.PI * t) / HALF));
        const h = sinc * win;
        acc += v * h;
        wsum += h;
      }
      out.push(wsum !== 0 ? acc / wsum : 0);
      this.next += this.ratio;
    }
    const keepFrom = Math.floor(this.next) - HALF;
    if (keepFrom > this.bufStart) {
      this.buf = this.buf.slice(keepFrom - this.bufStart);
      this.bufStart = keepFrom;
    }
    return Float32Array.from(out);
  }
}

/** Fixed-length rolling window of the most recent samples. */
export class RollingWindow {
  private data: Float32Array;
  private filled = 0;
  /** Samples added since the last take(). */
  fresh = 0;

  constructor(readonly size: number) {
    this.data = new Float32Array(size);
  }

  push(x: Float32Array): void {
    if (x.length >= this.size) {
      this.data.set(x.subarray(x.length - this.size));
    } else {
      this.data.copyWithin(0, x.length);
      this.data.set(x, this.size - x.length);
    }
    this.filled = Math.min(this.size, this.filled + x.length);
    this.fresh += x.length;
  }

  get full(): boolean {
    return this.filled >= this.size;
  }

  /** A copy of the window (oldest → newest); resets the fresh counter. */
  take(): Float32Array {
    this.fresh = 0;
    return this.data.slice();
  }
}
