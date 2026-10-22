// Director tool group "safety" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-SAFETY,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: set_content_rating, request_safety_review.
// Phase gate (when): always.
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const safetyToolGroup: ToolGroup = {
  id: 'safety',
  priority: 5,
  tools: () => []
};
