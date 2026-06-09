// Remembers a project's last successful deploy URL (per project, in localStorage), so a deployed
// app keeps a visible permanent link in the studio header + Publish panel across reloads — closing
// the "I built it but can't find where it's live" gap. Dependency-free; safe in SSR/tests.

const KEY = (projectId: string): string => `dreamstream_studio_deploy_${projectId}`;

export const getDeployUrl = (projectId?: string | null): string | null => {
  if (!projectId || typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(KEY(projectId));
    return v && /^https?:\/\//i.test(v) ? v : null;
  } catch {
    return null;
  }
};

export const setDeployUrl = (projectId: string | null | undefined, url: string | null): void => {
  if (!projectId || typeof window === 'undefined') return;
  try {
    if (url && /^https?:\/\//i.test(url)) window.localStorage.setItem(KEY(projectId), url);
    else window.localStorage.removeItem(KEY(projectId));
  } catch {
    /* storage unavailable */
  }
};
