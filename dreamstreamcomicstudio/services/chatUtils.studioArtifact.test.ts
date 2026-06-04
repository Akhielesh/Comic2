import { describe, it, expect } from 'vitest';
import { extractCodeBlocks, buildStudioArtifact } from './chatUtils';

describe('buildStudioArtifact', () => {
  it('returns null when there is no web-runnable code', () => {
    const blocks = extractCodeBlocks('```bash\nnpm install\n```\n```python\nprint("hi")\n```');
    expect(buildStudioArtifact(blocks)).toBeNull();
  });

  it('ignores trivial one-line snippets', () => {
    const blocks = extractCodeBlocks('```js\nconsole.log(1)\n```');
    expect(buildStudioArtifact(blocks)).toBeNull();
  });

  it('packs a React component into a react-ts project with an /App.tsx entry', () => {
    const md = [
      'Here you go:',
      '```tsx',
      "import React, { useState } from 'react';",
      'export default function App() {',
      '  const [n, setN] = useState(0);',
      '  return <button onClick={() => setN(n + 1)}>Count: {n}</button>;',
      '}',
      '```'
    ].join('\n');
    const artifact = buildStudioArtifact(extractCodeBlocks(md));
    expect(artifact).not.toBeNull();
    expect(artifact!.template).toBe('react-ts');
    expect(artifact!.files.some((f) => /\/App\.tsx$/.test(f.path))).toBe(true);
  });

  it('treats a full HTML document as a static site with index.html as the entry', () => {
    const md = [
      '```html',
      '<!doctype html>',
      '<html><body><h1>Hello</h1><script>document.title="x"</script></body></html>',
      '```'
    ].join('\n');
    const artifact = buildStudioArtifact(extractCodeBlocks(md));
    expect(artifact).not.toBeNull();
    expect(artifact!.template).toBe('static');
    expect(artifact!.files[0].path).toBe('/index.html');
  });

  it('preserves multiple named files', () => {
    const md = [
      '```js',
      '// utils.js',
      'export const add = (a, b) => a + b;',
      '```',
      '```js',
      '// index.js',
      "import { add } from './utils.js';",
      'console.log(add(2, 3));',
      '```'
    ].join('\n');
    const artifact = buildStudioArtifact(extractCodeBlocks(md));
    expect(artifact).not.toBeNull();
    expect(artifact!.files.length).toBe(2);
    expect(artifact!.files.map((f) => f.path).sort()).toEqual(['/index.js', '/utils.js']);
  });
});
