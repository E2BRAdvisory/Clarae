import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The app itself is built with esbuild (scripts/esbuild.mjs); this config is only for the tests.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    globals: true,
  },
});
