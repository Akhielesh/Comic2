// My comics' stage read (SH-B): one request for every card's stage and "Needs you" (services/comicWorkspaceActivity.ts
// loadComicStages), made when the view opens and again when a list reload starts (back from the studio, a new comic).
// Never on a timer, never one request per card. The last answer stays while a new one runs, so cards never flicker.

import React, { useContext, useEffect, useRef, useState } from 'react';
import { loadComicStages, type ComicStageRow } from '../../../services/comicWorkspaceActivity';
import type { CardStageStatus } from './homeModel';

/** The read itself: the real one, or fixture rows in the QA scene. */
export type ComicStagesLoader = (accountId: string, signal: AbortSignal) => Promise<ReadonlyMap<string, ComicStageRow>>;
export const ComicStagesSource = React.createContext<ComicStagesLoader>(loadComicStages);

export interface ComicStages {
  rows: ReadonlyMap<string, ComicStageRow>;
  /** 'loading' until the first answer (or failure); cards then read a missing row as "Open to see". */
  status: CardStageStatus;
}

const EMPTY: ReadonlyMap<string, ComicStageRow> = new Map();

/**
 * The stage rows for an account's comics. `projectsLoaded` is the list's own flag: each time it turns false (a reload
 * starting), the rows are read again in parallel with it.
 */
export function useComicStages(accountId: string | undefined, projectsLoaded: boolean): ComicStages {
  const load = useContext(ComicStagesSource);
  const [rows, setRows] = useState<ReadonlyMap<string, ComicStageRow>>(EMPTY);
  const [status, setStatus] = useState<CardStageStatus>(accountId ? 'loading' : 'settled');
  const [reload, setReload] = useState(0);
  const wasLoaded = useRef(projectsLoaded);
  const owner = useRef(accountId);
  useEffect(() => {
    if (wasLoaded.current && !projectsLoaded) setReload((n) => n + 1);
    wasLoaded.current = projectsLoaded;
  }, [projectsLoaded]);

  useEffect(() => {
    // Another account's rows are never shown, not even while this one's are read.
    if (owner.current !== accountId) {
      owner.current = accountId;
      setRows(EMPTY);
      setStatus(accountId ? 'loading' : 'settled');
    }
    if (!accountId) return;
    const ctrl = new AbortController();
    let current = true;
    load(accountId, ctrl.signal)
      .then((next) => {
        if (current) setRows(next);
      })
      // A failed read leaves the cards on their row counts and "Open to see": the list itself still works.
      .catch(() => undefined)
      .finally(() => {
        if (current) setStatus('settled');
      });
    return () => {
      current = false;
      ctrl.abort();
    };
  }, [accountId, load, reload]);

  return { rows, status };
}
