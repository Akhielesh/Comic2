// Global app status / activity store — the model behind the AppStatusBar. It lets the
// user SEE what the app is doing (loading, syncing) and WHAT went wrong (errors, failed
// loads) right in the UI, instead of opening the browser console.
//
// Dependency-free on purpose (no app-service imports) so anything — including low-level
// services like apiClient — can report into it without import cycles:
//
//   appStatus.report('error', 'Could not reach the server', { detail });
//   const id = appStatus.begin('Connecting Gmail…'); …later… appStatus.end(id);
//
// React reads it via the useAppStatus() hook (useSyncExternalStore).

export type StatusLevel = 'info' | 'success' | 'warn' | 'error';

export interface StatusEvent {
  id: number;
  level: StatusLevel;
  message: string;
  detail?: string;
  /** Where it came from: 'network' | 'window' | 'promise' | 'resource' | 'connectors' | … */
  source?: string;
  ts: number;
  /** Identical consecutive events are coalesced into one with a bumped count. */
  count: number;
}

export interface StatusSnapshot {
  events: StatusEvent[]; // newest first
  activeCount: number; // in-flight activities
  activeLabel: string | null; // most recently started activity's label
  /** Worst warn/error level seen since the log was last opened (for the badge). */
  worstUnseen: StatusLevel | null;
  unseen: number;
}

const MAX_EVENTS = 60;
const COALESCE_MS = 4000;
const LEVEL_RANK: Record<StatusLevel, number> = { info: 0, success: 1, warn: 2, error: 3 };

let seq = 0;
let events: StatusEvent[] = [];
const activities = new Map<number, { label: string; ts: number }>();
let unseen = 0;
let worstUnseen: StatusLevel | null = null;

const listeners = new Set<() => void>();

const buildSnapshot = (): StatusSnapshot => {
  let activeLabel: string | null = null;
  let latest = -1;
  for (const a of activities.values()) {
    if (a.ts >= latest) {
      latest = a.ts;
      activeLabel = a.label;
    }
  }
  return { events, activeCount: activities.size, activeLabel, worstUnseen, unseen };
};

// Cached so getSnapshot() returns a STABLE reference until something actually changes —
// required by useSyncExternalStore to avoid render loops.
let snapshot: StatusSnapshot = buildSnapshot();

const emit = () => {
  snapshot = buildSnapshot();
  for (const l of listeners) l();
};

export const appStatus = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },

  getSnapshot(): StatusSnapshot {
    return snapshot;
  },

  report(level: StatusLevel, message: string, opts?: { detail?: string; source?: string }): void {
    const msg = String(message ?? '').trim().slice(0, 300);
    if (!msg) return;
    const now = Date.now();
    const head = events[0];
    if (head && head.message === msg && head.level === level && now - head.ts < COALESCE_MS) {
      head.count += 1;
      head.ts = now;
      events = events.slice(); // new array ref (head mutated in place)
    } else {
      const ev: StatusEvent = {
        id: ++seq,
        level,
        message: msg,
        detail: opts?.detail ? String(opts.detail).slice(0, 600) : undefined,
        source: opts?.source,
        ts: now,
        count: 1
      };
      events = [ev, ...events].slice(0, MAX_EVENTS);
    }
    if (level === 'warn' || level === 'error') {
      unseen += 1;
      if (!worstUnseen || LEVEL_RANK[level] > LEVEL_RANK[worstUnseen]) worstUnseen = level;
    }
    emit();
  },

  /** Mark the start of an in-flight activity; returns an id to pass to end(). */
  begin(label: string): number {
    const id = ++seq;
    activities.set(id, { label: String(label || 'Working…').slice(0, 120), ts: Date.now() });
    emit();
    return id;
  },

  end(id: number): void {
    if (activities.delete(id)) emit();
  },

  /** Called when the user opens the log — clears the unseen badge. */
  markSeen(): void {
    if (unseen === 0 && worstUnseen === null) return;
    unseen = 0;
    worstUnseen = null;
    emit();
  },

  clear(): void {
    if (events.length === 0 && unseen === 0 && worstUnseen === null) return;
    events = [];
    unseen = 0;
    worstUnseen = null;
    emit();
  }
};

// Test-only: reset module state between specs.
export const __resetAppStatus = (): void => {
  seq = 0;
  events = [];
  activities.clear();
  unseen = 0;
  worstUnseen = null;
  emit();
};

let captureInstalled = false;

/**
 * Wire global browser failure signals into the status log, once. Catches the things that
 * otherwise only show up in DevTools: uncaught errors, unhandled promise rejections, and
 * failed resource loads (<img>/<script>/…). Benign noise (ResizeObserver loop, opaque
 * cross-origin "Script error.") is filtered or downgraded.
 */
export const installAppStatusCapture = (): void => {
  if (captureInstalled || typeof window === 'undefined') return;
  captureInstalled = true;

  window.addEventListener(
    'error',
    (e: Event) => {
      const target = e.target as (HTMLElement & { src?: string; href?: string }) | null;
      // Resource load failure — the target is an element (img/script/link/...), not window.
      if (target && target !== (window as unknown as EventTarget) && typeof target.tagName === 'string') {
        const url = target.src || target.href || '';
        if (!url) return;
        appStatus.report('warn', `Failed to load ${target.tagName.toLowerCase()}`, { detail: url, source: 'resource' });
        return;
      }
      const err = e as ErrorEvent;
      const message = err.message || 'Unknown error';
      if (/ResizeObserver loop/i.test(message)) return; // benign, spec-level noise
      if (message === 'Script error.') {
        appStatus.report('warn', 'A cross-origin script error occurred (details hidden by the browser)', { source: 'window' });
        return;
      }
      appStatus.report('error', message, {
        detail: err.filename ? `${err.filename}:${err.lineno ?? 0}` : undefined,
        source: 'window'
      });
    },
    true // capture phase — resource-load errors don't bubble
  );

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason as { message?: string; stack?: string } | string | undefined;
    const message =
      (typeof reason === 'object' && reason?.message) || (typeof reason === 'string' ? reason : '') || 'Unhandled promise rejection';
    if (/ResizeObserver loop/i.test(message)) return;
    appStatus.report('error', message, {
      detail: typeof reason === 'object' && reason?.stack ? reason.stack.slice(0, 600) : undefined,
      source: 'promise'
    });
  });
};
