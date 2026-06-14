// ============================================================================
// Connector sync diagnostics — a human-readable, color-coded log of EXACTLY what
// each sync page captures
// ============================================================================
//
// Answers the operator question "what are we actually syncing, and why does it look
// like it's still going?" The sync runner was previously near-silent on the happy
// path (only the BullMQ worker logged a terse JSON result, and the no-Redis inline
// path logged nothing on success), so there was no way to SEE what landed.
//
// This prints ONE clear line per sync page —
//   connector · account · mode · items captured (+ a kind breakdown) · running total ·
//   duration · hasMore + the next pagination cursor
// — plus loud START / DONE / CAPPED / RECONNECT / ERROR markers. With
// CONNECTORS_SYNC_DEBUG=verbose it ALSO lists each captured item (kind + title), so
// you can eyeball precisely what was ingested.
//
// Color is auto (on when stdout is a TTY — e.g. local `npm run dev` / the connectors
// worker) unless forced via CONNECTORS_SYNC_COLOR. When color is OFF (production /
// Railway / Cloudflare, where stdout isn't a TTY) it falls back to the shared
// structured JSON logger, so the same events stay timestamped + greppable in
// aggregated logs. Logging NEVER throws — diagnostics must not break a sync.
// ============================================================================

import { CONNECTORS_SYNC_COLOR, CONNECTORS_SYNC_DEBUG } from '../../config.js';
import { logger } from '../../lib/logger.js';
import type { NormalizedItem } from '../types.js';

// ---- ANSI palette -----------------------------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
} as const;

const COLOR: boolean =
  CONNECTORS_SYNC_COLOR !== null ? CONNECTORS_SYNC_COLOR : Boolean(process.stdout && (process.stdout as { isTTY?: boolean }).isTTY);

const paint = (s: string, ...codes: string[]): string => (COLOR && codes.length ? `${codes.join('')}${s}${ANSI.reset}` : s);

// Diagnostics must never break a sync — swallow any formatting/serialization error.
const safe = (fn: () => void): void => {
  try {
    fn();
  } catch {
    /* ignore */
  }
};

// ---- small formatters (exported pure helpers are unit-tested) ----------------

const short = (id: string): string => (id || '').slice(0, 8);

const fmtMs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** Count normalized items by kind (e.g. { document: 48 }). */
export const kindSummary = (items: ReadonlyArray<{ kind?: string }>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const it of items || []) {
    const k = it?.kind || 'unknown';
    out[k] = (out[k] || 0) + 1;
  }
  return out;
};

/** Render a kind breakdown as "48 documents, 1 event" (or "nothing" when empty). */
export const formatKinds = (counts: Record<string, number>): string => {
  const parts = Object.entries(counts).map(([kind, n]) => `${n} ${kind}${n === 1 ? '' : 's'}`);
  return parts.length ? parts.join(', ') : 'nothing';
};

const hasCursor = (c?: Record<string, unknown> | null): boolean => Boolean(c && Object.keys(c).length);

/** Compact, value-truncated view of a pagination cursor for logs (never huge). */
const cursorBrief = (c?: Record<string, unknown> | null): string => {
  if (!hasCursor(c)) return '∅';
  const trunc = (v: unknown): string => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s && s.length > 18 ? `${s.slice(0, 16)}…` : s ?? '';
  };
  return `{${Object.entries(c as Record<string, unknown>).map(([k, v]) => `${k}:${trunc(v)}`).join(', ')}}`;
};

