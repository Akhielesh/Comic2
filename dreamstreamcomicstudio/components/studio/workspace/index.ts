// Code Studio workspace (Sprint 1): editor, tabs, file tree + shared store.

export { CodeWorkspace } from './CodeWorkspace';
export type { CodeWorkspaceProps } from './CodeWorkspace';
export { MonacoEditor } from './MonacoEditor';
export { FileTree, buildTree } from './FileTree';
export { EditorTabs } from './EditorTabs';
export {
  useStudioWorkspace,
  isPathDirty,
  dirtyPaths,
  workspaceToArtifact,
} from './workspaceStore';
