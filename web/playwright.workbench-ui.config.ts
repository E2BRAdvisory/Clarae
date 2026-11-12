import { defineConfig } from '@playwright/test';

// The e2e matrix (P7 of the W8 review): every user-flow spec of the desktop UI
// (apps/desktop/frontend/e2e) runs on both targets.
//  - desktop-mock: the desktop UI on the in-memory Wails mock (the desktop frontend's dev server);
//  - web-core: the vault workbench in the browser on the real Go core compiled to WebAssembly
//    (OPFS, sqlite-wasm). e2e/support.ts opens a vault of this browser (`?local`, E2E builds only).
// A spec that cannot run on the web calls skipOnWeb(<feature id>, <reason>) (support.ts); the
// coverage of each target is in docs/web-workbench-parity.md (scripts/parity.mjs).
// Prerequisite: `task wasm-core`. Run with: yarn workspace @memobrain/web e2e:workbench-ui
// (one target: add `--project web-core` or `--project desktop-mock`).
/** The `target` option of e2e/support.ts (the specs are not part of this TypeScript project). */
type Target = 'desktop' | 'web';

// Two runs at once (several worktrees or agents) need their own ports: E2E_MATRIX_DESKTOP_PORT and
// E2E_MATRIX_WEB_PORT; the build folders and the results follow the ports.
const DESKTOP_PORT = Number(process.env['E2E_MATRIX_DESKTOP_PORT'] ?? 5199);
const WEB_PORT = Number(process.env['E2E_MATRIX_WEB_PORT'] ?? 5176);
const DESKTOP = `http://localhost:${DESKTOP_PORT}`;
const WEB = `http://localhost:${WEB_PORT}`;
const OUT = `../.dev/e2e-matrix/${DESKTOP_PORT}-${WEB_PORT}`;

export default defineConfig<{ target: Target }>({
  testDir: '../apps/desktop/frontend/e2e',
  // Not web/test-results: the other web suites clean that folder when they start.
  outputDir: `${OUT}/test-results`,
  fullyParallel: true,
  workers: 2,
  retries: process.env['CI'] ? 1 : 0,
  timeout: 90_000,
  reporter: process.env['CI'] ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop-mock',
      use: { browserName: 'chromium', baseURL: DESKTOP, target: 'desktop' },
    },
    {
      name: 'web-core',
      use: { browserName: 'chromium', baseURL: WEB, target: 'web' },
    },
  ],
  // Built once (--no-watch: a rebuild would reload the pages of the running tests) into folders of
  // their own (MEMOBRAIN_DIST): web/dist and apps/desktop/frontend/dist are rebuilt by other builds.
  webServer: [
    {
      command: `node scripts/esbuild.mjs dev --port ${DESKTOP_PORT} --no-watch`,
      cwd: '../apps/desktop/frontend',
      url: DESKTOP,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: { MEMOBRAIN_E2E: '1', MEMOBRAIN_DIST: `../../${OUT}/desktop-dist` },
    },
    {
      command: `node scripts/esbuild.mjs dev --port ${WEB_PORT} --no-watch`,
      url: WEB,
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: { MEMOBRAIN_E2E: '1', MEMOBRAIN_DIST: `${OUT}/web-dist` },
    },
  ],
});
