/// <reference types="node" />
// The Go core compiled to WebAssembly (build/wasm/clarae-core.wasm, `task wasm-core`), started in
// the Node process of a test: the same program the browser workbench runs in its Web Worker, with
// the harness of `task test-wasm` (Node's file system in a temporary data folder, SQLite through the
// sqlite-wasm bridge of @clarae/sqlite-bridge). The page's part of the contract (globalThis.
// __claraeHost, see apps/desktop/cmd/clarae-core/doc.go) is played here: a session owned by
// the "page" (a token, a remembered device), and `fetch` answered by an in-process cloud, so no
// port is opened. `window.go.app` is installed from the methods the core reports, as the web host's
// bridge does, so the workbench's binding facade (app/api.ts) and CoreCloudPort run unchanged.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { api } from '../app/api';

// Not `new URL(…, import.meta.url)`: Vite rewrites that pattern into an asset URL.
const root = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** The core and Go's loader, as `task wasm-core` writes them. */
export const wasmCore = nodePath.join(root, 'build/wasm/clarae-core.wasm');
const wasmExec = nodePath.join(root, 'build/wasm/wasm_exec.js');

/** Whether `task wasm-core` has built the core. */
export const wasmCoreBuilt = (): boolean => existsSync(wasmCore) && existsSync(wasmExec);

export interface WasmCoreOptions {
  /** The cloud: every request of the core goes here (the origin is `serverURL`). */
  fetch: (req: Request) => Promise<Response>;
  /** The device the "page" remembers for the account, so the core does not register a new one. */
  deviceId: string;
  /** The account the device belongs to (GET /me answers it). */
  userId: string;
  serverURL?: string;
}

export interface WasmCore {
  /** A binding call, as the bridge makes it: JSON arguments, parsed result, error message text. */
  call<T = unknown>(service: string, method: string, ...args: unknown[]): Promise<T>;
  /** The folder of the mounts of the shares in the core's data folder. */
  mountsDir: string;
  /** Events the core emitted (name, payload). */
  events: { name: string; payload: unknown }[];
  shutdown(): Promise<void>;
}

interface CoreGlobal {
  call(service: string, method: string, argsJSON: string): Promise<string>;
  start(): Promise<void>;
  domReady(): void;
  shutdown(): Promise<void>;
  methods(): string;
}

/**
 * Starts the core and waits until its hosted session is ready. Installs `window.go` and
 * `window.runtime` for the generated Wails modules. One core per test file: it holds global state.
 */
