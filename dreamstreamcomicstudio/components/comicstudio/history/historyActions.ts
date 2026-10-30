// Comic History — the free history_* actions the History UI sends (versions plan §3.3, §6.1; package H5).
//
// Every one goes through the studio controller (studio.act), streams like any other action and spends nothing.
// A restore's Undo restores the before-restore moment the server saved first, with the same scope — so it still
// works after a reload: the moment comes from the live `history` event (the restore row's undoId) or, failing that,
// from the newest before-restore moment in the list.

import type { StudioAction } from '../../../shared/comic/ops';
import type { RestoreScope } from '../../../shared/comic/history/types';
import type { HistoryApi } from './historyApi';
import type { HistoryStudio } from './useHistory';

export interface ActResult {
  ok: boolean;
  error?: string;
}

/** Run a StudioAction through the controller and read its outcome (older controllers resolve void = sent). */
export const runHistoryAction = async (studio: HistoryStudio, action: StudioAction): Promise<ActResult> => {
  try {
    const out = await studio.act(action);
    if (out && typeof out === 'object' && 'ok' in out) return { ok: !!out.ok && !out.skipped, ...(out.error ? { error: out.error } : {}) };
    return { ok: true };
  } catch (err) {
    return { ok: false, ...(err instanceof Error && err.message ? { error: err.message } : {}) };
  }
};

/** The before-restore moment of the latest restore (the live event first, then the list). */
export const beforeRestoreId = async (studio: HistoryStudio, api: HistoryApi): Promise<string | null> => {
  const last = studio.lastHistoryVersion;
  if (last?.kind === 'restore' && last.undoId) return last.undoId;
  if (!studio.doc) return null;
  try {
    return (await api.list(studio.doc.id, { limit: 5 })).rows.find((r) => r.kind === 'before_restore')?.id ?? null;
  } catch {
    return null;
  }
};

/** Undo the latest restore: bring back the copy saved just before it, with the same scope. Free. */
export const undoLastRestore = async (studio: HistoryStudio, api: HistoryApi, scope: RestoreScope): Promise<ActResult> => {
  const before = await beforeRestoreId(studio, api);
  if (!before) return { ok: false, error: 'Couldn’t find the copy saved just before. Open History to bring it back.' };
  return runHistoryAction(studio, { type: 'history_restore', versionId: before, scope, ...(scope.kind === 'book' && studio.doc ? { baseRev: studio.doc.rev } : {}) });
};
