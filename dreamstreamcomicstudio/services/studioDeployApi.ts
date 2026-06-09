// Client for publishing/deploying a Code Studio app. Talks to POST /api/studio/deploy.
//
// The server's one-click cloud deploy lands with the deploy worker; until an operator wires it,
// the endpoint reports "unavailable" and the Publish panel guides the user through the (working)
// manual path — a deploy-ready bundle + real provider commands. This client normalizes both cases
// into a single honest result so the UI never lies about whether the app actually shipped.

import { post } from './apiClient';

export type DeployTarget = 'cloudflare' | 'vercel' | 'supabase';

export interface DeployResult {
  status: 'live' | 'queued' | 'unavailable' | 'error';
  url?: string;
  message?: string;
}

export const deployStudioApp = async (
  input: { projectId?: string | null; title?: string; target: DeployTarget; files: { path: string; content: string }[] },
  signal?: AbortSignal,
): Promise<DeployResult> => {
  try {
    const res = await post<Record<string, unknown>, DeployResult>(
      '/api/studio/deploy',
      { projectId: input.projectId ?? undefined, title: input.title, target: input.target, files: input.files },
      { signal },
    );
    return res?.status ? res : { status: 'queued' };
  } catch (err) {
    const msg = (err as Error)?.message || '';
    // 501 Not Implemented (or "not configured") → the cloud deploy isn't wired yet on this server.
    if (/501|not implemented|not configured|STUDIO_DEPLOY/i.test(msg)) {
      return { status: 'unavailable', message: 'One-click cloud deploy isn’t enabled on this server yet — use the manual steps below (they work today).' };
    }
    return { status: 'error', message: msg || 'Deploy failed.' };
  }
};
