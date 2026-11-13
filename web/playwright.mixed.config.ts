import { defineConfig } from '@playwright/test';

// Mixed-client suite (P7 of the W8 review): a headless desktop device (apps/desktop/cmd/e2e-device,
// the real desktop core and sync engine) and the web workbench in Chromium, against the same cloud
// (Keycloak, PostgreSQL, S3) served with the production web build. No server is started here:
// scripts/e2e-mixed.sh (`task e2e-mixed`) brings up a throwaway stack on its own ports, builds the
// binaries and runs this config with CLARAE_CLOUD_URL and CLARAE_E2E_DEVICE set.
export default defineConfig({
  testDir: './e2e-mixed',
  outputDir: '../.dev/e2e-mixed/test-results',
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: process.env['CLARAE_CLOUD_URL'] ?? 'http://localhost:18091',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
