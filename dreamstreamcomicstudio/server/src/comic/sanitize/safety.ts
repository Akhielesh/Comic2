// Client-patch safety screen (contract §5.4 "pre-filter", §12.6). Owner: P1-SAFETY.
//
// The screen sees the WHOLE sanitized batch (every feature's ops) after the per-op sanitizers.
// Free text (line text, translations, cover/book/reader text, names, notes, briefs, ref notes…)
// goes through the $0 pre-filter at the request's effective rating:
//   block                                   → 422 CONTENT_POLICY, nothing of the batch is applied
//   dialogue past the rating (strict kinds) → 409 CONTENT_POLICY with a suggested rewrite
//                                             (swearing → comic grawlixes "@#$%!")
// Everything else passes and is re-checked at publish. No model call, no spend, no text logged.

import type { DocOp } from '../../../../shared/comic/ops.js';
import { audienceCeiling, minRating } from '../../../../shared/comic/safety.js';
import type { OpSanitizer, PatchScreen } from '../extensions.js';
import { screenOpsText } from '../safety/index.js';

/** Safety owns no op of its own; the screen below covers every op's text. */
export const SAFETY_SANITIZERS: OpSanitizer[] = [];

export const safetyPatchScreen: PatchScreen = (doc, ops: DocOp[], ctx) => {
  screenOpsText(doc, ops, {
    userId: ctx?.userId,
    projectId: doc?.id,
    rating: ctx?.rating ?? 'PG-13',
    ceiling: minRating(audienceCeiling(doc), ctx?.caps?.ratingCeiling)
  });
  return ops;
};
