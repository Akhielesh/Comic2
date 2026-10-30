// Comic History — "Undo the last AI change" (versions plan §6.4; package H0). Pure, three-way, manifest-level.
//
// R = the latest `ai` row on the active line, P = its parent (the `before_ai`, or the previous head), live = now.
// K = the section keys whose hash differs P → R (no body loads). For each key:
//   live == R (untouched since the AI)   → revert it to P;
//   otherwise it is a conflict: the user changed it after the AI — asked per key ("Keep mine" / "Take the earlier
//   one"); a decision of 'earlier' reverts it, 'mine' keeps it.
// Art keys restore with the render_use swap rule (history/apply.ts), so the AI's newer drawing stays in that page's
// versions. A key the AI added (absent in P) reverts by removal (a page goes to Deleted); a key it removed comes back.

import { parseSectionKey } from './sections.js';
import type { RestoreScope, UndoAiDecision } from './types.js';

/** key → content hash (manifestKeyHashes, or sectionSignatures for in-memory docs). */
export type KeyHashes = Readonly<Record<string, string>>;

export interface UndoAiPlan {
  /** Every key the AI changed (P → R), sorted. */
  changed: string[];
  /** Keys to bring back to P (untouched since, or decided 'earlier'). */
  revert: string[];
  /** Keys the user changed since and has not decided on (ask). */
  conflicts: string[];
  /** Keys the user chose to keep ('mine'). */
  kept: string[];
}

const own = (h: KeyHashes, k: string): string | undefined => (Object.prototype.hasOwnProperty.call(h, k) ? h[k] : undefined);

/** The three-way plan (pure). `decisions` answers earlier conflicts per key. */
export const planUndoLastAi = (P: KeyHashes, R: KeyHashes, live: KeyHashes, decisions: Readonly<Record<string, UndoAiDecision>> = {}): UndoAiPlan => {
  const keys = [...new Set([...Object.keys(P || {}), ...Object.keys(R || {})])].filter((k) => own(P, k) !== own(R, k)).sort();
  const plan: UndoAiPlan = { changed: keys, revert: [], conflicts: [], kept: [] };
  for (const k of keys) {
    if (own(live, k) === own(R, k)) plan.revert.push(k);
    else if (decisions[k] === 'earlier') plan.revert.push(k);
    else if (decisions[k] === 'mine') plan.kept.push(k);
    else plan.conflicts.push(k);
  }
  return plan;
};

/** The restore scope that carries out a plan (only its revert keys; null when there is nothing to revert). */
export const undoAiScope = (plan: UndoAiPlan): Extract<RestoreScope, { kind: 'keys' }> | null =>
  plan.revert.length ? { kind: 'keys', keys: plan.revert.slice() } : null;

/** The page ids a list of keys touches (page:, art:, edp:, trash:) — for "You've changed page 3 since". */
export const pageIdsOfKeys = (keys: readonly string[]): string[] => {
  const out = new Set<string>();
  for (const k of keys) {
    const p = parseSectionKey(k);
    if (!p) continue;
    if (p.kind === 'page' || p.kind === 'art') out.add(p.id);
    else if (p.kind === 'edp' || p.kind === 'trash') out.add(p.pageId);
  }
  return [...out];
};
