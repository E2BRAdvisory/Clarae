/** Messages between the page and the worker that runs the Go core (ADR-0030). */

/** A file the build emitted, with the SHA-384 the page checks when it fetches it (Subresource Integrity). */
export interface AssetRef {
  url: string;
  integrity: string;
}

/** The WebAssembly files of the core, as the build recorded them. */
export interface CoreAssets {
  /** The desktop core compiled with GOOS=js. */
  core: AssetRef;
  /** sqlite-wasm. */
  sqlite: AssetRef;
}

export interface CoreConfig {
  dataDir: string;
  version: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Log every file system call of the core to the console (diagnostics). */
  fsTrace?: boolean;
}

/** What the page can ask of the user's browser on behalf of the core (Go's `Host`). */
export type HostRequest =
  | { op: 'token' }
  | { op: 'openURL'; url: string }
  | { op: 'print' }
  | { op: 'quit' }
  | { op: 'error'; title: string; message: string }
  | { op: 'pickFile'; title: string; patterns: string[] };

export type ToWorker =
  | { type: 'init'; assets: CoreAssets; config: CoreConfig }
  | { type: 'call'; id: number; service: string; method: string; args: string }
  | { type: 'start'; id: number }
  | { type: 'domReady' }
  | { type: 'shutdown'; id: number }
  /** Wipes a folder of the core's file system and the databases stored under the same prefix. */
  | { type: 'wipe'; id: number; prefix: string }
  /** The answer to a HostRequest. */
  | {
      type: 'host-result';
      id: number;
      value?: unknown;
      error?: string;
      file?: { name: string; bytes: ArrayBuffer };
    };

export type FromWorker =
  | { type: 'ready'; methods: Record<string, string[]> }
  | { type: 'fatal'; error: string }
  | { type: 'result'; id: number; result?: string; error?: string }
  | { type: 'event'; name: string; payload: string }
  | { type: 'host'; id: number; request: HostRequest }
  /** A finished file the user asked to save: the page turns it into a download. */
  | { type: 'download'; name: string; bytes: ArrayBuffer };
