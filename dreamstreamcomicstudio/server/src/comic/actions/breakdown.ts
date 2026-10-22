// Feature actions "breakdown" (contract §12.1): show_breakdown.
// Wave-0 stub by P0-B; owned in wave 1 by P1-BOOKMODEL, which replaces the handlers IN PLACE
// (keep the export name; one handler per action type).
// Stub behaviour: every action answers `blocked` with code NOT_AVAILABLE and an honest notice.

import type { StudioAction } from '../../../../shared/comic/ops.js';
import { notAvailableAction, type ActionHandler } from '../extensions.js';

export const BREAKDOWN_ACTIONS: ActionHandler[] = [
  notAvailableAction<Extract<StudioAction, { type: 'show_breakdown' }>>('show_breakdown', false, "The page breakdown isn't available yet.")
];
