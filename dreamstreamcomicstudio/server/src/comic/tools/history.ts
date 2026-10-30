// Director tool group "history" (versions plan §9; package H0 STUB — H4 replaces it in place, keeping the export
// names and types).
//
// H4 builds three FREE tools under the per-turn ceiling: `history` (list / show / compare / read a moment, with
// "this morning" / "yesterday" resolved in the request's time zone — history/hooks.ts turnTimeZone + shared
// history/when.ts), `restore_from_history` (partial scopes on an explicit request; whole book, switch and conflicted
// undo-AI only through a card the user taps) and `save_version`.
//
// The group is registered only while Comic History is on (COMIC_HISTORY=1; tools/index.ts), so with the flag unset
// the director's toolset is byte-identical. The stub offers no tool and is never active.

import type { ToolGroup } from '../extensions.js';
import { isHistoryEnabled } from '../history/hooks.js';

export const historyToolGroup: ToolGroup = {
  id: 'history',
  priority: 35,
  when: () => false,
  tools: () => [],
  activity: {}
};

/** Whether the registry lists the history group (read once, when the registry fills). */
export const historyToolGroupEnabled = (): boolean => isHistoryEnabled();
