import { defineConfig } from '@playwright/test';

// The SPA runs in Chromium on the Vite dev server with the API mocked via page.route.
// VITE_E2E=1 swaps the OIDC client for a test double; that code is compiled out of production builds.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5175', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'yarn vite --port 5175 --strictPort',
    url: 'http://localhost:5175',
    reuseExistingServer: !process.env['CI'],
    env: { VITE_E2E: '1' },
  },
});
