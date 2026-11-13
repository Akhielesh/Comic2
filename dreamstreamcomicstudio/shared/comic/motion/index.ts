// Pro Edit motion (master plan §2.5). The stored shape (types.ts, PE-0) and the pure motion engine (PE-MOTION-ENGINE):
// reading beats (beats.ts), easing, the presets and their param schemas, the evaluator (sample.ts sampleAt), the calm,
// reduced and poster readings (reduced.ts) and the budgets PE-SERVER's sanitizer shares (budget.ts).
//
// The normalizer that keeps stored motion valid is doc.ts normalizePageMotion; the ops are ops.ts `motion` /
// `page_motion` (behind PRO_EDIT_OPS_PATCHABLE). Nothing here writes ops.
//
// Light callers (History, undo labels, anything in the reader's first load) import words.ts or types.ts directly, never
// this barrel: the engine modules are Pro code (master plan §2.8). Their tables are marked pure, so a bundle that takes
// only a label from here still drops them, but the leaf is the rule (chunks.test.ts holds both).

export * from './types.js';
export * from './words.js';
export * from './easing.js';
export * from './beats.js';
export * from './presets.js';
export * from './budget.js';
export * from './sample.js';
export * from './reduced.js';
