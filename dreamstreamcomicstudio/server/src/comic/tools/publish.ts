// Director tool group "publish" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-PUBLISH,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: publish_comic, get_share_link, unpublish_comic, update_publication (cards only; never act).
// Phase gate (when): at least one page drawn.
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const publishToolGroup: ToolGroup = {
  id: 'publish',
  priority: 40,
  tools: () => []
};
