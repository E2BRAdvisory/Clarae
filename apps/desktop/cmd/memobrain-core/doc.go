// Command memobrain-core is the desktop core compiled to WebAssembly for the
// vault workbench of the Web UI (ADR-0029, ADR-0030). It is the same Go code
// that the Wails app binds (internal/app, App.Services()), exposed to
// JavaScript through the dispatcher of internal/rpc instead of the Wails
// bindings. Build it with GOOS=js GOARCH=wasm (task wasm-core); on any other
// platform the binary only prints how to build it (main_other.go).
//
// # Where it runs
//
// The page web/src/workbench/main.tsx starts a module Web Worker
// (web/src/workbench/worker.ts) through the bridge (web/src/workbench/bridge.ts).
// The worker installs a Node-style fs on OPFS (opfs-fs.ts), the SQLite bridge on
// sqlite-wasm (@memobrain/sqlite-bridge, used by internal/sqlitejs), evaluates
// Go's wasm_exec.js and runs this program. The messages between page and worker
// are typed in web/src/workbench/protocol.ts.
//
// # JavaScript globals
//
// The worker and the core meet through four properties of globalThis:
//
//   - __memobrainConfig, set by the worker before the program starts:
//     { dataDir, version, logLevel }. Read once by readConfig in core_js.go;
//     missing fields keep their defaults (dataDir "/memobrain/data", the
//     version stamped with -ldflags, level "info").
//   - __memobrainCoreReady, an optional function set by the worker; the core
//     calls it once __memobrainCore is installed.
//   - __memobrainCore, installed by the core (core_js.go, install), with the
//     methods listed below.
//   - __memobrainHost, installed by the worker for the core's Host
//     (internal/app/host_web.go): emit(name, payloadJSON), token(),
//     openURL(url), print(), quit(), error(title, message),
//     deliver(path) and pickFile(title, patterns). Methods that wait for
//     the user or the page return a promise, which the core awaits from its own
//     goroutine; serverURL, when set, overrides the cloud origin.
//
// The methods of __memobrainCore:
//
//	call(service, method, argsJSON) -> Promise<string>  one binding call
//	start()    -> Promise<void>   Wails' OnStartup (opens app.db, restores the session)
//	domReady() -> void            Wails' OnDomReady (events can be delivered)
//	shutdown() -> Promise<void>   Wails' OnShutdown
//	methods()  -> string          JSON {service: [method, ...]}
//
// # Calls
//
// A binding call names the service struct and the method as Wails does
// (for example "VaultAPI", "OpenVault") and passes the arguments as a JSON
// array; the result is the JSON encoding of the method's first return value
// ("null" for none). The bridge turns the reported methods into
// window.go.app.<Service>.<Method> functions, so the generated Wails modules
// (packages/workbench/wailsjs) run unchanged on top of the core. Events go the
// other way: Host.Emit marshals the payload and calls __memobrainHost.emit,
// the worker posts it to the page and the bridge dispatches it to the
// subscribers of window.runtime.EventsOnMultiple.
//
// Every call runs in its own goroutine: a JavaScript callback must not block
// the event loop, so call, start and shutdown return a Promise settled when
// the goroutine finishes.
//
// # Errors
//
// A method that returns an error rejects the promise with a JavaScript Error
// whose message is err.Error(); an unknown service or method, or arguments
// that do not decode, and a panic inside a method, are errors of the
// dispatcher and are reported the same way. The worker forwards the message,
// and the bridge rejects the caller with the message text, as Wails does, so
// the UI handles both hosts alike. If the
// Go program exits or the worker fails, the worker posts a fatal message and
// the bridge rejects every pending and later call with a CoreDeadError;
// callWithin adds a CoreTimeoutError for a call that does not answer in time.
// A JavaScript exception thrown by a host function becomes a Go error in
// host_web.go.
package main
