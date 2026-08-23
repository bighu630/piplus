import basicSsl from '@vitejs/plugin-basic-ssl';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // SSL 配置：优先使用环境变量 / 仓库根目录 .env 中的 HTTPS_KEY_PATH / HTTPS_CERT_PATH，
  // 未配置（或文件不存在）时回退到内置自签名证书（basic-ssl）
  const env = loadEnv(mode, path.resolve(__dirname, '../..'), '');
  const httpsKeyPath = process.env.HTTPS_KEY_PATH || env.HTTPS_KEY_PATH;
  const httpsCertPath = process.env.HTTPS_CERT_PATH || env.HTTPS_CERT_PATH;

  let https: { key: Buffer; cert: Buffer } | undefined;
  if (httpsKeyPath && httpsCertPath && fs.existsSync(httpsKeyPath) && fs.existsSync(httpsCertPath)) {
    https = { key: fs.readFileSync(httpsKeyPath), cert: fs.readFileSync(httpsCertPath) };
  }

  return {
    // basic-ssl 会覆盖 server.https 的证书内容，配置了自定义证书时需跳过
    plugins: [...(https ? [] : [basicSsl()]), react(), tailwindcss()],
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
      ...(https && { https }),
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
