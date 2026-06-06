// Auto-verification for generated apps (the "verifier agent" of the build pipeline).
//
// After the model generates a project, we run fast, heuristic static checks for the failure modes
// that actually break studio apps — empty files, truncation/placeholder markers, a React entry with
// no default export, invalid JSON manifests, and unresolved relative imports. If anything is found,
// the generate stream automatically does one repair pass (feeding these issues back to the model)
// BEFORE handing the app to the user — so they don't have to notice the breakage and click "fix".
//
// Pure + dependency-free so it's unit-testable without a model or sandbox. Conservative by design:
// a false positive only costs one extra repair pass, but we still aim to avoid them.

export interface AppIssue {
  file?: string;
  message: string;
}

interface VerifyFile {
  path: string;
  content: string;
}

interface VerifyArtifact {
  template?: string;
  files: VerifyFile[];
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

// Placeholder / truncation markers that mean the model didn't emit complete code.
const PLACEHOLDER =
  /(\/\/\s*\.\.\.|\/\*\s*\.\.\.\s*\*\/|\.\.\.\s*rest of|rest of the (code|file|component|implementation)|implementation (goes )?here|your code here|<your code|TODO:?\s*implement|FIXME:?\s*implement)/i;

const EXT_CANDIDATES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.less'];
const INDEX_CANDIDATES = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/** Collapse `.`/`..` segments in a studio path. */
const normalizePath = (p: string): string => {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
};

/** Does a relative import from `fromPath` resolve to a file in the project? (best-effort) */
const resolvesRelative = (fromPath: string, spec: string, paths: Set<string>): boolean => {
  const dir = fromPath.slice(0, fromPath.lastIndexOf('/'));
  const base = normalizePath(`${dir}/${spec}`);
  for (const ext of EXT_CANDIDATES) if (paths.has(base + ext)) return true;
  for (const idx of INDEX_CANDIDATES) if (paths.has(base + idx)) return true;
  return false;
};

const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.[^'"]+)['"]/g;

/** Run the heuristic checks. Returns an empty array when the app looks complete. */
export const verifyGeneratedApp = (artifact: VerifyArtifact): AppIssue[] => {
  const issues: AppIssue[] = [];
  const files = artifact.files || [];
  const paths = new Set(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f]));

  // 1. Empty files.
  for (const f of files) {
    if (!f.content || !f.content.trim()) issues.push({ file: f.path, message: 'File is empty — emit complete code.' });
  }

  // 2. Placeholder / truncated content.
  for (const f of files) {
    if (f.content && PLACEHOLDER.test(f.content)) {
      issues.push({ file: f.path, message: 'Contains a placeholder/“rest of code” marker instead of complete code.' });
    }
  }

  // 3. React entry must default-export (the studio mounts the default export of App).
  const isReact = artifact.template === 'react' || artifact.template === 'react-ts';
  if (isReact) {
    const entry =
      byPath.get('/App.tsx') || byPath.get('/src/App.tsx') || byPath.get('/App.jsx') || byPath.get('/src/App.jsx');
    if (entry && !/export\s+default/.test(entry.content)) {
      issues.push({ file: entry.path, message: 'React entry has no default export; App must be the default export.' });
    }
  }

  // 4. Manifests must be valid JSON.
  for (const f of files) {
    if (/\.json$/i.test(f.path) && f.content.trim()) {
      try { JSON.parse(f.content); } catch { issues.push({ file: f.path, message: 'Invalid JSON.' }); }
    }
  }

  // 5. Unresolved relative imports (a common multi-file breakage).
  for (const f of files) {
    if (!CODE_EXT.test(f.path) || !f.content) continue;
    RELATIVE_IMPORT.lastIndex = 0;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = RELATIVE_IMPORT.exec(f.content)) !== null) {
      const spec = m[1];
      if (seen.has(spec)) continue;
      seen.add(spec);
      if (!resolvesRelative(f.path, spec, paths)) {
        issues.push({ file: f.path, message: `Imports "${spec}" but no matching file exists — create it or fix the path.` });
      }
    }
  }

  return issues;
};

/** Render issues as a bullet list for a repair prompt / phase label. */
export const formatIssues = (issues: AppIssue[]): string =>
  issues.map((i) => `- ${i.file ? `${i.file}: ` : ''}${i.message}`).join('\n');
