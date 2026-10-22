// Client-patch sanitizers "i18n" (contract §5.4 / §12.1): edition, translation, edition_text, edition_balloon, glossary_term.
// Wave-0 stub by P0-B; owned in wave 1 by P1-I18N, which replaces them IN PLACE (keep the
// export name; one sanitizer per op). A sanitizer returns the op to commit (rewritten with
// forced fields/stamps) or throws StudioError (400 / 409 / 422) to reject the whole batch.
// Stub behaviour: 400 NOT_AVAILABLE.

import type { DocOp } from '../../../../shared/comic/ops.js';
import { notAvailableSanitizer, type OpSanitizer } from '../extensions.js';

export const I18N_SANITIZERS: OpSanitizer[] = [
  notAvailableSanitizer<Extract<DocOp, { op: 'edition' }>>('edition'),
  notAvailableSanitizer<Extract<DocOp, { op: 'translation' }>>('translation'),
  notAvailableSanitizer<Extract<DocOp, { op: 'edition_text' }>>('edition_text'),
  notAvailableSanitizer<Extract<DocOp, { op: 'edition_balloon' }>>('edition_balloon'),
  notAvailableSanitizer<Extract<DocOp, { op: 'glossary_term' }>>('glossary_term')
];
