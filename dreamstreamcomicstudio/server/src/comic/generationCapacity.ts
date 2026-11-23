import { COMIC_IMAGE_CONCURRENCY, COMIC_TEXT_CONCURRENCY } from '../config.js';
import { StudioError } from './types.js';

interface Waiter {
  start(): void;
  bytes: number;
  ownKey: boolean;
}

const busy = () => new StudioError('BUSY', 'Generation is busy. This step has not started. Please try again shortly.', { status: 429, retryable: true });
const cancelled = () => new StudioError('CANCELLED', 'Generation was cancelled before it started.', { status: 499 });

/** One process serves the named backend container. Round-robin applies across accounts, FIFO within each account. */
export class GenerationQueue {
  private active = 0;
  private platformActive = 0;
  private waiting = 0;
  private waitingBytes = 0;
  private readonly running = new Map<string, number>();
  private readonly queues = new Map<string, Set<Waiter>>();

  constructor(private readonly slots: number, private readonly perCreator: number, private readonly limits: {
    maxWaiting?: number; maxCreatorWaiting?: number; maxBytes?: number; platformSlots?: number;
  } = {}) {}

  async run<T>(creator: string, signal: AbortSignal | undefined, work: () => Promise<T>, options: {
    bytes?: number; waitMs?: number; ownKey?: boolean;
  } = {}): Promise<T> {
    const { bytes = 0, waitMs = 12 * 60_000, ownKey = false } = options;
    if (signal?.aborted) throw cancelled();
    if (this.canStart(creator, ownKey)) {
      this.start(creator, ownKey);
    } else {
      const group = this.queues.get(creator) ?? new Set<Waiter>();
      if (this.waiting >= (this.limits.maxWaiting ?? 384) || group.size >= (this.limits.maxCreatorWaiting ?? 16) ||
          this.waitingBytes + bytes > (this.limits.maxBytes ?? 48 * 1024 * 1024)) throw busy();
      await new Promise<void>((resolve, reject) => {
        const clean = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const entry: Waiter = { bytes, ownKey, start: () => { clean(); resolve(); } };
        const leave = (error: StudioError) => {
          if (!group.delete(entry)) return;
          this.waiting--;
          this.waitingBytes -= bytes;
          if (!group.size) this.queues.delete(creator);
          clean();
          reject(error);
        };
        const onAbort = () => leave(cancelled());
        const timer = setTimeout(() => leave(busy()), waitMs);
        timer.unref?.();
        signal?.addEventListener('abort', onAbort, { once: true });
        group.add(entry);
        this.queues.set(creator, group);
        this.waiting++;
        this.waitingBytes += bytes;
      });
    }
    try {
      if (signal?.aborted) throw cancelled();
      return await work();
    } finally {
      this.active--;
      if (!ownKey) this.platformActive--;
      const count = this.running.get(creator)! - 1;
      if (count) this.running.set(creator, count);
      else this.running.delete(creator);
      this.next();
    }
  }

  private canStart(creator: string, ownKey: boolean) {
    return this.active < this.slots && (this.running.get(creator) ?? 0) < this.perCreator &&
      (ownKey || this.platformActive < (this.limits.platformSlots ?? this.slots));
  }

  private start(creator: string, ownKey: boolean) {
    if (!ownKey) this.platformActive++;
    this.running.set(creator, (this.running.get(creator) ?? 0) + 1);
    this.active++;
  }

  private next() {
    for (const [creator, group] of this.queues) {
      const entry = group.values().next().value!;
      if (!this.canStart(creator, entry.ownKey)) continue;
      group.delete(entry);
      this.queues.delete(creator);
      if (group.size) this.queues.set(creator, group);
      this.waiting--;
      this.waitingBytes -= entry.bytes;
      this.start(creator, entry.ownKey);
      entry.start();
      return;
    }
  }
}

// BYOK jobs may use all available slots; platform jobs leave headroom for independent provider accounts.
export const comicTextCapacity = new GenerationQueue(COMIC_TEXT_CONCURRENCY + 4, 6, { platformSlots: COMIC_TEXT_CONCURRENCY });
export const comicImageCapacity = new GenerationQueue(COMIC_IMAGE_CONCURRENCY + 2, 3, { platformSlots: COMIC_IMAGE_CONCURRENCY });
