// Director tool group "lettering" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-LETTER-ENGINE,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: set_lettering_style, restyle_balloons, arrange_balloons.
// Phase gate (when): overlay lettering and at least one page.
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const letteringToolGroup: ToolGroup = {
  id: 'lettering',
  priority: 20,
  tools: () => []
};
