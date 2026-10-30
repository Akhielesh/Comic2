// Comic History — the shared engine (versions plan; package H0). Pure, dependency-free, used by server and client.
//
//   types     the wire contract (rows, manifests, compare, restore sets/scopes, actions, card)
//   sections  split a book into sections / join it back through normalizeDoc (§3.1)
//   apply     the pure `history_restore` applier (merge I1–I6, exact) — called by ops.ts applyOp
//   restore   what a scope brings back (§6.3)
//   diff      manifest and book compare with the semantic filter, word diff (§5)
//   touched   which sections an op touches and who made it (§4.1–§4.2)
//   describe  plain-word labels (§4.3)
//   when      "this morning" / "yesterday" in the user's time zone (§9)
//   lastAi    "Undo the last AI change" three-way plan (§6.4)
//   earlier   "Earlier (images only)" for comics older than History: dated drawings per owner and per local day
//
// Import it from 'shared/comic/history/index.js' (shared/comic/index.ts does not re-export it). Nothing under
// server/src/comic/publication/**, comics-edge/** or the public reader router imports history (§12).

export * from './types.js';
export * from './sections.js';
export { applyHistoryRestore, type RestoreKernel } from './apply.js';
export * from './restore.js';
export * from './diff.js';
export * from './touched.js';
export * from './describe.js';
export * from './when.js';
export * from './lastAi.js';
export * from './earlier.js';
