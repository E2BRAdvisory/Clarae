import { defineConfig } from '@playwright/test';

// The UI runs in plain Chromium against the in-memory Wails mock (CLARAE_E2E=1
// makes main.tsx install it); the Go backend is covered by its own tests.
// E2E_PREVIEW=1 (yarn e2e:prod) runs the same specs on the minified production bundle, so
// bundling problems (split chunks, CommonJS interop, CSP-sensitive code) show up before a release.
// E2E_WEBKIT=1 adds a WebKit project that runs only the specs of WEBKIT_SPECS: the engine of the Wails
// web view on macOS (WKWebView), which Chromium does not reproduce (`npx playwright install webkit` first).
const PORT = 5199;
const WEBKIT_SPECS = /marp-show-layout\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    ...(process.env['E2E_WEBKIT']
      ? [{ name: 'webkit', testMatch: WEBKIT_SPECS, use: { browserName: 'webkit' as const } }]
      : []),
  ],
  webServer: {
    command: `node scripts/esbuild.mjs ${process.env['E2E_PREVIEW'] ? 'preview' : 'dev'} --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    env: { CLARAE_E2E: '1' },
  },
});
