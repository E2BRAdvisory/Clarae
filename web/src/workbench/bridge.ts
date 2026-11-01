/**
 * The page side of the Go core (ADR-0030): starts the worker, forwards calls to it, answers what the
 * core asks of the browser, and installs `window.go` / `window.runtime` so the desktop UI, which was
 * written against Wails, runs unchanged on top of the core.
 */
import type {
  AssetRef,
  CoreAssets,
  CoreConfig,
  FromWorker,
  HostRequest,
  ToWorker,
} from './protocol';
import { downloadBlob } from '../shared/download';

export interface CoreOptions {
  assets: CoreAssets;
  config: CoreConfig;
  /** A valid access token for the cloud, renewed by the page's OIDC client. */
  getToken(): Promise<string>;
  /** The core asked to quit (the desktop would close the window). */
  onQuit?(): void;
  /** The core reports a failure that stops it. */
  onFatal?(message: string): void;
  /** Worker factory, for tests. */
  createWorker?(): Worker;
}

/** Every call rejects with this once the core stopped (the worker failed or the Go program exited). */
export class CoreDeadError extends Error {
  constructor(reason: string) {
    super(`the vault engine stopped: ${reason}`);
    this.name = 'CoreDeadError';
  }
}

/** A call that got no answer within the time it was given (see CoreHandle.callWithin). */
export class CoreTimeoutError extends Error {
  constructor(service: string, method: string, ms: number) {
    super(`${service}.${method} did not answer within ${Math.round(ms / 1000)} s`);
    this.name = 'CoreTimeoutError';
  }
}

export interface CoreHandle {
  /** The services and methods the core exposes, as reported when it started. */
  readonly methods: Record<string, string[]>;
  /** True once the core stopped: every call then rejects at once with a CoreDeadError. */
  readonly dead: boolean;
  /**
   * Calls a binding: JSON arguments in, parsed result out. Rejects with the binding's error message
   * (text, like Wails), or with a CoreDeadError when the core stopped.
   */
  call<T = unknown>(service: string, method: string, ...args: unknown[]): Promise<T>;
  /** Like `call`, but rejects with a CoreTimeoutError when no answer arrives within `timeoutMs`. */
  callWithin<T = unknown>(
    timeoutMs: number,
    service: string,
    method: string,
    ...args: unknown[]
  ): Promise<T>;
  /** Wails' OnStartup / OnDomReady / OnShutdown. */
  start(): Promise<void>;
  domReady(): void;
  shutdown(): Promise<void>;
  /** Removes a folder of the core's file system and the databases stored under it. */
  wipe(prefix: string): Promise<void>;
  /** Subscribes to a Go → TypeScript event; returns the unsubscribe function. */
  on(name: string, cb: (payload: unknown) => void): () => void;
  /** Drops every subscription to an event (Wails' EventsOff). */
  off(name: string): void;
  terminate(): void;
}

/**
 * The worker that runs the core; the build bundles it separately and records its URL and SHA-384
 * (scripts/esbuild.mjs). It holds the vault keys, so its script is checked like the page's own.
 */
export const createCoreWorker = (): Worker =>
  new VerifiedWorker(__MEMOBRAIN_WORKER__, __MEMOBRAIN_WORKER_INTEGRITY__, {
    type: 'module',
    name: 'memobrain-core',
  }) as unknown as Worker;

/** What VerifiedWorker needs from the browser (replaced in tests). */
export interface VerifiedWorkerDeps {
  fetch(url: string, init: RequestInit): Promise<Response>;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
  createWorker(url: string, options: WorkerOptions): Worker;
}

const browserDeps = (): VerifiedWorkerDeps => ({
  fetch: (url, init) => fetch(url, init),
  createObjectURL: (blob) => URL.createObjectURL(blob),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
  createWorker: (url, options) => new Worker(url, options),
});

/**
 * A worker whose script passes Subresource Integrity before it runs. `new Worker(url)` takes no
 * integrity, so the script is fetched with it (the expected hash comes from the page bundle, itself
 * loaded with SRI) and the worker starts from a blob: URL of the checked bytes; the workbench policy
 * allows `worker-src blob:` for this. The script must be self-contained (a blob: module cannot resolve
 * relative imports) and resolve what it fetches against `location.origin` (worker.ts does).
 *
 * It behaves like a Worker for what the bridge and the tests use: messages posted before the worker
 * exists are queued, the real worker's events are re-dispatched here (`onmessage`, `onerror`,
 * `dispatchEvent`), and a failed check surfaces as an `error` event: the core never starts.
 */
export class VerifiedWorker extends EventTarget {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  private worker: Worker | null = null;
  private queue: [unknown, Transferable[]][] = [];
  private terminated = false;
  private blobURL = '';

