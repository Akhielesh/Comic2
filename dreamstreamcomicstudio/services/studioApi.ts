// Client for the Studio v2 control plane (/api/studio/*).
//
// Kept separate from studioLauncher.ts (which the standalone /studio.html bundle imports)
// so the heavier apiClient deps don't get pulled into that bundle.

import { post, get, del } from './apiClient';
import type { CodeStudioArtifact, CodeStudioFile } from '../apiTypes';

export interface LiveStudioResult {
  previewUrl?: string;
  sandboxId: string;
  projectId: string;
  runId?: string;
}

// Re-exported from the dependency-free flags module (kept here for back-compat with existing
// importers). New code can import directly from services/studioFlags.
export { isLiveStudioEnabled } from './studioFlags';

/** Launch the project on the live Studio and get back a preview URL to open. */
export const launchLiveStudio = async (
  artifact: CodeStudioArtifact,
  projectId?: string
): Promise<LiveStudioResult> => {
  const files = artifact.files.map((f) => ({ path: f.path, content: f.content }));
  return post<
    { projectId?: string; title?: string; template?: string; files: { path: string; content: string }[] },
    LiveStudioResult
  >('/api/studio/launch', { projectId, title: artifact.title, template: artifact.template, files });
};

/** Stop a running live preview. */
export const stopLiveStudio = async (runId: string): Promise<{ status: string; awakeSeconds?: number }> =>
  post<Record<string, never>, { status: string; awakeSeconds?: number }>(`/api/studio/${runId}/stop`, {});

// --- Saved projects (Phase 5 persistence) ------------------------------------------------

export interface StudioProjectSummary {
  id: string;
  name: string;
  template: string;
  updatedAt: string;
  deployUrl?: string;
  githubRepo?: string;
}

/** The user's saved Code Studio projects, most recent first. */
export const listStudioProjects = async (): Promise<StudioProjectSummary[]> =>
  (await get<{ projects: StudioProjectSummary[] }>('/api/studio/projects')).projects;

/** A saved project with its current file tree, mapped to a runnable artifact. */
export const getStudioProject = async (id: string): Promise<CodeStudioArtifact & { id: string }> => {
  const data = await get<{
    project: { id: string; name: string; template?: string };
    files: { path: string; content: string; language: string | null }[];
  }>(`/api/studio/projects/${encodeURIComponent(id)}`);
  const files: CodeStudioFile[] = data.files.map((f) => ({ path: f.path, content: f.content }));
  return {
    id: data.project.id,
    title: data.project.name,
    template: (data.project.template as CodeStudioArtifact['template']) || 'react-ts',
    files,
  };
};

/** Delete a saved project. */
export const deleteStudioProject = async (id: string): Promise<void> => {
  await del<{ deleted: boolean }>(`/api/studio/projects/${encodeURIComponent(id)}`);
};
