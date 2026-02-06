import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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
      plugins: [react()],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
