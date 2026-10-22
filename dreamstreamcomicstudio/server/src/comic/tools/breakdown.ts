// Director tool group "breakdown" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-BOOKMODEL,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: show_pages, quote.
// Phase gate (when): always.
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const breakdownToolGroup: ToolGroup = {
  id: 'breakdown',
  priority: 10,
  tools: () => []
};
