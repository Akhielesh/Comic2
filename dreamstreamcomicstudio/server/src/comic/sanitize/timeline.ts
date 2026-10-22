// Client-patch sanitizers "timeline" (contract §5.4 / §12.1): pages_reorder, page_insert, page_duplicate, page_delete, page_restore, book, render_use, version_star.
// Wave-0 stub by P0-B; owned in wave 1 by P1-TIMELINE, which replaces them IN PLACE (keep the
// export name; one sanitizer per op). A sanitizer returns the op to commit (rewritten with
// forced fields/stamps) or throws StudioError (400 / 409 / 422) to reject the whole batch.
// Stub behaviour: 400 NOT_AVAILABLE.

import type { DocOp } from '../../../../shared/comic/ops.js';
import { notAvailableSanitizer, type OpSanitizer } from '../extensions.js';

export const TIMELINE_SANITIZERS: OpSanitizer[] = [
  notAvailableSanitizer<Extract<DocOp, { op: 'pages_reorder' }>>('pages_reorder'),
  notAvailableSanitizer<Extract<DocOp, { op: 'page_insert' }>>('page_insert'),
  notAvailableSanitizer<Extract<DocOp, { op: 'page_duplicate' }>>('page_duplicate'),
  notAvailableSanitizer<Extract<DocOp, { op: 'page_delete' }>>('page_delete'),
  notAvailableSanitizer<Extract<DocOp, { op: 'page_restore' }>>('page_restore'),
  notAvailableSanitizer<Extract<DocOp, { op: 'book' }>>('book'),
  notAvailableSanitizer<Extract<DocOp, { op: 'render_use' }>>('render_use'),
  notAvailableSanitizer<Extract<DocOp, { op: 'version_star' }>>('version_star')
];
