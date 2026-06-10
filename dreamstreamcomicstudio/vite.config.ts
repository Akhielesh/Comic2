import path from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Serve the dedicated Code Studio page (/studio.html) with cross-origin isolation
// headers so WebContainers can boot there — WITHOUT isolating the main app (which
// would break OSM map tiles, image-search results and cross-origin embeds).
const studioIsolation = (): Plugin => {
  const apply = (req: { url?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    if (req.url && req.url.startsWith('/studio')) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
    next();
  };
  return {
    name: 'studio-coop-coep',
    configureServer: (server) => { server.middlewares.use(apply); },
    configurePreviewServer: (server) => { server.middlewares.use(apply); }
  };
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: Number(env.VITE_PORT) || 7000,
      strictPort: false,
      host: '0.0.0.0',
      proxy: {
        '/api': {
          target: 'http://localhost:7071',
          changeOrigin: true
        }
      }
    },
    plugins: [react(), studioIsolation()],
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
          studio: path.resolve(__dirname, 'studio.html'),
          live: path.resolve(__dirname, 'live.html')
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
      exclude: ['**/node_modules/**', '**/dist/**', '**/server/dist/**']
    }
  };
});
