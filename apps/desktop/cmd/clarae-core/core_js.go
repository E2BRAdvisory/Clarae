//go:build js

package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"syscall/js"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/app"
	"clarae/apps/desktop/internal/rpc"
	"clarae/apps/desktop/internal/telemetry"
)

const (
	coreName   = "__claraeCore"   // what the page calls
	configName = "__claraeConfig" // what the page sets before starting the core
	readyHook  = "__claraeCoreReady"
)

// Version is stamped at build time (-ldflags "-X main.Version=...").
var Version = "dev"

// config is read from globalThis.__claraeConfig = { dataDir, version, logLevel }.
type config struct {
	dataDir  string
	version  string
	logLevel zerolog.Level
}

func readConfig() config {
	c := config{dataDir: "/clarae/data", version: Version, logLevel: zerolog.InfoLevel}
	cfg := js.Global().Get(configName)
	if cfg.Type() != js.TypeObject {
		return c
	}
	if v := cfg.Get("dataDir"); v.Type() == js.TypeString && v.String() != "" {
		c.dataDir = v.String()
	}
	if v := cfg.Get("version"); v.Type() == js.TypeString && v.String() != "" {
		c.version = v.String()
	}
	if v := cfg.Get("logLevel"); v.Type() == js.TypeString {
		if l, err := zerolog.ParseLevel(strings.ToLower(v.String())); err == nil && l != zerolog.NoLevel {
			c.logLevel = l
		}
	}
	return c
}

// consoleWriter sends each log line to the browser console.
type consoleWriter struct{}

func (consoleWriter) Write(p []byte) (int, error) {
	js.Global().Get("console").Call("log", strings.TrimRight(string(p), "\n"))
	return len(p), nil
}

// newDispatcher exposes every service of the application, exactly as Wails binds them.
func newDispatcher(a *app.App) (*rpc.Dispatcher, error) {
	d := rpc.New()
	for _, s := range a.Services() {
		if err := d.Register(s); err != nil {
			return nil, err
		}
	}
	return d, nil
}

// promise runs fn in its own goroutine (a blocking call inside a JavaScript callback would stall
// the event loop) and settles a Promise with its outcome.
func promise(fn func() (any, error)) js.Value {
	var executor js.Func
	executor = js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer executor.Release()
			res, err := fn()
			if err != nil {
				reject.Invoke(js.Global().Get("Error").New(err.Error()))
				return
			}
			resolve.Invoke(res)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(executor)
}

// install publishes the core's entry points on globalThis.__claraeCore:
//
//	call(service, method, argsJSON) -> Promise<string>   a binding call, JSON in and out
//	start()    -> Promise<void>                          App.Startup (the desktop's Lifecycle.Start): opens app.db, restores the session
//	domReady() -> void                                   App.DomReady (the desktop's "frontend ready"): the page can receive events
//	shutdown() -> Promise<void>                          App.Shutdown (the desktop's Lifecycle.Stop)
//	methods()  -> string                                 JSON {service: [method, ...]}
func install(a *app.App, d *rpc.Dispatcher) {
	ctx, cancel := context.WithCancel(context.Background())
	core := js.Global().Get("Object").New()
	core.Set("call", js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 3 {
			return promise(func() (any, error) { return nil, errors.New("call(service, method, argsJSON) takes three arguments") })
		}
		service, method, argsJSON := args[0].String(), args[1].String(), args[2].String()
		return promise(func() (any, error) {
			out, err := d.Call(service, method, argsJSON)
			if err != nil {
				return nil, err
			}
			return out, nil
		})
	}))
	core.Set("start", js.FuncOf(func(js.Value, []js.Value) any {
		return promise(func() (any, error) { a.Startup(ctx); return js.Undefined(), nil })
	}))
	core.Set("domReady", js.FuncOf(func(js.Value, []js.Value) any { a.DomReady(ctx); return nil }))
	core.Set("shutdown", js.FuncOf(func(js.Value, []js.Value) any {
		return promise(func() (any, error) { a.Shutdown(ctx); cancel(); return js.Undefined(), nil })
	}))
	core.Set("methods", js.FuncOf(func(js.Value, []js.Value) any {
		out, err := json.Marshal(d.Methods())
		if err != nil {
			return "{}"
		}
		return string(out)
	}))
	js.Global().Set(coreName, core)
	if hook := js.Global().Get(readyHook); hook.Type() == js.TypeFunction {
		hook.Invoke()
	}
}

func main() {
	cfg := readConfig()
	logger := zerolog.New(consoleWriter{}).Level(cfg.logLevel).With().Timestamp().Logger()
	telemetry.RouteSlog(logger)
	a := app.New(app.Options{DataDir: cfg.dataDir, Logger: logger, Version: cfg.version})
	d, err := newDispatcher(a)
	if err != nil {
		logger.Fatal().Err(err).Msg("expose the bindings")
	}
	install(a, d)
	select {} // the core answers calls from JavaScript until the worker is terminated
}
