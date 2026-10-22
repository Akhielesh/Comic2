/**
 * How the camera phone shares its processor and uplink between the live
 * picture and everything else it does. Pure, so the numbers are tested
 * (videoBudget.unit.test.ts).
 *
 *  - Smart vision (object + pose models on the main thread) steps back when
 *    several people watch or the encoder reports the phone is busy. Sound and
 *    cry detection never do — they are the safety net.
 *  - The relay picture's JPEG frames (for viewers whose browser can't decode
 *    the relay video — relay.ts) pace themselves by what the socket can
 *    actually send: 2–5 frames a second, skipping rather than queueing.
 */

/**
 * Milliseconds between smart-vision frames. `cost` is one frame's inference
 * time on this phone, `peers` the viewers being encoded for (the relay counts
 * as one), `pressure` the rungs the encoder has stepped down for the CPU.
 */
export function sceneIntervalMs(cost: number, peers: number, pressure: number): number {
  let ms = cost > 400 ? 3000 : cost > 150 ? 1500 : 1000;
  if (peers >= 2) ms *= 2;
  if (pressure > 0) ms *= 3;
  return Math.min(6000, ms);
}

/** Bytes still queued on the socket above which the uplink is falling behind. */
export const RELAY_BACKLOG = 80 * 1024;
/** Never queue a frame behind more than this (client.sendBinary's limit for relay frames). */
export const RELAY_MAX_BUFFERED = 128 * 1024;
const CLEAR = 16 * 1024;

/**
 * Paces the camera's relay frames. Call `tick()` at `intervalMs`; it says
 * whether to grab and send a frame now. A backlog on the socket steps the
 * rate down at once; two seconds of a clear socket step it back up. JPEG
 * quality follows frame size (a dark, grainy nursery makes big frames).
 */
export class RelayPacer {
  fps: number;
  quality = 0.55;
  private clean = 0;
  private sent: number[] = [];

  constructor(readonly min = 2, readonly max = 5, start = 3) {
    this.fps = Math.max(min, Math.min(max, start));
  }

  get intervalMs(): number {
    return Math.round(1000 / this.fps);
  }

  /** `buffered`: the socket's bufferedAmount; `busy`: the previous frame is still encoding. */
  tick(buffered: number, busy = false): boolean {
    if (busy) return false;
    if (buffered > RELAY_BACKLOG) {
      this.onBacklog();
      return false;
    }
    if (buffered < CLEAR) {
      this.clean += 1;
      if (this.clean >= this.fps * 2 && this.fps < this.max) {
        this.fps += 1;
        this.clean = 0;
      }
    } else {
      this.clean = 0;
    }
    return true;
  }

  /** The socket is backed up (also when the caller skips frames at its own, lower mark): one step down. */
  onBacklog(): void {
    this.clean = 0;
    this.fps = Math.max(this.min, this.fps - 1);
  }

  /** A frame went out: `bytes` long, at `now`. */
  onSent(bytes: number, now: number): void {
    this.sent = [...this.sent.filter((t) => now - t < 5000), now];
    if (bytes > 60 * 1024) this.quality = Math.max(0.35, +(this.quality - 0.05).toFixed(2));
    else if (bytes < 24 * 1024) this.quality = Math.min(0.6, +(this.quality + 0.05).toFixed(2));
  }

  /** Frames actually sent per second over the last five seconds. */
  sentFps(now: number): number {
    const recent = this.sent.filter((t) => now - t < 5000);
    if (recent.length < 2) return recent.length;
    return Math.round(((recent.length - 1) / Math.max(1, (recent[recent.length - 1] - recent[0]) / 1000)) * 10) / 10;
  }
}

/** The viewer's side: how many relay frames a second really arrive, and whether they stopped. */
export class RelayMeter {
  private at: number[] = [];

  frame(now: number): void {
    this.at = [...this.at.filter((t) => now - t < 5000), now];
  }

  reset(): void {
    this.at = [];
  }

  get last(): number | null {
    return this.at.length ? this.at[this.at.length - 1] : null;
  }

  /** Frames per second over the last five seconds (rounded; 0 when none arrive). */
  fps(now: number): number {
    const recent = this.at.filter((t) => now - t < 5000);
    if (recent.length < 2) return 0;
    const span = Math.max(1000, now - recent[0]);
    return Math.max(1, Math.round(((recent.length - 1) / span) * 1000));
  }

  /** No frame for more than five seconds. */
  stale(now: number): boolean {
    const last = this.last;
    return last != null && now - last > 5000;
  }
}
