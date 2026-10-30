// Comic History — the free history_* actions the History UI sends (versions plan §3.3, §6.1; package H5).
//
// Every one goes through the studio controller (studio.act), streams like any other action and spends nothing.
// A restore's Undo restores the moment the server saved just before it, with the same scope — so it still works after
// a reload. That moment is named only by the restore itself: the outcome's beforeVersionId (§6.1 step 8) when the
// stream carries it, else the restore row's undoId — never "the newest before-restore moment", because a restore whose
// book already matched the latest moment reuses that moment and saves no before-restore row of its own (§6.1 step 4).

import type { StudioAction } from '../../../shared/comic/ops';
import type { RestoreScope, VersionRow } from '../../../shared/comic/history/types';
import type { HistoryApi } from './historyApi';
import { findOwnRow, type HistoryStudio } from './useHistory';

export interface ActResult {
  ok: boolean;
  error?: string;
  /** history_restore: the moment saved just before it (§6.1 step 8), when the outcome carries it. */
  beforeVersionId?: string;
}

/** Run a StudioAction through the controller and read its outcome (older controllers resolve void = sent). */
export const runHistoryAction = async (studio: HistoryStudio, action: StudioAction): Promise<ActResult> => {
  try {
    const out = await studio.act(action);
    if (out && typeof out === 'object' && 'ok' in out) {
      const before = (out as { beforeVersionId?: unknown }).beforeVersionId;
      const ok = !!out.ok && !out.skipped;
      return { ok, ...(out.error ? { error: out.error } : {}), ...(ok && typeof before === 'string' && before ? { beforeVersionId: before } : {}) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, ...(err instanceof Error && err.message ? { error: err.message } : {}) };
  }
};

/** How many of the newest moments of the book you're on the Undo looks through for the restore row. */
export const UNDO_LOOKUP_LIMIT = 5;

/**
 * The moment saved just before the latest restore: `known` (the restore's own outcome) first; else the restore row's
 * undoId — from the live `history` event or the newest restore row in the list, whichever is newer. null when no
 * restore row names one (Undo then says so instead of guessing).
 */
export const beforeRestoreId = async (studio: HistoryStudio, api: HistoryApi, known?: string | null): Promise<string | null> => {
  if (known) return known;
  const last = studio.lastHistoryVersion;
  const live = last?.kind === 'restore' && last.undoId ? last : null;
  let listed: VersionRow | null = null;
  if (studio.doc) {
    try {
      // Never a removed version's restore: its before-copy belongs to a version you're no longer on. Its rows never
      // use up the window (findOwnRow reads on past them); only the newest UNDO_LOOKUP_LIMIT rows of yours are
      // looked through, so an older restore is never undone for the latest one.
      listed = await findOwnRow(api, studio.doc.id, { limit: UNDO_LOOKUP_LIMIT }, (r) => r.kind === 'restore', { within: UNDO_LOOKUP_LIMIT });
    } catch {
      listed = null;
    }
  }
  const pick = [live, listed?.undoId ? listed : null].filter((r): r is VersionRow => !!r).sort((a, b) => b.createdAt - a.createdAt || b.contentAt - a.contentAt)[0];
  return pick?.undoId ?? null;
};

/** Undo the latest restore: bring back the copy saved just before it, with the same scope. Free. */
export const undoLastRestore = async (studio: HistoryStudio, api: HistoryApi, scope: RestoreScope, beforeVersionId?: string | null): Promise<ActResult> => {
  const before = await beforeRestoreId(studio, api, beforeVersionId);
  if (!before) return { ok: false, error: 'Couldn’t find the copy saved just before. Open History to bring it back.' };
  return runHistoryAction(studio, { type: 'history_restore', versionId: before, scope, ...(scope.kind === 'book' && studio.doc ? { baseRev: studio.doc.rev } : {}) });
};
