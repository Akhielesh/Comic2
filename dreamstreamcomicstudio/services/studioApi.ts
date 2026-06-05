// Client for the Studio v2 control plane (/api/studio/*).
//
// Kept separate from studioLauncher.ts (which the standalone /studio.html bundle imports)
// so the heavier apiClient deps don't get pulled into that bundle.

import { post } from './apiClient';
import type { CodeStudioArtifact } from '../apiTypes';

export interface LiveStudioResult {
  previewUrl?: string;
  sandboxId: string;
  projectId: string;
  runId?: string;
}

/**
 * Whether the live (Cloudflare container) Studio path is enabled in this build.
 * Off by default — the owner flips VITE_STUDIO_LIVE_ENABLED=true after deploying the
 * Studio Worker (see docs/studio/OWNER-ACTIONS.md), so production is unaffected until then.
 */
export const isLiveStudioEnabled = (): boolean =>
  String(import.meta.env.VITE_STUDIO_LIVE_ENABLED || '').toLowerCase() === 'true';

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
