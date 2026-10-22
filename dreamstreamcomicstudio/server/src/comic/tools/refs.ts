// Director tool group "refs" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-REFS,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: attach_refs, set_primary_ref, label_ref, move_ref, remove_ref.
// Phase gate (when): images this turn, carried images, or refs exist.
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const refsToolGroup: ToolGroup = {
  id: 'refs',
  priority: 15,
  tools: () => []
};
