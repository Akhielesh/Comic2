import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv, searchForWorkspaceRoot, type Plugin, type Rollup } from 'vite';
import react from '@vitejs/plugin-react';
import { browserModulesReport } from './scripts/licence-check.mjs';
import { webNotices } from './scripts/notices.mjs';

// Comic Studio QA harness entry (P1-QA: qa/comic-qa.html). Built ONLY when QA_BUILD=1
// (`npm run qa:build` → dist-qa/), so production dist/ never contains it.
const qaInput = (): Record<string, string> => {
  if (process.env.QA_BUILD !== '1') return {};
  const entry = path.resolve(__dirname, 'qa/comic-qa.html');
  if (!fs.existsSync(entry)) {
    throw new Error('QA_BUILD=1 but qa/comic-qa.html does not exist yet (the QA harness entry is added by P1-QA).');
  }
  return { qa: entry };
};

/** Every source a Rollup output came from: chunk modules, and the files assets were emitted from. */
const bundleSources = (bundle: Rollup.OutputBundle): string[] => {
  const ids: string[] = [];
  for (const item of Object.values(bundle)) {
    if (item.type === 'chunk') ids.push(...Object.keys(item.modules));
    else ids.push(...(item.originalFileNames ?? []));
  }
  return ids;
};

/**
 * W1.6 licence gate, browser side: records the npm packages whose modules (or emitted files: fonts,
 * wasm) are REALLY in the production bundle — the main entries and every worker bundle — and emits
 * dist/THIRD-PARTY-NOTICES.txt for exactly those (scripts/notices.mjs). With LICENCE_MODULES_OUT set
 * (CI) it also writes that module list as JSON for `node scripts/licence-check.mjs --browser-modules`,
 * which applies the browser rules (MIT/Apache/BSD/ISC/MPL/OFL only) to it. The list is written
 * outside dist/ so it never ships. `worker()` is the collector for `worker.plugins` (Vite bundles
 * workers in separate Rollup builds that finish before the main bundle's generateBundle).
 */
export function licenceModules(options: { root?: string; reportFile?: string } = {}): Plugin & { worker: () => Plugin } {
  const root = options.root ?? __dirname;
  const workerSources = new Set<string>();
  return {
    name: 'licence-modules',
    apply: 'build',
    enforce: 'post',
    generateBundle(_output, bundle) {
      const report = browserModulesReport([...bundleSources(bundle), ...workerSources], { root });
      this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.txt', source: webNotices(report, { root }) });
      const out = options.reportFile ?? process.env.LICENCE_MODULES_OUT;
      if (out) {
        fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
        fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
      }
    },
    worker: (): Plugin => ({
      name: 'licence-modules:worker',
      apply: 'build',
      enforce: 'post',
      generateBundle(_output, bundle) {
        for (const id of bundleSources(bundle)) workerSources.add(id);
      }
    })
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const licence = licenceModules();
  return {
    server: {
      port: Number(env.VITE_PORT) || 7000,
      strictPort: false,
      host: '0.0.0.0',
      fs: {
        // Git worktrees link node_modules to the main checkout; vite's fs guard checks the
        // REAL path, so without this every `?url` font import (fontFiles.ts) fails in tests there.
        allow: [searchForWorkspaceRoot(process.cwd()), ...(fs.existsSync('node_modules') ? [fs.realpathSync('node_modules')] : [])]
      },
      proxy: {
        // Regex, not the bare '/api' prefix: a prefix key also captures app MODULE
        // requests like /apiTypes.ts and forwards them to the backend, whose Express
        // 404 then kills the whole dev module graph (blank app, chat never opens).
        '^/api(/|$)': {
          target: 'http://localhost:7071',
          changeOrigin: true
        }
      }
    },
    plugins: [react(), licence],
    // Module workers (the baby monitor's sound-model worker imports ONNX Runtime). Their packages
    // count as browser code for the licence gate too.
    worker: { format: 'es', plugins: () => [licence.worker()] },
    // ONNX Runtime loads its .wasm next to its own module; pre-bundling it into
    // .vite/deps breaks that path in dev (production builds emit it correctly).
    optimizeDeps: { exclude: ['onnxruntime-web'] },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    },
    build: {
      // vendor-sandpack (CodeMirror + in-browser bundler) is inherently large but lazy-loaded
      // (only the legacy Sandpack peek pulls it), so allow headroom past it.
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          live: path.resolve(__dirname, 'live.html'),
          ...qaInput()
        },
        output: {
          // Split heavy, independently-cacheable vendors out of the entry chunks so a change
          // to app code doesn't bust their cache (and the >500 kB warning clears).
          manualChunks(id: string) {
            // Vite's dynamic-import preload helper is pulled in by every chunk with a lazy
            // import — including the entry. Left unassigned, Rollup folds it into a heavy
            // vendor chunk (here vendor-sandpack, 958 kB), which then gets eagerly preloaded
            // on first paint just to obtain this tiny helper. Pin it to the always-eager
            // React chunk so the entry references it for free and Sandpack stays lazy.
            if (id.includes('preload-helper')) return 'vendor-react';
            if (!id.includes('node_modules')) return undefined;
            // Pin React core to its own stable, eagerly-loaded chunk. Without this, Rollup
            // merges react/react-dom into whichever vendor chunk first pulls them in (here
            // vendor-sandpack), forcing the landing page to download ~950 kB of Sandpack/
            // CodeMirror just to get React. The regex matches exact package segments so it
            // never catches react-markdown, react-leaflet, @codesandbox/sandpack-react, etc.
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) return 'vendor-react';
            if (id.includes('framer-motion')) return 'vendor-motion';
            if (id.includes('@codesandbox/sandpack') || id.includes('@codemirror') || id.includes('codemirror')) return 'vendor-sandpack';
            if (
              id.includes('react-markdown') || id.includes('remark') || id.includes('rehype') ||
              id.includes('micromark') || id.includes('mdast') || id.includes('hast') ||
              id.includes('unist') || id.includes('vfile') || id.includes('property-information')
            ) return 'vendor-markdown';
            if (id.includes('leaflet')) return 'vendor-leaflet';
            if (id.includes('jszip')) return 'vendor-jszip';
            return undefined;
          }
        }
      }
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './tests/setup.ts',
      // tests/e2e holds Playwright specs (npm run qa:mobile), not vitest suites.
      exclude: ['**/node_modules/**', '**/dist/**', '**/dist-qa/**', '**/server/dist/**', 'tests/e2e/**']
    }
  };
});
