// Director tool-group registry (contract §12.1; created in wave 0 by P0-B, FROZEN in wave 1).
//
// Every feature group is listed here exactly once. Core tools stay in ../tools.ts
// (buildDirectorTools); director.ts merges core + the active groups per turn with
// buildTurnToolset(), sorted by priority and trimmed to MAX_TOOLS_PER_TURN.

import { createKeyedRegistry, type ToolGroup } from '../extensions.js';
import { breakdownToolGroup } from './breakdown.js';
import { i18nToolGroup } from './i18n.js';
import { letteringToolGroup } from './lettering.js';
import { libraryToolGroup } from './library.js';
import { modelsToolGroup } from './models.js';
import { publishToolGroup } from './publish.js';
import { readerToolGroup } from './reader.js';
import { refsToolGroup } from './refs.js';
import { safetyToolGroup } from './safety.js';
import { timelineToolGroup } from './timeline.js';
// --- history (versions plan §9; H0 stub, H4 replaces it). Listed only while COMIC_HISTORY is on. ---
import { historyToolGroup, historyToolGroupEnabled } from './history.js';

const registry = createKeyedRegistry<ToolGroup>({
  what: 'tool group',
  keyOf: (g) => g.id,
  reserved: new Set(['core']),
  lists: () => [
    [
      safetyToolGroup,
      breakdownToolGroup,
      refsToolGroup,
      letteringToolGroup,
      timelineToolGroup,
      publishToolGroup,
      i18nToolGroup,
      libraryToolGroup,
      readerToolGroup,
      modelsToolGroup,
      ...(historyToolGroupEnabled() ? [historyToolGroup] : [])
    ]
  ]
});

/** Feature tool groups in registration order (filled at load, or lazily on first use). */
export const TOOL_GROUPS: ToolGroup[] = [];

/** The registered feature groups (use this rather than reading TOOL_GROUPS during module init). */
export function toolGroups(): ToolGroup[] {
  registry.ensure();
  if (TOOL_GROUPS.length !== Object.keys(registry.table).length) TOOL_GROUPS.splice(0, TOOL_GROUPS.length, ...Object.values(registry.table));
  return TOOL_GROUPS;
}

/** One group by id (undefined for 'core' and unknown ids). */
export const toolGroupById = (id: string): ToolGroup | undefined => registry.get(id);

try {
  toolGroups();
} catch (err) {
  if (!(err instanceof ReferenceError)) throw err;
}
