// The desktop host of the workbench on Wails v3 (ADR-0051, B-D1). The UI was written against the
// Wails v2 globals: `window.go.app.<Service>.<Method>` (the generated modules of wailsjs/go) and
// `window.runtime` (wailsjs/runtime). v3 has neither, so this shim installs them on top of
// `@wailsio/runtime`, the twin of installWailsGlobals in web/src/workbench/bridge.ts, which installs
// the same two objects on top of the Go core compiled to WebAssembly. packages/workbench, the mock of
// the e2e tests and the bridge to the core stay as they are.
//
// Every binding goes through the one Wails service of the desktop, CoreBridge (apps/desktop/
// bridge.go): `Call(service, method, args)` runs it in the same dispatcher the WebAssembly core uses,
// and `Methods()` says what exists, so a new Go service needs no change here.
//
// A call whose arguments are larger than the HTTP transport of Wails takes (64 MiB per request: the
// export of a note as HTML goes up to 256 MiB) does not go through `Call`: its arguments are sent in
// chunks to the asset server, to /memobrain/upload/<id> (same origin, so the CSP is unchanged), and
// the core then runs the call on them (B-W4b, ADR-0051; shell.UploadStore on the Go side). The
// signature a binding has for the workbench does not change.
//
// The runtime is loaded with a dynamic import: it is not part of the initial bundle (ADR-0020 counts
// the entry and its static imports; v2 injected its runtime outside the budget as well).
import { Events } from '@memobrain/workbench/events';
import type * as WailsRuntimeModule from '@wailsio/runtime';

// `package.struct.method` of the Go service (key of Wails v3's binding table, see CoreBridge).
const CORE_CALL = 'main.CoreBridge.Call';
const CORE_METHODS = 'main.CoreBridge.Methods';
const CORE_DOM_READY = 'main.CoreBridge.DomReady';
const CORE_BEGIN_UPLOAD = 'main.CoreBridge.BeginUpload';
const CORE_ABORT_UPLOAD = 'main.CoreBridge.AbortUpload';
const CORE_CALL_UPLOADED = 'main.CoreBridge.CallUploaded';

/** Where the chunks of an upload go (shell.UploadPath). */
export const UPLOAD_PATH = '/memobrain/upload/';
/**
 * Arguments of more than this many bytes of JSON go through an upload. The transport of Wails takes
 * 64 MiB per request; half of that leaves room for the envelope and for the day it counts differently.
 */
export const UPLOAD_THRESHOLD = 32 * 1024 * 1024;
/** The size of a chunk, as the runtime's own: WebView2 delivers about 2 MiB of a request body at most. */
export const UPLOAD_CHUNK = 512 * 1024;
/**
 * A call is measured only when its strings have this many UTF-16 units: even at six bytes a unit
 * (a control character escaped as \u00XX) that is 24 MiB, below UPLOAD_THRESHOLD, so a smaller one
 * is never worth serialising to find out.
 */
const MEASURE_ABOVE_UNITS = 4 * 1024 * 1024;

/** The part of @wailsio/runtime the shim uses (the module satisfies it; the tests fake it). */
export interface WailsRuntime {
  Call: { ByName(name: string, ...args: unknown[]): Promise<unknown> };
  Events: {
    On(name: string, cb: (event: { data: unknown }) => void): () => void;
    Off(...names: string[]): void;
    Emit(name: string, data?: unknown): Promise<unknown>;
  };
  Browser: { OpenURL(url: string): Promise<void> };
  Application: { Quit(): Promise<void> };
  Window: {
    Show(): Promise<void>;
    Fullscreen(): Promise<void>;
    UnFullscreen(): Promise<void>;
    IsFullscreen(): Promise<boolean>;
  };
}

// Compile-time check that the real module has the shape above (it is not a value: no code is emitted).
export type RuntimeModuleFits = typeof WailsRuntimeModule extends WailsRuntime ? true : never;
const fits: RuntimeModuleFits = true;
void fits;

export interface InstallOptions {
  /** The runtime; by default @wailsio/runtime, loaded on demand. */
  runtime?: WailsRuntime;
  /** What sends the chunks of an upload; by default the fetch of the target window. */
  fetch?: typeof fetch;
  /** Where `go` and `runtime` are installed and the drop guard listens (the page's window). */
  target?: Window;
}

/** The text of a failed call: v2 rejected with the message string, and the UI reads the code from it. */
const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);

/** A failed fire-and-forget call of the window or the browser: nothing to show, but not lost. */
const report =
  (what: string) =>
  (e: unknown): void => {
    console.error(`memobrain: ${what} failed: ${messageOf(e)}`);
  };

/**
 * Whether the strings of value (at any depth) add up to more than limit UTF-16 units; it stops
 * counting as soon as they do, so a huge value costs no more than its first limit units.
 */
function stringsExceed(value: unknown, limit: number): boolean {
  let left = limit;
  const walk = (v: unknown): boolean => {
    if (typeof v === 'string') {
      left -= v.length;
    } else if (Array.isArray(v)) {
      for (const item of v) if (walk(item)) return true;
    } else if (v !== null && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) {
        left -= key.length;
        if (walk(item)) return true;
      }
    }
    return left < 0;
  };
  return walk(value);
}

/** The JSON of the arguments as the UTF-8 bytes the core receives (the string is gone when this returns). */
const encodeArgs = (args: unknown[]): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(JSON.stringify(args));

