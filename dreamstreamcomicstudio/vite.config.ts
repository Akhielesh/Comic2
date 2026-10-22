import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: Number(env.VITE_PORT) || 7000,
      strictPort: false,
      host: '0.0.0.0',
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
    plugins: [react()],
    // Module workers (the baby monitor's sound-model worker imports ONNX Runtime).
    worker: { format: 'es' },
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
