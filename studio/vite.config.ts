import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API calls to a running Studio server (KEEL_STUDIO_DEV_API).
// Filled into Studio's AI agent prompt (see website/.vitepress/site.ts).
const images = (
  process.env.KEEL_IMAGE_PREFIX ||
  `ghcr.io/${(process.env.KEEL_IMAGE_OWNER || process.env.GITHUB_REPOSITORY_OWNER || 'YOUR-GITHUB-NAME').toLowerCase()}`
).replace(/\/+$/, '');
const site = (process.env.KEEL_SITE_URL || 'https://YOUR-KEEL-WEBSITE').replace(/\/+$/, '');

export default defineConfig({
  plugins: [react()],
  define: {
    __KEEL_IMAGES__: JSON.stringify(images),
    __KEEL_SITE__: JSON.stringify(site),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.KEEL_STUDIO_DEV_API || 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
