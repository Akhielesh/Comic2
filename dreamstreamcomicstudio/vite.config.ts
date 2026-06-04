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
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          studio: path.resolve(__dirname, 'studio.html')
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
