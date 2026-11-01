/**
 * The Web Worker that runs the Go core (ADR-0030): it gives the core a file system on OPFS, SQLite on
 * sqlite-wasm, and a host that forwards what the core needs from the page. Started by bridge.ts.
 *
 * Order matters: `fs`, `path` and `process` must exist before wasm_exec.js is evaluated (it only fills
 * in what is missing), and the SQLite bridge and the host must exist before the Go program starts.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  createBridge,
  installBridge,
  type SqliteDatabase,
  type SqliteStatement,
} from '@memobrain/sqlite-bridge';
import { installOpfsFs, segments, type OpfsFs } from './opfs-fs';
import type {
  AssetRef,
  CoreAssets,
  CoreConfig,
  FromWorker,
  HostRequest,
  ToWorker,
} from './protocol';

/** The worker's global scope (the DOM lib types `self` as a Window). */
const scope = globalThis as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: MessageEvent<ToWorker>) => void) | null;
};

const post = (m: FromWorker, transfer: Transferable[] = []): void => scope.postMessage(m, transfer);

let opfs: OpfsFs;
let pool: { unlink(name: string): boolean; getFileNames(): string[] } | null = null;

// ---- host: what the core asks of the page -----------------------------------------------------------

let nextHost = 1;
const hostWaiting = new Map<
  number,
  {
    resolve: (v: { value?: unknown; file?: { name: string; bytes: ArrayBuffer } }) => void;
    reject: (e: Error) => void;
  }
>();

function ask(
  request: HostRequest,
): Promise<{ value?: unknown; file?: { name: string; bytes: ArrayBuffer } }> {
  const id = nextHost++;
  return new Promise((resolve, reject) => {
    hostWaiting.set(id, { resolve, reject });
    post({ type: 'host', id, request });
  });
}

/** The object Go's webHost (internal/app/host_web.go) looks for as globalThis.__memobrainHost. */
function installHost(): void {
  (globalThis as Record<string, unknown>)['__memobrainHost'] = {
    emit: (name: string, payload: string) => post({ type: 'event', name, payload }),
    token: async () => {
      const { value } = await ask({ op: 'token' });
      return typeof value === 'string' ? value : '';
    },
    openURL: (url: string) => void ask({ op: 'openURL', url }),
    print: () => void ask({ op: 'print' }),
    quit: () => void ask({ op: 'quit' }),
    error: (title: string, message: string) => void ask({ op: 'error', title, message }),
    /** A file the core finished writing for the user to keep: hand its bytes to the page, then drop it. */
    deliver: async (path: string) => {
      const bytes = await opfs.readFile(path);
      const name = segments(path).pop() ?? 'download';
      const copy = bytes.slice().buffer;
      post({ type: 'download', name, bytes: copy }, [copy]);
      await opfs.removeTree(path);
    },
    /** The page shows its file picker; the chosen file is copied into the scratch area and its path returned. */
    pickFile: async (title: string, patterns: string[]) => {
      const { file } = await ask({ op: 'pickFile', title, patterns });
      if (!file) return '';
      const dir = '/tmp/memobrain-uploads';
      await new Promise<void>((resolve, reject) =>
        mkdirAll(dir, (e) => (e ? reject(e) : resolve())),
      );
      const path = `${dir}/${file.name.replace(/[\\/]/g, '_')}`;
      await writeFile(path, new Uint8Array(file.bytes));
      return path;
    },
  };
}

type FsLike = {
  mkdir(p: string, m: number, cb: (e: Error | null) => void): void;
  open(p: string, f: number, m: number, cb: (e: Error | null, fd?: number) => void): void;
  write(
    fd: number,
    b: Uint8Array,
    o: number,
    l: number,
    p: number | null,
    cb: (e: Error | null, n?: number) => void,
  ): void;
  close(fd: number, cb: (e: Error | null) => void): void;
  constants: Record<string, number>;
};
const fsApi = (): FsLike => (globalThis as unknown as { fs: FsLike }).fs;

function mkdirAll(path: string, cb: (e: Error | null) => void): void {
  const parts = segments(path);
  const step = (i: number): void => {
    if (i > parts.length) return cb(null);
    fsApi().mkdir('/' + parts.slice(0, i).join('/'), 0o755, (e) => {
      if (e && (e as Error & { code?: string }).code !== 'EEXIST') return cb(e);
      step(i + 1);
    });
  };
  step(1);
}

