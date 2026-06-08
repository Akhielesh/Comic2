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
    expect(p.files['/index.tsx']).toContain("import App from './src/App.tsx'"); // explicit ext
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
    expect(p.files['/index.tsx']).toContain("import App from './App.tsx'");
    expect(p.files['/public/index.html']).toContain('id="root"');
  });

  it('imports the app with its REAL extension so a template stub cannot shadow it', () => {
    // /App.jsx in a react-ts project: Sandpack merges its own /App.tsx stub, so an
    // extensionless "./App" import would resolve to the stub. The explicit extension
    // disambiguates to the generated file.
    const p = buildSandpackProject({
      title: 'Mix', template: 'react-ts',
      files: [{ path: '/App.jsx', content: 'export default () => <div>real</div>;' }],
    });
    expect(p.files['/index.tsx']).toContain("import App from './App.jsx'");
    expect(p.files['/index.tsx']).not.toContain("import App from './App'\n");
  });

  it('routes static through Sandpack\'s static env and serves the html verbatim', () => {
    const p = buildSandpackProject({
      title: 'Landing', template: 'static',
      files: [{ path: '/index.html', content: '<h1>Launch</h1><script>console.log(1)</script>' }],
    });
    expect(p.template).toBe('static');
    expect(p.files['/index.html']).toContain('Launch');
    expect(p.files['/index.html']).toContain('<script>'); // inline script preserved
    expect(p.files['/index.js']).toBeUndefined(); // no bundler entry forced
  });

  it('synthesizes a mountable fallback when there is no root component or entry', () => {
    const p = buildSandpackProject({
      title: 'Lib', template: 'react-ts',
      files: [{ path: '/utils.ts', content: 'export const add = (a:number,b:number)=>a+b;' }],
    });
    expect(p.entry).toBe('/index.tsx');
    expect(p.files['/App.tsx']).toContain('export default function App');
    expect(p.files['/App.tsx']).toContain('utils.ts'); // lists the project files
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
