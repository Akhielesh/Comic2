// Dialogue understanding: the pipeline (agent-editor plan §3 B2). Final names and signatures (K3 contract); the bodies
// live in grammar.ts / resolve.ts / speakers.ts / placement.ts / compile.ts (wave 1 B-RESOLVE). Pure and free: no model
// call, no I/O, no spend.
//
//   text + focus → parseDialogue → DialogueIntent[] → resolveLineRef → 0, 1 or N lines → compileIntent → DocOp[] (free),
//   or a question ("Which line?", "Who says it?"). compileDialogue runs the whole chain for the director and the fast path.

export * from './types.js';
export * from './speakers.js';
export * from './placement.js';
export * from './resolve.js';
export * from './compile.js';
export * from './grammar.js';

/**
 * What the wave-0 stubs answered. Kept for callers that still name it (the dialogue engine is built; nothing returns it
 * any more).
 */
export const DIALOGUE_NOT_READY = "Dialogue understanding isn't available yet.";
