import { defineConfig } from 'vitest/config';

// The app is built with esbuild (scripts/esbuild.mjs); this config is only for the unit tests.
// Playwright's specs (e2e/) are not Vitest's.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
