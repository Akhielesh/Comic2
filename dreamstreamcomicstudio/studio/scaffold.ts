// Turns a CodeStudioArtifact (the AI's loose files) into a *real, runnable* Vite
// project the WebContainer can `npm install && npm run dev`. If the model already
// shipped a package.json we trust it; otherwise we scaffold one around its files.

import type { CodeStudioArtifact } from '../apiTypes';

export interface ScaffoldResult {
  /** Flat path → contents map of the complete runnable project. */
  files: Record<string, string>;
  installCommand: [string, string[]];
  devCommand: [string, string[]];
}

const stripSlash = (p: string): string => p.replace(/^\/+/, '');
const slug = (s: string): string =>
  (s || 'app').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
const esc = (s: string): string => s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));

const safeJson = (s: string): Record<string, unknown> | null => {
  try { return JSON.parse(s); } catch { return null; }
};

const flatten = (a: CodeStudioArtifact): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const f of a.files) out[stripSlash(f.path)] = f.content;
  return out;
};

const DEFAULT_APP = `export default function App() {
  return <div style={{ fontFamily: 'sans-serif', padding: 24 }}>
    <h1>App</h1>
    <p>No App component was provided.</p>
  </div>;
}
`;

const PKG_REACT = (name: string) => JSON.stringify({
  name, private: true, type: 'module', version: '0.0.0',
  scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
  dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
  devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0' }
}, null, 2);

const PKG_VANILLA = (name: string) => JSON.stringify({
  name, private: true, type: 'module', version: '0.0.0',
  scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
  devDependencies: { vite: '^5.4.0' }
}, null, 2);

const VITE_REACT = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { host: true } });
`;
const VITE_VANILLA = `import { defineConfig } from 'vite';
export default defineConfig({ server: { host: true } });
`;

const reactScaffold = (artifact: CodeStudioArtifact, userFiles: Record<string, string>): ScaffoldResult => {
  const ts = artifact.template === 'react-ts';
  const ext = ts ? 'tsx' : 'jsx';
  const files: Record<string, string> = {};
  const cssImports: string[] = [];

  // Move all app code under src/. We generate our own index.html + entry, so skip
  // any the model emitted (they're usually Sandpack-flavored and won't boot Vite).
  for (const [path, content] of Object.entries(userFiles)) {
    if (path === 'index.html' || path === 'package.json') continue;
    if (/^(src\/)?(main|index)\.(t|j)sx?$/.test(path)) continue;
    files[`src/${path}`] = content;
    if (path.endsWith('.css')) cssImports.push(`import './${path}';`);
  }

  if (!Object.keys(files).some((p) => /^src\/App\.(t|j)sx?$/.test(p))) {
    files[`src/App.${ext}`] = DEFAULT_APP;
  }

  files[`src/main.${ext}`] = `import React from 'react';
import { createRoot } from 'react-dom/client';
${cssImports.join('\n')}
import App from './App';

createRoot(document.getElementById('root')).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
);
`;
  files['index.html'] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(artifact.title)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.${ext}"></script>
  </body>
</html>
`;
  files['vite.config.js'] = VITE_REACT;
  files['package.json'] = PKG_REACT(slug(artifact.title));

  return { files, installCommand: ['npm', ['install']], devCommand: ['npm', ['run', 'dev']] };
};

const vanillaScaffold = (artifact: CodeStudioArtifact, userFiles: Record<string, string>): ScaffoldResult => {
  const files: Record<string, string> = { ...userFiles };

  if (!files['index.html']) {
    const entry = Object.keys(files).find((p) => /\.(m?js|ts)$/.test(p));
    files['index.html'] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(artifact.title)}</title>
  </head>
  <body>
    <div id="app"></div>
    ${entry ? `<script type="module" src="/${entry}"></script>` : ''}
  </body>
</html>
`;
  }
  if (!files['package.json']) files['package.json'] = PKG_VANILLA(slug(artifact.title));
  if (!files['vite.config.js'] && !files['vite.config.ts']) files['vite.config.js'] = VITE_VANILLA;

  return { files, installCommand: ['npm', ['install']], devCommand: ['npm', ['run', 'dev']] };
};

export const scaffold = (artifact: CodeStudioArtifact): ScaffoldResult => {
  const userFiles = flatten(artifact);

  // The model shipped a full project — trust its package.json + scripts.
  if (userFiles['package.json']) {
    const pkg = safeJson(userFiles['package.json']);
    const scripts = (pkg?.scripts as Record<string, string>) || {};
    const dev = scripts.dev ? 'dev' : scripts.start ? 'start' : 'dev';
    return { files: userFiles, installCommand: ['npm', ['install']], devCommand: ['npm', ['run', dev]] };
  }

  const isReact = artifact.template === 'react' || artifact.template === 'react-ts';
  return isReact ? reactScaffold(artifact, userFiles) : vanillaScaffold(artifact, userFiles);
};
