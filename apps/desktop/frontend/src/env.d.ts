// Ambient types of the esbuild build (scripts/esbuild.mjs).
interface ImportMetaEnv {
  /** "1" when built for Playwright: main.tsx leaves the Wails runtime out (the workbench installs the mock). */
  readonly MEMOBRAIN_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