  constructor(
    url: string,
    integrity: string,
    options: WorkerOptions,
    private readonly deps: VerifiedWorkerDeps = browserDeps(),
  ) {
    super();
    this.addEventListener('message', (e) => this.onmessage?.(e as MessageEvent));
    this.addEventListener('error', (e) => this.onerror?.(e as ErrorEvent));
    this.boot(url, integrity, options).catch((e: unknown) => {
      this.fail(`cannot load ${url}: ${e instanceof Error ? e.message : String(e)}`);
    });
  }

  private async boot(url: string, integrity: string, options: WorkerOptions): Promise<void> {
    // Only E2E builds may start an unpinned script; production builds always embed the hash.
    if (!integrity && !import.meta.env.MEMOBRAIN_E2E) throw new Error('no integrity to check');
    if (!integrity) return this.started(this.deps.createWorker(url, options));
    const res = await this.deps.fetch(url, { integrity, credentials: 'same-origin' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = new Blob([await res.arrayBuffer()], { type: 'text/javascript' });
    if (this.terminated) return;
    this.blobURL = this.deps.createObjectURL(blob);
    this.started(this.deps.createWorker(this.blobURL, options));
  }

  private started(worker: Worker): void {
    this.worker = worker;
    worker.onmessage = (e: MessageEvent) => {
      this.revoke();
      this.dispatchEvent(new MessageEvent('message', { data: e.data as unknown }));
    };
    worker.onerror = (e: ErrorEvent) => {
      this.revoke();
      e.preventDefault();
      this.fail(e.message || 'unknown error');
    };
    for (const [m, transfer] of this.queue) worker.postMessage(m, transfer);
    this.queue = [];
  }

  /** The worker read its script (it answered or failed): the blob: URL is no longer needed. */
  private revoke(): void {
    if (!this.blobURL) return;
    this.deps.revokeObjectURL(this.blobURL);
    this.blobURL = '';
  }

  private fail(message: string): void {
    if (this.terminated) return;
    this.dispatchEvent(new ErrorEvent('error', { message }));
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    if (this.worker) this.worker.postMessage(message, transfer);
    else this.queue.push([message, transfer]);
  }

  terminate(): void {
    this.terminated = true;
    this.queue = [];
    this.worker?.terminate();
    this.revoke();
  }
}

/** Starts the worker and resolves when the core answers its first call. */
export function startCore(options: CoreOptions): Promise<CoreHandle> {
  const worker = (options.createWorker ?? createCoreWorker)();
  const send = (m: ToWorker, transfer: Transferable[] = []): void =>
    worker.postMessage(m, transfer);

  let next = 1;
  const pending = new Map<number, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();

  let deadReason: string | null = null;

  const request = (
    build: (id: number) => ToWorker,
    timeout?: () => Error,
    ms = 0,
  ): Promise<string> =>
    new Promise((resolve, reject) => {
      if (deadReason !== null) return reject(new CoreDeadError(deadReason));
      const id = next++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        clearTimeout(timer);
        pending.delete(id);
      };
      pending.set(id, {
        resolve: (v) => (done(), resolve(v)),
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- an Error, or Wails' text
        reject: (e) => (done(), reject(e)),
      });
      // A late answer finds no entry and is dropped.
      if (timeout && ms > 0) timer = setTimeout(() => (done(), reject(timeout())), ms);
      send(build(id));
    });

  /** The core is gone: fail what is waiting and everything that comes after. */
  const die = (reason: string): void => {
    if (deadReason !== null) return;
    deadReason = reason;
    const waiting = [...pending.values()];
    pending.clear();
    for (const p of waiting) p.reject(new CoreDeadError(reason));
  };

  const callText = (service: string, method: string, args: unknown[], ms = 0): Promise<string> =>
    request(
      (id) => ({ type: 'call', id, service, method, args: JSON.stringify(args) }),
      () => new CoreTimeoutError(service, method, ms),
      ms,
    ).catch((e: unknown) => {
      if (e instanceof CoreDeadError || e instanceof CoreTimeoutError) throw e;
      // Like Wails, the rejection is the message text: the UI is written for that.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw e instanceof Error ? e.message : String(e);
    });
  const parse = <T>(text: string): T => (text === '' ? null : JSON.parse(text)) as T;

  return new Promise<CoreHandle>((resolveReady, rejectReady) => {
    let methods: Record<string, string[]> = {};
    let settled = false;

    const handle: CoreHandle = {
      get methods() {
        return methods;
      },
      get dead() {
        return deadReason !== null;
      },
      async call<T>(service: string, method: string, ...args: unknown[]): Promise<T> {
        return parse<T>(await callText(service, method, args));
      },
      async callWithin<T>(
        timeoutMs: number,
        service: string,
        method: string,
        ...args: unknown[]
      ): Promise<T> {
        return parse<T>(await callText(service, method, args, timeoutMs));
      },
      async start() {
        await request((id) => ({ type: 'start', id }));
      },
      domReady() {
        if (deadReason === null) send({ type: 'domReady' });
      },
      async shutdown() {
        await request((id) => ({ type: 'shutdown', id }));
      },
      async wipe(prefix) {
        await request((id) => ({ type: 'wipe', id, prefix }));
      },
      on(name, cb) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)?.add(cb);
        return () => listeners.get(name)?.delete(cb);
      },
      off(name) {
        listeners.delete(name);
      },
      terminate() {
        worker.terminate();
        die('terminated');
      },
    };

    const fatal = (message: string): void => {
      const first = deadReason === null;
      die(message);
      if (!settled) rejectReady(new Error(message));
      if (first) options.onFatal?.(message);
    };

    worker.onerror = (e) => {
      fatal(`the core worker failed: ${e.message || 'unknown error'}`);
    };

    worker.onmessage = (ev: MessageEvent<FromWorker>) => {
      const m = ev.data;
      switch (m.type) {
        case 'ready':
          methods = m.methods;
          settled = true;
          resolveReady(handle);
          return;
        case 'fatal':
          fatal(m.error);
          return;
        case 'result': {
          const p = pending.get(m.id);
          if (!p) return;
          if (m.error !== undefined) p.reject(new Error(m.error));
          else p.resolve(m.result ?? 'null');
          return;
        }
        case 'event': {
          const set = listeners.get(m.name);
          if (!set || set.size === 0) return;
          let payload: unknown;
          try {
            payload = m.payload === '' ? undefined : JSON.parse(m.payload);
          } catch {
            payload = m.payload;
          }
          for (const cb of [...set]) cb(payload);
          return;
        }
        case 'download':
          saveDownload(m.name, m.bytes);
          return;
        case 'host':
          void answerHost(m.request).then(
            (r) => send({ type: 'host-result', id: m.id, ...r.reply }, r.transfer),
            (e: unknown) =>
              send({
                type: 'host-result',
                id: m.id,
                error: e instanceof Error ? e.message : String(e),
              }),
          );
          return;
      }
    };

    async function answerHost(req: HostRequest): Promise<{
      reply: { value?: unknown; file?: { name: string; bytes: ArrayBuffer } };
      transfer: Transferable[];
    }> {
      switch (req.op) {
        case 'token':
          return { reply: { value: await options.getToken() }, transfer: [] };
        case 'openURL':
          window.open(req.url, '_blank', 'noopener,noreferrer');
          return { reply: {}, transfer: [] };
        case 'print':
          window.print();
          return { reply: {}, transfer: [] };
        case 'quit':
          options.onQuit?.();
          return { reply: {}, transfer: [] };
        case 'error':
          console.error(`${req.title}: ${req.message}`);
          return { reply: {}, transfer: [] };
        case 'pickFile': {
          const file = await pickFile(req.patterns);
          return file ? { reply: { file }, transfer: [file.bytes] } : { reply: {}, transfer: [] };
        }
      }
    }

    send({ type: 'init', assets: options.assets, config: options.config });
  });
}

