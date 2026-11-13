//go:build js

package main

import (
	"encoding/json"
	"strings"
	"syscall/js"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/app"
)

// await waits for a JavaScript promise from a Go test.
func await(t *testing.T, p js.Value) (js.Value, error) {
	t.Helper()
	type outcome struct {
		val js.Value
		err error
	}
	ch := make(chan outcome, 1)
	ok := js.FuncOf(func(_ js.Value, args []js.Value) any { ch <- outcome{val: args[0]}; return nil })
	fail := js.FuncOf(func(_ js.Value, args []js.Value) any {
		ch <- outcome{err: jsError(args[0].Get("message").String())}
		return nil
	})
	defer ok.Release()
	defer fail.Release()
	p.Call("then", ok, fail)
	select {
	case o := <-ch:
		return o.val, o.err
	case <-time.After(30 * time.Second):
		t.Fatal("the promise never settled")
		return js.Value{}, nil
	}
}

type jsError string

func (e jsError) Error() string { return string(e) }

func TestCoreAnswersBindingCallsThroughThePage(t *testing.T) {
	events := js.Global().Get("Array").New()
	host := js.Global().Get("Object").New()
	host.Set("emit", js.FuncOf(func(_ js.Value, args []js.Value) any { events.Call("push", args[0]); return nil }))
	js.Global().Set("__claraeHost", host)
	defer js.Global().Delete("__claraeHost")

	a := app.New(app.Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Version: "9.9.9"})
	d, err := newDispatcher(a)
	if err != nil {
		t.Fatal(err)
	}
	install(a, d)
	core := js.Global().Get(coreName)
	defer js.Global().Delete(coreName)

	if _, err := await(t, core.Call("start")); err != nil {
		t.Fatalf("start: %v", err)
	}
	core.Call("domReady")

	// A call is JSON in, JSON out.
	res, err := await(t, core.Call("call", "SettingsAPI", "Info", "[]"))
	if err != nil {
		t.Fatal(err)
	}
	var info map[string]string
	if err := json.Unmarshal([]byte(res.String()), &info); err != nil {
		t.Fatalf("Info returned %q: %v", res.String(), err)
	}
	if info["platform"] != "web" || info["version"] != "9.9.9" {
		t.Fatalf("Info = %v", info)
	}

	// Errors reject the promise with the binding's message.
	if _, err := await(t, core.Call("call", "VaultAPI", "NoSuchMethod", "[]")); err == nil || !strings.Contains(err.Error(), "unknown method") {
		t.Fatalf("an unknown method must reject, got %v", err)
	}
	if _, err := await(t, core.Call("call", "VaultAPI", "ReadNote", `["unknown-vault","a.md"]`)); err == nil {
		t.Fatal("reading from a vault that is not open must reject")
	}

	// The page can list what the core exposes.
	var methods map[string][]string
	if err := json.Unmarshal([]byte(core.Call("methods").String()), &methods); err != nil {
		t.Fatal(err)
	}
	if len(methods) != len(a.Services()) || len(methods["VaultAPI"]) == 0 {
		t.Fatalf("methods() = %d services", len(methods))
	}

	if _, err := await(t, core.Call("shutdown")); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}
