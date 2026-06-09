// codeInsights.ts — pure, dependency-free static analysis of a studio project's working copy.
//
// This is what lets the Code Studio SHOW that it verified the code instead of silently shipping the
// model's first answer: an actionable health score, real project metrics (files, LOC, languages),
// the import graph (resolved vs dangling), and a categorized, fixable issue list. No model or
// sandbox needed — it runs instantly in the browser on every edit, so the studio always reflects the
// true state of the code. Kept pure so it's fully unit-testable.

export type InsightSeverity = 'error' | 'warn' | 'info';

export interface CodeIssue {
  severity: InsightSeverity;
  /** File the issue belongs to (omitted for project-wide issues). */
  file?: string;
  message: string;
}

export interface LanguageStat {
  language: string;
  files: number;
  loc: number;
}

export interface CodeInsights {
  /** 0–100 health score derived from the issues found. */
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Total file count. */
  files: number;
  /** Total non-blank lines of code across all files. */
  loc: number;
  languages: LanguageStat[];
  /** Largest files by LOC (top few), so users can spot "split this" candidates. */
  largest: { path: string; loc: number }[];
  issues: CodeIssue[];
  counts: { error: number; warn: number; info: number };
  imports: { resolved: number; dangling: number };
  /** Whether the project ships a dependency manifest (package.json / requirements.txt / go.mod …). */
  hasManifest: boolean;
}

export interface InsightFile {
  path: string;
  content: string;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const MANIFESTS = new Set(['/package.json', '/requirements.txt', '/go.mod', '/Cargo.toml', '/pyproject.toml', '/Gemfile', '/composer.json']);
const ENTRYISH = /\/(App|index|main|server|app)\.(t|j)sx?$/i;
const OVERSIZE_LOC = 260;

const EXT_LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  html: 'HTML', css: 'CSS', scss: 'CSS', less: 'CSS', json: 'JSON', md: 'Markdown', mdx: 'Markdown',
  py: 'Python', go: 'Go', rs: 'Rust', rb: 'Ruby', java: 'Java', kt: 'Kotlin', swift: 'Swift',
  sh: 'Shell', bash: 'Shell', yaml: 'YAML', yml: 'YAML', toml: 'TOML', sql: 'SQL', graphql: 'GraphQL',
};

const langOf = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? (ext ? ext.toUpperCase() : 'Other');
};

/** Non-blank line count. */
const locOf = (content: string): number => content.split('\n').filter((l) => l.trim().length > 0).length;

// Placeholder / truncation markers that mean the model didn't emit complete code (mirrors the server
// verifier, kept here so the client can flag it instantly without a round-trip).
const PLACEHOLDER =
  /(\/\/\s*\.\.\.|\.\.\.\s*rest of|rest of the (code|file|component|implementation)|implementation (goes )?here|your code (goes )?here|TODO:?\s*implement|FIXME:?\s*implement|for brevity|in a real (app|game|implementation|world|project)|would (go|be|need) here|not (yet )?implemented|coming soon|placeholder (for|logic|implementation)|stubbed(\s+out)?)/i;

const LOOP_IN_COMMENT =
  /\/\/[^\n]*\b(game ?loop|render ?loop|animation ?loop|update loop|setinterval|requestanimationframe)\b|\/\*[\s\S]*?\b(game ?loop|setinterval|requestanimationframe)\b[\s\S]*?\*\//i;
