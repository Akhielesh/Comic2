// Normalize a CodeStudioArtifact into a project Sandpack can actually mount.
//
// Why this exists: generated/starter apps are REAL Vite projects (/index.html → /src/main.tsx
// → /src/App.tsx). Sandpack's react template expects a different shape (its own entry + a
// /public/index.html with <div id="root">). Handing a Vite-structured app straight to Sandpack
// means there's no #root, so the app's mount throws "Cannot set properties of null (innerHTML)".
// We transform any app into Sandpack's canonical shape: a guaranteed #root html + a generated
// entry that mounts the detected root component, importing all CSS so styles survive.

import type { CodeStudioArtifact } from '../../../apiTypes';

export type SandpackTemplate = 'react-ts' | 'react' | 'vanilla-ts' | 'vanilla';

export interface SandpackProject {
  template: SandpackTemplate;
  files: Record<string, string>;
  /** Explicit entry for Sandpack's customSetup (so it doesn't guess). */
  entry?: string;
  dependencies?: Record<string, string>;
}

// Tooling Sandpack supplies itself (it bundles in-browser; it does not run Vite/TS). Listing
// these as deps would make Sandpack try to install a bundler it never uses.
const BUILD_ONLY_DEPS = new Set([
  'vite', '@vitejs/plugin-react', '@vitejs/plugin-react-swc', 'typescript',
  'react-scripts', 'webpack', 'esbuild', 'parcel', '@types/react', '@types/react-dom',
]);

const TEMPLATE_MAP: Record<string, SandpackTemplate> = {
  'react-ts': 'react-ts', react: 'react', 'vanilla-ts': 'vanilla-ts', vanilla: 'vanilla', static: 'vanilla',
};
const mapTemplate = (t: string): SandpackTemplate => TEMPLATE_MAP[t] ?? 'react-ts';

const norm = (p: string): string => (p.startsWith('/') ? p : `/${p}`);
const baseName = (p: string): string => p.split('/').pop() || p;
const stripExt = (p: string): string => p.replace(/\.[a-zA-Z0-9]+$/, '');
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const extractDependencies = (pkgContent?: string): Record<string, string> | undefined => {
  if (!pkgContent) return undefined;
  try {
    const parsed = JSON.parse(pkgContent) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const merged = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
    const deps: Record<string, string> = {};
    for (const [name, version] of Object.entries(merged)) {
      if (!BUILD_ONLY_DEPS.has(name)) deps[name] = version;
    }
    return Object.keys(deps).length ? deps : undefined;
  } catch {
    return undefined;
  }
};

const htmlShell = (title: string): string =>
  `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(title || 'App')}</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

const reactEntry = (appImport: string, cssImports: string[]): string =>
  `import React from 'react';
import { createRoot } from 'react-dom/client';
${cssImports.map((p) => `import '${p}';`).join('\n')}
import App from '${appImport}';

const el = document.getElementById('root');
if (el) {
  createRoot(el).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
`;

// A path is one of the app's own entry/html files that we replace with canonical ones.
const isEntryOrHtml = (p: string): boolean => {
  const b = baseName(p).toLowerCase();
  return b === 'index.html' || p === '/public/index.html' ||
    ['main.tsx', 'main.jsx', 'main.js', 'index.tsx', 'index.jsx', 'index.js'].includes(b);
};

export const buildSandpackProject = (data: CodeStudioArtifact): SandpackProject => {
  const template = mapTemplate(data.template);
  const isTs = template === 'react-ts' || template === 'vanilla-ts';

  // Collect files; pull package.json out into dependencies.
  const all: Record<string, string> = {};
  let pkgJson: string | undefined;
  for (const f of data.files) {
    const p = norm(f.path);
    if (p.replace(/^\/+/, '') === 'package.json') { pkgJson = f.content; continue; }
    all[p] = f.content;
  }
  const dependencies = extractDependencies(pkgJson);

  // ---- vanilla / static: just need an html (+ an entry Sandpack can load) ----
  if (template === 'vanilla' || template === 'vanilla-ts') {
    const files = { ...all };
    if (!files['/index.html']) {
      const anyHtml = Object.keys(all).find((k) => k.endsWith('.html'));
      files['/index.html'] = anyHtml ? all[anyHtml] : htmlShell(data.title);
    }
    // Sandpack's vanilla template expects an index entry; supply an empty one if the app is pure HTML/CSS.
    if (!files['/index.js'] && !files['/index.ts']) files[isTs ? '/index.ts' : '/index.js'] = '';
    return { template, files, dependencies };
  }

  // ---- react / react-ts: rebuild into Sandpack's canonical shape ----
  const APP_CANDIDATES = isTs
    ? ['/App.tsx', '/App.jsx', '/App.js', '/src/App.tsx', '/src/App.jsx', '/src/App.js']
    : ['/App.jsx', '/App.js', '/App.tsx', '/src/App.jsx', '/src/App.js', '/src/App.tsx'];
  let appPath = APP_CANDIDATES.find((c) => all[c]);
  if (!appPath) {
    // Any default-exporting component that isn't itself an entry file.
    appPath = Object.keys(all).find(
      (p) => /\.(t|j)sx?$/.test(p) && /export\s+default/.test(all[p]) && !/^(main|index)\./i.test(baseName(p))
    );
  }

  const cssImports = Object.keys(all)
    .filter((p) => p.endsWith('.css'))
    .map((p) => `.${p}`); // '/src/x.css' -> './src/x.css'

  // No detectable root component → keep everything, ensure an html, let Sandpack use the app's entry.
  if (!appPath) {
    const files = { ...all };
    if (!files['/public/index.html']) files['/public/index.html'] = htmlShell(data.title);
    const entry = Object.keys(all).find((p) => /(^|\/)(main|index)\.(t|j)sx?$/.test(p));
    return { template, files, dependencies, entry };
  }

  const files: Record<string, string> = {};
  for (const [p, c] of Object.entries(all)) {
    if (isEntryOrHtml(p)) continue; // replaced by canonical entry/html below
    files[p] = c;
  }
  const entryPath = isTs ? '/index.tsx' : '/index.js';
  files[entryPath] = reactEntry(`.${stripExt(appPath)}`, cssImports);
  files['/public/index.html'] = htmlShell(data.title);

  return { template, files, entry: entryPath, dependencies };
};