export async function startWasmCore(o: WasmCoreOptions): Promise<WasmCore> {
  // The globals the core and Go's loader read and write (fs, fetch, __clarae*, Go).
  const g = globalThis as unknown as Record<string, unknown>;
  // The same SQLite bridge as `task test-wasm` (scripts/go-js-exec.sh preloads it). The specifier
  // is not a literal: the module imports TypeScript files by their extension, which this package's
  // compiler options do not allow, and it is only needed at run time.
  const preload = '@clarae/sqlite-bridge/go-test-preload';
  await import(/* @vite-ignore */ preload);

  // What wasm_exec_node.js provides: Node's file system for the Go runtime.
  g['fs'] = nodeFs;
  g['path'] = nodePath;
  const dataDir = mkdtempSync(nodePath.join(tmpdir(), 'clarae-core-'));
  g['__claraeConfig'] = { dataDir, version: 'test', logLevel: 'error' };

  const events: WasmCore['events'] = [];
  const subscribers = new Map<string, Set<(payload: unknown) => void>>();
  g['__claraeHost'] = {
    serverURL: o.serverURL ?? 'http://cloud.test',
    emit: (name: string, payload: string) => {
      const data = JSON.parse(payload) as unknown;
      events.push({ name, payload: data });
      for (const cb of subscribers.get(name) ?? []) cb(data);
    },
    token: () => Promise.resolve('test-access-token'),
    loadDevice: () => Promise.resolve({ deviceId: o.deviceId, userId: o.userId }),
    saveDevice: () => Promise.resolve(),
    openURL: () => undefined,
    print: () => undefined,
    quit: () => undefined,
    error: () => undefined,
    deliver: () => Promise.resolve(),
    pickFile: () => Promise.resolve(''),
  };
  // The cloud, in process. Go's Fetch API client meets two realms in a component test (jsdom's
  // globals, Node's Request and Response): the AbortSignal of a request is jsdom's, which Node's
  // Request refuses (the in-process cloud answers at once, it is dropped), and the chunks of a
  // Node stream are not the Uint8Array Go checks for, so the answer is handed over without a body
  // stream and Go reads it whole (its arrayBuffer fallback, as for a browser without streams).
  g['fetch'] = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rest: RequestInit = { ...init };
    delete rest.signal;
    const res = await o.fetch(new Request(input, rest));
    return {
      status: res.status,
      headers: res.headers,
      body: null,
      redirected: false,
      url: res.url,
      arrayBuffer: () => res.arrayBuffer(),
    };
  };

  const ready = new Promise<void>((resolve) => {
    g['__claraeCoreReady'] = resolve;
  });
  // Go's loader (a script that defines globalThis.Go; it runs as a module as well).
  await import(/* @vite-ignore */ pathToFileURL(wasmExec).href);
  const GoCtor = g['Go'] as new () => {
    importObject: WebAssembly.Imports;
    env: Record<string, string>;
    run(instance: WebAssembly.Instance): Promise<void>;
  };
  const go = new GoCtor();
  go.env = { TMPDIR: tmpdir(), HOME: dataDir };
  const { instance } = await WebAssembly.instantiate(readFileSync(wasmCore), go.importObject);
  // Go's net/http talks to the Fetch API unless it runs under Node (process.argv0 "node…", read
  // once while its package initializes): the core must take the browser's path, so it sees another
  // name while the program initializes. go.run runs it synchronously up to its first wait, so the
  // real object is back before any other code runs.
  const realProcess = process;
  g['process'] = Object.create(realProcess, { argv0: { value: 'clarae-core' } }) as unknown;
  let exited: Promise<void>;
  try {
    exited = go.run(instance);
  } finally {
    g['process'] = realProcess;
  }
  void exited.then(() => {
    throw new Error('the core exited');
  });
  await ready;
  const core = g['__claraeCore'] as CoreGlobal;

  const call = async <T>(service: string, method: string, ...args: unknown[]): Promise<T> => {
    try {
      return JSON.parse(await core.call(service, method, JSON.stringify(args))) as T;
    } catch (e) {
      // The bridge rejects with the message text, as Wails does.
      throw e instanceof Error ? e.message : e;
    }
  };

  // The generated Wails modules call window.go.app.<Service>.<Method>; the UI listens through
  // window.runtime (web/src/workbench/bridge.ts, installWailsGlobals).
  const app: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const [service, names] of Object.entries(
    JSON.parse(core.methods()) as Record<string, string[]>,
  )) {
    app[service] = {};
    for (const method of names) app[service][method] = (...args) => call(service, method, ...args);
  }
  const w = (g['window'] ?? g) as Record<string, unknown>;
  w['go'] = { app };
  w['runtime'] = {
    EventsOnMultiple: (name: string, cb: (...data: unknown[]) => void) => {
      const set = subscribers.get(name) ?? new Set();
      subscribers.set(name, set);
      const fn = (p: unknown) => cb(p);
      set.add(fn);
      return () => set.delete(fn);
    },
    EventsOff: (...names: string[]) => names.forEach((n) => subscribers.delete(n)),
    EventsEmit: () => undefined,
    BrowserOpenURL: () => undefined,
    WindowShow: () => undefined,
  };

  await core.start();
  core.domReady();
  // The hosted session: the core loads the profile with the page's token.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const st = await api.auth.status();
    if (st.status === 'ready') break;
    if (Date.now() > deadline)
      throw new Error(`the core has no cloud session (${st.status}: ${st.error ?? ''})`);
    await new Promise((r) => setTimeout(r, 50));
  }

  return {
    call,
    mountsDir: nodePath.join(dataDir, 'mounts'),
    events,
    async shutdown() {
      await core.shutdown();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
