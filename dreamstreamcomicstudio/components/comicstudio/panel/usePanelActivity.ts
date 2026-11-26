// Loads the small activity rows behind the panel's "Your comics" (the old AI activity feed's loader,
// services/comicWorkspaceActivity.ts: a scalar projection of the owner's own comic_docs, the 25 most recently changed),
// and remembers which finished work this viewer cleared. Every comic is listed from App's project list; these rows add
// the news (Needs you, In progress, Finished) of the comics that changed lately, which is where news is.
//
// When it fetches (SH-C1; the backend and the database stay idle otherwise): when the list mounts (the panel opens),
// when the tab comes back into view or gets focus after FOCUS_REFRESH_MS, shortly after a run settles in this tab
// (WORK_CHANGED_EVENT), on reconnecting, and when the person asks (Refresh). Never on a timer. A load nobody asked for
// over rows already shown is quiet (`background`): the list does not announce it or move. A per-account memory shows
// the last rows at once when the panel opens again, and skips the fetch while they are fresher than CACHE_FRESH_MS. A
// response for another account, or one that arrives after unmount, is dropped.

import { useCallback, useEffect, useRef, useState } from 'react';
import { loadComicActivity, type ComicActivityRow } from '../../../services/comicWorkspaceActivity';
import type { FinishedKind, FinishedWork } from '../../../shared/comic/workspaceActivity';
import { WORK_CHANGED_EVENT } from '../home/workspaceTaskTarget';

export type ActivityStatus = 'loading' | 'ready' | 'failed' | 'offline';

export const CACHE_FRESH_MS = 20_000;
export const FOCUS_REFRESH_MS = 30_000;
export const SETTLE_DELAY_MS = 700;
export const LOAD_TIMEOUT_MS = 12_000;

interface Snapshot {
  rows: ComicActivityRow[];
  checked: number;
}

/** The last rows per account, for this tab (cleared on reload). */
const memory = new Map<string, Snapshot>();
/** Tests: forget the remembered rows. */
export const resetPanelActivityForTests = (): void => memory.clear();

export const clearedKey = (owner: string, projectId: string, kind: FinishedKind) => `dreamstream.comic-work.${owner}.${projectId}.${kind}`;
const workVersion = (work: FinishedWork) => `${work.at}:${work.count ?? 0}`;

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

export interface PanelActivity {
  /** Loaded rows, or null before the first page. */
  rows: ComicActivityRow[] | null;
  status: ActivityStatus;
  /** When the rows were last checked (0 = never). */
  checked: number;
  /** The load under way was not asked for and rows are already shown: nothing to announce. */
  background: boolean;
  /** Check again, as the person asked (announced). */
  refresh(): void;
  isCleared(projectId: string, work: FinishedWork): boolean;
  clear(items: Array<{ id: string; work: FinishedWork }>): void;
}

export function usePanelActivity(accountId: string): PanelActivity {
  const remembered = memory.get(accountId);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(remembered ?? null);
  const [status, setStatus] = useState<ActivityStatus>(remembered ? 'ready' : offline() ? 'offline' : 'loading');
  const [request, setRequest] = useState<{ manual: boolean; nonce: number } | null>(() =>
    remembered && Date.now() - remembered.checked < CACHE_FRESH_MS ? null : { manual: false, nonce: 0 }
  );
  const [, redraw] = useState(0);
  const cleared = useRef(new Map<string, string>());
  const lastAttempt = useRef(remembered?.checked ?? 0);

  const check = useCallback((manual: boolean) => setRequest((r) => ({ manual, nonce: (r?.nonce ?? 0) + 1 })), []);
  const refresh = useCallback(() => check(true), [check]);
  const recheck = useCallback(() => check(false), [check]);

  useEffect(() => {
    if (!request) return;
    if (offline()) {
      setStatus('offline');
      return;
    }
    const ctrl = new AbortController();
    let current = true;
    lastAttempt.current = Date.now();
    setStatus('loading');
    const timeout = window.setTimeout(() => {
      ctrl.abort();
      if (current) setStatus('failed');
    }, LOAD_TIMEOUT_MS);
    void loadComicActivity(accountId, 0, ctrl.signal)
      .then((page) => {
        if (!current || ctrl.signal.aborted) return;
        const next: Snapshot = { rows: page.rows, checked: Date.now() };
        memory.set(accountId, next);
        setSnapshot(next);
        setStatus('ready');
      })
      .catch(() => {
        if (current) setStatus(offline() ? 'offline' : 'failed');
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      current = false;
      ctrl.abort();
      window.clearTimeout(timeout);
    };
  }, [accountId, request]);

  useEffect(() => {
    let settled: number | undefined;
    const visible = () => document.visibilityState !== 'hidden';
    const back = () => {
      if (visible() && Date.now() - lastAttempt.current > FOCUS_REFRESH_MS) recheck();
    };
    const workChanged = (event: Event) => {
      if ((event as CustomEvent<{ accountId?: string }>).detail?.accountId !== accountId || !visible()) return;
      window.clearTimeout(settled);
      settled = window.setTimeout(recheck, SETTLE_DELAY_MS);
    };
    const wentOffline = () => setStatus('offline');
    // Another tab cleared finished work: read the saved choices again.
    const storage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith(`dreamstream.comic-work.${accountId}.`)) {
        cleared.current.clear();
        redraw((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    window.addEventListener('online', recheck);
    window.addEventListener('offline', wentOffline);
    window.addEventListener(WORK_CHANGED_EVENT, workChanged);
    window.addEventListener('storage', storage);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
      window.removeEventListener('online', recheck);
      window.removeEventListener('offline', wentOffline);
      window.removeEventListener(WORK_CHANGED_EVENT, workChanged);
      window.removeEventListener('storage', storage);
      window.clearTimeout(settled);
    };
  }, [accountId, recheck]);

  const isCleared = useCallback(
    (projectId: string, work: FinishedWork) => {
      const key = clearedKey(accountId, projectId, work.kind);
      let value = cleared.current.get(key);
      if (value === undefined) {
        try {
          value = window.localStorage.getItem(key) ?? '';
        } catch {
          value = '';
        }
        cleared.current.set(key, value);
      }
      if (!value) return false;
      const [at, count] = value.split(':').map(Number);
      return !(work.at > at || (work.at === at && (work.count ?? 0) > count));
    },
    [accountId]
  );

  const clear = useCallback(
    (items: Array<{ id: string; work: FinishedWork }>) => {
      for (const { id, work } of items) {
        const key = clearedKey(accountId, id, work.kind);
        cleared.current.set(key, workVersion(work));
        try {
          window.localStorage.setItem(key, workVersion(work));
        } catch {
          /* Kept for this view. */
        }
      }
      redraw((n) => n + 1);
    },
    [accountId]
  );

  const background = status === 'loading' && !!snapshot && !request?.manual;
  return { rows: snapshot?.rows ?? null, status, checked: snapshot?.checked ?? 0, background, refresh, isCleared, clear };
}
