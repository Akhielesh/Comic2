// Code Studio workspace (Sprint 1): editor, tabs, file tree + shared store.

export { CodeWorkspace } from './CodeWorkspace';
export type { CodeWorkspaceProps } from './CodeWorkspace';
export { LogsConsole } from './LogsConsole';
export { PreviewFrame } from './PreviewFrame';
export type { PreviewFrameProps } from './PreviewFrame';
export { BuildTrace } from './BuildTrace';
export { useStudioBuild } from './buildStore';
export { ChangesPanel } from './ChangesPanel';
export { DiffView } from './DiffView';
export { diffLines, diffStat } from './diff';
export { HistoryPanel } from './HistoryPanel';
export { useStudioLogs, MAX_LOG_ENTRIES } from './logsStore';
export type { LogEntry, LogLevel } from './logsStore';
export { MonacoEditor } from './MonacoEditor';
export { FileTree, buildTree } from './FileTree';
export { EditorTabs } from './EditorTabs';
export {
  useStudioWorkspace,
  isPathDirty,
  dirtyPaths,
  workspaceToArtifact,
  workspaceCurrentArtifact,
} from './workspaceStore';
