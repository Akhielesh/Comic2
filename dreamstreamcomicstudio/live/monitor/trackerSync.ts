/**
 * The tracker's live copy on this device: entries for the window on screen,
 * running timers, and an offline queue. Saving is optimistic — the entry
 * shows at once, waits in localStorage if the nursery's room can't be
 * reached, and is sent on the next connection. If the room refuses it
 * (a viewer, a bad value) the change is undone and the reason shown.
 */

import type { MonQuery } from './query';
import type { BabyProfile, TrackItem } from './trackTypes';

type Op = { op: 'put'; item: TrackItem; prev: TrackItem | null } | { op: 'del'; id: string; prev: TrackItem | null };

export interface TrackerSnapshot {
  items: TrackItem[];
  /** Camera-detected sleep for the loaded window. */
  auto: TrackItem[];
  running: TrackItem[];
  /** Entries waiting to reach the room. */
  pending: number;
  loaded: { from: number; to: number } | null;
  loading: boolean;
}

export const newTrackId = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(9));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export class TrackerSync {
  private items = new Map<string, TrackItem>();
  private auto: TrackItem[] = [];
  private queue = new Map<string, Op>();
  private listeners = new Set<() => void>();
  private snap: TrackerSnapshot | null = null;
  private send: ((m: Record<string, unknown>) => void) | null = null;
  private query: MonQuery | null = null;
  private loaded: { from: number; to: number } | null = null;
  private loading = false;
  onError: ((msg: string) => void) | null = null;
  onBaby: ((b: BabyProfile | null) => void) | null = null;

  constructor(private nid: string) {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) || '[]') as Op[];
      for (const op of raw) this.applyLocal(op);
    } catch { /* storage unavailable or corrupt: start clean */ }
  }

  private get key() {
    return `ds-track-queue-${this.nid}`;
  }

  /* -------------------------------------------------------------- store */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  snapshot = (): TrackerSnapshot => {
    if (!this.snap) {
      const items = [...this.items.values()].sort((a, b) => a.start - b.start);
      this.snap = { items, auto: this.auto, running: items.filter((i) => i.end == null), pending: this.queue.size, loaded: this.loaded, loading: this.loading };
    }
    return this.snap;
  };

  private emit(): void {
    this.snap = null;
    for (const fn of this.listeners) fn();
  }

  private persist(): void {
    try {
      if (this.queue.size) localStorage.setItem(this.key, JSON.stringify([...this.queue.values()]));
      else localStorage.removeItem(this.key);
    } catch { /* storage unavailable: the queue lives for this visit */ }
  }

  private applyLocal(op: Op): void {
    const id = op.op === 'put' ? op.item.id : op.id;
    // Keep the oldest "before" so an undo goes back to what the room has.
    const first = this.queue.get(id);
    const prev = first ? first.prev : op.prev;
    this.queue.set(id, op.op === 'put' ? { op: 'put', item: op.item, prev } : { op: 'del', id, prev });
    if (op.op === 'put') this.items.set(op.item.id, op.item);
    else this.items.delete(op.id);
  }

  /* ---------------------------------------------------------- connection */
  /** The room said hello: flush what was waiting, then refresh the window. */
  attach(send: (m: Record<string, unknown>) => void, query: MonQuery, hello?: { running?: TrackItem[] }): void {
    this.send = send;
    this.query = query;
    for (const r of hello?.running ?? []) if (!this.queue.has(r.id)) this.items.set(r.id, r);
    for (const op of this.queue.values()) this.sendOp(op);
    if (this.loaded) void this.load(this.loaded.from, this.loaded.to);
    this.emit();
  }

  detach(): void {
    this.send = null;
    this.query = null;
  }

  private sendOp(op: Op): void {
    if (!this.send) return;
    if (op.op === 'put') this.send({ t: 'track_put', item: { id: op.item.id, kind: op.item.kind, start: op.item.start, end: op.item.end, data: op.item.data } });
    else this.send({ t: 'track_del', id: op.id });
  }

  /** Messages from the room. Returns true when it was a tracker message. */
  handle(m: { t: string; item?: TrackItem; id?: string; msg?: string }): boolean {
    if (m.t === 'track' && m.item) {
      const q = this.queue.get(m.item.id);
      if (q?.op === 'put') {
        this.queue.delete(m.item.id);
        this.persist();
      }
      // Our own newer local edit still waiting wins until it lands.
      if (!this.queue.has(m.item.id)) this.items.set(m.item.id, m.item);
      this.emit();
      return true;
    }
    if (m.t === 'track_del' && m.id) {
      this.queue.delete(m.id);
      this.persist();
      this.items.delete(m.id);
      this.emit();
      return true;
    }
    if (m.t === 'track_err') {
      const q = m.id ? this.queue.get(m.id) : undefined;
      if (q && m.id) {
        this.queue.delete(m.id);
        this.persist();
        if (q.prev) this.items.set(m.id, q.prev);
        else this.items.delete(m.id);
        this.emit();
      }
      this.onError?.(m.msg || 'Couldn’t save that.');
      return true;
    }
    return false;
  }

  /* -------------------------------------------------------------- edits */
  put(item: TrackItem): void {
    const op: Op = { op: 'put', item, prev: this.items.get(item.id) ?? null };
    this.applyLocal(op);
    this.persist();
    this.sendOp(op);
    this.emit();
  }

  del(id: string): void {
    const op: Op = { op: 'del', id, prev: this.items.get(id) ?? null };
    this.applyLocal(op);
    this.persist();
    this.sendOp(op);
    this.emit();
  }

  get(id: string): TrackItem | undefined {
    return this.items.get(id);
  }

  /* ------------------------------------------------------------ loading */
  async load(from: number, to: number): Promise<void> {
    this.loaded = { from: Math.min(from, this.loaded?.from ?? from), to: Math.max(to, this.loaded?.to ?? to) };
    const q = this.query;
    if (!q) return this.emit();
    this.loading = true;
    this.emit();
    const r = await q.ask<{ items: TrackItem[]; auto: TrackItem[]; settings?: { baby?: BabyProfile | null } }>('track', { from: this.loaded.from, to: this.loaded.to }, 15_000);
    this.loading = false;
    if (r) {
      const inWindow = (i: TrackItem) => i.start < this.loaded!.to && (i.end == null || i.end >= this.loaded!.from);
      for (const [id, it] of this.items) if (inWindow(it) && !this.queue.has(id)) this.items.delete(id);
      for (const it of r.items) if (!this.queue.has(it.id)) this.items.set(it.id, it);
      this.auto = r.auto;
      if (r.settings) this.onBaby?.(r.settings.baby ?? null);
    }
    this.emit();
  }
}
