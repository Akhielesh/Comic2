// Client feature module "editor" (pro plan C7 SHELL; master plan §2.11: PE-SHELL in S2, PE-SHELL-2 in S3). The Pro
// workspace shell lives here: the Easy | Pro switch (ProTopBar), the tool rail, the docked workspace, the shortcuts and
// the shell's state (useProEditor). The page editor (board/PageEditor.tsx) mounts it while COMIC_PRO_EDITOR_V2 is on.
//
// The feature module itself still registers nothing (no card, tab, header slot or admin section), so features.ts
// leaves it out of featureModules() and every registry is what it was. The Pro parts (kit, inspector, layers, assets,
// animate, stage) are the sub-folders, each with its PE-0 `part`.

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};

export { ProWorkspace, ProDock, ProCoach, ShortcutSheet, ProLayersSheet, ProPanelFrame, type DockTab, type DockTabId, type ProWorkspaceProps, type ProDockProps, type ProCoachProps } from './ProWorkspace';
export { ProTopBar, ProModeSwitch, MODE_GROUP_LABEL, type ProTopBarProps, type ProModeSwitchProps } from './ProTopBar';
export { ToolRail, TOOL_RAIL_W, type ToolRailProps } from './ToolRail';
export {
  PRO_TOOLS,
  SHORTCUT_SHEET,
  TOOL_LINE_KIND,
  cycleReadingOrder,
  isEditableTarget,
  isLetteringTool,
  selectionHoldsArrows,
  shellShortcut,
  toolSpec,
  type ProTool,
  type ProToolSpec,
  type ShellShortcut
} from './shortcuts';
export {
  EDITOR_MODE_KEY,
  PRO_COACH_CARDS,
  PRO_COACH_KEY,
  ProPartsContext,
  coachCardsFor,
  editorViewFor,
  mountedParts,
  partModule,
  partMounts,
  readEditorMode,
  requestEditorTool,
  takeEditorTool,
  useProEditor,
  writeEditorMode,
  type MountedParts,
  type ProEditorState,
  type ProPanelProps,
  type ProPartModule
} from './useProEditor';
