// Code Studio workspace (Sprint 1): editor, tabs, file tree + shared store.

export { CodeWorkspace } from './CodeWorkspace';
export type { CodeWorkspaceProps } from './CodeWorkspace';
export { LogsConsole } from './LogsConsole';
export { PreviewFrame } from './PreviewFrame';
export type { PreviewFrameProps } from './PreviewFrame';
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
