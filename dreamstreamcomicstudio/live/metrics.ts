/** Tiny metric helpers for the live studio/viewer overlays. */

/** Exponential moving average — smooths jittery per-segment measurements. */
export class Ema {
  private v: number | null = null;
  constructor(private alpha = 0.3) {}
  push(x: number): number {
    this.v = this.v == null ? x : this.alpha * x + (1 - this.alpha) * this.v;
    return this.v;
  }
  get value(): number | null {
    return this.v;
  }
}

export const fmtBps = (bps: number | null): string => {
  if (bps == null) return '—';
  return bps >= 1_000_000 ? `${(bps / 1_000_000).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`;
};

export const fmtBytes = (b: number): string => {
  if (b >= 1_073_741_824) return `${(b / 1_073_741_824).toFixed(2)} GB`;
  if (b >= 1_048_576) return `${(b / 1_048_576).toFixed(1)} MB`;
  return `${Math.round(b / 1024)} KB`;
};

export const fmtDuration = (totalSec: number): string => {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
