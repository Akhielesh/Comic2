// Unit coverage for the client-side code-insights engine (verification + metrics + suggestions).

import { describe, it, expect } from 'vitest';
import {
  analyzeProject, applyRuntimeStatus, insightsSummary, issuesToFixPrompt, suggestNextSteps, insightsToMarkdown,
  type InsightFile,
} from './codeInsights';

const f = (path: string, content: string): InsightFile => ({ path, content });

describe('applyRuntimeStatus — honest health', () => {
  const clean = () =>
    analyzeProject([f('/App.tsx', 'export default function App(){ return <div>hi</div>; }')], 'react-ts');

  it('a statically-clean project scores high WITHOUT a runtime error', () => {
    const ins = clean();
    expect(ins.score).toBeGreaterThanOrEqual(90);
    expect(applyRuntimeStatus(ins, null).score).toBe(ins.score); // no error → unchanged
    expect(applyRuntimeStatus(ins, '   ').score).toBe(ins.score); // blank → unchanged
  });

  it('a live preview error caps health to a failing grade even if static checks passed', () => {
    const ins = clean();
    expect(ins.grade).toBe('A');
    const withErr = applyRuntimeStatus(ins, "ReferenceError: foo is not defined");
    expect(withErr.score).toBeLessThanOrEqual(25);
    expect(withErr.grade).toBe('F');
    expect(withErr.counts.error).toBe(ins.counts.error + 1);
    expect(withErr.issues[0].severity).toBe('error');
    expect(withErr.issues[0].message).toMatch(/preview failed to run/i);
  });

  it('does not mutate the input insights', () => {
    const ins = clean();
    const before = ins.score;
    applyRuntimeStatus(ins, 'boom');
    expect(ins.score).toBe(before);
    expect(ins.issues.length).toBeGreaterThanOrEqual(0);
  });
});

describe('analyzeProject — metrics', () => {
  it('counts files, non-blank LOC and language breakdown', () => {
    const ins = analyzeProject([
      f('/App.tsx', 'export default function App(){\n\n  return null;\n}'),
      f('/styles.css', 'body { margin: 0; }'),
    ], 'react-ts');
    expect(ins.files).toBe(2);
    expect(ins.loc).toBe(3 + 1); // App has 3 non-blank lines, css 1
    const ts = ins.languages.find((l) => l.language === 'TypeScript');
    expect(ts?.files).toBe(1);
    expect(ins.languages.find((l) => l.language === 'CSS')?.loc).toBe(1);
  });

  it('a clean React app scores an A with no issues', () => {
    const ins = analyzeProject([
      f('/App.tsx', "import { Box } from './Box';\nexport default function App(){ return <Box/>; }"),
      f('/Box.tsx', 'export const Box = () => <div>hi</div>;'),
      f('/index.tsx', "import App from './App';\nApp;"),
    ], 'react-ts');
    expect(ins.counts.error).toBe(0);
    expect(ins.grade).toBe('A');
    expect(ins.imports.dangling).toBe(0);
    expect(ins.imports.resolved).toBeGreaterThan(0);
  });
});

describe('analyzeProject — issue detection', () => {
  it('flags a dangling relative import as an error and lowers the score', () => {
    const ins = analyzeProject([
      f('/App.tsx', "import { Missing } from './Missing';\nexport default () => <Missing/>;"),
    ], 'react-ts');
    expect(ins.imports.dangling).toBe(1);
    expect(ins.counts.error).toBeGreaterThan(0);
    expect(ins.score).toBeLessThan(100);
    expect(ins.issues.some((i) => i.message.includes('./Missing'))).toBe(true);
  });

  it('flags a missing default export on the React entry', () => {
    const ins = analyzeProject([f('/App.tsx', 'export const App = () => null;')], 'react-ts');
    expect(ins.issues.some((i) => /no default export/.test(i.message))).toBe(true);
  });

  it('flags empty files, placeholders and invalid JSON', () => {
    const ins = analyzeProject([
      f('/App.tsx', 'export default () => null; // ... rest of the code here'),
      f('/empty.ts', '   '),
      f('/data.json', '{ not json }'),
    ], 'react-ts');
    expect(ins.issues.some((i) => /empty/i.test(i.message))).toBe(true);
    expect(ins.issues.some((i) => /placeholder/i.test(i.message))).toBe(true);
    expect(ins.issues.some((i) => /Invalid JSON/i.test(i.message))).toBe(true);
  });

  it('flags an orphan (never-imported) non-entry file as info', () => {
    const ins = analyzeProject([
      f('/App.tsx', 'export default () => null;'),
      f('/orphan.ts', 'export const x = 1;'),
    ], 'react-ts');
    expect(ins.issues.some((i) => i.file === '/orphan.ts' && /Not referenced/.test(i.message))).toBe(true);
  });

  it('flags an oversized file as a split nudge', () => {
    const big = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const ins = analyzeProject([f('/App.tsx', `export default () => null;\n${big}`)], 'react-ts');
    expect(ins.issues.some((i) => /Large file/.test(i.message))).toBe(true);
    expect(ins.largest[0].path).toBe('/App.tsx');
  });

  it('flags an <img> with no alt text', () => {
    const ins = analyzeProject([f('/App.tsx', 'export default () => <img src="x.png"/>;')], 'react-ts');
    expect(ins.issues.some((i) => /alt text/.test(i.message))).toBe(true);
  });
});

describe('helpers', () => {
  it('insightsSummary renders a readable one-liner', () => {
    const ins = analyzeProject([f('/App.tsx', 'export default () => null;')], 'react-ts');
    expect(insightsSummary(ins)).toMatch(/Verified 1 file .* health \d+\/100/);
  });

  it('issuesToFixPrompt prioritises errors/warnings over info', () => {
    const ins = analyzeProject([
      f('/App.tsx', "import { M } from './M';\nexport default () => null;"), // dangling = error
      f('/orphan.ts', 'export const x = 1;'), // orphan = info
    ], 'react-ts');
    const prompt = issuesToFixPrompt(ins.issues);
    expect(prompt).toContain('./M');
    expect(prompt).toContain('return the COMPLETE corrected project');
  });

  it('suggestNextSteps returns actionable, deduped chips', () => {
    const ins = analyzeProject([f('/App.tsx', "import { M } from './M';\nexport default () => null;")], 'react-ts');
    const steps = suggestNextSteps(ins);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.length).toBeLessThanOrEqual(5);
    expect(steps.some((s) => /missing imports/i.test(s))).toBe(true);
  });

  it('suggestNextSteps is backend-aware (connect vs. use)', () => {
    const ins = analyzeProject([f('/App.tsx', 'export default () => null;')], 'react-ts');
    expect(suggestNextSteps(ins).some((s) => /connect a supabase backend/i.test(s))).toBe(true);
    expect(suggestNextSteps(ins, { hasBackend: true }).some((s) => /connected supabase backend/i.test(s))).toBe(true);
  });

  it('insightsToMarkdown includes identity + verification results', () => {
    const ins = analyzeProject([f('/App.tsx', 'export default () => null;')], 'react-ts');
    const md = insightsToMarkdown(ins, { title: 'My App', projectId: 'proj_1', sessionId: 'sess_1' });
    expect(md).toContain('# My App — Studio Report');
    expect(md).toContain('proj_1');
    expect(md).toContain('sess_1');
    expect(md).toContain('Health:');
  });
});
