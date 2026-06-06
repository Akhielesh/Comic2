// Project-kind detection (Sprint 3, polyglot): the studio is web-first (it renders web apps in the
// browser), but generation is now multi-language. This classifies a file set so the UI can do the
// right thing — render the in-browser preview for web projects, and show an honest "run it locally /
// cloud-run" panel for non-web ones (Python/Go/Rust/…) instead of a broken browser preview.
// Pure + dependency-free (unit-tested).

export type ProjectKind =
  | 'web' | 'python' | 'go' | 'rust' | 'java' | 'ruby' | 'php' | 'shell' | 'csharp' | 'other';

// Web files win: if any are present, the project is browser-renderable.
const WEB_EXTS = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'tsx', 'jsx', 'ts', 'js', 'mjs', 'cjs', 'vue', 'svelte']);

const EXT_TO_KIND: Record<string, ProjectKind> = {
  py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'java', scala: 'java',
  rb: 'ruby', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  cs: 'csharp',
};

const extOf = (path: string): string => {
  const file = path.split('/').pop()?.toLowerCase() ?? '';
  return file.includes('.') ? file.split('.').pop()! : '';
};

/** Classify a project from its files. Web wins when present; else the dominant non-web language. */
export const detectProjectKind = (files: { path: string }[]): ProjectKind => {
  const exts = files.map((f) => extOf(f.path));
  if (exts.some((e) => WEB_EXTS.has(e))) return 'web';
  const counts: Partial<Record<ProjectKind, number>> = {};
  for (const e of exts) {
    const k = EXT_TO_KIND[e];
    if (k) counts[k] = (counts[k] ?? 0) + 1;
  }
  const top = (Object.entries(counts) as [ProjectKind, number][]).sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? 'other';
};

const KIND_LABEL: Record<ProjectKind, string> = {
  web: 'Web', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java',
  ruby: 'Ruby', php: 'PHP', shell: 'Shell', csharp: 'C#', other: 'Code',
};

export const projectKindLabel = (kind: ProjectKind): string => KIND_LABEL[kind];

/** Whether this project can run in the in-browser preview. */
export const isWebProject = (kind: ProjectKind): boolean => kind === 'web';
