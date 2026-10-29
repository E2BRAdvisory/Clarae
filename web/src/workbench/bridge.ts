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

export interface CoreHandle {
  /** The services and methods the core exposes, as reported when it started. */
  readonly methods: Record<string, string[]>;
  /** Calls a binding: JSON arguments in, parsed result out. Rejects with the binding's error message. */
  call<T = unknown>(service: string, method: string, ...args: unknown[]): Promise<T>;
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

/** Starts the worker and resolves when the core answers its first call. */
export function startCore(options: CoreOptions): Promise<CoreHandle> {
  // The build bundles the worker separately and records its URL (scripts/esbuild.mjs).
  const worker = options.createWorker
    ? options.createWorker()
    : new Worker(__MEMOBRAIN_WORKER__, { type: 'module', name: 'memobrain-core' });
  const send = (m: ToWorker, transfer: Transferable[] = []): void =>
    worker.postMessage(m, transfer);

  let next = 1;
  const pending = new Map<number, { resolve: (v: string) => void; reject: (e: unknown) => void }>();
  const listeners = new Map<string, Set<(p: unknown) => void>>();

  const request = (build: (id: number) => ToWorker): Promise<string> =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      send(build(id));
    });

  return new Promise<CoreHandle>((resolveReady, rejectReady) => {
    let methods: Record<string, string[]> = {};
    let settled = false;

    const handle: CoreHandle = {
      get methods() {
        return methods;
      },
      async call<T>(service: string, method: string, ...args: unknown[]): Promise<T> {
        // Like Wails, a rejection carries the message text, not an Error.
        const text = await request((id) => ({
          type: 'call',
          id,
          service,
          method,
          args: JSON.stringify(args),
        })).catch((e: unknown) => {
          // Like Wails, the rejection is the message text: the UI is written for that.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw e instanceof Error ? e.message : String(e);
        });
        return (text === '' ? null : JSON.parse(text)) as T;
      },
      async start() {
        await request((id) => ({ type: 'start', id }));
      },
      domReady() {
        send({ type: 'domReady' });
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
      },
    };

    worker.onerror = (e) => {
      const message = `the core worker failed: ${e.message || 'unknown error'}`;
      if (!settled) rejectReady(new Error(message));
      options.onFatal?.(message);
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
          if (!settled) rejectReady(new Error(m.error));
          options.onFatal?.(m.error);
          return;
        case 'result': {
          const p = pending.get(m.id);
          if (!p) return;
          pending.delete(m.id);
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
  const url = URL.createObjectURL(new Blob([bytes]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
