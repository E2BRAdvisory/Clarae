import { defineConfig } from '@playwright/test';

// The SPA runs in Chromium on the esbuild dev server with the API mocked via page.route.
// MEMOBRAIN_E2E=1 swaps the OIDC client for a test double; that code is compiled out of production builds.
// Two runs at once (several worktrees or agents) need their own port: E2E_WEB_PORT.
const PORT = Number(process.env['E2E_WEB_PORT'] ?? 5175);
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: BASE, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: `node scripts/esbuild.mjs dev --port ${PORT}`,
    url: BASE,
    reuseExistingServer: !process.env['CI'],
    env: { MEMOBRAIN_E2E: '1' },
  },
});
