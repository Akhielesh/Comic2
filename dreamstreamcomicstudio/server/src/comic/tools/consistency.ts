// Director tool group "consistency" (pro plan §4.7; B10). STUB with fixed export names (K2b): B10 replaces it in place
// and owns this file from the moment K2b merges (pro plan §10 stub rule).
//
// B10 builds consistency_report, set_continuity (with its impact and price), set_panel_direction, make_anchors (quoted,
// gated), fix_finding (free kinds direct, paid kinds quoted) and enrich_pages (quoted). The stub offers no tool, is never
// active and is not registered (tools/index.ts lists it only once consistencyToolGroupEnabled() says so).

import type { ToolGroup } from '../extensions.js';

export const consistencyToolGroup: ToolGroup = {
  id: 'consistency',
  priority: 41,
  when: () => false,
  tools: () => [],
  activity: {}
};

/** Whether the registry lists the consistency group (read once, when the registry fills). STUB: false. */
export const consistencyToolGroupEnabled = (): boolean => false;
