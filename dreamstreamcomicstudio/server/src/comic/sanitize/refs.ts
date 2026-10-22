// Client-patch sanitizers "refs" (contract §5.4 / §12.1): ref_add, ref_patch, ref_move, ref_remove, ref_transfer.
// Wave-0 stub by P0-B; owned in wave 1 by P1-REFS, which replaces them IN PLACE (keep the
// export name; one sanitizer per op). A sanitizer returns the op to commit (rewritten with
// forced fields/stamps) or throws StudioError (400 / 409 / 422) to reject the whole batch.
// Stub behaviour: 400 NOT_AVAILABLE.

import type { DocOp } from '../../../../shared/comic/ops.js';
import { notAvailableSanitizer, type OpSanitizer } from '../extensions.js';

export const REFS_SANITIZERS: OpSanitizer[] = [
  notAvailableSanitizer<Extract<DocOp, { op: 'ref_add' }>>('ref_add'),
  notAvailableSanitizer<Extract<DocOp, { op: 'ref_patch' }>>('ref_patch'),
  notAvailableSanitizer<Extract<DocOp, { op: 'ref_move' }>>('ref_move'),
  notAvailableSanitizer<Extract<DocOp, { op: 'ref_remove' }>>('ref_remove'),
  notAvailableSanitizer<Extract<DocOp, { op: 'ref_transfer' }>>('ref_transfer')
];
