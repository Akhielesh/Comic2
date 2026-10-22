// Feature actions "safety" (contract §12.1): safety_recheck.
// Wave-0 stub by P0-B; owned in wave 1 by P1-SAFETY, which replaces the handlers IN PLACE
// (keep the export name; one handler per action type).
// Stub behaviour: every action answers `blocked` with code NOT_AVAILABLE and an honest notice.

import type { StudioAction } from '../../../../shared/comic/ops.js';
import { notAvailableAction, type ActionHandler } from '../extensions.js';

export const SAFETY_ACTIONS: ActionHandler[] = [
  notAvailableAction<Extract<StudioAction, { type: 'safety_recheck' }>>('safety_recheck', false, "Safety re-checks aren't available yet.")
];
