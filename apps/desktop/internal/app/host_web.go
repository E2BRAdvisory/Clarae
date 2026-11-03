//go:build js

package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall/js"
	"time"

	"memobrain/apps/desktop/internal/auth"
)

// hostName is the JavaScript object the page installs for the Go core (web/src/workbench).
const hostName = "__memobrainHost"

// isWeb tells the browser build from the desktop one: there is no file watcher (vault.FS.SetOnChange
// reports the core's own writes), no updater and no OS trash.
const isWeb = true

// defaultHost talks to the page hosting the Go core.
func defaultHost() Host { return webHost{} }

// systemTrash is not available: a browser has no OS trash (VaultAPI.Trash uses the vault's .trash/).
// Capability: osTrash (capabilities.go).
func systemTrash(string) error { return errors.New("the system trash is not available in the browser") }

// webHost implements Host in the browser. Every method forwards to a function of the page; the
// ones that wait for the user (file picker) return a promise, awaited here without blocking the
// JavaScript event loop (callers run in their own goroutine).
type webHost struct{}

// hostTokenTimeout bounds the wait for an access token from the page when the caller's context
// has no earlier deadline: a page whose token refresh hangs must not hold every sync call forever.
const hostTokenTimeout = 30 * time.Second

// Session lets the page own the sign-in: tokens come from the page, and the server is the origin
// that served it (the page can override it with serverURL).
func (h webHost) Session() *auth.Hosted {
	server := ""
	if o := js.Global().Get("location"); o.Type() == js.TypeObject {
		server = o.Get("origin").String()
	}
	if host := js.Global().Get(hostName); host.Type() == js.TypeObject && host.Get("serverURL").Type() == js.TypeString {
		server = host.Get("serverURL").String()
	}
	hosted := &auth.Hosted{ServerURL: server, Token: func(ctx context.Context) (string, error) {
		ctx, cancel := context.WithTimeout(ctx, hostTokenTimeout)
		defer cancel()
		res, err := h.call("token")
		if err != nil {
			return "", err
		}
		v, err := await(ctx, res)
		if err != nil {
			return "", err
		}
		return v.String(), nil
	}}
	return hosted.WithDevice(webDevice{h})
}

// webDevice keeps the browser's device registration with the page (IndexedDB), outside the data
// directory that signing out and "forget this browser" wipe: the browser stays one device.
type webDevice struct{ h webHost }

func (d webDevice) available(method string) bool {
	host := js.Global().Get(hostName)
	return host.Type() == js.TypeObject && host.Get(method).Type() == js.TypeFunction
}

func (d webDevice) LoadDevice(ctx context.Context, serverURL string) (string, string, error) {
	if !d.available("loadDevice") {
		return "", "", nil // an older page: one registration per data directory, as before
	}
	res, err := d.h.call("loadDevice", serverURL)
	if err != nil {
		return "", "", err
	}
	v, err := await(ctx, res)
	if err != nil || v.Type() != js.TypeObject {
		return "", "", err
	}
	id, user := v.Get("deviceId"), v.Get("userId")
	if id.Type() != js.TypeString || user.Type() != js.TypeString {
		return "", "", nil
	}
	return id.String(), user.String(), nil
}

func (d webDevice) SaveDevice(ctx context.Context, serverURL, deviceID, userID string) error {
	if !d.available("saveDevice") {
		return nil
	}
	res, err := d.h.call("saveDevice", serverURL, deviceID, userID)
	if err != nil {
		return err
	}
	_, err = await(ctx, res)
	return err
}

func (webHost) call(method string, args ...any) (js.Value, error) {
	h := js.Global().Get(hostName)
	if h.IsUndefined() || h.IsNull() || h.Get(method).Type() != js.TypeFunction {
		return js.Value{}, fmt.Errorf("host.%s is not available in this browser build", method)
	}
	return jsCall(h, method, args...)
}

// jsCall calls a method, turning a JavaScript exception into an error.
func jsCall(obj js.Value, method string, args ...any) (res js.Value, err error) {
	defer func() {
		if r := recover(); r != nil {
			if e, ok := r.(error); ok {
				err = e
			} else {
				err = fmt.Errorf("%v", r)
			}
		}
	}()
	return obj.Call(method, args...), nil
}

