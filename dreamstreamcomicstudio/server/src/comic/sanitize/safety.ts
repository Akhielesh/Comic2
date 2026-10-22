// Client-patch safety screen (contract §5.4 "pre-filter", §12.6). Wave-0 stub by P0-B; owned
// in wave 1 by P1-SAFETY, which replaces it IN PLACE (keep the export names).
//
// The screen sees the WHOLE sanitized batch (every feature's ops) after the per-op
// sanitizers: free-text fields (line text, book blurb/credits, reader credits/dedication,
// ref notes, translations) go through prefilterText() at ctx.rating; `block` → 422
// CONTENT_POLICY, `ambiguous` above the rating → 409 with the suggested rewrite.
// Stub behaviour: pass (returns the ops unchanged).

import type { DocOp } from '../../../../shared/comic/ops.js';
import type { OpSanitizer, PatchScreen } from '../extensions.js';

/** Safety owns no op of its own; the screen below covers every op's text. */
export const SAFETY_SANITIZERS: OpSanitizer[] = [];

export const safetyPatchScreen: PatchScreen = (_doc, ops: DocOp[]) => ops;