function writeFile(path: string, data: Uint8Array): Promise<void> {
  const fs = fsApi();
  const c = fs.constants;
  return new Promise((resolve, reject) => {
    fs.open(
      path,
      (c['O_WRONLY'] ?? 1) | (c['O_CREAT'] ?? 0x40) | (c['O_TRUNC'] ?? 0x200),
      0o644,
      (e, fd) => {
        if (e || fd === undefined) return reject(e ?? new Error('open failed'));
        fs.write(fd, data, 0, data.length, null, (we) =>
          fs.close(fd, (ce) =>
            we || ce ? reject(we ?? ce ?? new Error('write failed')) : resolve(),
          ),
        );
      },
    );
  });
}

// ---- SQLite -----------------------------------------------------------------------------------------

async function installSqlite(assets: CoreAssets): Promise<void> {
  const wasm = await (await fetchChecked(assets.sqlite)).arrayBuffer();
  // The module's types declare no options; Emscripten's `wasmBinary` is what spares it a second fetch.
  const init = sqlite3InitModule as unknown as (options: object) => Promise<unknown>;
  const sqlite3 = await init({
    // The loader would fetch sqlite3.wasm next to itself; the bytes are already here, checked.
    wasmBinary: new Uint8Array(wasm),
    // Only names the file: without it the loader resolves it against import.meta.url, which a blob:
    // worker cannot serve as a base. The bytes above are what gets compiled.
    locateFile: (file: string) => file,
    print: (...a: unknown[]) => console.log('[sqlite]', ...a),
    printErr: (...a: unknown[]) => console.warn('[sqlite]', ...a),
  });
  // The "opfs-sahpool" VFS keeps every database in a pool of pre-allocated OPFS files. Each database
  // needs a slot (plus one for its journal while a transaction runs), and slots cannot be added from
  // synchronous code, so a generous number is reserved up front.
  const util = await (
    sqlite3 as {
      installOpfsSAHPoolVfs(o: object): Promise<
        NonNullable<typeof pool> & {
          OpfsSAHPoolDb: new (n: string) => unknown;
          reserveMinimumCapacity(n: number): Promise<number>;
        }
      >;
    }
  ).installOpfsSAHPoolVfs({
    name: 'memobrain',
    directory: '/memobrain-sqlite',
    initialCapacity: 64,
    clearOnInit: false,
  });
  await util.reserveMinimumCapacity(64);
  pool = util;
  const canon = (p: string): string => '/' + segments(p).join('/');
  installBridge(
    createBridge({
      canonicalPath: canon,
      openDatabase: (path) => new util.OpfsSAHPoolDb(path) as SqliteDatabase,
      deleteDatabase: (path) => void util.unlink(path),
      databaseExists: (path) => util.getFileNames().includes(path),
      columnTypes: (stmt: SqliteStatement) => {
        const s = stmt as unknown as { pointer: number; columnCount: number };
        const capi = (
          sqlite3 as {
            capi: { sqlite3_column_decltype(p: number, i: number): string | null };
          }
        ).capi;
        return Array.from(
          { length: s.columnCount },
          (_, i) => capi.sqlite3_column_decltype(s.pointer, i) ?? '',
        );
      },
    }),
  );
}

/**
 * Fetches a WebAssembly file with the Subresource Integrity the build recorded. A missing hash is a
 * broken build, not a reason to skip the check: only E2E builds (a build-time constant, compiled out
 * of production) may load an unpinned file. URLs are resolved against the origin because the worker
 * runs from a blob: URL (bridge.ts), which cannot serve as a base.
 */
async function fetchChecked(ref: AssetRef): Promise<Response> {
  if (!ref.integrity && !import.meta.env.MEMOBRAIN_E2E)
    throw new Error(`refusing to load ${ref.url} without its integrity hash`);
  const url = new URL(ref.url, location.origin).href;
  const res = await fetch(url, ref.integrity ? { integrity: ref.integrity } : {});
  if (!res.ok) throw new Error(`cannot load ${ref.url}: HTTP ${res.status}`);
  return res;
}