// await waits for a promise (or returns a plain value as is) until it settles or ctx ends. The
// callbacks handed to the promise release themselves when it settles, also after the wait was
// given up: releasing them earlier would crash the runtime when the late result arrives. A
// promise that never settles therefore keeps its two callbacks for the rest of the session.
func await(ctx context.Context, v js.Value) (js.Value, error) {
	if v.Type() != js.TypeObject || v.Get("then").Type() != js.TypeFunction {
		return v, nil
	}
	if err := ctx.Err(); err != nil {
		return js.Value{}, err
	}
	type outcome struct {
		val js.Value
		err error
	}
	ch := make(chan outcome, 1) // buffered: a callback never blocks on a waiter that left
	var ok, fail js.Func
	release := func() {
		ok.Release()
		fail.Release()
	}
	ok = js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer release()
		o := outcome{}
		if len(args) > 0 {
			o.val = args[0]
		}
		ch <- o
		return nil
	})
	fail = js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer release()
		ch <- outcome{err: errors.New(rejectionMessage(args))}
		return nil
	})
	if _, err := jsCall(v, "then", ok, fail); err != nil {
		release()
		return js.Value{}, err
	}
	select {
	case o := <-ch:
		return o.val, o.err
	case <-ctx.Done():
		return js.Value{}, ctx.Err()
	}
}

// rejectionMessage describes the reason of a rejected promise: an Error, a plain value or nothing.
func rejectionMessage(args []js.Value) string {
	if len(args) == 0 {
		return "rejected"
	}
	switch reason := args[0]; reason.Type() {
	case js.TypeUndefined, js.TypeNull:
		return "rejected"
	case js.TypeObject, js.TypeFunction:
		if m := reason.Get("message"); m.Type() == js.TypeString && m.String() != "" {
			return m.String()
		}
		return "rejected"
	default:
		return reason.String()
	}
}

func (h webHost) Emit(_ context.Context, name string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = h.call("emit", name, string(data))
}

// SaveFile hands out a path in the scratch area of the core's file system; Delivered turns the
// finished file into a download.
func (webHost) SaveFile(_ context.Context, d SaveDialog) (string, error) {
	dir := filepath.Join(os.TempDir(), "memobrain-downloads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := filepath.Base(d.DefaultFilename)
	if name == "." || name == string(filepath.Separator) {
		name = "export"
	}
	return filepath.Join(dir, name), nil
}

func (h webHost) Delivered(ctx context.Context, path string) {
	if res, err := h.call("deliver", path); err == nil {
		_, _ = await(ctx, res)
	}
}

// OpenFile lets the page show its file picker; the page copies the chosen file into the scratch
// area and answers with its path.
func (h webHost) OpenFile(ctx context.Context, d OpenDialog) (string, error) {
	pats := make([]any, 0, len(d.Filters))
	for _, f := range d.Filters {
		pats = append(pats, f.Pattern)
	}
	res, err := h.call("pickFile", d.Title, pats)
	if err != nil {
		return "", err
	}
	v, err := await(ctx, res)
	if err != nil || v.IsUndefined() || v.IsNull() {
		return "", err
	}
	return v.String(), nil
}

// OpenDirectory is not offered: in the browser vaults live in the cloud, not in a local folder.
// Capability: localFolders (HostMethodCapability).
func (webHost) OpenDirectory(context.Context, OpenDialog) (string, error) {
	return "", errors.New("opening a local folder is not available in the browser")
}

// OpenPath is not offered: the page offers to download the file instead (VaultAPI.DownloadFile).
// Capability: openWithSystemApp (HostMethodCapability).
func (webHost) OpenPath(context.Context, string) error {
	return errors.New("opening a file with a system application is not available in the browser")
}

// RevealPath is not offered: a browser has no file manager.
// Capability: openWithSystemApp (HostMethodCapability).
func (webHost) RevealPath(context.Context, string) error {
	return errors.New("showing a file in the file manager is not available in the browser")
}

func (h webHost) OpenURL(_ context.Context, url string) { _, _ = h.call("openURL", url) }
func (h webHost) Print(context.Context)                 { _, _ = h.call("print") }
func (webHost) ShowWindow(context.Context)              {} // capability nativeWindow
func (h webHost) Quit(context.Context)                  { _, _ = h.call("quit") }

func (h webHost) ErrorDialog(_ context.Context, title, message string) {
	_, _ = h.call("error", title, message)
}
