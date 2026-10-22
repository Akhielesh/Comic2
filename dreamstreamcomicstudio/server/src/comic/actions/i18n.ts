// Feature actions "i18n" (contract §12.1): translate, swap_source_language, accept_translation_issue.
// Wave-0 stub by P0-B; owned in wave 1 by P1-I18N, which replaces the handlers IN PLACE
// (keep the export name; one handler per action type).
// `translate` is a SPEND action: jobs.ts runs estimate → gateDecision → run for spend handlers (P1-JOBS).
// Stub behaviour: every action answers `blocked` with code NOT_AVAILABLE and an honest notice.

import type { StudioAction } from '../../../../shared/comic/ops.js';
import { notAvailableAction, type ActionHandler } from '../extensions.js';

export const I18N_ACTIONS: ActionHandler[] = [
  notAvailableAction<Extract<StudioAction, { type: 'translate' }>>('translate', true, "Translation isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'swap_source_language' }>>('swap_source_language', false, "Changing the comic's language isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'accept_translation_issue' }>>('accept_translation_issue', false, "Translation review isn't available yet.")
];
