import { defineConfig } from '@playwright/test';

// The vault workbench against a real cloud (Keycloak, PostgreSQL, S3), served by the cloud binary with the
// production web build. No web server is started here: bring the stack up first, after `make web-build`:
//   scripts/run-desktop-with-cloud.sh --cloud-only --keep
// Keycloak's redirect URIs cover http://localhost:18081/*, so the tests use that origin (not 127.0.0.1).
// Run with: yarn workspace @memobrain/web e2e:cloud
export default defineConfig({
  testDir: './e2e-cloud',
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: process.env['MEMOBRAIN_CLOUD_URL'] ?? 'http://localhost:18081',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
