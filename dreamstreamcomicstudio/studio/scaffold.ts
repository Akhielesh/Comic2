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

const PKG_REACT = (
  name: string,
  extraDeps: Record<string, string> = {},
  extraDevDeps: Record<string, string> = {}
) => JSON.stringify({
  name, private: true, type: 'module', version: '0.0.0',
  scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
  dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', ...extraDeps },
  devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0', ...extraDevDeps }
}, null, 2);

// Well-known design/UX libraries the DESIGN_CHARTER steers models toward. When the generated
// React code imports one, we add it to package.json so the recommended stack (shadcn/ui, Magic
// UI, Framer Motion, …) runs on first install instead of dying on a missing dependency. Only
// libraries that are actually imported are added, so this never bloats unrelated apps.
const KNOWN_DEPS: Record<string, string> = {
  'framer-motion': '^11.11.0', motion: '^11.11.0', 'lucide-react': '^0.456.0',
  clsx: '^2.1.1', 'tailwind-merge': '^2.5.4', 'class-variance-authority': '^0.7.0',
  'tailwindcss-animate': '^1.0.7', recharts: '^2.13.0', 'react-router-dom': '^6.27.0',
  zustand: '^5.0.0', 'date-fns': '^4.1.0', '@tanstack/react-query': '^5.59.0',
  'react-hook-form': '^7.53.0', zod: '^3.23.8', 'embla-carousel-react': '^8.3.0',
  sonner: '^1.5.0', 'next-themes': '^0.3.0',
};

