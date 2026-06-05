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

// Per-file content cap (1 MiB) — source files are far smaller; this bounds memory + payloads
// and stops a runaway model from writing a giant blob during the autonomous build loop.
export const MAX_STUDIO_FILE_BYTES = 1024 * 1024;

/**
 * A path is safe to write inside the sandbox workspace iff it has no traversal (`..`),
 * no NUL/backslash, no home-expansion, and is a bounded, non-empty relative path. The
 * leading slash means "project root", not the host filesystem root — it's normalized away
 * before use. This is the guardrail that keeps an autonomous FIX iteration from escaping
 * the project (e.g. `../../etc/passwd`).
 */
export const isSafeStudioPath = (path: unknown): path is string => {
  if (typeof path !== 'string') return false;
  const p = path.trim();
  if (!p || p.length > 400) return false;
  if (p.includes('\0') || p.includes('\\') || p.startsWith('~')) return false;
  const segments = p.split('/').filter((s) => s.length > 0);
  if (segments.length === 0 || segments.some((s) => s === '..' || s === '.')) return false;
  return true;
};

/** Canonical in-project path: exactly one leading slash. */
export const canonicalStudioPath = (path: string): string => '/' + path.trim().replace(/^\/+/, '');

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

/** Normalize + cap an inbound file list (defensive: drop bad/unsafe entries, bound count/size). */
export const sanitizeFiles = (raw: unknown, maxFiles = 200): StudioFileInput[] => {
  if (!Array.isArray(raw)) return [];
  const out: StudioFileInput[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue;
    const r = f as { path?: unknown; content?: unknown; language?: unknown };
    if (typeof r.path !== 'string' || typeof r.content !== 'string') continue;
    if (!isSafeStudioPath(r.path)) continue;
    if (Buffer.byteLength(r.content, 'utf8') > MAX_STUDIO_FILE_BYTES) continue;
    out.push({
      path: canonicalStudioPath(r.path),
      content: r.content,
      language: typeof r.language === 'string' ? r.language : inferLanguage(r.path)
    });
    if (out.length >= maxFiles) break;
  }
  return out;
};

export interface FixSanitizeOptions {
  maxFiles?: number; // changed files per FIX iteration
  maxFileBytes?: number; // per-file cap
  maxTotalBytes?: number; // total cap per iteration
}

export interface FixSanitizeResult {
  files: Record<string, string>; // canonical-path → content (safe to merge into the project)
  rejected: { path: string; reason: 'unsafe_path' | 'bad_content' | 'file_too_large' | 'total_too_large' | 'max_files' }[];
}

/**
 * Guard the model's FIX output before it's merged into a live project during the autonomous
 * build loop: reject traversal/unsafe paths, oversized files, and bound the number + total
 * size of changes per iteration. Canonicalizes paths so merges overwrite (never duplicate)
 * existing files. Returns the safe subset plus a report of what was dropped (for the trace).
 */
export const sanitizeFixFiles = (
  raw: Record<string, unknown> | undefined,
  opts: FixSanitizeOptions = {}
): FixSanitizeResult => {
  const maxFiles = opts.maxFiles ?? 40;
  const maxFileBytes = opts.maxFileBytes ?? MAX_STUDIO_FILE_BYTES;
  const maxTotalBytes = opts.maxTotalBytes ?? 4 * 1024 * 1024;
  const files: Record<string, string> = {};
  const rejected: FixSanitizeResult['rejected'] = [];
  let total = 0;
  let count = 0;
  for (const [path, content] of Object.entries(raw || {})) {
    if (count >= maxFiles) {
      rejected.push({ path, reason: 'max_files' });
      continue;
    }
    if (typeof content !== 'string') {
      rejected.push({ path, reason: 'bad_content' });
      continue;
    }
    if (!isSafeStudioPath(path)) {
      rejected.push({ path, reason: 'unsafe_path' });
      continue;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > maxFileBytes) {
      rejected.push({ path, reason: 'file_too_large' });
      continue;
    }
    if (total + bytes > maxTotalBytes) {
      rejected.push({ path, reason: 'total_too_large' });
      continue;
    }
    files[canonicalStudioPath(path)] = content;
    total += bytes;
    count++;
  }
  return { files, rejected };
};
