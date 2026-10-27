import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const ASSET_URL = '/excalidraw-assets/';

/**
 * Excalidraw loads its fonts at run time from window.EXCALIDRAW_ASSET_PATH. Serving them
 * from the app itself keeps the editor working offline (no CDN request, see drawing/assets.ts):
 * dev middleware in `vite`, a copy into dist/ in `vite build`.
 */
function excalidrawAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const dir = dirname(require.resolve('@excalidraw/excalidraw')); // .../dist/prod
  return {
    name: 'memobrain-excalidraw-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        if (!url.startsWith(ASSET_URL)) return next();
        const file = normalize(join(dir, url.slice(ASSET_URL.length)));
        if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader(
          'Content-Type',
          file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream',
        );
        createReadStream(file).pipe(res);
      });
    },
    async closeBundle() {
      await cp(
        join(dir, 'fonts'),
        join(fileURLToPath(new URL('./dist', import.meta.url)), ASSET_URL, 'fonts'),
        {
          recursive: true,
        },
      );
    },
  };
}

// Wails serves the built assets from frontend/dist via the Go asset server;
// in dev mode it proxies to this Vite server ("frontend:dev:serverUrl": "auto").
export default defineConfig({
  plugins: [react(), excalidrawAssets()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    globals: true,
  },
});