const IMPORT_RE = /(?:import\s[^'"]*?from\s*|import\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;

const barePackage = (spec: string): string | null => {
  if (!spec || spec.startsWith('.') || spec.startsWith('/')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

/** Scan emitted React/TS source for imports of known design libs (and shadcn's Radix primitives). */
const detectExtraDeps = (files: Record<string, string>): Record<string, string> => {
  const deps: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (!/\.(t|j)sx?$/.test(path)) continue;
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(content))) {
      const name = barePackage(m[1]);
      if (!name || name === 'react' || name === 'react-dom') continue;
      if (KNOWN_DEPS[name]) deps[name] = KNOWN_DEPS[name];
      else if (name.startsWith('@radix-ui/')) deps[name] = '^1.1.0'; // shadcn/ui primitives
    }
  }
  return deps;
};

const ROOT_CONFIG_RE = /^(tailwind\.config\.(c|m)?[jt]s|postcss\.config\.(c|m)?js|vite\.config\.[jt]s|tsconfig(\.\w+)?\.json)$/;
const TAILWIND_CSS_RE = /@tailwind\b|@import\s+["']tailwindcss/;

/** The model opted into Tailwind if it shipped a tailwind config or a CSS file with the directives. */
const usesTailwind = (files: Record<string, string>): boolean =>
  Object.keys(files).some((p) => /^tailwind\.config\./.test(p)) ||
  Object.entries(files).some(([p, c]) => p.endsWith('.css') && TAILWIND_CSS_RE.test(c));

const TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
`;
const POSTCSS_CONFIG = `export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`;
const TAILWIND_ENTRY_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;
`;

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
  const extraDeps = detectExtraDeps(userFiles);
  const extraDevDeps: Record<string, string> = {};

  // Move all app code under src/. We generate our own index.html + entry, so skip
  // any the model emitted (they're usually Sandpack-flavored and won't boot Vite).
  for (const [path, content] of Object.entries(userFiles)) {
    if (path === 'index.html' || path === 'package.json') continue;
    if (/^(src\/)?(main|index)\.(t|j)sx?$/.test(path)) continue;
    if (ROOT_CONFIG_RE.test(path)) { files[path] = content; continue; } // tooling configs stay at root
    files[`src/${path}`] = content;
    if (path.endsWith('.css')) cssImports.push(`import './${path}';`);
  }

  if (!Object.keys(files).some((p) => /^src\/App\.(t|j)sx?$/.test(p))) {
    files[`src/App.${ext}`] = DEFAULT_APP;
  }

  // If the model opted into Tailwind (shadcn/Magic UI's styling layer), wire it up so the
  // utility classes actually render: install Tailwind + PostCSS, ensure the config files and a
  // CSS entry with the @tailwind directives exist, and import that entry.
  if (usesTailwind(userFiles)) {
    Object.assign(extraDevDeps, { tailwindcss: '^3.4.14', postcss: '^8.4.47', autoprefixer: '^10.4.20' });
    if (!Object.keys(files).some((p) => /^tailwind\.config\./.test(p))) files['tailwind.config.js'] = TAILWIND_CONFIG;
    if (!Object.keys(files).some((p) => /^postcss\.config\./.test(p))) files['postcss.config.js'] = POSTCSS_CONFIG;
    const hasTwEntry = Object.entries(files).some(([p, c]) => p.startsWith('src/') && p.endsWith('.css') && TAILWIND_CSS_RE.test(c));
    if (!hasTwEntry) {
      files['src/index.css'] = TAILWIND_ENTRY_CSS;
      cssImports.unshift(`import './index.css';`);
    }
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
  if (!files['vite.config.js'] && !files['vite.config.ts']) files['vite.config.js'] = VITE_REACT;
  files['package.json'] = PKG_REACT(slug(artifact.title), extraDeps, extraDevDeps);

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

// ---------------------------------------------------------------------------------------------
// Expo / React Native — "web + mobile from one codebase".
//
// The SAME React Native code that runs on a device (via `npm run native` → `expo start`) is
// previewed live in the browser by aliasing `react-native` → `react-native-web` and bundling it
// with Vite. That keeps the in-studio preview reliable (it's a plain Vite app, so it boots in the
// WebContainer like every other web project) while still emitting a real, runnable Expo project.
// ---------------------------------------------------------------------------------------------

// Expo SDK 51 / RN 0.74-aligned versions for common, web-compatible RN libraries. Only added when
// the generated code imports them; for exact native versions users run `npx expo install`.
const KNOWN_RN_DEPS: Record<string, string> = {
  'react-native-safe-area-context': '4.10.5',
  'react-native-reanimated': '~3.10.1',
  'react-native-gesture-handler': '~2.16.1',
  'react-native-screens': '3.31.1',
  'react-native-svg': '15.2.0',
  '@react-navigation/native': '^6.1.18',
  '@react-navigation/native-stack': '^6.11.0',
  '@react-navigation/bottom-tabs': '^6.6.1',
  'expo-status-bar': '~1.12.1',
  'expo-constants': '~16.0.2',
  'expo-linear-gradient': '~13.0.2',
  'expo-haptics': '~13.0.1',
  'expo-image': '~1.12.15',
  '@expo/vector-icons': '^14.0.2',
  nativewind: '^4.1.23',
};

const DEFAULT_RN_APP = `import { View, Text, StyleSheet } from 'react-native';

export default function App() {
  return (
    <View style={styles.center}><Text style={styles.title}>App</Text></View>
  );
}
const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700' },
});
`;

// NativeWind (Tailwind for React Native, the basis of react-native-reusables) is opt-in: when the
// generated code imports it (or ships Tailwind directives / a tailwind config), we wire the native
// build correctly (babel + metro + tailwind preset + a global.css). Styling is canonical on device
// (`npm run native`); the lightweight Vite web preview renders layout/base styles.
const usesNativeWind = (files: Record<string, string>): boolean =>
  Object.entries(files).some(([p, c]) => /\.(t|j)sx?$/.test(p) && /from\s+['"]nativewind['"]/.test(c)) ||
  Object.entries(files).some(([p, c]) => p.endsWith('.css') && TAILWIND_CSS_RE.test(c)) ||
  Object.keys(files).some((p) => /(^|\/)tailwind\.config\./.test(p));

const NW_BABEL = `module.exports = function (api) {
  api.cache(true);
  return { presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'] };
};
`;
const NW_METRO = `const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
module.exports = withNativeWind(getDefaultConfig(__dirname), { input: './global.css' });
`;
const NW_TAILWIND = `/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./App.{js,jsx,ts,tsx}', './src/**/*.{js,jsx,ts,tsx}', './components/**/*.{js,jsx,ts,tsx}', './screens/**/*.{js,jsx,ts,tsx}'],
  presets: [require('nativewind/preset')],
  theme: { extend: {} },
  plugins: [],
};
`;

const isExpoArtifact = (userFiles: Record<string, string>): boolean => {
  const appJson = userFiles['app.json'];
  if (appJson && /"expo"\s*:/.test(appJson)) return true;
  const pkg = userFiles['package.json'];
  if (pkg && /"(expo|react-native)"\s*:/.test(pkg)) return true;
  return Object.entries(userFiles).some(
    ([p, c]) => /\.(t|j)sx?$/.test(p) && /from\s+['"](react-native|expo|expo-[\w-]+)['"]/.test(c)
  );
};

/** Detect imported RN libraries (and bare expo-* modules) so they land in package.json. */
const detectRnDeps = (files: Record<string, string>): Record<string, string> => {
  const deps: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (!/\.(t|j)sx?$/.test(path)) continue;
    IMPORT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IMPORT_RE.exec(content))) {
      const name = barePackage(m[1]);
      if (!name) continue;
      if (KNOWN_RN_DEPS[name]) deps[name] = KNOWN_RN_DEPS[name];
    }
  }
  return deps;
};

const VITE_RNW = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React Native Web preview: the same React Native code that runs on device renders in the
// browser by aliasing 'react-native' -> 'react-native-web'.
export default defineConfig({
  plugins: [react()],
  define: { global: 'window', __DEV__: 'true', 'process.env': '{}' },
  resolve: {
    alias: { 'react-native': 'react-native-web' },
    extensions: ['.web.tsx', '.web.ts', '.web.jsx', '.web.js', '.tsx', '.ts', '.jsx', '.js', '.json'],
  },
  server: { host: true },
});
`;

const APP_JSON_EXPO = (name: string, slugName: string): string => JSON.stringify({
  expo: {
    name, slug: slugName, version: '1.0.0', orientation: 'portrait',
    userInterfaceStyle: 'automatic', platforms: ['ios', 'android', 'web'],
    web: { bundler: 'metro' },
  }
}, null, 2);

const expoScaffold = (artifact: CodeStudioArtifact, userFiles: Record<string, string>): ScaffoldResult => {
  const files: Record<string, string> = {};

  // Keep the user's RN code at the project ROOT — Expo's AppEntry, Metro and Tailwind all expect
  // App + the source tree there. We only ADD a web preview harness + configs alongside it, so the
  // SAME project runs on device (`npm run native`) and previews on web (`npm run dev` via Vite).
  for (const [path, content] of Object.entries(userFiles)) {
    if (path === 'index.html' || path === 'package.json' || path === 'app.json') continue;
    if (/^(src\/)?(main|index)\.(t|j)sx?$/.test(path)) continue; // skip Sandpack-flavored web entries
    files[path] = content;
  }
  const ext = Object.keys(files).some((p) => /\.jsx?$/.test(p)) && !Object.keys(files).some((p) => /\.tsx?$/.test(p)) ? 'jsx' : 'tsx';
  if (!Object.keys(files).some((p) => /^App\.(t|j)sx?$/.test(p))) files[`App.${ext}`] = DEFAULT_RN_APP;

  // Web preview harness (Vite + react-native-web) over the ROOT App — mirrors expo/AppEntry.
  files[`web-entry.${ext}`] = `import { AppRegistry } from 'react-native';
import App from './App';

AppRegistry.registerComponent('App', () => App);
AppRegistry.runApplication('App', { rootTag: document.getElementById('root') });
`;
  files['index.html'] = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
    <title>${esc(artifact.title)}</title>
    <style>html, body, #root { height: 100%; margin: 0; } #root { display: flex; }</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/web-entry.${ext}"></script>
  </body>
</html>
`;
  if (!files['vite.config.js'] && !files['vite.config.ts']) files['vite.config.js'] = VITE_RNW;
  files['app.json'] = userFiles['app.json'] || APP_JSON_EXPO(artifact.title, slug(artifact.title));

  // NativeWind (Tailwind for RN / react-native-reusables): wire the native build when opted into.
  const extraDevDeps: Record<string, string> = {};
  const nativewind = usesNativeWind(userFiles);
  if (nativewind) {
    if (!Object.keys(files).some((p) => /^babel\.config\./.test(p))) files['babel.config.js'] = NW_BABEL;
    if (!Object.keys(files).some((p) => /^metro\.config\./.test(p))) files['metro.config.js'] = NW_METRO;
    if (!Object.keys(files).some((p) => /^tailwind\.config\./.test(p))) files['tailwind.config.js'] = NW_TAILWIND;
    if (!Object.keys(files).some((p) => p === 'global.css' || p.endsWith('/global.css'))) files['global.css'] = TAILWIND_ENTRY_CSS;
    extraDevDeps.tailwindcss = '^3.4.17';
  }

  // Merge any model-shipped deps with the required Expo + preview baseline.
  const modelPkg = userFiles['package.json'] ? safeJson(userFiles['package.json']) : null;
  const modelDeps = (modelPkg?.dependencies as Record<string, string>) || {};
  const dependencies = {
    expo: '~51.0.39', react: '18.2.0', 'react-dom': '18.2.0',
    'react-native': '0.74.5', 'react-native-web': '~0.19.13',
    ...(nativewind ? { nativewind: '^4.1.23' } : {}),
    ...detectRnDeps(userFiles), ...modelDeps,
  };
  files['package.json'] = JSON.stringify({
    name: slug(artifact.title), private: true, version: '1.0.0',
    main: 'node_modules/expo/AppEntry.js',
    scripts: {
      dev: 'vite', build: 'vite build', preview: 'vite preview',
      native: 'expo start', 'native:web': 'expo start --web',
    },
    dependencies,
    devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0', ...extraDevDeps },
  }, null, 2);

  return { files, installCommand: ['npm', ['install']], devCommand: ['npm', ['run', 'dev']] };
};

export const scaffold = (artifact: CodeStudioArtifact): ScaffoldResult => {
  const userFiles = flatten(artifact);

  // Expo / React Native is detected from content (no template enum) and wired for web preview
  // even when the model shipped its own package.json, so the studio controls the preview command.
  if (isExpoArtifact(userFiles)) return expoScaffold(artifact, userFiles);

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
