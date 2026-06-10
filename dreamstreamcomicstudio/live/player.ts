/**
 * MSE player for the segment rail.
 *
 * Segments arrive as independent, self-contained files (the studio rotates
 * MediaRecorder per segment), so we append them in 'sequence' mode and let the
 * SourceBuffer restitch the timeline. Handles: out-of-order arrival (buffers
 * by seq), missing segments (skips ahead after a stall), live-edge chasing and
 * buffer eviction so marathon sessions don't eat the viewer's memory.
 */

export class SegmentPlayer {
  private mediaSource = new MediaSource();
  private sb: SourceBuffer | null = null;
  private pending = new Map<number, ArrayBuffer>();
  private nextSeq = 1;
  private lastAppendAt = 0;
  private objectUrl: string | null = null;
  private destroyed = false;

  constructor(private video: HTMLVideoElement, private mime: string, private segMs: number) {}

  static canPlay(mime: string): boolean {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
  }

  start(fromSeq: number): void {
    this.nextSeq = Math.max(1, fromSeq);
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    this.mediaSource.addEventListener('sourceopen', () => {
      if (this.destroyed || this.sb) return;
      this.sb = this.mediaSource.addSourceBuffer(this.mime);
      this.sb.mode = 'sequence';
      this.sb.addEventListener('updateend', () => this.pump());
      this.pump();
    });
  }

  /** Buffered media segment, possibly out of order. */
  push(seq: number, buf: ArrayBuffer): void {
    if (this.destroyed || seq < this.nextSeq) return;
    this.pending.set(seq, buf);
    this.pump();
  }

  get wantedSeq(): number {
    return this.nextSeq;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  bufferedAheadSec(): number {
    try {
      const b = this.video.buffered;
      if (b.length === 0) return 0;
      return Math.max(0, b.end(b.length - 1) - this.video.currentTime);
    } catch {
      return 0;
    }
  }

  /** Call periodically: un-stalls after gaps and keeps us near the live edge. */
  tick(isLive: boolean): void {
    if (this.destroyed) return;
    // A segment never arrived (upload hiccup) — skip to the next one we have.
    const stalledMs = performance.now() - this.lastAppendAt;
    if (this.pending.size > 0 && !this.pending.has(this.nextSeq) && stalledMs > this.segMs * 2.5) {
      this.nextSeq = Math.min(...this.pending.keys());
    }
    this.pump();
    if (isLive) this.chaseLiveEdge();
  }

  private pump(): void {
    if (!this.sb || this.sb.updating || this.destroyed) return;
    if (this.evictIfNeeded()) return; // remove() triggers updateend → pump runs again
    const buf = this.pending.get(this.nextSeq);
    if (!buf) return;
    this.pending.delete(this.nextSeq);
    this.nextSeq += 1;
    this.lastAppendAt = performance.now();
    try {
      this.sb.appendBuffer(buf);
    } catch {
      // QuotaExceeded and friends — drop buffer history and retry on next tick.
      this.pending.set(this.nextSeq - 1, buf);
      this.nextSeq -= 1;
    }
  }

  private evictIfNeeded(): boolean {
    if (!this.sb) return false;
    try {
      const b = this.video.buffered;
      if (b.length > 0 && this.video.currentTime - b.start(0) > 90) {
        this.sb.remove(b.start(0), this.video.currentTime - 30);
        return true;
      }
    } catch {
      /* buffered not readable yet */
    }
    return false;
  }

  private chaseLiveEdge(): void {
    try {
      const b = this.video.buffered;
      if (b.length === 0) return;
      const end = b.end(b.length - 1);
      // Fell too far behind (tab slept, slow network burst) — jump near the edge.
      if (end - this.video.currentTime > (this.segMs / 1000) * 3 + 2) {
        this.video.currentTime = end - 1;
      }
    } catch {
      /* seeking not possible yet */
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.pending.clear();
    try {
      if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
    } catch {
      /* already closed */
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}
