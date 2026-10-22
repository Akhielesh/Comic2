// Director tool group "timeline" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-TIMELINE,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: move/insert/duplicate/delete/restore_page, list_versions, use_version, set_book, fit_render.
// Phase gate (when): pages exist (versions: any render with history/archive).
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const timelineToolGroup: ToolGroup = {
  id: 'timeline',
  priority: 30,
  tools: () => []
};
