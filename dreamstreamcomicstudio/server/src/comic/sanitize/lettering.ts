// Client-patch sanitizers "lettering" (contract §5.4 / §12.1): letter_style, line_style.
// Wave-0 stub by P0-B; owned in wave 1 by P1-LETTER-ENGINE, which replaces them IN PLACE (keep the
// export name; one sanitizer per op). A sanitizer returns the op to commit (rewritten with
// forced fields/stamps) or throws StudioError (400 / 409 / 422) to reject the whole batch.
// Stub behaviour: 400 NOT_AVAILABLE.

import type { DocOp } from '../../../../shared/comic/ops.js';
import { notAvailableSanitizer, type OpSanitizer } from '../extensions.js';

export const LETTERING_SANITIZERS: OpSanitizer[] = [
  notAvailableSanitizer<Extract<DocOp, { op: 'letter_style' }>>('letter_style'),
  notAvailableSanitizer<Extract<DocOp, { op: 'line_style' }>>('line_style')
];
