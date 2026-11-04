// The conflict guard: the creator's edit wins (agent-editor plan §3 A3.1, owner decision D3). STUB with final names
// (K3 contract): wave 1 A3 CONFLICT replaces the bodies in place.
//
// A director tool that writes a line, a balloon or a style first asks guardUserEdits which of its planned ops touch an
// entity (shared/comic/conflicts.ts entityKeys) the creator committed (origin 'user') after the turn's startRev
// (session.recentCommits). It applies the allowed part, tells the model "Conflict: … so I left it", and records the
// blocked part on turn.conflicts; after the loop, conflictCardFor turns those into ONE conflict card. Free; no model call.

import { newId, normalizeConflictCard, type ConflictCard, type ConflictItem, type ConflictWhere } from '../../../shared/comic/doc.js';
import type { DocOp } from '../../../shared/comic/ops.js';
import type { DirectorTurn } from './tools.js';
import type { StudioContext } from './types.js';

/** Director ops held back because the creator changed the same entity mid-turn. `mine` = the creator's current version. */
export interface BlockedEdit {
  where: ConflictWhere;
  mine: string;
  theirs: string;
  proposed: DocOp[];
}

/** What a tool may commit now, and what it must leave for the conflict card. */
export interface GuardResult {
  allowed: DocOp[];
  blocked: BlockedEdit[];
}

/**
 * Split `plannedOps` into the ones that may commit and the ones the creator's mid-turn edits block (plan §3 A3.1).
 * Off (caps.liveAgent.conflicts false) it allows everything, exactly as today. STUB: allows everything.
 */
export function guardUserEdits(ctx: StudioContext, turn: DirectorTurn, plannedOps: DocOp[]): GuardResult {
  void ctx;
  void turn;
  return { allowed: plannedOps, blocked: [] };
}

/**
 * The tool result for blocked edits (plan §3 A3.1): "Conflict: you changed page 2 · panel 1 · line 2 ("We have to go")
 * while I was working, so I left it. Do not redo it; the studio will ask." Empty when nothing was blocked.
 */
export function conflictToolNote(blocked: readonly BlockedEdit[]): string {
  if (!blocked.length) return '';
  const where = blocked.map((b) => (b.mine ? `${b.where.label} ("${b.mine}")` : b.where.label)).join('; ');
  return `Conflict: you changed ${where} while I was working, so I left it. Do not redo it; the studio will ask.`;
}

/** Record blocked edits on the turn (each becomes a ConflictItem the card will show). */
export function recordConflicts(turn: DirectorTurn, blocked: readonly BlockedEdit[]): void {
  if (!blocked.length) return;
  const items: ConflictItem[] = blocked.map((b) => ({ id: newId('cf'), where: b.where, mine: b.mine, theirs: b.theirs, proposed: b.proposed }));
  turn.conflicts = [...(turn.conflicts ?? []), ...items];
}

/**
 * After the director loop: one conflict card for everything the guard held back this turn ("We both changed page 2 ·
 * panel 1." Keep mine / Use the director's / Show me), or null (plan §3 A3.1). Minimal until A3: the recorded items,
 * bounded by normalizeConflictCard — null whenever nothing was held back (today: always, the guard blocks nothing yet).
 */
export function conflictCardFor(turn: DirectorTurn): ConflictCard | null {
  if (!turn.conflicts?.length) return null;
  return normalizeConflictCard({ type: 'conflict', id: newId('card'), items: turn.conflicts }) ?? null;
}
