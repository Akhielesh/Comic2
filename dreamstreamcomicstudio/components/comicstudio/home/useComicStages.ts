// My comics' stage read (SH-B): one request for every card's stage and "Needs you" (services/comicWorkspaceActivity.ts
// loadComicStages), made when the view opens, again when a list reload starts (back from the studio, a new comic), and
// after a run in this tab settles (studioStreams' WORK_CHANGED_EVENT, the moment the AI activity feed beside it reads
// again). Never on a timer, never one request per card. The last answer stays while a new one runs, so cards never
// flicker, and this tab remembers it: coming back to the view paints the cards at once and reads again behind them.

import React, { useContext, useEffect, useRef, useState } from 'react';
import { loadComicStages, type ComicStageRow } from '../../../services/comicWorkspaceActivity';
import type { CardStageStatus } from './homeModel';
import { WORK_CHANGED_EVENT } from './workspaceTaskTarget';

/** The read itself: the real one, or fixture rows in the QA scene. */
export type ComicStagesLoader = (accountId: string, signal: AbortSignal) => Promise<ReadonlyMap<string, ComicStageRow>>;
export const ComicStagesSource = React.createContext<ComicStagesLoader>(loadComicStages);

export interface ComicStages {
  rows: ReadonlyMap<string, ComicStageRow>;
  /** 'loading' while a read is on its way (a comic with no row yet shows a placeholder); 'settled' once it ends. */
  status: CardStageStatus;
  /** Rows are known for this account (from this read or an earlier one in this tab): nothing need wait for the read. */
  known: boolean;
}

const EMPTY: ReadonlyMap<string, ComicStageRow> = new Map();
/** A read that has not answered by then (a network that accepts and goes quiet) is given up: the cards use their rows. */
export const STAGE_READ_TIMEOUT_MS = 12_000;
/** A settled run reads again once its burst of events is over (the AI activity feed's own wait). */
export const STAGE_REFRESH_DELAY_MS = 700;

/** The last rows each source answered, for one account, in this tab only. */
let remembered = new WeakMap<ComicStagesLoader, { accountId: string; rows: ReadonlyMap<string, ComicStageRow> }>();
const recall = (load: ComicStagesLoader, accountId: string | undefined): ReadonlyMap<string, ComicStageRow> | null => {
  const hit = accountId ? remembered.get(load) : undefined;
  return hit && hit.accountId === accountId ? hit.rows : null;
};
/** Tests: forget every remembered answer. */
export const forgetComicStages = (): void => {
  remembered = new WeakMap();
};

/**
 * The stage rows for an account's comics. `projectsLoaded` is the list's own flag: each time it turns false (a reload
 * starting), the rows are read again in parallel with it.
 */
export function useComicStages(accountId: string | undefined, projectsLoaded: boolean): ComicStages {
  const load = useContext(ComicStagesSource);
  const [rows, setRows] = useState<ReadonlyMap<string, ComicStageRow>>(() => recall(load, accountId) ?? EMPTY);
  const [known, setKnown] = useState(() => recall(load, accountId) !== null);
  const [status, setStatus] = useState<CardStageStatus>(accountId ? 'loading' : 'settled');
  const [reload, setReload] = useState(0);
  const wasLoaded = useRef(projectsLoaded);
  const owner = useRef(accountId);
  useEffect(() => {
    if (wasLoaded.current && !projectsLoaded) setReload((n) => n + 1);
    wasLoaded.current = projectsLoaded;
  }, [projectsLoaded]);

  // A run of this account's that settles changes what its card says (a drawing to approve, pages drawn): read again,
  // after the burst, while the page is in view. One that settles while the tab is hidden is read when it shows again.
  useEffect(() => {
    if (!accountId) return;
    let delayed: number | undefined;
    let missed = false;
    const visible = () => document.visibilityState !== 'hidden';
    const readSoon = () => {
      window.clearTimeout(delayed);
      delayed = window.setTimeout(() => setReload((n) => n + 1), STAGE_REFRESH_DELAY_MS);
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ accountId?: string } | undefined>).detail?.accountId !== accountId) return;
      if (visible()) readSoon();
      else missed = true;
    };
    const shown = () => {
      if (!missed || !visible()) return;
      missed = false;
      readSoon();
    };
    window.addEventListener(WORK_CHANGED_EVENT, changed);
    document.addEventListener('visibilitychange', shown);
    return () => {
      window.removeEventListener(WORK_CHANGED_EVENT, changed);
      document.removeEventListener('visibilitychange', shown);
      window.clearTimeout(delayed);
    };
  }, [accountId]);

  useEffect(() => {
    // Another account's rows are never shown, not even while this one's are read.
    if (owner.current !== accountId) {
      owner.current = accountId;
      const mine = recall(load, accountId);
      setRows(mine ?? EMPTY);
      setKnown(mine !== null);
    }
    if (!accountId) {
      setStatus('settled');
      return;
    }
    const ctrl = new AbortController();
    let current = true;
    setStatus('loading');
    const timeout = window.setTimeout(() => {
      ctrl.abort();
      if (current) setStatus('settled');
    }, STAGE_READ_TIMEOUT_MS);
    load(accountId, ctrl.signal)
      .then((next) => {
        if (!current) return;
        remembered.set(load, { accountId, rows: next });
        setRows(next);
        setKnown(true);
      })
      // A failed read leaves the cards on their row counts and "Open to see": the list itself still works.
      .catch(() => undefined)
      .finally(() => {
        window.clearTimeout(timeout);
        if (current) setStatus('settled');
      });
    return () => {
      current = false;
      ctrl.abort();
      window.clearTimeout(timeout);
    };
  }, [accountId, load, reload]);

  return { rows, status, known };
}
