// Answering a conflict card (resolve_conflict; agent-editor plan §3 A3.1, owner decision D3). STUB with fixed export
// names (K3 contract): wave 1 A3 CONFLICT replaces it in place and owns this file from then on.
//
// Free: 'mine' marks the card's items resolved and keeps the creator's edit; 'theirs' re-sanitizes the stored proposed
// ops against the CURRENT doc (sanitizePatchOps) and commits them with origin 'director', so Undo brings the creator's
// version back; a stale op (its line deleted since) is refused in plain words. The stub refuses honestly, changes nothing.

import type { ResolveConflictAction } from '../../../../shared/comic/ops.js';
import type { ActionHandler } from '../extensions.js';
import { notAvailableAction } from '../extensions.js';

export const CONFLICT_NOT_AVAILABLE = "Answering a conflict card isn't available yet. Nothing was changed.";

/** resolve_conflict (free). STUB: not available. */
export const resolveConflictAction: ActionHandler = notAvailableAction<ResolveConflictAction>('resolve_conflict', false, CONFLICT_NOT_AVAILABLE) as unknown as ActionHandler;

export const CONFLICT_ACTIONS: ActionHandler[] = [resolveConflictAction];
