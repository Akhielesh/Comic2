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
export { PromptComposer } from './PromptComposer';
export type { PromptComposerProps } from './PromptComposer';
export { ConversationThread } from './ConversationThread';
export { useStudioConversation } from './conversationStore';
export type { StudioMessage } from './conversationStore';
export { ActivityFeed } from './ActivityFeed';
export { useStudioActivity } from './activityStore';
export type { StudioActivityItem } from './activityStore';
export { ClarifyPanel } from './ClarifyPanel';
export type { ClarifyPanelProps } from './ClarifyPanel';
export { PlanPanel } from './PlanPanel';
export type { PlanPanelProps } from './PlanPanel';
export { detectProjectKind, projectKindLabel, isWebProject, runHint } from './projectKind';
export type { ProjectKind } from './projectKind';
export { ServicesPanel } from './ServicesPanel';
export { detectServices, buildEnvExample } from './serviceDetect';
export type { DetectedServices, ServiceId } from './serviceDetect';
export { InsightsPanel } from './InsightsPanel';
export type { InsightsPanelProps } from './InsightsPanel';
export {
  analyzeProject, applyRuntimeStatus, insightsSummary, issuesToFixPrompt, suggestNextSteps, insightsToMarkdown,
} from './codeInsights';
export type { CodeInsights, CodeIssue, InsightSeverity } from './codeInsights';
export {
  useStudioWorkspace,
  isPathDirty,
  dirtyPaths,
  workspaceToArtifact,
  workspaceCurrentArtifact,
} from './workspaceStore';
