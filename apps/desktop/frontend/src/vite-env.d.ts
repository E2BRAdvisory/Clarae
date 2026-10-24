/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set by the Playwright web server: use the in-memory Wails mock. */
  readonly VITE_E2E?: string;
}
