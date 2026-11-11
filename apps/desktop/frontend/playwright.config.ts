import { defineConfig } from '@playwright/test';

// The UI runs in plain Chromium against the in-memory Wails mock (MEMOBRAIN_E2E=1
// makes main.tsx install it); the Go backend is covered by its own tests.
// E2E_PREVIEW=1 (yarn e2e:prod) runs the same specs on the minified production bundle, so
// bundling problems (split chunks, CommonJS interop, CSP-sensitive code) show up before a release.
// MEMOBRAIN_LIVE_ENGINE=milkdown runs the same specs on a build whose Live mode is Milkdown (ADR-0049);
// its server has a port of its own, so that one left running by the other engine is never reused.
const PORT = process.env['MEMOBRAIN_LIVE_ENGINE'] === 'milkdown' ? 5299 : 5199;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node scripts/esbuild.mjs ${process.env['E2E_PREVIEW'] ? 'preview' : 'dev'} --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    env: { MEMOBRAIN_E2E: '1' },
  },
});
