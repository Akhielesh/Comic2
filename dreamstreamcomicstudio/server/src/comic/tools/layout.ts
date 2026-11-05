// Director tool group "layout" (pro plan §4.7; B10). STUB with fixed export names (K2b): B10 replaces it in place and
// owns this file from the moment K2b merges (pro plan §10 stub rule).
//
// B10 builds check_page, fix_layout, split_page, arrange_page (through the shared editor engine, so the director's ops
// equal the UI's), panelize_page and a fix_panel quote card, behind a cheap `when` regex (the per-turn tool ceiling
// holds). The stub offers no tool, is never active and is not even registered (tools/index.ts lists it only once
// layoutToolGroupEnabled() says so), so the director's toolset is byte-identical.

import type { ToolGroup } from '../extensions.js';

export const layoutToolGroup: ToolGroup = {
  id: 'layout',
  priority: 40,
  when: () => false,
  tools: () => [],
  activity: {}
};

/** Whether the registry lists the layout group (read once, when the registry fills). STUB: false. */
export const layoutToolGroupEnabled = (): boolean => false;
