// Project-kind detection (Sprint 3, polyglot). The studio renders web apps in the browser, but
// generation is multi-language. This classifies a file set so the UI does the right thing — render
// the in-browser preview for web projects, and show an honest "run it locally / cloud-run" panel for
// non-web ones (Python/Go/Node-backend/…). Content-aware so it can tell a Node *backend* (Express/
// Fastify, a server with .listen) apart from a browser app — a bare `.js` set is otherwise ambiguous.
// Pure + dependency-free (unit-tested).

export type ProjectKind =
  | 'web' | 'node' | 'python' | 'go' | 'rust' | 'java' | 'ruby' | 'php' | 'shell' | 'csharp' | 'other';

export interface KindFile {
  path: string;
  content?: string;
}

// Browser-renderable file extensions. If any are present (and it isn't a server), it's a web app.
const WEB_EXTS = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'tsx', 'jsx', 'ts', 'js', 'mjs', 'cjs', 'vue', 'svelte']);

const EXT_TO_KIND: Record<string, ProjectKind> = {
  py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'java', scala: 'java',
  rb: 'ruby', php: 'php',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  cs: 'csharp',
};

// Server signals in source or package.json — used only when there's no HTML/JSX (i.e. it could be
// a Node backend rather than a browser app).
const SERVER_SRC = /\b(express|fastify|koa|hono|@hapi\/hapi|@nestjs\/core|http2?\.createServer|createServer\s*\(|app\.listen\s*\(|server\.listen\s*\()/;
const SERVER_DEP = /"(express|fastify|koa|hono|@hapi\/hapi|@nestjs\/core)"\s*:/;

const extOf = (path: string): string => {
  const file = path.split('/').pop()?.toLowerCase() ?? '';
  return file.includes('.') ? file.split('.').pop()! : '';
};

/** Classify a project from its files (content optional but improves accuracy). */
export const detectProjectKind = (files: KindFile[]): ProjectKind => {
  const exts = files.map((f) => extOf(f.path));
  const hasHtml = exts.some((e) => e === 'html' || e === 'htm');
  const hasJsxLike = exts.some((e) => e === 'tsx' || e === 'jsx');
  const hasWeb = exts.some((e) => WEB_EXTS.has(e));

  // The dominant clearly-non-web language, if any.
  const langCounts: Partial<Record<ProjectKind, number>> = {};
  for (const e of exts) {
    const k = EXT_TO_KIND[e];
    if (k) langCounts[k] = (langCounts[k] ?? 0) + 1;
  }
  const topLang = (Object.entries(langCounts) as [ProjectKind, number][]).sort((a, b) => b[1] - a[1])[0];

  // A non-web language with no browser UI files → that language (e.g. a Python project with a .js helper).
  if (topLang && !hasHtml && !hasJsxLike) return topLang[0];
  // No web files at all → the dominant language, else unknown.
  if (!hasWeb) return topLang ? topLang[0] : 'other';

  // Web files present. Tell a Node backend apart from a browser app (only when there's no HTML/JSX).
  if (!hasHtml && !hasJsxLike) {
    const pkg = files.find((f) => f.path.toLowerCase().endsWith('package.json'));
    const src = files.map((f) => f.content ?? '').join('\n');
    if ((pkg?.content && SERVER_DEP.test(pkg.content)) || SERVER_SRC.test(src)) return 'node';
  }
  return 'web';
};

const KIND_LABEL: Record<ProjectKind, string> = {
  web: 'Web', node: 'Node.js', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java',
  ruby: 'Ruby', php: 'PHP', shell: 'Shell', csharp: 'C#', other: 'Code',
};

export const projectKindLabel = (kind: ProjectKind): string => KIND_LABEL[kind];

/** Whether this project can run in the in-browser preview. */
export const isWebProject = (kind: ProjectKind): boolean => kind === 'web';

/** A short, copy-pasteable run hint for non-web projects (shown in the preview panel). */
export const runHint = (kind: ProjectKind): string | null => {
  switch (kind) {
    case 'node': return 'npm install && npm start';
    case 'python': return 'pip install -r requirements.txt && python main.py';
    case 'go': return 'go run .';
    case 'rust': return 'cargo run';
    case 'ruby': return 'ruby main.rb';
    case 'php': return 'php -S localhost:8000';
    case 'java': return 'See the README for build/run steps';
    case 'shell': return 'bash main.sh';
    case 'csharp': return 'dotnet run';
    default: return null;
  }
};
