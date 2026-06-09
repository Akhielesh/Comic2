// One-click deploy orchestration (Phase 6 → live).
//
// The actual build + publish runs in the Studio Worker (it has wrangler + the Cloudflare token
// in its container), so this module just: validates the target, derives a safe Cloudflare Pages
// project name, asks the worker to deploy, normalizes its reply, and best-effort records the
// deployment. When the worker isn't configured it returns an honest `unavailable` so the client
// shows the working manual path instead of pretending to ship. Pure helpers are unit-tested; the
// live worker call is integration-only.

import { getSupabaseAdmin } from './supabase.js';
import { callStudioWorker } from './studioWorker.js';

export type DeployTarget = 'cloudflare' | 'vercel' | 'supabase';
export interface DeployResult {
  status: 'live' | 'queued' | 'building' | 'unavailable' | 'error';
  url?: string;
  message?: string;
}

const TARGETS: DeployTarget[] = ['cloudflare', 'vercel', 'supabase'];
export const normalizeTarget = (t: unknown): DeployTarget =>
  TARGETS.includes(t as DeployTarget) ? (t as DeployTarget) : 'cloudflare';

/**
 * A valid Cloudflare Pages project name: lowercase, [a-z0-9-], starts/ends alphanumeric, ≤58 chars.
 * Derived from the app title (+ a short project-id suffix for uniqueness). Pure.
 */
export const deployProjectName = (title?: string, projectId?: string): string => {
  const base =
    (title || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
  const suffix = (projectId || '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(-6);
  const name = (suffix ? `ds-${base}-${suffix}` : `ds-${base}`).replace(/-+/g, '-');
  return name.replace(/^-+|-+$/g, '').slice(0, 58) || 'ds-app';
};

/** A container-safe sandbox id (`u_<userId>_<projectId>`), matching the launch scheme. */
export const deploySandboxId = (userId: string, projectId?: string): string =>
  `u_${userId}_${(projectId || 'app').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40) || 'app'}`;

/** Normalize the worker's deploy JSON into a DeployResult. Pure. */
export const normalizeDeployResult = (json: any): DeployResult => {
  if (!json) return { status: 'error', message: 'No response from the deploy worker.' };
  if (json.status === 'error' || json.error) {
    return { status: 'error', message: String(json.message || json.error || 'Deploy failed.').slice(0, 400) };
  }
  const url = typeof json.url === 'string' ? json.url : typeof json.previewUrl === 'string' ? json.previewUrl : undefined;
  if (url) return { status: 'live', url };
  const status = (['queued', 'building', 'live'] as const).includes(json.status) ? json.status : 'queued';
  return { status, message: typeof json.message === 'string' ? json.message : undefined };
};

/** Best-effort deployment record (FK requires a saved project; failures are swallowed). */
export const recordDeployment = async (
  projectId: string | undefined,
  target: DeployTarget,
  status: string,
  url?: string,
): Promise<void> => {
  if (!projectId) return;
  try {
    const admin = getSupabaseAdmin();
    await admin.from('studio_deployments').insert({ project_id: projectId, target, status, url: url ?? null });
  } catch {
    /* best-effort — never block a deploy on telemetry */
  }
};

/** Ask the worker to build + publish the project to Cloudflare Pages and return the live URL. */
export const deployViaWorker = async (input: {
  userId: string;
  projectId?: string;
  title?: string;
  target: DeployTarget;
  files: { path: string; content: string }[];
}): Promise<DeployResult> => {
  const projectName = deployProjectName(input.title, input.projectId);
  const sandboxId = deploySandboxId(input.userId, input.projectId);
  // Deploy = npm install + build + wrangler/vercel publish — minutes, not seconds.
  const DEPLOY_TIMEOUT_MS = 9 * 60_000;
  const r = await callStudioWorker(
    { action: 'deploy', sandboxId, target: input.target, projectName, files: input.files },
    DEPLOY_TIMEOUT_MS,
  );
  if (!r.ok) {
    return { status: 'error', message: r.json?.message || r.json?.error || `Deploy worker returned ${r.status}.` };
  }
  return normalizeDeployResult(r.json);
};
