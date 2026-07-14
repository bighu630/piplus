import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [basicSsl(), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(process.env.APP_VERSION || 'dev'),
    },
    server: {
    host: true,
      port: 3000,
      proxy: {
        '/api': {
          target: 'http://localhost:3003',
          changeOrigin: true,
        },
        '/ws': {
          target: 'ws://localhost:3003',
          ws: true,
        },
        '/health': {
          target: 'http://localhost:3003',
          changeOrigin: true,
        },
      },
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
