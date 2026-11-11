package main

import (
	"context"
	"encoding/json"

	"github.com/wailsapp/wails/v3/pkg/application"

	"memobrain/apps/desktop/internal/rpc"
	"memobrain/apps/desktop/internal/shell"
)

// CoreBridge is the one Wails service of the desktop application: the door between the web view
// and the Go core (B-D2, ADR-0051). Wails v3 binds a service per concrete type, while the core has
// twenty (App.Services()) that the browser build already calls through rpc.Dispatcher: the bridge
// puts the same dispatcher in front of them, so the desktop and the WebAssembly core answer a call
// in exactly the same way and a new service needs no change here.
//
// The frontend shim (apps/desktop/frontend/src/wailsHost.ts) reaches it with
//
//	Call.ByName("main.CoreBridge.Call", service, method, args)  // args: JSON array, one per parameter
//	Call.ByName("main.CoreBridge.Methods")                      // {service: [method, ...]}
//	Call.ByName("main.CoreBridge.DomReady")                     // the "frontend ready" signal
//	Call.ByName("main.CoreBridge.BeginUpload", bytes)           // a call too large for the transport:
//	POST /memobrain/upload/<id>?offset=<n>  (chunks)            //   its arguments go in chunks (shell.UploadStore)
//	Call.ByName("main.CoreBridge.CallUploaded", service, method, id)
//
// The key is the package path of the type ("main"), so the type stays in package main.
//
// An error of a binding rejects the promise with its text, "<code>: <text>", untouched (the
// frontend branches on the code); a panic in a binding is an error too (the dispatcher recovers it),
// and Wails recovers any other one in its own call.
type CoreBridge struct {
	d       *rpc.Dispatcher
	lc      *shell.Lifecycle
	uploads *shell.UploadStore
}

// NewCoreBridge puts a dispatcher, and the lifecycle of the core, behind one Wails service.
// uploads holds the arguments of the calls too large for the transport of Wails (see BeginUpload);
// the application serves its chunks through uploads.Middleware().
func NewCoreBridge(d *rpc.Dispatcher, lc *shell.Lifecycle, uploads *shell.UploadStore) *CoreBridge {
	return &CoreBridge{d: d, lc: lc, uploads: uploads}
}

// Call runs service.method with args (a JSON array, as the dispatcher takes it) and returns the
// JSON the binding returns ("null" when it returns nothing).
func (b *CoreBridge) Call(service, method string, args json.RawMessage) (json.RawMessage, error) {
	out, err := b.d.CallBytes(service, method, args)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(out), nil
}

// BeginUpload announces the arguments of a call that are too large for the transport of Wails (its
// HTTP requests are limited to 64 MiB, the export of a note as HTML goes up to 256 MiB): total is
// their size in bytes. The id it returns is where the shim POSTs them in chunks, to
// shell.UploadPath + id; CallUploaded then runs the call on them.
func (b *CoreBridge) BeginUpload(total int64) (string, error) { return b.uploads.Begin(total) }

// AbortUpload drops an upload the shim gave up on (a chunk failed): its memory is freed at once,
// not when it expires.
func (b *CoreBridge) AbortUpload(id string) { b.uploads.Abort(id) }

// CallUploaded is Call on the arguments of an upload, which it consumes (a second call with the
// same id finds nothing). It does not check anything Call does not: the dispatcher is the same.
func (b *CoreBridge) CallUploaded(service, method, uploadID string) (json.RawMessage, error) {
	args, err := b.uploads.Take(uploadID)
	if err != nil {
		return nil, err
	}
	return b.Call(service, method, args)
}

// Methods lists the callable methods of every service: the shim builds window.go.app from it.
func (b *CoreBridge) Methods() map[string][]string { return b.d.Methods() }

// DomReady is the "frontend ready" signal: the shim calls it when the workbench subscribes to
// app:open-request. Until then the memobrain:// URLs wait in the core (App.DomReady delivers them);
// a page reload calls it again, which is harmless.
func (b *CoreBridge) DomReady() { b.lc.DomReady() }

// ServiceStartup starts the core. It never returns an error: a service that fails to start makes
// Run return before the window exists, with nothing on screen; the core shows its failures through
// the host once the platform loop runs.
func (b *CoreBridge) ServiceStartup(context.Context, application.ServiceOptions) error { //nolint:unparam // the signature of application.ServiceStartup
	b.lc.Start()
	return nil
}

// ServiceShutdown stops the core (idempotent, with OnShutdown and the return of Run).
func (b *CoreBridge) ServiceShutdown() error { //nolint:unparam // the signature of application.ServiceShutdown
	b.lc.Stop()
	return nil
}
