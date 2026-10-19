/**
 * Host-side segment delivery: an ordered upload queue with retry + backlog
 * shedding, and an adaptive-bitrate controller.
 *
 * Why: the old path fired every segment upload immediately with no retry. On
 * a wobbly uplink, uploads piled up and fought each other for bandwidth, one
 * failed POST left a permanent hole (viewers stalled ~15 s waiting for it),
 * and a stream encoded above the real uplink fell further behind every
 * segment until viewers froze. Now:
 *   - at most 2 uploads in flight, oldest first;
 *   - each segment retries 3× with backoff before it's given up on;
 *   - if the backlog grows past a few segments we drop the OLDEST queued ones
 *     (staying live beats being perfectly complete but a minute late);
 *   - the ABR controller lowers the encoder bitrate when uploads take too
 *     long relative to the segment length, and recovers it when they're fast.
 */

export interface UploadResult {
  elapsedMs: number;
  bytes: number;
}

export type UploadFn = (seq: number, durMs: number, blob: Blob) => Promise<UploadResult>;

export interface UploaderEvents {
  onUploaded?(seq: number, durMs: number, r: UploadResult): void;
  onFailed?(seq: number, err: unknown): void;
  onDropped?(seq: number): void;
  onBacklog?(pending: number): void;
}

interface Job {
  seq: number;
  durMs: number;
  blob: Blob;
  attempts: number;
}

export class SegmentUploader {
  private queue: Job[] = [];
  private inflight = 0;
  private closed = false;

  constructor(
    private upload: UploadFn,
    private ev: UploaderEvents = {},
    private opts: { concurrency?: number; maxAttempts?: number; maxBacklog?: number; backoffMs?: number[] } = {},
  ) {}

  get pending(): number {
    return this.queue.length + this.inflight;
  }

  enqueue(seq: number, durMs: number, blob: Blob): void {
    if (this.closed) return;
    this.queue.push({ seq, durMs, blob, attempts: 0 });
    this.queue.sort((a, b) => a.seq - b.seq);
    const maxBacklog = this.opts.maxBacklog ?? 4;
    while (this.queue.length > maxBacklog) {
      const dropped = this.queue.shift()!;
      this.ev.onDropped?.(dropped.seq);
    }
    this.ev.onBacklog?.(this.pending);
    this.pump();
  }

  close(): void {
    this.closed = true;
    this.queue = [];
  }

  private pump(): void {
    const concurrency = this.opts.concurrency ?? 2;
    while (!this.closed && this.inflight < concurrency && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.inflight += 1;
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    const maxAttempts = this.opts.maxAttempts ?? 3;
    const backoff = this.opts.backoffMs ?? [400, 1200, 2500];
    try {
      const r = await this.upload(job.seq, job.durMs, job.blob);
      this.ev.onUploaded?.(job.seq, job.durMs, r);
    } catch (err) {
      job.attempts += 1;
      if (!this.closed && job.attempts < maxAttempts) {
        await new Promise((res) => setTimeout(res, backoff[Math.min(job.attempts - 1, backoff.length - 1)]));
        if (!this.closed) {
          this.inflight -= 1;
          this.queue.unshift(job); // retry keeps its place at the front
          this.pump();
          return;
        }
      }
      this.ev.onFailed?.(job.seq, err);
    }
    this.inflight -= 1;
    this.ev.onBacklog?.(this.pending);
    this.pump();
  }
}

/**
 * Adaptive bitrate from upload timing. `ratio` = upload time / segment length:
 * above ~0.75 the uplink can't keep up (we'd fall behind live), below ~0.4
 * there's headroom. Steps down fast (−25%), recovers slowly (+12% after 3
 * healthy segments), never below `floorBps` or above the target.
 */
export class AbrController {
  private bps: number;
  private healthyRun = 0;

  constructor(private targetBps: number, private floorBps = Math.max(350_000, Math.round(targetBps * 0.3))) {
    this.bps = targetBps;
  }

  get current(): number {
    return this.bps;
  }

  /** Feed one finished upload; returns the bitrate to use for the next segment. */
  observe(uploadMs: number, segMs: number, backlog: number): number {
    const ratio = uploadMs / Math.max(1, segMs);
    if (ratio > 0.75 || backlog > 2) {
      this.healthyRun = 0;
      this.bps = Math.max(this.floorBps, Math.round(this.bps * 0.75));
    } else if (ratio < 0.4 && backlog <= 1) {
      this.healthyRun += 1;
      if (this.healthyRun >= 3 && this.bps < this.targetBps) {
        this.healthyRun = 0;
        this.bps = Math.min(this.targetBps, Math.round(this.bps * 1.12));
      }
    } else {
      this.healthyRun = 0;
    }
    return this.bps;
  }

  /** A segment upload failed outright — treat as congestion. */
  failed(): number {
    this.healthyRun = 0;
    this.bps = Math.max(this.floorBps, Math.round(this.bps * 0.7));
    return this.bps;
  }

  /** Viewers-facing quality label for the current step. */
  get degraded(): boolean {
    return this.bps < this.targetBps * 0.95;
  }
}