// ---- the Go program ---------------------------------------------------------------------------------

type GoCore = {
  call(service: string, method: string, argsJSON: string): Promise<string>;
  start(): Promise<void>;
  domReady(): void;
  shutdown(): Promise<void>;
  methods(): string;
};
let core: GoCore | null = null;

async function startGo(assets: CoreAssets, config: CoreConfig): Promise<void> {
  (globalThis as Record<string, unknown>)['__memobrainConfig'] = config;
  const ready = new Promise<void>((resolve) => {
    (globalThis as Record<string, unknown>)['__memobrainCoreReady'] = resolve;
  });
  // wasm_exec.js (Go's own loader, evaluated for its side effect) defines globalThis.Go.
  await import('../../../build/wasm/wasm_exec.js');
  const Go = (
    globalThis as unknown as {
      Go: new () => {
        importObject: WebAssembly.Imports;
        env: Record<string, string>;
        argv: string[];
        run(i: WebAssembly.Instance): Promise<void>;
      };
    }
  ).Go;
  const go = new Go();
  go.argv = ['memobrain-core'];
  go.env = { TMPDIR: '/tmp', HOME: '/' };
  const res = await fetchChecked(assets.core);
  let instance: WebAssembly.Instance;
  try {
    ({ instance } = await WebAssembly.instantiateStreaming(res.clone(), go.importObject));
  } catch {
    // Not served as application/wasm: compile from the bytes.
    ({ instance } = await WebAssembly.instantiate(await res.arrayBuffer(), go.importObject));
  }
  void go.run(instance).then(
    () => post({ type: 'fatal', error: 'the Go core exited' }),
    (e: unknown) => post({ type: 'fatal', error: `the Go core stopped: ${String(e)}` }),
  );
  await ready;
  core = (globalThis as unknown as { __memobrainCore: GoCore }).__memobrainCore;
}

// ---- messages ---------------------------------------------------------------------------------------

async function init(assets: CoreAssets, config: CoreConfig): Promise<void> {
  opfs = await installOpfsFs(
    globalThis,
    config.fsTrace ? { trace: (l) => console.debug('[fs]', l) } : {},
  );
  // Go expects its temp folder and its data folder to exist.
  for (const dir of ['/tmp', config.dataDir])
    await new Promise<void>((resolve, reject) => mkdirAll(dir, (e) => (e ? reject(e) : resolve())));
  installHost();
  await installSqlite(assets);
  await startGo(assets, config);
  post({
    type: 'ready',
    methods: JSON.parse((core as GoCore).methods()) as Record<string, string[]>,
  });
}

const settle = (id: number, p: Promise<unknown>): void =>
  void p.then(
    (r) => post({ type: 'result', id, result: typeof r === 'string' ? r : 'null' }),
    (e: unknown) => post({ type: 'result', id, error: e instanceof Error ? e.message : String(e) }),
  );

scope.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init':
      init(m.assets, m.config).catch((e: unknown) =>
        post({ type: 'fatal', error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    case 'call':
      settle(m.id, (core as GoCore).call(m.service, m.method, m.args));
      return;
    case 'start':
      settle(
        m.id,
        (core as GoCore).start().then(() => 'null'),
      );
      return;
    case 'domReady':
      (core as GoCore).domReady();
      return;
    case 'shutdown':
      settle(
        m.id,
        (core as GoCore).shutdown().then(() => 'null'),
      );
      return;
    case 'wipe':
      settle(
        m.id,
        (async () => {
          await opfs.removeTree(m.prefix);
          // The databases of a vault live in sqlite's own pool, not in the file system.
          for (const name of pool?.getFileNames() ?? [])
            if (name.startsWith(m.prefix + '/') || name === m.prefix) pool?.unlink(name);
          return 'null';
        })(),
      );
      return;
    case 'host-result': {
      const w = hostWaiting.get(m.id);
      if (!w) return;
      hostWaiting.delete(m.id);
      if (m.error) w.reject(new Error(m.error));
      else
        w.resolve({
          ...(m.value !== undefined ? { value: m.value } : {}),
          ...(m.file ? { file: m.file } : {}),
        });
      return;
    }
  }
};
