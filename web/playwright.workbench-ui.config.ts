import { defineConfig } from '@playwright/test';

// The desktop's user-flow specs (apps/desktop/frontend/e2e) run against the vault workbench in the browser:
// the same UI on the real Go core compiled to WebAssembly (OPFS, sqlite-wasm), not on the Wails mock.
// E2E_TARGET=web makes e2e/support.ts open a vault of this browser (`?local`, E2E builds only).
// Only the specs whose flows exist on both targets are listed; see docs/web-workbench-parity.md.
// Prerequisite: `task wasm-core`. Run with: yarn workspace @memobrain/web e2e:workbench-ui
export default defineConfig({
  testDir: '../apps/desktop/frontend/e2e',
  testMatch: ['workflows', 'keyboard', 'editor-toolbar', 'slides', 'graph'].map(
    (n) => `${n}.spec.ts`,
  ),
  fullyParallel: true,
  workers: 2,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 90_000,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5176', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'node scripts/esbuild.mjs dev --port 5176',
    url: 'http://localhost:5176',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    env: { MEMOBRAIN_E2E: '1', E2E_TARGET: 'web', E2E_ORIGIN: 'http://localhost:5176' },
  },
});
