// Ambient types of the esbuild build (scripts/esbuild.mjs).

declare module '*.css';

/** `import url from 'pkg/file?url'`: the URL of the file copied into dist/assets. */
declare module '*?url' {
  const url: string;
  export default url;
}

interface ImportMetaEnv {
  /** "1" when built for Playwright: use the in-memory Wails mock. */
  readonly CLARAE_E2E?: string;
  /** "1" when built with the AI assistant enabled (ADR-0050); absent in every released build. */
  readonly CLARAE_AI?: string;
  /** "1" when built with real-time collaboration enabled (ADR-0050); absent in every released build. */
  readonly CLARAE_COLLAB?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /** Provided by Vitest (the tests read sources with it); the esbuild bundle never uses it. */
  glob<T = unknown>(
    pattern: string | string[],
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, T>;
}