/** Turns "*.md;*.txt" patterns of a Wails dialog into the `accept` list of a file input. */
export function acceptOf(patterns: string[]): string {
  return patterns
    .flatMap((p) => p.split(';'))
    .map((p) => p.trim().replace(/^\*/, ''))
    .filter((p) => p.startsWith('.'))
    .join(',');
}

/** Shows the browser's file picker; resolves to the chosen file's bytes, or null when cancelled. */
function pickFile(patterns: string[]): Promise<{ name: string; bytes: ArrayBuffer } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    const accept = acceptOf(patterns);
    if (accept) input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      void f.arrayBuffer().then((bytes) => resolve({ name: f.name, bytes }));
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}

/** Starts a browser download of bytes the core produced (an export, a ZIP of the vault). */
export function saveDownload(name: string, bytes: ArrayBuffer): void {
  downloadBlob(new Blob([bytes]), name);
}

/**
 * Installs what the generated Wails modules (wailsjs/go/app/*, wailsjs/runtime) call: `window.go.app`
 * with one function per method the core reports, and the parts of `window.runtime` the UI uses.
 */
export function installWailsGlobals(core: CoreHandle, target: Window = window): void {
  const app: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const [service, names] of Object.entries(core.methods)) {
    app[service] = {};
    for (const method of names)
      app[service][method] = (...args) => core.call(service, method, ...args);
  }
  const w = target as unknown as Record<string, unknown>;
  w['go'] = { app };
  w['runtime'] = {
    EventsOnMultiple: (name: string, cb: (...data: unknown[]) => void, max: number) => {
      let left = max > 0 ? max : Infinity;
      const off = core.on(name, (payload) => {
        if (--left <= 0) off();
        cb(payload);
      });
      return off;
    },
    EventsOff: (...names: string[]) => names.forEach((n) => core.off(n)),
    EventsEmit: () => undefined,
    BrowserOpenURL: (url: string) => void window.open(url, '_blank', 'noopener,noreferrer'),
    WindowShow: () => undefined,
  };
}

export type { AssetRef };
