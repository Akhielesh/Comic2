/**
 * Event ids (ADR 0006 D5.1): every camera event carries `eid = "<dev>:<seq>"`, minted where
 * it happened (the web camera from Phase 0, the nursery hub from Phase 4). Every path stores
 * it with `ON CONFLICT DO NOTHING`, and viewers alert on the FIRST arrival — over the data
 * channel or through the room, whichever is quicker — and drop the duplicate.
 *
 * `seq` starts from the clock and only goes up, so a camera that reloads (and forgets its
 * counter) never reuses an id: a reused id would make a real new alert look like a duplicate.
 */

/** A device id (the camera's `dev`, or a 22-character devId): letters, digits, `_` and `-`. */
const DEV_RE = /^[A-Za-z0-9_-]{1,40}$/;
const EID_RE = /^([A-Za-z0-9_-]{1,40}):(0|[1-9][0-9]{0,15})$/;
/** Longest eid: 40 + 1 + 16. */
export const EID_MAX = 57;

export interface Eid {
  dev: string;
  seq: number;
}

export function mintEid(dev: string, seq: number): string {
  if (!DEV_RE.test(dev)) throw new Error('eid: bad device id');
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('eid: bad sequence');
  return `${dev}:${seq}`;
}

/** The parts of an eid, or null when it isn't one. */
export function parseEid(v: unknown): Eid | null {
  if (typeof v !== 'string' || v.length > EID_MAX) return null;
  const m = EID_RE.exec(v);
  if (!m) return null;
  const seq = Number(m[2]);
  return Number.isSafeInteger(seq) ? { dev: m[1], seq } : null;
}

export const isEid = (v: unknown): v is string => parseEid(v) !== null;

/**
 * Mints a device's eids: `seq` = max(last + 1, now), so it rises across reloads as long as
 * the clock does, and never repeats within one run even if the clock steps back.
 */
export class EidMinter {
  readonly dev: string;
  private last: number;
  private readonly clock: () => number;

  /** `last`: the highest seq this device used before (persisted), if known. */
  constructor(dev: string, last = 0, clock: () => number = () => Date.now()) {
    if (!DEV_RE.test(dev)) throw new Error('eid: bad device id');
    this.dev = dev;
    this.last = Math.max(0, Math.floor(last));
    this.clock = clock;
  }

  next(): string {
    this.last = Math.max(this.last + 1, Math.floor(this.clock()));
    return mintEid(this.dev, this.last);
  }

  /** The last seq handed out (persist it to survive a clock that steps back across reloads). */
  get seq(): number {
    return this.last;
  }
}

/**
 * First-arrival dedupe for viewers: `first(eid)` is true the first time an eid is seen and
 * false after. Bounded (oldest forgotten first). Events without an eid always count as first
 * — they come from cameras before eids, and missing an alert is worse than showing it twice.
 */
export class EidSeen {
  private readonly seen = new Set<string>();
  private readonly max: number;

  constructor(max = 512) {
    this.max = Math.max(1, max);
  }

  first(eid: string | null | undefined): boolean {
    if (!eid || !isEid(eid)) return true;
    if (this.seen.has(eid)) return false;
    this.seen.add(eid);
    if (this.seen.size > this.max) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  has(eid: string): boolean {
    return this.seen.has(eid);
  }

  get size(): number {
    return this.seen.size;
  }
}
