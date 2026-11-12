// Client feature module "editor" (pro plan C7 SHELL; master plan §2.11: PE-SHELL in S2, PE-SHELL-2 in S3). The Pro
// workspace shell lives here: the Easy | Pro switch (ProModeSwitch, and the top bar), the tool rail, the docked
// workspace, the shortcuts and the shell's state (useProEditor). The page editor (board/PageEditor.tsx) mounts it while
// COMIC_PRO_EDITOR_V2 is on.
//
// The feature module itself still registers nothing (no card, tab, header slot or admin section), so features.ts
// leaves it out of featureModules() and every registry is what it was. The Pro parts (kit, inspector, layers, assets,
// animate, stage) are the sub-folders, each with its PE-0 `part`.
//
// features.ts imports this barrel statically, so it re-exports ONLY the Easy-path modules (the switch, the key table,
// the shell's state and the lazy doors). The Pro view's modules are imported by path, and only through proLazy.ts's
// lazy doors in the app (master plan §2.8: no Pro UI in the page editor's first load):
//   ./ProWorkspace      ProWorkspace, ProDockedWorkspace, ProDock, ProCoach, ShortcutSheet, ProLayersSheet,
//                       ProPanelFrame, ProToolRow, ProDrawer, ProInspectorSheet, ProTabletPanels
//   ./shortcuts         PRO_TOOLS (names, keys, hints), toolSpec, SHORTCUT_SHEET (and keys.ts re-exported)
//   ./ProTopBar         ProTopBar (and ProModeSwitch / MODE_GROUP_LABEL re-exported)
//   ./ToolRail          ToolRail, TOOL_RAIL_W
//   ./balloonTransform  the rotate / height handles, the two-finger rotate, dragRotation, BALLOON_TRANSFORM_KIT
//   ./proShapes         ShapePlaceLayer, shapeDropAt
//   ./proNudge          overlayNudgeOps

import type { FeatureModule } from '../extensions';

export const feature: FeatureModule = {};

export { ProModeSwitch, MODE_GROUP_LABEL, type ProModeSwitchProps } from './ProModeSwitch';
export {
  PRO_TOOL_IDS,
  PRO_TOOL_KEYS,
  TOOL_LINE_KIND,
  isEditableTarget,
  isLetteringTool,
  selectionHoldsArrows,
  shellShortcut,
  type ProTool,
  type ShellShortcut
} from './keys';
export { cycleReadingOrder } from './readingCycle';
export {
  PRO_COACH_CARDS,
  PRO_COACH_KEY,
  PRO_COACH_READERS_LINE,
  ProPartsContext,
  coachCardsFor,
  editorViewFor,
  mountedParts,
  panelOf,
  partModule,
  partMounts,
  reachableParts,
  readDismissedTips,
  useProEditor,
  writeDismissedTips,
  type MountedParts,
  type ProEditorState,
  type ProPanelProps,
  type ProPartModule
} from './useProEditor';
export { preloadProShell, useBalloonTransformKit } from './proLazy';
export type { DockTab, DockTabId, ProWorkspaceProps, ProDockProps, ProCoachProps } from './ProWorkspace';
export type { ProTopBarProps } from './ProTopBar';
export type { ToolRailProps } from './ToolRail';
