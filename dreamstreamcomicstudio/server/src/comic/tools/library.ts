// Director tool group "library" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-LIBRARY,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: suggest_presets, use_preset.
// Phase gate (when): style empty or drafted.
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const libraryToolGroup: ToolGroup = {
  id: 'library',
  priority: 60,
  tools: () => []
};
