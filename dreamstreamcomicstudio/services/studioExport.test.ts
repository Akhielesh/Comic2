import { describe, it, expect } from 'vitest';
import { projectToMarkdown } from './studioExport';
import type { CodeStudioArtifact } from '../apiTypes';

const art: CodeStudioArtifact = {
  title: 'My App',
  description: 'demo',
  template: 'react-ts',
  files: [
    { path: '/App.tsx', content: 'export default () => null;', language: 'typescript' },
    { path: '/styles.css', content: '.x{color:red}', language: 'css' },
  ],
};

describe('projectToMarkdown', () => {
  it('renders title, summary, a file list, and fenced code per file with language', () => {
    const md = projectToMarkdown(art);
    expect(md).toContain('# My App');
    expect(md).toContain('Template: react-ts · 2 files');
    expect(md).toContain('- `/App.tsx`'); // file list
    expect(md).toContain('## /App.tsx');
    expect(md).toContain('```typescript');
    expect(md).toContain('export default () => null;');
    expect(md).toContain('```css');
  });

  it('infers the fence language from the extension when none is given', () => {
    const md = projectToMarkdown({ title: 'x', template: 'static', files: [{ path: '/main.py', content: 'print(1)' }] });
    expect(md).toContain('```py');
    expect(md).toContain('print(1)');
  });
});
