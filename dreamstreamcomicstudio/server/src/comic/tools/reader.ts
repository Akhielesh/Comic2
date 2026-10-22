// Director tool group "reader" (contract §12.1/§12.2). Wave-0 stub by P0-B; owned in wave 1 by P1-READER,
// which replaces the implementation IN PLACE (keep the export name and type).
//
// Final tools: set_reader_options, set_chapter.
// Phase gate (when): at least one page drawn.
// Stub behaviour: contributes no tools, prompt rules or summary lines.

import type { ToolGroup } from '../extensions.js';

export const readerToolGroup: ToolGroup = {
  id: 'reader',
  priority: 70,
  tools: () => []
};
