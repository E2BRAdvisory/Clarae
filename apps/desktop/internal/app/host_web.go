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

	"memobrain/apps/desktop/internal/auth"
)

// hostName is the JavaScript object the page installs for the Go core (web/src/workbench).
const hostName = "__memobrainHost"

// isWeb tells the browser build from the desktop one: there is no file watcher (vault.FS.SetOnChange
// reports the core's own writes), no updater and no OS trash.
const isWeb = true

// defaultHost talks to the page hosting the Go core.
func defaultHost() Host { return webHost{} }

// webHost implements Host in the browser. Every method forwards to a function of the page; the
// ones that wait for the user (file picker) return a promise, awaited here without blocking the
// JavaScript event loop (callers run in their own goroutine).
type webHost struct{}

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
	return &auth.Hosted{ServerURL: server, Token: func(ctx context.Context) (string, error) {
		res, err := h.call("token")
		if err != nil {
			return "", err
		}
		v, err := await(res)
		if err != nil {
			return "", err
		}
		return v.String(), nil
	}}
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

// await waits for a promise (or returns a plain value as is).
func await(v js.Value) (js.Value, error) {
	if v.Type() != js.TypeObject || v.Get("then").Type() != js.TypeFunction {
		return v, nil
	}
	type outcome struct {
		val js.Value
		err error
	}
	ch := make(chan outcome, 1)
	ok := js.FuncOf(func(_ js.Value, args []js.Value) any {
		o := outcome{}
		if len(args) > 0 {
			o.val = args[0]
		}
		ch <- o
		return nil
	})
	fail := js.FuncOf(func(_ js.Value, args []js.Value) any {
		msg := "rejected"
		if len(args) > 0 {
			msg = args[0].Get("message").String()
		}
		ch <- outcome{err: errors.New(msg)}
		return nil
	})
	defer ok.Release()
	defer fail.Release()
	v.Call("then", ok, fail)
	o := <-ch
	return o.val, o.err
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

func (h webHost) Delivered(_ context.Context, path string) {
	if res, err := h.call("deliver", path); err == nil {
		_, _ = await(res)
	}
}

// OpenFile lets the page show its file picker; the page copies the chosen file into the scratch
// area and answers with its path.
func (h webHost) OpenFile(_ context.Context, d OpenDialog) (string, error) {
	pats := make([]any, 0, len(d.Filters))
	for _, f := range d.Filters {
		pats = append(pats, f.Pattern)
	}
	res, err := h.call("pickFile", d.Title, pats)
	if err != nil {
		return "", err
	}
	v, err := await(res)
	if err != nil || v.IsUndefined() || v.IsNull() {
		return "", err
	}
	return v.String(), nil
}

// OpenDirectory is not offered: in the browser vaults live in the cloud, not in a local folder.
func (webHost) OpenDirectory(context.Context, OpenDialog) (string, error) {
	return "", errors.New("opening a local folder is not available in the browser")
}

func (h webHost) OpenURL(_ context.Context, url string) { _, _ = h.call("openURL", url) }
func (h webHost) Print(context.Context)                 { _, _ = h.call("print") }
func (webHost) ShowWindow(context.Context)              {}
func (h webHost) Quit(context.Context)                  { _, _ = h.call("quit") }

func (h webHost) ErrorDialog(_ context.Context, title, message string) {
	_, _ = h.call("error", title, message)
}
