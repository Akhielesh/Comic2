// Uncast-being scan (contract §12.8; fixes "animals not cast → drift"). Wave-0 stub by P0-B;
// owned in wave 1 by P1-DIRECTOR, which replaces both functions IN PLACE.
//
// findUncastBeings reads the plan (panel actions, lines, summaries) for recurring animals,
// pets, toys, vehicles, creatures and robots that are not in the cast; planPages commits
// castOpsForUncast so every recurring being gets a drawable identity.
// Stub behaviour: finds nothing, adds nothing.

import type { CastKind, ComicDoc } from '../../../shared/comic/doc.js';
import type { DocOp } from '../../../shared/comic/ops.js';

export interface UncastBeing {
  /** The noun as written ("duckling"). */
  noun: string;
  /** Proposed cast name ("DUCKLINGS"). */
  name: string;
  kind: CastKind;
  /** 2–12 for a group drawn as one identity class. */
  count?: number;
  /** Panels it appears in. */
  panels: number;
  /** Where it first appears ("p1 panel 2"). */
  firstMention: string;
}

export function findUncastBeings(_doc: ComicDoc): UncastBeing[] {
  return [];
}

export function castOpsForUncast(_doc: ComicDoc, _beings: ReturnType<typeof findUncastBeings>): DocOp[] {
  return [];
}
