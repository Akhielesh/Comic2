// Feature actions "refs" (contract §12.1): ref_crop.
// Wave-0 stub by P0-B; owned in wave 1 by P1-REFS, which replaces the handlers IN PLACE
// (keep the export name; one handler per action type).
// Stub behaviour: every action answers `blocked` with code NOT_AVAILABLE and an honest notice.

import type { StudioAction } from '../../../../shared/comic/ops.js';
import { notAvailableAction, type ActionHandler } from '../extensions.js';

export const REFS_ACTIONS: ActionHandler[] = [
  notAvailableAction<Extract<StudioAction, { type: 'ref_crop' }>>('ref_crop', false, "Cropping reference photos isn't available yet.")
];
