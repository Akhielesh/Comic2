// Durable storage for Studio projects (Supabase). The container is disposable; the
// project (files + version history) is persisted here so it survives sleep/eviction/
// reload. All functions are scoped to a userId; the API calls them behind requireAuth.
// Writes use the service role (bypasses RLS); ownership is enforced in every query.

import { getSupabaseAdmin } from './supabase.js';
import { inferLanguage, filesToVersionMap, type StudioFileInput } from './studioFiles.js';

export interface StudioProjectSummary {
  id: string;
  name: string;
  template: string;
  updatedAt: string;
  deployUrl?: string;
  githubRepo?: string;
}

/** Create or update a project + replace its files + snapshot a version. Ownership-guarded. */
export const saveProject = async (input: {
  userId: string;
  projectId: string;
  name: string;
  template: string;
  files: StudioFileInput[];
  versionLabel?: string;
  createdBy?: 'agent' | 'user';
}): Promise<{ projectId: string; versionId?: string }> => {
  const admin = getSupabaseAdmin();

  // Guard: the projectId comes from the client on launch — never let it overwrite or
  // hijack a project owned by someone else.
  const { data: existing } = await admin
    .from('studio_projects')
    .select('user_id')
    .eq('id', input.projectId)
    .maybeSingle();
  if (existing && existing.user_id !== input.userId) {
    throw new Error('Project belongs to another user.');
  }

  await admin.from('studio_projects').upsert(
    {
      id: input.projectId,
      user_id: input.userId,
      name: input.name,
      template: input.template,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'id' }
  );

  // Replace the current file tree.
  await admin.from('studio_files').delete().eq('project_id', input.projectId);
  if (input.files.length) {
    await admin.from('studio_files').insert(
      input.files.map((f) => ({
        project_id: input.projectId,
        path: f.path,
        content: f.content,
        language: f.language || inferLanguage(f.path) || null
      }))
    );
  }

  // Snapshot a version (for history / restore).
  const { data: ver } = await admin
    .from('studio_versions')
    .insert({
      project_id: input.projectId,
      label: input.versionLabel || 'build',
      files: filesToVersionMap(input.files),
      created_by: input.createdBy || 'agent'
    })
    .select('id')
    .single();
  if (ver?.id) {
    await admin.from('studio_projects').update({ current_version_id: ver.id }).eq('id', input.projectId);
  }

  return { projectId: input.projectId, versionId: ver?.id };
};

export const listProjects = async (userId: string): Promise<StudioProjectSummary[]> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('studio_projects')
    .select('id, name, template, updated_at, deploy_url, github_repo')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(100);
  return (data || []).map((p) => ({
    id: p.id,
    name: p.name,
    template: p.template,
    updatedAt: p.updated_at,
    deployUrl: p.deploy_url || undefined,
    githubRepo: p.github_repo || undefined
  }));
};

export const getProjectWithFiles = async (
  userId: string,
  projectId: string
): Promise<{ project: Record<string, unknown>; files: { path: string; content: string; language: string | null }[] } | null> => {
  const admin = getSupabaseAdmin();
  const { data: project } = await admin
    .from('studio_projects')
    .select('id, name, template, deploy_url, github_repo, current_version_id, updated_at')
    .eq('id', projectId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!project) return null;
  const { data: files } = await admin
    .from('studio_files')
    .select('path, content, language')
    .eq('project_id', projectId);
  return { project, files: files || [] };
};

export const deleteProject = async (userId: string, projectId: string): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('studio_projects')
    .delete()
    .eq('id', projectId)
    .eq('user_id', userId)
    .select('id');
  return Array.isArray(data) && data.length > 0;
};
