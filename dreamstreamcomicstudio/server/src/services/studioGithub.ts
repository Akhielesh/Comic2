// GitHub sync for Studio projects (Phase 6).
//
// Two-way sync between a saved project's `studio_files` and a GitHub repo: push commits
// the current file tree, pull reads the repo tree back into files. Uses the Git Data API
// (blobs->tree->commit->ref) so a multi-file push lands as ONE atomic commit.
//
// Token handling: this codebase never stores provider secrets at rest -- BYOK keys are
// passed per-request via headers and used transiently. We follow that exact pattern: the
// GitHub PAT is supplied per call and never persisted. We store only the repo NAME on the
// project (the `github_repo` column), never the token.

const GH_API = 'https://api.github.com';
const GH_TIMEOUT_MS = 20_000;
// Don't try to round-trip binary/huge files through the JSON tree API.
const MAX_FILE_BYTES = 512 * 1024;

export interface GithubRepo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
}

export interface RepoFile {
  path: string;
  content: string;
}

const gh = async <T>(token: string, method: string, path: string, body?: unknown): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GH_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'DreamStream-Studio',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`GitHub ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
};

/** Parse "owner/name" (tolerating a full URL or trailing .git). */
export const parseRepoFullName = (input: string): { owner: string; repo: string } | null => {
  const cleaned = input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
};

/** Build Git Data API tree entries from project files. Pure (tested). */
export const buildTreeEntries = (
  files: RepoFile[]
): { path: string; mode: '100644'; type: 'blob'; content: string }[] =>
  files
    .filter((f) => f.path && typeof f.content === 'string' && Buffer.byteLength(f.content, 'utf8') <= MAX_FILE_BYTES)
    .map((f) => ({ path: f.path.replace(/^\/+/, ''), mode: '100644', type: 'blob', content: f.content }));

/** The repos the token can push to (most recently updated first). */
export const listRepos = async (token: string): Promise<GithubRepo[]> => {
  const repos = await gh<any[]>(token, 'GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator');
  return (repos || []).map((r) => ({
    fullName: r.full_name,
    defaultBranch: r.default_branch || 'main',
    private: Boolean(r.private),
    htmlUrl: r.html_url
  }));
};

/**
 * Commit the file tree to `owner/repo` on `branch` as one commit. Handles three cases:
 * an existing branch (commit on top), an empty repo (root commit + create ref), and a new
 * branch off the repo's default branch. Returns the commit URL.
 */
export const pushFiles = async (params: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  files: RepoFile[];
  message: string;
}): Promise<{ commitSha: string; commitUrl: string; branch: string }> => {
  const { token, owner, repo, branch, message } = params;
  const base = `/repos/${owner}/${repo}/git`;
  const tree = buildTreeEntries(params.files);
  if (!tree.length) throw new Error('No committable files (empty or too large).');

  // Find the branch head, if any.
  let parentSha: string | undefined;
  let baseTreeSha: string | undefined;
  try {
    const ref = await gh<any>(token, 'GET', `${base}/ref/heads/${encodeURIComponent(branch)}`);
    parentSha = ref?.object?.sha;
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    // Branch missing -- try to branch off the repo's default branch (if it has commits).
    try {
      const repoInfo = await gh<any>(token, 'GET', `/repos/${owner}/${repo}`);
      const def = repoInfo?.default_branch || 'main';
      const defRef = await gh<any>(token, 'GET', `${base}/ref/heads/${encodeURIComponent(def)}`);
      parentSha = defRef?.object?.sha;
    } catch {
      /* empty repo -- root commit below */
    }
  }

  if (parentSha) {
    const parentCommit = await gh<any>(token, 'GET', `${base}/commits/${parentSha}`);
    baseTreeSha = parentCommit?.tree?.sha;
  }

  const newTree = await gh<any>(token, 'POST', `${base}/trees`, {
    ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
    tree
  });
  const commit = await gh<any>(token, 'POST', `${base}/commits`, {
    message,
    tree: newTree.sha,
    ...(parentSha ? { parents: [parentSha] } : {})
  });

  // Update the branch ref, creating it if it doesn't exist yet.
  if (parentSha) {
    await gh(token, 'PATCH', `${base}/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
  } else {
    await gh(token, 'POST', `${base}/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }

  return {
    commitSha: commit.sha,
    commitUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}`,
    branch
  };
};

/** Read the repo tree on `branch` back into project files (text files only). */
export const pullFiles = async (params: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}): Promise<RepoFile[]> => {
  const { token, owner, repo, branch } = params;
  const base = `/repos/${owner}/${repo}/git`;
  const ref = await gh<any>(token, 'GET', `${base}/ref/heads/${encodeURIComponent(branch)}`);
  const commit = await gh<any>(token, 'GET', `${base}/commits/${ref.object.sha}`);
  const treeRes = await gh<any>(token, 'GET', `${base}/trees/${commit.tree.sha}?recursive=1`);
  const blobs = (treeRes?.tree || []).filter(
    (t: any) => t.type === 'blob' && typeof t.size === 'number' && t.size <= MAX_FILE_BYTES
  );

  const files: RepoFile[] = [];
  for (const b of blobs.slice(0, 200)) {
    try {
      const blob = await gh<any>(token, 'GET', `${base}/blobs/${b.sha}`);
      if (blob?.encoding === 'base64' && typeof blob.content === 'string') {
        const buf = Buffer.from(blob.content, 'base64');
        // A NUL byte means this is a binary asset, not source -- skip it.
        if (!buf.includes(0)) files.push({ path: b.path, content: buf.toString('utf8') });
      }
    } catch {
      /* skip a blob that fails to fetch */
    }
  }
  return files;
};