const LOOP_CALL = /\b(setInterval|setTimeout|requestAnimationFrame)\s*\(/;

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

/** Resolve a relative import from `fromPath` to an emitted path (or null if it dangles). */
const resolveRelative = (fromPath: string, spec: string, paths: Set<string>): string | null => {
  const dir = fromPath.slice(0, fromPath.lastIndexOf('/'));
  const base = normalizePath(`${dir}/${spec}`);
  for (const ext of EXT_CANDIDATES) if (paths.has(base + ext)) return base + ext;
  for (const idx of INDEX_CANDIDATES) if (paths.has(base + idx)) return base + idx;
  return null;
};

const RELATIVE_IMPORT = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](\.[^'"]+)['"]/g;
const IMG_NO_ALT = /<img(?![^>]*\balt=)[^>]*>/i;

const gradeFor = (score: number): CodeInsights['grade'] =>
  score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

/**
 * Analyze a project's files into actionable insights. `template` (when known) enables the
 * React-entry default-export check. Conservative: each issue is a real, fixable signal.
 */
export const analyzeProject = (files: InsightFile[], template?: string): CodeInsights => {
  const issues: CodeIssue[] = [];
  const paths = new Set(files.map((f) => f.path));
  const codeFiles = files.filter((f) => CODE_EXT.test(f.path));

  // ---- Metrics ----
  const langMap = new Map<string, { files: number; loc: number }>();
  let totalLoc = 0;
  const perFileLoc: { path: string; loc: number }[] = [];
  for (const f of files) {
    const loc = locOf(f.content);
    totalLoc += loc;
    perFileLoc.push({ path: f.path, loc });
    const lang = langOf(f.path);
    const cur = langMap.get(lang) ?? { files: 0, loc: 0 };
    cur.files += 1; cur.loc += loc;
    langMap.set(lang, cur);
  }
  const languages = [...langMap.entries()]
    .map(([language, v]) => ({ language, ...v }))
    .sort((a, b) => b.loc - a.loc);
  const largest = perFileLoc.slice().sort((a, b) => b.loc - a.loc).slice(0, 3).filter((x) => x.loc > 0);
  const hasManifest = files.some((f) => MANIFESTS.has(f.path));

  // ---- Issue checks ----
  // 1. Empty files.
  for (const f of files) {
    if (!f.content || !f.content.trim()) issues.push({ severity: 'error', file: f.path, message: 'File is empty.' });
  }

  // 2. Placeholder / truncated content.
  for (const f of files) {
    if (f.content && PLACEHOLDER.test(f.content)) {
      issues.push({ severity: 'warn', file: f.path, message: 'Contains a placeholder / “rest of code” marker instead of complete code.' });
    }
  }

  // 3. React entry must default-export (the studio mounts the default export of App).
  const isReact = template === 'react' || template === 'react-ts';
  if (isReact) {
    const entry = files.find((f) => /\/(src\/)?App\.(t|j)sx$/.test(f.path));
    if (entry && !/export\s+default/.test(entry.content)) {
      issues.push({ severity: 'error', file: entry.path, message: 'React entry has no default export — App must be the default export.' });
    }
  }

  // 4. Manifests must be valid JSON.
  for (const f of files) {
    if (/\.json$/i.test(f.path) && f.content.trim()) {
      try { JSON.parse(f.content); } catch { issues.push({ severity: 'error', file: f.path, message: 'Invalid JSON.' }); }
    }
  }

  // 5. Import graph: resolved vs dangling relative imports + an orphan (never-imported) pass.
  let resolved = 0;
  let dangling = 0;
  const referenced = new Set<string>();
  for (const f of codeFiles) {
    if (!f.content) continue;
    RELATIVE_IMPORT.lastIndex = 0;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = RELATIVE_IMPORT.exec(f.content)) !== null) {
      const spec = m[1];
      if (seen.has(spec)) continue;
      seen.add(spec);
      const target = resolveRelative(f.path, spec, paths);
      if (target) { resolved += 1; referenced.add(target); }
      else { dangling += 1; issues.push({ severity: 'error', file: f.path, message: `Imports "${spec}" but no matching file exists — create it or fix the path.` }); }
    }
  }

  // 6. Orphan code files — emitted but never imported and not an entry/manifest (likely dead code).
  for (const f of codeFiles) {
    if (referenced.has(f.path) || ENTRYISH.test(f.path)) continue;
    issues.push({ severity: 'info', file: f.path, message: 'Not referenced by any other file — wire it up or remove it.' });
  }

  // 7. Stubbed core mechanic: a comment describes a loop/timer but the file never calls one.
  for (const f of codeFiles) {
    if (f.content && LOOP_IN_COMMENT.test(f.content) && !LOOP_CALL.test(f.content)) {
      issues.push({ severity: 'warn', file: f.path, message: 'Describes a game/animation loop in a comment but never implements one — write the real loop.' });
    }
  }

  // 8. Oversized files — a "split this" nudge toward a clean component structure.
  for (const { path, loc } of perFileLoc) {
    if (CODE_EXT.test(path) && loc > OVERSIZE_LOC) {
      issues.push({ severity: 'info', file: path, message: `Large file (${loc} lines) — consider splitting into smaller components.` });
    }
  }

  // 9. Accessibility: <img> without alt text (a common polish gap).
  for (const f of codeFiles) {
    if (f.content && IMG_NO_ALT.test(f.content)) {
      issues.push({ severity: 'info', file: f.path, message: 'An <img> is missing alt text — add it for accessibility.' });
    }
  }

  // 10. Bare package imports without a manifest (web React apps are bundled, so don't flag those).
  if (!hasManifest && !isReact) {
    const usesBare = codeFiles.some((f) => /\bfrom\s+['"][a-z@][^'".][^'"]*['"]/i.test(f.content) && !/\bfrom\s+['"]\.?\//.test(f.content));
    if (usesBare) issues.push({ severity: 'info', message: 'Imports packages but ships no dependency manifest (package.json / requirements.txt).' });
  }

  const counts = {
    error: issues.filter((i) => i.severity === 'error').length,
    warn: issues.filter((i) => i.severity === 'warn').length,
    info: issues.filter((i) => i.severity === 'info').length,
  };
  // Score: start at 100, weight by severity, floor at 0.
  const score = Math.max(0, Math.min(100, 100 - counts.error * 14 - counts.warn * 6 - counts.info * 2));

  return {
    score,
    grade: gradeFor(score),
    files: files.length,
    loc: totalLoc,
    languages,
    largest,
    issues,
    counts,
    imports: { resolved, dangling },
    hasManifest,
  };
};

/**
 * Fold a LIVE preview compile/runtime error into the insights so "code health" reflects what
 * actually happened when the code RAN — not just static checks. Static cleanliness (resolved
 * imports, a default export, valid JSON) does NOT mean the app works, so without this an app that
 * fails to run can still score 100. When a preview error is present this injects it as the top
 * issue and caps the score to a failing grade — a broken app can never show as healthy.
 */
export const applyRuntimeStatus = (ins: CodeInsights, previewError?: string | null): CodeInsights => {
  const err = previewError?.trim();
  if (!err) return ins;
  const runtimeIssue: CodeIssue = { severity: 'error', message: `Live preview failed to run: ${err.slice(0, 300)}` };
  const counts = { ...ins.counts, error: ins.counts.error + 1 };
  const score = Math.min(ins.score, 25); // it doesn't run → not healthy (caps to grade F)
  return { ...ins, issues: [runtimeIssue, ...ins.issues], counts, score, grade: gradeFor(score) };
};

/** A one-line console summary of a verification pass (so the logs show real, not vague, output). */
export const insightsSummary = (ins: CodeInsights): string =>
  `Verified ${ins.files} file${ins.files === 1 ? '' : 's'} · ${ins.loc} LOC · health ${ins.score}/100 (${ins.grade}) · ` +
  `${ins.counts.error} error${ins.counts.error === 1 ? '' : 's'}, ${ins.counts.warn} warning${ins.counts.warn === 1 ? '' : 's'}, ${ins.counts.info} hint${ins.counts.info === 1 ? '' : 's'}`;

/** Turn the highest-severity issues into a concrete refine prompt for the "Fix issues" action. */
export const issuesToFixPrompt = (issues: CodeIssue[]): string => {
  const actionable = issues.filter((i) => i.severity !== 'info').slice(0, 20);
  const list = (actionable.length ? actionable : issues.slice(0, 20))
    .map((i) => `- ${i.file ? `${i.file}: ` : ''}${i.message}`)
    .join('\n');
  return `Fix these issues found by the studio's verifier and return the COMPLETE corrected project so it runs cleanly. Address the ROOT CAUSE; do not reintroduce any of them:\n${list}`;
};

/** Heuristic, model-free "what next" suggestions derived from the current code (actionable chips).
 *  Pass `hasBackend` so the chips reflect whether a real DB is wired (use it vs. connect one). */
export const suggestNextSteps = (ins: CodeInsights, opts?: { hasBackend?: boolean }): string[] => {
  const out: string[] = [];
  if (ins.imports.dangling > 0) out.push('Resolve missing imports so every file loads.');
  const big = ins.largest.find((f) => f.loc > OVERSIZE_LOC);
  if (big) out.push(`Split ${big.path.split('/').pop()} (${big.loc} lines) into smaller components.`);
  if (ins.counts.info > 0 && ins.issues.some((i) => /alt text/.test(i.message))) out.push('Add alt text and ARIA labels for accessibility.');
  // Backend-aware: use the connected DB, or suggest connecting one for real persistence.
  if (opts?.hasBackend) out.push('Persist the app’s data to the connected Supabase backend (replace any mock/in-memory data).');
  else out.push('Connect a Supabase backend so the app saves real data instead of resetting on reload.');
  // Always-useful product polish prompts.
  out.push('Add empty, loading and error states to every view.');
  out.push('Polish the visual design — spacing, typography, color and alignment.');
  out.push('Add realistic sample data so it looks alive on first load.');
  return out.slice(0, 5);
};

/** Export a shareable project report (markdown) including identity + verification results. */
export const insightsToMarkdown = (
  ins: CodeInsights,
  meta?: { title?: string; projectId?: string | null; sessionId?: string | null }
): string => {
  const lines: string[] = [];
  lines.push(`# ${meta?.title || 'Project'} — Studio Report`);
  if (meta?.projectId) lines.push(`- Project ID: \`${meta.projectId}\``);
  if (meta?.sessionId) lines.push(`- Session ID: \`${meta.sessionId}\``);
  lines.push('');
  lines.push(`**Health:** ${ins.score}/100 (${ins.grade}) — ${ins.counts.error} errors, ${ins.counts.warn} warnings, ${ins.counts.info} hints`);
  lines.push(`**Size:** ${ins.files} files · ${ins.loc} LOC`);
  lines.push(`**Imports:** ${ins.imports.resolved} resolved, ${ins.imports.dangling} dangling`);
  if (ins.languages.length) {
    lines.push('');
    lines.push('## Languages');
    for (const l of ins.languages) lines.push(`- ${l.language}: ${l.files} files, ${l.loc} LOC`);
  }
  if (ins.issues.length) {
    lines.push('');
    lines.push('## Issues');
    for (const i of ins.issues) lines.push(`- [${i.severity}] ${i.file ? `${i.file}: ` : ''}${i.message}`);
  } else {
    lines.push('');
    lines.push('No issues found ✓');
  }
  return lines.join('\n');
};
