import { defineConfig } from '@playwright/test';

// The UI runs in plain Chromium against the in-memory Wails mock (VITE_E2E=1
// makes main.tsx install it); the Go backend is covered by its own tests.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { baseURL: 'http://localhost:5199', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'yarn vite --port 5199 --strictPort',
    url: 'http://localhost:5199',
    reuseExistingServer: !process.env['CI'],
    env: { VITE_E2E: '1' },
  },
});
