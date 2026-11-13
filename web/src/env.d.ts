// Ambient types of the esbuild build (scripts/esbuild.mjs).

declare module '*.css';

/** The WebAssembly files of the core, recorded by the build (null when it was built without them). */
declare const __CLARAE_CORE__: unknown;
/** URL of the bundled worker that runs the core (scripts/esbuild.mjs). */
declare const __CLARAE_WORKER__: string;
/** SHA-384 of that bundle (Subresource Integrity), checked before the worker starts (bridge.ts). */
declare const __CLARAE_WORKER_INTEGRITY__: string;
/** Version stamped by the build. */
declare const __CLARAE_VERSION__: string;
/** Go's loader for the core (build/wasm/wasm_exec.js, produced by `task wasm-core`). */
declare module '*/wasm_exec.js';

interface ImportMetaEnv {
  /** "1" when built for Playwright: use the OIDC test double. */
  readonly CLARAE_E2E?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
  /** Provided by Vitest (the tests read sources with it); the esbuild bundle never uses it. */
  glob<T = unknown>(
    pattern: string | string[],
    options?: { query?: string; import?: string; eager?: boolean },
  ): Record<string, T>;
}