/**
 * Wails v2 let a file dragged over the page act as a drop target (dropEffect "copy", default
 * prevented): the editor and Excalidraw read the files of the drop themselves. The v3 runtime
 * listens on `documentElement` and, with file drop disabled (EnableFileDrop is false: the native
 * drop view of macOS would keep the files from the DOM), sets dropEffect to "none" after the
 * handlers of the page. A listener on `window` (bubble, so it runs after the runtime's) restores
 * v2's behavior; it never stops the propagation, the page handlers have already run by then. A
 * file dropped outside any target is prevented too, so the window never navigates to it.
 */
export function installDropGuard(target: Window = window): () => void {
  const hasFiles = (e: DragEvent): boolean =>
    e.dataTransfer !== null && Array.from(e.dataTransfer.types).includes('Files');
  const over = (e: DragEvent): void => {
    if (!hasFiles(e) || !e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const drop = (e: DragEvent): void => {
    if (hasFiles(e)) e.preventDefault();
  };
  target.addEventListener('dragenter', over);
  target.addEventListener('dragover', over);
  target.addEventListener('drop', drop);
  return () => {
    target.removeEventListener('dragenter', over);
    target.removeEventListener('dragover', over);
    target.removeEventListener('drop', drop);
  };
}

/**
 * Installs `window.go.app` and `window.runtime` on the Wails v3 runtime and the drop guard; resolves
 * when they are ready (the workbench may mount). Returns the function that takes the guard away.
 * Rejects when the runtime or the bridge cannot be reached: without them there is no backend.
 */
export async function installWailsHost(options: InstallOptions = {}): Promise<() => void> {
  const target = options.target ?? window;
  const rt: WailsRuntime = options.runtime ?? (await import('@wailsio/runtime'));

  const methods = (await rt.Call.ByName(CORE_METHODS)) as Record<string, string[]> | null;
  if (!methods || typeof methods !== 'object') throw new Error('the core reports no services');

  const send: typeof fetch = options.fetch ?? ((input, init) => target.fetch(input, init));

  /**
   * The id of an upload of the arguments, or null when they fit the transport of Wails. The bytes
   * live only in here: they are free for the garbage collector while the core runs the call.
   */
  const uploadArgs = async (args: unknown[]): Promise<string | null> => {
    if (!stringsExceed(args, MEASURE_ABOVE_UNITS)) return null;
    const body = encodeArgs(args);
    if (body.length <= UPLOAD_THRESHOLD) return null;
    const id = (await rt.Call.ByName(CORE_BEGIN_UPLOAD, body.length)) as string;
    try {
      // In order, one chunk at a time (the core takes them at the offset where it stands). The body
      // is a Uint8Array, as the runtime's own chunks: WebKitGTK cannot read a Blob body of a request
      // to a custom scheme.
      for (let offset = 0; offset < body.length; offset += UPLOAD_CHUNK) {
        const res = await send(`${UPLOAD_PATH}${id}?offset=${offset}`, {
          method: 'POST',
          body: body.subarray(offset, offset + UPLOAD_CHUNK),
        });
        if (!res.ok)
          throw new Error(`upload: ${(await res.text()) || res.statusText} (HTTP ${res.status})`);
      }
    } catch (e) {
      // Free the memory the core reserved now rather than when the upload expires.
      rt.Call.ByName(CORE_ABORT_UPLOAD, id).catch(() => undefined);
      throw e;
    }
    return id;
  };

  const callCore = async (service: string, method: string, args: unknown[]): Promise<unknown> => {
    const id = await uploadArgs(args);
    if (id !== null) return rt.Call.ByName(CORE_CALL_UPLOADED, service, method, id);
    // The arguments go as the JSON array the dispatcher takes; the result is parsed JSON.
    return rt.Call.ByName(CORE_CALL, service, method, args);
  };

  const app: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
  for (const [service, names] of Object.entries(methods)) {
    const bound: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const method of names) {
      bound[method] = (...args) =>
        callCore(service, method, args).catch((e: unknown) =>
          // A string, not an Error: that is what v2 rejected with and errorCode() reads.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          Promise.reject(messageOf(e)),
        );
    }
    app[service] = bound;
  }

  // The frontend is ready when the workbench first listens for memobrain:// links (App.tsx): until
  // then the core keeps them. A page reload starts over with a new shim, which tells the core again
  // (harmless for it); within a page the signal goes once, and again only if it failed.
  let readySent = false;
  const signalReady = (): void => {
    if (readySent) return;
    readySent = true;
    rt.Call.ByName(CORE_DOM_READY).catch((e: unknown) => {
      readySent = false;
      report('the ready signal')(e);
    });
  };

  const w = target as unknown as Record<string, unknown>;
  w['go'] = { app };
  w['runtime'] = {
    EventsOnMultiple: (name: string, cb: (...data: unknown[]) => void, max: number) => {
      let left = max > 0 ? max : Infinity;
      const off = rt.Events.On(name, (event) => {
        if (--left <= 0) off();
        cb(event.data);
      });
      if (name === Events.appOpenRequest) signalReady();
      return off;
    },
    EventsOff: (...names: string[]) => rt.Events.Off(...names),
    EventsEmit: (name: string, ...data: unknown[]) => {
      rt.Events.Emit(name, data[0]).catch(report('EventsEmit'));
    },
    BrowserOpenURL: (url: string) => {
      rt.Browser.OpenURL(url).catch(report('BrowserOpenURL'));
    },
    WindowShow: () => {
      rt.Window.Show().catch(report('WindowShow'));
    },
    Quit: () => {
      rt.Application.Quit().catch(report('Quit'));
    },
    WindowFullscreen: () => {
      rt.Window.Fullscreen().catch(report('WindowFullscreen'));
    },
    WindowUnfullscreen: () => {
      rt.Window.UnFullscreen().catch(report('WindowUnfullscreen'));
    },
    WindowIsFullscreen: () => rt.Window.IsFullscreen(),
  };

  return installDropGuard(target);
}
