import { describe, it, expect } from 'vitest';
import { buildSandpackProject } from './sandpackProject';
import type { CodeStudioArtifact } from '../../../apiTypes';

describe('buildSandpackProject', () => {
  it('rewrites a Vite-structured react-ts app into Sandpack canonical shape', () => {
    const art: CodeStudioArtifact = {
      title: 'Counter',
      template: 'react-ts',
      files: [
        { path: '/index.html', content: '<div id="root"></div><script src="/src/main.tsx"></script>' },
        { path: '/src/main.tsx', content: 'createRoot(document.getElementById("root")).render(<App/>)' },
        { path: '/src/App.tsx', content: 'export default function App(){ return <h1>hi</h1>; }' },
        { path: '/src/styles.css', content: 'body{margin:0}' },
      ],
    };
    const p = buildSandpackProject(art);
    expect(p.template).toBe('react-ts');
    // Canonical entry + html injected.
    expect(p.entry).toBe('/index.tsx');
    expect(p.files['/index.tsx']).toContain("import App from './src/App'");
    expect(p.files['/index.tsx']).toContain("import './src/styles.css'"); // CSS preserved
    expect(p.files['/index.tsx']).toContain("document.getElementById('root')");
    expect(p.files['/public/index.html']).toContain('id="root"');
    // App + css kept; the app's own entry/html dropped (replaced).
    expect(p.files['/src/App.tsx']).toBeDefined();
    expect(p.files['/src/styles.css']).toBeDefined();
    expect(p.files['/src/main.tsx']).toBeUndefined();
    expect(p.files['/index.html']).toBeUndefined();
  });

  it('handles a root /App.tsx app', () => {
    const p = buildSandpackProject({
      title: 'X', template: 'react-ts',
      files: [{ path: '/App.tsx', content: 'export default () => <div/>;' }],
    });
    expect(p.files['/index.tsx']).toContain("import App from './App'");
    expect(p.files['/public/index.html']).toContain('id="root"');
  });

  it('maps static to vanilla and keeps the html, adding an entry stub', () => {
    const p = buildSandpackProject({
      title: 'Landing', template: 'static',
      files: [{ path: '/index.html', content: '<h1>Launch</h1>' }],
    });
    expect(p.template).toBe('vanilla');
    expect(p.files['/index.html']).toContain('Launch');
    expect(p.files['/index.js']).toBe(''); // Sandpack vanilla needs an entry
  });

  it('extracts runtime deps from package.json and strips build-only tooling', () => {
    const p = buildSandpackProject({
      title: 'Dep', template: 'react-ts',
      files: [
        { path: '/App.tsx', content: 'export default () => null;' },
        { path: '/package.json', content: JSON.stringify({ dependencies: { zustand: '^5.0.0' }, devDependencies: { vite: '^5', typescript: '^5' } }) },
      ],
    });
    expect(p.dependencies).toEqual({ zustand: '^5.0.0' });
    // package.json is consumed into deps, not passed as a file.
    expect(p.files['/package.json']).toBeUndefined();
  });

  it('escapes the title in the generated html', () => {
    const p = buildSandpackProject({
      title: '<script>x</script>', template: 'react-ts',
      files: [{ path: '/App.tsx', content: 'export default () => null;' }],
    });
    expect(p.files['/public/index.html']).toContain('&lt;script&gt;');
    expect(p.files['/public/index.html']).not.toContain('<script>x');
  });
});
