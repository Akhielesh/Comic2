// Pure helpers for studio project persistence (no DB / no network) — unit-testable.

export interface StudioFileInput {
  path: string;
  content: string;
  language?: string;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css',
  json: 'json', md: 'markdown', mdx: 'markdown', txt: 'text',
  py: 'python', go: 'go', rs: 'rust', rb: 'ruby', java: 'java',
  sh: 'shell', bash: 'shell', yaml: 'yaml', yml: 'yaml', toml: 'toml', sql: 'sql'
};

/** Best-effort editor language from a file path's extension. */
export const inferLanguage = (path: string): string | undefined => {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return EXT_TO_LANG[ext];
};

/** A normalized name for a project derived from a title or its files. */
export const deriveProjectName = (title: string | undefined, files: StudioFileInput[]): string => {
  const t = (title || '').trim();
  if (t) return t.slice(0, 100);
  // Fall back to the app entry file or the first file.
  const entry = files.find((f) => /\/?(src\/)?App\.(t|j)sx?$/.test(f.path)) || files[0];
  return entry ? entry.path.split('/').filter(Boolean).pop()!.slice(0, 100) : 'Untitled app';
};

/** Flatten a file list into the { path: content } map stored on a version snapshot. */
export const filesToVersionMap = (files: StudioFileInput[]): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const f of files) map[f.path] = f.content;
  return map;
};

/** Normalize + cap an inbound file list (defensive: drop bad entries, bound count/size). */
export const sanitizeFiles = (raw: unknown, maxFiles = 200): StudioFileInput[] => {
  if (!Array.isArray(raw)) return [];
  const out: StudioFileInput[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const r = f as { path?: unknown; content?: unknown; language?: unknown };
    if (typeof r.path !== 'string' || typeof r.content !== 'string') continue;
    out.push({
      path: r.path.startsWith('/') ? r.path : `/${r.path}`,
      content: r.content,
      language: typeof r.language === 'string' ? r.language : inferLanguage(r.path)
    });
    if (out.length >= maxFiles) break;
  }
  return out;
};
