/**
 * Live players for the segment rail.
 *
 * Segments arrive as independent, self-contained files (the studio rotates
 * MediaRecorder per segment), so playback works three ways, picked per device:
 *
 *  - `mse`  — classic Media Source Extensions: append segments to a
 *             SourceBuffer in 'sequence' mode (desktop Chrome/Edge/Firefox/Safari).
 *  - `mms`  — ManagedMediaSource, Safari's MSE on iPhone (iOS 17.1+). Same
 *             append pipeline; the element just needs remote playback disabled.
 *  - `blob` — no MSE at all (older iOS, embedded webviews): because every
 *             segment is an independently-playable file, we queue them and play
 *             each as an object-URL back to back. Slightly seamed, but live.
 *
 * All three handle out-of-order arrival (buffer by seq), missing segments
 * (skip ahead after a stall), live-edge chasing and memory eviction so
 * marathon sessions don't eat the viewer's RAM.
 */

export type PlaybackMode = 'mse' | 'mms' | 'blob' | 'none';

export interface LivePlayer {
  readonly mode: PlaybackMode;
  readonly wantedSeq: number;
  readonly pendingCount: number;
  start(fromSeq: number): void;
  push(seq: number, buf: ArrayBuffer): void;
  tick(isLive: boolean): void;
  bufferedAheadSec(): number;
  destroy(): void;
}

/** Safari's ManagedMediaSource isn't in TS's DOM lib yet. */
interface ManagedMediaSourceCtor {
  new (): MediaSource;
  isTypeSupported(mime: string): boolean;
}
const managedMediaSource = (): ManagedMediaSourceCtor | undefined =>
  (globalThis as { ManagedMediaSource?: ManagedMediaSourceCtor }).ManagedMediaSource;

/**
 * What the current browser can do with this stream's codec. Exported for the
 * viewer's diagnostics ("this device can't decode WebM" beats a black screen).
 */
export function playbackSupport(
  mime: string,
  probe?: { mse?: (m: string) => boolean; mms?: (m: string) => boolean; canPlayType?: (m: string) => string },
): PlaybackMode {
  const mseOk = probe?.mse
    ? probe.mse(mime)
    : typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
  if (mseOk) return 'mse';
  const mms = managedMediaSource();
  const mmsOk = probe?.mms ? probe.mms(mime) : !!mms && mms.isTypeSupported(mime);
  if (mmsOk) return 'mms';
  const canPlay = probe?.canPlayType
    ? probe.canPlayType(mime)
    : typeof document !== 'undefined'
      ? document.createElement('video').canPlayType(mime)
      : '';
  if (canPlay === 'probably' || canPlay === 'maybe') return 'blob';
  return 'none';
}

/** Picks the right implementation for this device, or null when none can play. */
export function createLivePlayer(video: HTMLVideoElement, mime: string, segMs: number): LivePlayer | null {
  const mode = playbackSupport(mime);
  if (mode === 'mse') return new SegmentPlayer(video, mime, segMs, MediaSource, 'mse');
  if (mode === 'mms') {
    // ManagedMediaSource refuses to attach while remote playback is possible.
    (video as HTMLVideoElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    return new SegmentPlayer(video, mime, segMs, managedMediaSource()!, 'mms');
  }
  if (mode === 'blob') return new BlobQueuePlayer(video, mime, segMs);
  return null;
}

export class SegmentPlayer implements LivePlayer {
  private mediaSource: MediaSource;
  private sb: SourceBuffer | null = null;
  private pending = new Map<number, ArrayBuffer>();
  private nextSeq = 1;
  private lastAppendAt = 0;
  private objectUrl: string | null = null;
  private destroyed = false;

  constructor(
    private video: HTMLVideoElement,
    private mime: string,
    private segMs: number,
    source: { new (): MediaSource } = MediaSource,
    readonly mode: PlaybackMode = 'mse',
  ) {
    this.mediaSource = new source();
  }

  static canPlay(mime: string): boolean {
    return playbackSupport(mime) === 'mse' || playbackSupport(mime) === 'mms';
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

/**
 * Last-resort player for browsers without any MSE: plays each self-contained
 * segment as an object URL, advancing on `ended`. Keeps at most a few segments
 * queued and jumps to the freshest one when it falls behind the live edge.
 */
export class BlobQueuePlayer implements LivePlayer {
  readonly mode: PlaybackMode = 'blob';
  private pending = new Map<number, ArrayBuffer>();
  private nextSeq = 1;
  private currentUrl: string | null = null;
  private playing = false;
  private lastAdvanceAt = 0;
  private destroyed = false;
  private onEnded = () => this.advance();
  private onError = () => this.advance();

  constructor(
    private video: HTMLVideoElement,
    private mime: string,
    private segMs: number,
  ) {}

  start(fromSeq: number): void {
    this.nextSeq = Math.max(1, fromSeq);
    this.lastAdvanceAt = performance.now();
    this.video.addEventListener('ended', this.onEnded);
    this.video.addEventListener('error', this.onError);
  }

  push(seq: number, buf: ArrayBuffer): void {
    if (this.destroyed || seq < this.nextSeq) return;
    this.pending.set(seq, buf);
    if (!this.playing) this.advance();
  }

  get wantedSeq(): number {
    return this.nextSeq;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  bufferedAheadSec(): number {
    return (this.pending.size * this.segMs) / 1000;
  }

  tick(isLive: boolean): void {
    if (this.destroyed) return;
    const stalledMs = performance.now() - this.lastAdvanceAt;
    // The segment we want never arrived — skip to the next one we have.
    if (this.pending.size > 0 && !this.pending.has(this.nextSeq) && stalledMs > this.segMs * 2.5) {
      this.nextSeq = Math.min(...this.pending.keys());
      if (!this.playing) this.advance();
    }
    // Fell behind the live edge — drop old segments and chase.
    if (isLive && this.pending.size > 4) {
      const keep = [...this.pending.keys()].sort((a, b) => a - b).slice(-3);
      for (const k of [...this.pending.keys()]) if (!keep.includes(k)) this.pending.delete(k);
      this.nextSeq = keep[0];
    }
    if (!this.playing && this.pending.has(this.nextSeq)) this.advance();
  }

  private advance(): void {
    if (this.destroyed) return;
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    const buf = this.pending.get(this.nextSeq);
    if (!buf) {
      this.playing = false;
      return;
    }
    this.pending.delete(this.nextSeq);
    this.nextSeq += 1;
    this.lastAdvanceAt = performance.now();
    this.currentUrl = URL.createObjectURL(new Blob([buf], { type: this.mime }));
    this.video.src = this.currentUrl;
    this.playing = true;
    this.video.play().catch(() => {
      /* resumes on user gesture */
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.pending.clear();
    this.video.removeEventListener('ended', this.onEnded);
    this.video.removeEventListener('error', this.onError);
    if (this.currentUrl) URL.revokeObjectURL(this.currentUrl);
  }
}
