// Studio GitHub sync routes (Phase 6). Mounted under /api/studio/github (auth'd by the
// global requireAuth). The GitHub PAT is supplied per-request via the `x-github-token`
// header and used transiently -- never stored (matches the BYOK posture for provider
// keys). We persist only the repo name on the project.

import { Router } from 'express';
import { getSupabaseAdmin } from '../services/supabase.js';
import { getProjectWithFiles, saveProject } from '../services/studioRepository.js';
import { sanitizeFiles, deriveProjectName } from '../services/studioFiles.js';
import { listRepos, pushFiles, pullFiles, parseRepoFullName, type RepoFile } from '../services/studioGithub.js';
import { normalizeStudioId } from '../services/studioIds.js';

export const studioGithubRouter = Router();

const tokenFrom = (req: { header(name: string): string | undefined }): string =>
  (req.header('x-github-token') || '').trim();

const needToken = { error: { message: 'A GitHub token is required (send it in the x-github-token header).', code: 'GITHUB_TOKEN_REQUIRED' } };

// GET /api/studio/github/repos — repos the token can push to.
studioGithubRouter.get('/repos', async (req, res, next) => {
  try {
    const token = tokenFrom(req);
    if (!token) return res.status(400).json(needToken);
    res.json({ repos: await listRepos(token) });
  } catch (err) {
    res.status(502).json({ error: { message: (err as Error)?.message || 'Could not reach GitHub.', code: 'GITHUB_ERROR' } });
    void next;
  }
});

// POST /api/studio/github/push — commit the saved project's files to a repo.
studioGithubRouter.post('/push', async (req, res, next) => {
  try {
    const token = tokenFrom(req);
    if (!token) return res.status(400).json(needToken);
    const body = (req.body || {}) as { projectId?: string; repo?: string; branch?: string; message?: string; files?: unknown };

    const parsed = typeof body.repo === 'string' ? parseRepoFullName(body.repo) : null;
    if (!parsed) return res.status(400).json({ error: { message: 'A repo as "owner/name" is required.', code: 'REPO_REQUIRED' } });
    const branch = (typeof body.branch === 'string' && body.branch.trim()) || 'main';

    // Prefer the saved project's files; fall back to files supplied in the body.
    const projectId = normalizeStudioId(body.projectId);
    let files: RepoFile[] = [];
    if (projectId) {
      const data = await getProjectWithFiles(req.user!.id, projectId);
      if (data) files = data.files.map((f) => ({ path: f.path, content: f.content }));
    }
    if (!files.length) files = sanitizeFiles(body.files).map((f) => ({ path: f.path, content: f.content }));
    if (!files.length) return res.status(400).json({ error: { message: 'No files to push.', code: 'NO_FILES' } });

    const result = await pushFiles({
      token,
      owner: parsed.owner,
      repo: parsed.repo,
      branch,
      files,
      message: (typeof body.message === 'string' && body.message.trim()) || 'Update from DreamStream Studio'
    });

    // Record the repo on the project so the UI shows the connection.
    if (projectId) {
      try {
        await getSupabaseAdmin()
          .from('studio_projects')
          .update({ github_repo: `${parsed.owner}/${parsed.repo}` })
          .eq('id', projectId)
          .eq('user_id', req.user!.id);
      } catch {
        /* best-effort */
      }
    }

    res.json({ ...result, repo: `${parsed.owner}/${parsed.repo}` });
  } catch (err) {
    res.status(502).json({ error: { message: (err as Error)?.message || 'Push failed.', code: 'GITHUB_PUSH_FAILED' } });
    void next;
  }
});

// POST /api/studio/github/pull — read a repo's tree back into the project (new version).
studioGithubRouter.post('/pull', async (req, res, next) => {
  try {
    const token = tokenFrom(req);
    if (!token) return res.status(400).json(needToken);
    const body = (req.body || {}) as { projectId?: string; repo?: string; branch?: string };

    const parsed = typeof body.repo === 'string' ? parseRepoFullName(body.repo) : null;
    if (!parsed) return res.status(400).json({ error: { message: 'A repo as "owner/name" is required.', code: 'REPO_REQUIRED' } });
    const projectId = normalizeStudioId(body.projectId);
    if (!projectId) {
      return res.status(400).json({ error: { message: 'projectId is required to pull into a project.', code: 'PROJECT_REQUIRED' } });
    }
    const branch = (typeof body.branch === 'string' && body.branch.trim()) || 'main';

    const repoFiles = await pullFiles({ token, owner: parsed.owner, repo: parsed.repo, branch });
    const files = sanitizeFiles(repoFiles);
    if (!files.length) return res.status(422).json({ error: { message: 'No text files found in the repo to pull.', code: 'EMPTY_REPO' } });

    await saveProject({
      userId: req.user!.id,
      projectId,
      name: deriveProjectName(undefined, files),
      template: 'react-ts',
      files,
      versionLabel: `github pull (${parsed.owner}/${parsed.repo}@${branch})`,
      createdBy: 'user'
    });

    res.json({ projectId, fileCount: files.length, repo: `${parsed.owner}/${parsed.repo}`, branch });
  } catch (err) {
    res.status(502).json({ error: { message: (err as Error)?.message || 'Pull failed.', code: 'GITHUB_PULL_FAILED' } });
    void next;
  }
});
