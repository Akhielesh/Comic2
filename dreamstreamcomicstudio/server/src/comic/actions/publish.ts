// Feature actions "publish" (contract §12.1): publish, update_publication, unpublish, regenerate_link, decline_publish.
// Wave-0 stub by P0-B; owned in wave 1 by P1-PUBLISH, which replaces the handlers IN PLACE
// (keep the export name; one handler per action type).
// Stub behaviour: every action answers `blocked` with code NOT_AVAILABLE and an honest notice.

import type { StudioAction } from '../../../../shared/comic/ops.js';
import { notAvailableAction, type ActionHandler } from '../extensions.js';

export const PUBLISH_ACTIONS: ActionHandler[] = [
  notAvailableAction<Extract<StudioAction, { type: 'publish' }>>('publish', false, "Publishing from the studio isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'update_publication' }>>('update_publication', false, "Publishing from the studio isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'unpublish' }>>('unpublish', false, "Publishing from the studio isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'regenerate_link' }>>('regenerate_link', false, "Publishing from the studio isn't available yet."),
  notAvailableAction<Extract<StudioAction, { type: 'decline_publish' }>>('decline_publish', false, "Publishing from the studio isn't available yet.")
];
