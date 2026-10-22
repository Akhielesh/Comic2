// Feature actions "timeline" (contract §12.1): fit_render.
// Wave-0 stub by P0-B; owned in wave 1 by P1-TIMELINE (fit_render calls derive.ts from P1-STORAGE), which replaces the handlers IN PLACE
// (keep the export name; one handler per action type).
// Stub behaviour: every action answers `blocked` with code NOT_AVAILABLE and an honest notice.

import type { StudioAction } from '../../../../shared/comic/ops.js';
import { notAvailableAction, type ActionHandler } from '../extensions.js';

export const TIMELINE_ACTIONS: ActionHandler[] = [
  notAvailableAction<Extract<StudioAction, { type: 'fit_render' }>>('fit_render', false, "Fitting a drawing to its page shape isn't available yet.")
];
