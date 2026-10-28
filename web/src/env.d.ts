// Ambient types of the esbuild build (scripts/esbuild.mjs).

declare module '*.css';

interface ImportMetaEnv {
  /** "1" when built for Playwright: use the OIDC test double. */
  readonly MEMOBRAIN_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /** Provided by Vitest (the tests read sources with it); the esbuild bundle never uses it. */
  glob<T = unknown>(
    pattern: string | string[],
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, T>;
}
