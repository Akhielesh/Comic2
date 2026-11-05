// Conflict keys: which doc entity an op changes, fine enough that two different balloons on one page never collide
// (agent-editor plan §3 A3.1). STUB with final names (K3 contract): wave 1 A3 CONFLICT replaces the bodies in place.
//
// History's touchedKeys (history/touched.ts) is page-level, too coarse for "you edited this while I was working": the
// guard (server/src/comic/conflictGuard.ts) compares these keys between the creator's commits after a turn's startRev
// and the director's planned ops. Pure; imports only types from doc.ts / ops.ts.

import type { DocOp } from './ops.js';

/**
 * One entity an op changes: a line's words / kind / speaker (`line:`), its balloon box (`balloon:`), its own style
 * (`lstyle:`), a panel (`panel:`), a panel's line order (`order:`), or a comic-wide lettering scope (`letter:base`,
 * `letter:kind:shout`, `letter:speaker:<id>`).
 */
export type EntityKey = `line:${string}` | `balloon:${string}` | `lstyle:${string}` | `panel:${string}` | `order:${string}` | `letter:${string}`;

/** The fine keys `op` changes (plan §3 A3.1; e.g. a `balloon` op → `balloon:<lineId>`). STUB: [] (nothing collides). */
export function entityKeys(op: DocOp): EntityKey[] {
  void op;
  return [];
}

/** Keys both op lists change, in first-seen order of `a` (the conflict guard's test). Built on entityKeys. */
export function collidingKeys(a: readonly DocOp[], b: readonly DocOp[]): EntityKey[] {
  const theirs = new Set(b.flatMap((op) => entityKeys(op)));
  const out: EntityKey[] = [];
  for (const key of a.flatMap((op) => entityKeys(op))) if (theirs.has(key) && !out.includes(key)) out.push(key);
  return out;
}
