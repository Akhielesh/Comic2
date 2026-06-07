import { describe, it, expect } from 'vitest';
import { verifyGeneratedApp, formatIssues } from './verifyApp.js';

describe('verifyGeneratedApp', () => {
  it('passes a clean single-file React app', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [{ path: '/App.tsx', content: 'export default function App() { return null; }' }],
    });
    expect(issues).toEqual([]);
  });

  it('flags an empty file', () => {
    const issues = verifyGeneratedApp({ template: 'static', files: [{ path: '/index.html', content: '   ' }] });
    expect(issues.some((i) => /empty/i.test(i.message))).toBe(true);
  });

  it('flags placeholder/truncation markers', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [{ path: '/App.tsx', content: 'export default function App(){\n  // ... rest of the component\n}' }],
    });
    expect(issues.some((i) => /placeholder|rest of/i.test(i.message))).toBe(true);
  });

  it('flags a React entry with no default export', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [{ path: '/App.tsx', content: 'export function App() { return null; }' }],
    });
    expect(issues.some((i) => /default export/i.test(i.message))).toBe(true);
  });

  it('flags invalid JSON manifests', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [
        { path: '/App.tsx', content: 'export default () => null;' },
        { path: '/package.json', content: '{ "name": "x", }' }, // trailing comma
      ],
    });
    expect(issues.some((i) => /invalid json/i.test(i.message))).toBe(true);
  });

  it('flags an unresolved relative import', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [{ path: '/App.tsx', content: "import { Button } from './components/Button';\nexport default () => null;" }],
    });
    expect(issues.some((i) => /no matching file/i.test(i.message))).toBe(true);
  });

  it('resolves relative imports that DO exist (incl. index + extensionless)', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [
        { path: '/src/App.tsx', content: "import { Button } from './ui/Button';\nimport { cn } from '../lib/utils';\nexport default () => null;" },
        { path: '/src/ui/Button.tsx', content: 'export const Button = () => null;' },
        { path: '/lib/utils.ts', content: 'export const cn = (x: string) => x;' },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('flags a comment-only game loop (the Retro Pac-Man failure mode)', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [{
        path: '/hooks/useGameLogic.ts',
        content: 'export const useGameLogic = () => {\n  const start = () => {\n    // Game initialization logic, setInterval for game loop, etc.\n  };\n  return { start };\n};',
      }],
    });
    expect(issues.some((i) => /loop or timer|implement the real loop/i.test(i.message))).toBe(true);
  });

  it('does NOT flag when a real loop/timer is actually implemented', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [{
        path: '/hooks/useGameLogic.ts',
        content: 'export const useGameLogic = () => {\n  // game loop\n  const id = setInterval(() => tick(), 16);\n  return { id };\n};\nfunction tick(){}',
      }],
    });
    expect(issues).toEqual([]);
  });

  it('flags narrative "in a real app …" placeholders', () => {
    const issues = verifyGeneratedApp({
      template: 'react-ts',
      files: [{ path: '/App.tsx', content: 'export default () => {\n  // in a real app this would fetch from an API\n  return null;\n};' }],
    });
    expect(issues.some((i) => /placeholder/i.test(i.message))).toBe(true);
  });

  it('formatIssues renders a bullet list', () => {
    const out = formatIssues([{ file: '/App.tsx', message: 'broken' }, { message: 'general' }]);
    expect(out).toContain('- /App.tsx: broken');
    expect(out).toContain('- general');
  });
});
