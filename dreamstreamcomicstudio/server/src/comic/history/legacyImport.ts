// Comic History — "Open in the new studio" from one classic snapshot (versions plan §11; package H0 STUB, H6
// replaces it: keep the export names and signatures).
//
// POST /api/comic/projects {importFromProjectId, fromVersionId} imports that classic snapshot instead of the live
// classic state. H6 loads it from comic_versions (codec 'legacy'), owner-scoped, and returns it in the shape
// routes/comic.ts legacyImportOps already maps. Until then there is no server-side snapshot to read: null, and the
// route answers the same 404 as a missing project (no oracle).

import type { HistoryScope } from './hooks.js';

/** A classic project state as routes/comic.ts legacyImportOps reads it. */
export interface LegacySnapshotState {
  name: string;
  state: Record<string, unknown>;
}

/**
 * The classic snapshot `versionId` of `fromProjectId`, owned by `scope.userId`, or null (missing, foreign, or —
 * in H0 — not stored on the server yet). Never throws for a missing snapshot.
 */
export async function loadLegacyVersionState(_scope: HistoryScope, _fromProjectId: string, _versionId: string): Promise<LegacySnapshotState | null> {
  return null;
}
