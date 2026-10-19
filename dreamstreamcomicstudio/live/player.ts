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
  /** Stall recoveries so far (gap jumps + live-edge chases) — for the metrics overlay. */
  readonly recoveries: number;
  /** Fired when the decoder/MSE pipeline died; the caller rebuilds the player. */
  onFatal: ((reason: string) => void) | null;
  start(fromSeq: number): void;
  push(seq: number, buf: ArrayBuffer): void;
  tick(isLive: boolean): void;
  bufferedAheadSec(): number;
  destroy(): void;
}

/**
 * Where to jump when playback is parked at a hole in the buffer. Each segment
 * is its own recording, so audio and video rarely end on the exact same
 * timestamp and MSE leaves tiny gaps between appends — browsers simply STOP at
 * a gap and wait forever (the "plays a few seconds then freezes" bug). If the
 * playhead is at/inside a gap and buffered media resumes within `maxGapSec`,
 * return the time to seek to; otherwise null.
 */
export function findGapJump(ranges: [number, number][], t: number, maxGapSec = 3.5): number | null {
  for (let i = 0; i < ranges.length; i++) {
    const [start, end] = ranges[i];
    if (t >= start && t < end - 0.25) return null; // comfortably inside data — not a gap
    const next = ranges[i + 1];
    if (!next) continue;
    const atEdge = t >= end - 0.25 && t < next[0];
    if (atEdge && next[0] - t <= maxGapSec) return next[0] + 0.05;
  }
  // Playhead before the first range (fresh join): snap to its start.
  if (ranges.length && t < ranges[0][0] && ranges[0][0] - t <= maxGapSec) return ranges[0][0] + 0.05;
  return null;
}

/**
 * Gentle latency control instead of hard jumps: drift slightly faster when
 * we've accumulated too much buffer (we're far behind live), slightly slower
 * when the buffer is thin (avoid a stall while the next segment downloads).
 * Pitch is preserved by browsers, so ±6% is inaudible.
 */
export function catchUpRate(aheadSec: number, targetSec: number): number {
  if (aheadSec < 1) return 0.94;
  if (aheadSec < 2) return 0.97;
  if (aheadSec > targetSec * 2) return 1.08;
  if (aheadSec > targetSec + 3) return 1.04;
  return 1;
}

function bufferedRanges(video: HTMLVideoElement): [number, number][] {
  const out: [number, number][] = [];
  try {
    const b = video.buffered;
    for (let i = 0; i < b.length; i++) out.push([b.start(i), b.end(i)]);
  } catch {
    /* not readable yet */
  }
  return out;
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
  private lastT = -1;
  private lastProgressAt = 0;
  private appendErrors = 0;
  recoveries = 0;
  onFatal: ((reason: string) => void) | null = null;
  private onVideoError = () => {
    const code = this.video.error?.code;
    if (!this.destroyed && code != null && code !== 1) this.onFatal?.(`media error ${code}`);
  };

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
    this.lastProgressAt = performance.now();
    this.objectUrl = URL.createObjectURL(this.mediaSource);
    this.video.src = this.objectUrl;
    this.video.addEventListener('error', this.onVideoError);
    this.mediaSource.addEventListener('sourceopen', () => {
      if (this.destroyed || this.sb) return;
      try {
        this.sb = this.mediaSource.addSourceBuffer(this.mime);
      } catch {
        this.onFatal?.('codec rejected');
        return;
      }
      this.sb.mode = 'sequence';
      this.sb.addEventListener('updateend', () => this.pump());
      this.sb.addEventListener('error', () => this.onFatal?.('source buffer error'));
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
    const now = performance.now();
    // A segment never arrived (upload dropped it) — skip to the next one we
    // have. The fetcher retries first, so this only fires for real holes.
    const stalledMs = now - this.lastAppendAt;
    if (this.pending.size > 0 && !this.pending.has(this.nextSeq) && stalledMs > this.segMs * 1.6) {
      this.nextSeq = Math.min(...this.pending.keys());
    }
    this.pump();

    // Stall watchdog: playhead stuck while media exists past a gap → hop it.
    const t = this.video.currentTime;
    if (Math.abs(t - this.lastT) > 0.01) {
      this.lastT = t;
      this.lastProgressAt = now;
    } else if (!this.video.paused && now - this.lastProgressAt > 700) {
      const jump = findGapJump(bufferedRanges(this.video), t);
      if (jump != null) {
        try {
          this.video.currentTime = jump;
          this.recoveries += 1;
          this.lastProgressAt = now;
        } catch {
          /* not seekable yet */
        }
      }
    }
    if (this.video.paused && this.video.readyState >= 3) this.video.play().catch(() => undefined);

    if (isLive) {
      this.chaseLiveEdge();
      const rate = catchUpRate(this.bufferedAheadSec(), (this.segMs / 1000) * 1.5);
      if (Math.abs(this.video.playbackRate - rate) > 0.001) this.video.playbackRate = rate;
    } else if (this.video.playbackRate !== 1) {
      this.video.playbackRate = 1;
    }
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
      this.appendErrors = 0;
    } catch (e) {
      this.pending.set(this.nextSeq - 1, buf);
      this.nextSeq -= 1;
      if ((e as DOMException)?.name === 'QuotaExceededError') {
        // Phones have small MSE quotas: free everything already played.
        this.evictIfNeeded(true);
      } else if (++this.appendErrors >= 3) {
        this.onFatal?.('append failed');
      }
    }
  }

  private evictIfNeeded(force = false): boolean {
    if (!this.sb || this.sb.updating) return false;
    try {
      const b = this.video.buffered;
      const keepBehind = force ? 3 : 30;
      if (b.length > 0 && this.video.currentTime - b.start(0) > (force ? keepBehind + 1 : 90)) {
        this.sb.remove(b.start(0), this.video.currentTime - keepBehind);
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
      // Fell far behind (tab slept, slow network burst) — jump near the edge.
      // Smaller drifts are absorbed by catchUpRate() without a visible jump.
      if (end - this.video.currentTime > (this.segMs / 1000) * 3 + 2) {
        this.video.currentTime = Math.max(this.video.currentTime, end - (this.segMs / 1000) * 1.2);
        this.recoveries += 1;
      }
    } catch {
      /* seeking not possible yet */
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.pending.clear();
    this.video.removeEventListener('error', this.onVideoError);
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
  recoveries = 0;
  onFatal: ((reason: string) => void) | null = null;
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
