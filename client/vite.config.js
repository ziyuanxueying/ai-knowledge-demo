import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite 配置
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 把 /api 请求代理到后端，避免跨域问题（虽然后端也开了 CORS）
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