const oneLine = (s: string | null | undefined, max = 72): string => {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// How many items to enumerate in verbose mode (a full page is ~PAGE_SIZE; cap defensively).
const VERBOSE_ITEM_CAP = 100;

const listItems = (items: ReadonlyArray<NormalizedItem>): void => {
  const shown = items.slice(0, VERBOSE_ITEM_CAP);
  for (const it of shown) {
    const when = it.occurredAt ? paint(` (${String(it.occurredAt).slice(0, 10)})`, ANSI.gray) : '';
    console.log(
      `   ${paint('•', ANSI.gray)} ${paint(`[${it.kind}]`, ANSI.magenta)} ${oneLine(it.title) || paint('(untitled)', ANSI.gray)}${when}`
    );
  }
  if (items.length > shown.length) {
    console.log(`   ${paint(`… and ${items.length - shown.length} more`, ANSI.gray)}`);
  }
};

// ---- public event API -------------------------------------------------------

export interface PageInfo {
  connectorId: string;
  account?: string | null;
  connectionId: string;
  mode: string;
}

/** A page of a sync is about to run. */
export const logPageStart = (a: PageInfo & { cursorIn?: Record<string, unknown> }): void =>
  safe(() => {
    if (!COLOR) {
      logger.info('connector_sync_page_start', {
        connector: a.connectorId,
        account: a.account || undefined,
        connection: a.connectionId,
        mode: a.mode,
        resume: hasCursor(a.cursorIn) || undefined
      });
      return;
    }
    console.log(
      `${paint('↻ sync', ANSI.cyan, ANSI.bold)} ${paint(a.connectorId, ANSI.cyan)}` +
        `${a.account ? ` ${paint(a.account, ANSI.gray)}` : ''} ${paint(a.mode, ANSI.magenta)} ` +
        `${paint(`#${short(a.connectionId)}`, ANSI.gray)} ` +
        (hasCursor(a.cursorIn) ? paint(`resume ${cursorBrief(a.cursorIn)}`, ANSI.gray) : paint('(fresh)', ANSI.gray))
    );
  });

/** A page of a sync finished successfully. */
export const logPageDone = (
  a: PageInfo & {
    items: ReadonlyArray<NormalizedItem>;
    written: number;
    hasMore: boolean;
    cursorOut?: Record<string, unknown>;
    total: number;
    ms: number;
  }
): void =>
  safe(() => {
    const counts = kindSummary(a.items);
    if (!COLOR) {
      logger.info('connector_sync_page_done', {
        connector: a.connectorId,
        account: a.account || undefined,
        connection: a.connectionId,
        mode: a.mode,
        captured: a.items.length,
        written: a.written,
        kinds: counts,
        hasMore: a.hasMore,
        total: a.total,
        ms: a.ms,
        ...(CONNECTORS_SYNC_DEBUG === 'verbose'
          ? { items: a.items.slice(0, VERBOSE_ITEM_CAP).map((it) => ({ kind: it.kind, title: oneLine(it.title) })) }
          : {})
      });
      return;
    }
    const head = a.hasMore ? paint('⏳ more', ANSI.yellow, ANSI.bold) : paint('✓ done', ANSI.green, ANSI.bold);
    console.log(
      `${head} ${paint(a.connectorId, ANSI.cyan)} ${paint(a.mode, ANSI.magenta)} ` +
        `captured ${paint(String(a.items.length), ANSI.bold)} (${formatKinds(counts)}) · ` +
        `${paint(`total ${a.total}`, ANSI.green)} · ${paint(fmtMs(a.ms), ANSI.gray)}` +
        (a.hasMore ? ` · ${paint(`next ${cursorBrief(a.cursorOut)}`, ANSI.gray)}` : '')
    );
    if (CONNECTORS_SYNC_DEBUG === 'verbose') listItems(a.items);
  });

/** A sync failed on auth — terminal until the user reconnects (no retry). */
export const logReconnect = (a: PageInfo & { message: string }): void =>
  safe(() => {
    if (!COLOR) {
      logger.warn('connector_sync_reconnect', {
        connector: a.connectorId,
        account: a.account || undefined,
        connection: a.connectionId,
        message: a.message
      });
      return;
    }
    console.log(
      `${paint('⚠ reconnect', ANSI.yellow, ANSI.bold)} ${paint(a.connectorId, ANSI.cyan)} ` +
        `${paint(`#${short(a.connectionId)}`, ANSI.gray)} — ${paint('auth invalid; user must reconnect', ANSI.yellow)} ` +
        `${paint(`(${oneLine(a.message, 120)})`, ANSI.gray)}`
    );
  });

/** A sync failed on a transient/rate-limit error — it'll be retried with backoff. */
export const logError = (a: PageInfo & { message: string; willRetry: boolean }): void =>
  safe(() => {
    if (!COLOR) {
      logger.error('connector_sync_error', {
        connector: a.connectorId,
        account: a.account || undefined,
        connection: a.connectionId,
        mode: a.mode,
        willRetry: a.willRetry,
        message: a.message
      });
      return;
    }
    console.log(
      `${paint('✖ error', ANSI.red, ANSI.bold)} ${paint(a.connectorId, ANSI.cyan)} ${paint(a.mode, ANSI.magenta)} ` +
        `${paint(`#${short(a.connectionId)}`, ANSI.gray)} — ${paint(oneLine(a.message, 140), ANSI.red)}` +
        `${a.willRetry ? ` ${paint('(will retry)', ANSI.gray)}` : ''}`
    );
  });

export type RunOutcome = 'drained' | 'capped' | 'reconnect' | 'skipped' | 'not_found' | 'error';

/** The inline (no-Redis) sync loop is starting. */
export const logRunStart = (a: { connectionId: string; mode: string; maxPages: number }): void =>
  safe(() => {
    if (!COLOR) {
      logger.info('connector_sync_run_start', { connection: a.connectionId, mode: a.mode, maxPages: a.maxPages });
      return;
    }
    console.log(
      `${paint('▶ inline sync', ANSI.cyan, ANSI.bold)} ${paint(`#${short(a.connectionId)}`, ANSI.gray)} ` +
        `${paint(a.mode, ANSI.magenta)} ${paint(`(≤${a.maxPages} pages this run)`, ANSI.gray)}`
    );
  });

/**
 * The inline sync loop finished. The 'capped' outcome is the important one to SEE:
 * the page budget ran out while more remained, so only part of the account was
 * ingested this run and sync_state stays 'syncing' until the next trigger.
 */
export const logRunEnd = (a: {
  connectionId: string;
  mode: string;
  outcome: RunOutcome;
  pages: number;
  total: number;
  ms: number;
  note?: string;
}): void =>
  safe(() => {
    if (!COLOR) {
      const level = a.outcome === 'error' ? 'error' : a.outcome === 'capped' || a.outcome === 'reconnect' ? 'warn' : 'info';
      logger[level]('connector_sync_run_end', {
        connection: a.connectionId,
        mode: a.mode,
        outcome: a.outcome,
        pages: a.pages,
        total: a.total,
        ms: a.ms,
        ...(a.note ? { note: a.note } : {})
      });
      return;
    }
    const tail = `${paint(`${a.pages} page${a.pages === 1 ? '' : 's'}`, ANSI.gray)} · ${paint(`total ${a.total}`, ANSI.green)} · ${paint(fmtMs(a.ms), ANSI.gray)}`;
    switch (a.outcome) {
      case 'drained':
        console.log(`${paint('■ inline done', ANSI.green, ANSI.bold)} ${paint(`#${short(a.connectionId)}`, ANSI.gray)} — fully synced · ${tail}`);
        break;
      case 'capped':
        console.log(
          `${paint('▣ inline CAPPED', ANSI.yellow, ANSI.bold)} ${paint(`#${short(a.connectionId)}`, ANSI.gray)} — ` +
            `${paint('page budget hit; MORE REMAINS — re-sync to continue (status stays "syncing")', ANSI.yellow)} · ${tail}`
        );
        break;
      case 'error':
        console.log(
          `${paint('■ inline error', ANSI.red, ANSI.bold)} ${paint(`#${short(a.connectionId)}`, ANSI.gray)} — ${paint(oneLine(a.note || 'sync failed', 140), ANSI.red)} · ${tail}`
        );
        break;
      default:
        console.log(`${paint(`■ inline ${a.outcome}`, ANSI.gray, ANSI.bold)} ${paint(`#${short(a.connectionId)}`, ANSI.gray)} · ${tail}`);
    }
  });

/** Generic worker/queue line (ready, job failed, …) — colored when interactive, JSON otherwise. */
export const logNote = (event: string, message: string, tone: 'info' | 'warn' | 'error' = 'info', fields?: Record<string, unknown>): void =>
  safe(() => {
    if (!COLOR) {
      logger[tone](event, fields);
      return;
    }
    const c = tone === 'error' ? ANSI.red : tone === 'warn' ? ANSI.yellow : ANSI.cyan;
    console.log(`${paint('[connectors]', c, ANSI.bold)} ${message}`);
  });
