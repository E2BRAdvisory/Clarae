import { defineConfig } from '@playwright/test';

// Browser-level security checks against the production build, served by the real
// embedded-SPA handler (services/cloud/web-embed/cmd/webembed-serve) so the CSP and
// headers are the ones the cloud binary sends. Prerequisite: `task web-build`.
// Run with: yarn workspace @memobrain/web e2e:security
export default defineConfig({
  testDir: './e2e-security',
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:18095', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'go run ./web-embed/cmd/webembed-serve -addr 127.0.0.1:18095',
      cwd: '../services/cloud',
      url: 'http://127.0.0.1:18095/',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      // The vault workbench under the production handler and policy. It needs the E2E build (a folder of
      // this browser opens without a cloud: `?local`), so that build gets a directory of its own; the
      // handler serves it from disk. Prerequisite: `task wasm-core`.
      command:
        'sh -c "MEMOBRAIN_E2E=1 MEMOBRAIN_DIST=dist-e2e node scripts/esbuild.mjs build && cd ../services/cloud && go run ./web-embed/cmd/webembed-serve -addr 127.0.0.1:18096 -dir ../../web/dist-e2e"',
      cwd: '.',
      url: 'http://127.0.0.1:18096/',
      reuseExistingServer: !process.env['CI'],
      timeout: 300_000,
    },
  ],
});
