import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  root: 'ui',
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4273',
    },
  },
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
  },
});
