import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The tests on the Go core compiled to WebAssembly (`*.core.test.tsx`, ADR-0045 §4): they need
// build/wasm (`task wasm-core`), so they run apart from the unit tests (`task test-core`). No Wails
// mock here: the core installs the bindings.
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.core.test.{ts,tsx}'],
    setupFiles: ['src/test/coreSetup.ts'],
    globals: true,
    // One core per file, started once before its tests.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
