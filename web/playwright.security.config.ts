import { defineConfig } from '@playwright/test';

// Browser-level security checks against the production build, served by the real
// embedded-SPA handler (services/cloud/web-embed/cmd/webembed-serve) so the CSP and
// headers are the ones the cloud binary sends. Prerequisite: `make web-build`.
// Run with: yarn workspace @memobrain/web e2e:security
export default defineConfig({
  testDir: './e2e-security',
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:18095', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'go run ./web-embed/cmd/webembed-serve -addr 127.0.0.1:18095',
    cwd: '../services/cloud',
    url: 'http://127.0.0.1:18095/',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
