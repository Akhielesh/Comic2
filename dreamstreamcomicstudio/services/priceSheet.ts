// The person's price sheet (docs/features/pricing.md): the sources their server PriceBook is built from — live list
// prices merged with the registry, their observed medians, observed QC and the observed text rates — so every Draw,
// Redraw, Plan and re-check button prices with the SAME book (shared/comic/priceBook.ts priceBookFromSources) as the
// Approve card it opens, the run and the credit card. One sheet per signed-in owner per page.
//
// When it reads (never on a timer: the backend sleeps): when a view that quotes opens and the sheet is missing or
// older than 10 minutes, and again after a drawing run settles (something was drawing, now nothing is — observed
// medians may have moved). Concurrent asks share one request; a failed read keeps the old sheet and is not retried for
// 2 minutes. Until a sheet arrives a quote uses the registry list (the book is undefined), exactly as before.

import { useEffect, useSyncExternalStore } from 'react';
import { priceBookFromSources, sanitizePriceSheet, type PriceSheet, type SharedPriceBook } from '../shared/comic/priceBook';
import { get } from './apiClient';

export const PRICE_SHEET_PATH = '/api/comic/models/prices';
export const PRICE_SHEET_FRESH_MS = 10 * 60_000;
export const PRICE_SHEET_RETRY_MS = 2 * 60_000;

export interface PriceSheetSnapshot {
  owner: string;
  sheet: PriceSheet | null;
  /** The book built from the sheet (undefined until one arrives). */
  book: SharedPriceBook | undefined;
  /** When this page received the sheet (ms). */
  receivedAt: number;
  failedAt: number;
}

const EMPTY: PriceSheetSnapshot = Object.freeze({ owner: '', sheet: null, book: undefined, receivedAt: 0, failedAt: 0 }) as PriceSheetSnapshot;

let snapshot: PriceSheetSnapshot = EMPTY;
let inflight: { owner: string; promise: Promise<void> } | null = null;
/** A forced read asked for while a read for the same owner was already on its way: it runs once that one lands. */
let queued: { owner: string; promise: Promise<void> } | null = null;
/** Per owner: was something drawing the last time a quoting view looked (settle detection). */
const lastBusy = new Map<string, boolean>();
const listeners = new Set<() => void>();
let clock: () => number = () => Date.now();

const publish = (next: PriceSheetSnapshot) => {
  snapshot = next;
  listeners.forEach((l) => l());
};

/** The snapshot for an owner (EMPTY for anyone else). Stable between changes (useSyncExternalStore). */
export const priceSheetFor = (owner: string | null | undefined): PriceSheetSnapshot => (owner && snapshot.owner === owner ? snapshot : EMPTY);

export const subscribePriceSheet = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * Read the sheet for this owner. Without `force`, only when there is none yet or it is older than
 * PRICE_SHEET_FRESH_MS (and not within PRICE_SHEET_RETRY_MS of a failed read). Never throws.
 */
export function refreshPriceSheet(owner: string | null | undefined, opts: { force?: boolean } = {}): Promise<void> {
  if (!owner) return Promise.resolve();
  const current = priceSheetFor(owner);
  const now = clock();
  if (!opts.force && current.sheet && now - current.receivedAt < PRICE_SHEET_FRESH_MS) return Promise.resolve();
  if (!opts.force && current.failedAt && now - current.failedAt < PRICE_SHEET_RETRY_MS) return Promise.resolve();
  if (inflight?.owner === owner) {
    if (!opts.force) return inflight.promise;
    // A run settled while an older read was on its way (that read may predate the run's own costs): read once more
    // after it lands. Several forced asks in the meantime share that one follow-up read.
    if (queued?.owner === owner) return queued.promise;
    const followUp = inflight.promise.then(() => {
      if (queued?.promise === followUp) queued = null;
      // An account switch meanwhile: the follow-up belongs to nobody now.
      if (snapshot.owner && snapshot.owner !== owner) return;
      return refreshPriceSheet(owner, { force: true });
    });
    queued = { owner, promise: followUp };
    return followUp;
  }
  const promise = Promise.resolve()
    .then(() => get<unknown>(PRICE_SHEET_PATH, { expectedAccountId: owner, authOnly: true }))
    .then((body) => {
      const sheet = sanitizePriceSheet(body);
      if (!sheet) throw new Error('malformed price sheet');
      // An account switch while we read: this sheet belongs to someone else.
      if (snapshot.owner && snapshot.owner !== owner) return;
      publish({ owner, sheet, book: priceBookFromSources(sheet.sources), receivedAt: clock(), failedAt: 0 });
    })
    .catch(() => {
      if (snapshot.owner && snapshot.owner !== owner) return;
      publish({ ...priceSheetFor(owner), owner, failedAt: clock() });
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null;
    });
  inflight = { owner, promise };
  // A new owner starts from nothing (the previous account's prices never price this one's buttons).
  if (snapshot.owner !== owner) publish({ ...EMPTY, owner });
  return promise;
}

/**
 * Tell the store whether something is drawing in the view that quotes. A run that settled (true → false) reads the
 * sheet again: what it really cost is now one more observation. Several views report the same transition once.
 */
export function notePriceSheetActivity(owner: string | null | undefined, busy: boolean): void {
  if (!owner) return;
  const was = lastBusy.get(owner) === true;
  lastBusy.set(owner, busy);
  if (was && !busy) void refreshPriceSheet(owner, { force: true });
}

/**
 * The person's PriceBook for a view that quotes: reads the sheet when the view opens and it is missing or stale, again
 * after a drawing run settles (`busy` true → false), and returns the shared book — or undefined until a sheet arrives
 * (the quote helpers then read the registry list).
 */
export function usePriceBook(owner: string | null | undefined, opts: { busy?: boolean; enabled?: boolean } = {}): SharedPriceBook | undefined {
  const enabled = opts.enabled !== false && !!owner;
  const snap = useSyncExternalStore(subscribePriceSheet, () => priceSheetFor(owner), () => EMPTY);
  useEffect(() => {
    if (enabled) void refreshPriceSheet(owner);
  }, [enabled, owner]);
  const busy = opts.busy === true;
  useEffect(() => {
    if (enabled) notePriceSheetActivity(owner, busy);
  }, [enabled, owner, busy]);
  return enabled ? snap.book : undefined;
}

/** Test hooks. */
export const __resetPriceSheetForTests = (): void => {
  inflight = null;
  queued = null;
  lastBusy.clear();
  clock = () => Date.now();
  publish(EMPTY);
};
export const __setPriceSheetClockForTests = (now: () => number): void => {
  clock = now;
};
/** Test hook: a sheet already read for this owner (no request). */
export const __seedPriceSheetForTests = (owner: string, sheet: PriceSheet): void => {
  publish({ owner, sheet, book: priceBookFromSources(sheet.sources), receivedAt: clock(), failedAt: 0 });
};
