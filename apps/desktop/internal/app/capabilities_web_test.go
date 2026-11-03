//go:build js

package app

import (
	"context"
	"reflect"
	"syscall/js"
	"testing"
)

// callAll calls every method of v with zero arguments (a live context for a context.Context) and
// returns, by method name, the error it returned (nil for a method that returns no error).
func callAll(t *testing.T, v reflect.Value) map[string]error {
	t.Helper()
	ctxType := reflect.TypeFor[context.Context]()
	errType := reflect.TypeFor[error]()
	out := map[string]error{}
	for i := range v.NumMethod() {
		m := v.Type().Method(i)
		fn := v.Method(i)
		args := make([]reflect.Value, fn.Type().NumIn())
		for j := range args {
			in := fn.Type().In(j)
			if in == ctxType {
				args[j] = reflect.ValueOf(context.Background())
			} else {
				args[j] = reflect.Zero(in)
			}
		}
		var err error
		for _, r := range fn.Call(args) {
			if r.Type() == errType && !r.IsNil() {
				err = r.Interface().(error)
			}
		}
		out[m.Name] = err
	}
	return out
}

// The browser's Host fails only in the methods gated by a capability, and that capability is off in
// the browser (ADR-0045 §1). The page is a stand-in that implements every function the host calls,
// so a failure comes from the core, not from a missing page.
func TestWebHostFailsOnlyWhereItsCapabilityIsOff(t *testing.T) {
	page := js.Global().Get("Object").New()
	noop := js.FuncOf(func(js.Value, []js.Value) any { return nil })
	defer noop.Release()
	for _, f := range []string{"emit", "deliver", "pickFile", "openURL", "print", "quit", "error"} {
		page.Set(f, noop)
	}
	prev := js.Global().Get(hostName)
	js.Global().Set(hostName, page)
	defer js.Global().Set(hostName, prev)

	caps := platformCapabilities()
	var host Host = webHost{}
	for name, err := range callAll(t, reflect.ValueOf(host)) {
		gate := HostMethodCapability[name]
		if err != nil && gate == "" {
			t.Errorf("Host.%s fails in the browser (%v) but no capability gates it in HostMethodCapability", name, err)
		}
		if err != nil && caps.Has(gate) {
			t.Errorf("Host.%s fails in the browser (%v) but its capability %s is true there", name, err, gate)
		}
		if gate != "" && caps.Has(gate) {
			t.Errorf("Host.%s is gated by %s, which is true in the browser", name, gate)
		}
	}
	// OpenDirectory returns an error: it must be the gated failure, not a success.
	if _, err := host.OpenDirectory(context.Background(), OpenDialog{}); err == nil {
		t.Error("Host.OpenDirectory succeeds in the browser: localFolders could be true")
	}
}

// The functions of the core the browser lacks fail there, and their capability is off.
func TestWebCoreFunctionsFailWhereTheirCapabilityIsOff(t *testing.T) {
	caps := platformCapabilities()
	if err := systemTrash("/x"); err == nil || caps.OSTrash {
		t.Errorf("systemTrash: err %v, osTrash %v: it must fail and the capability be off", err, caps.OSTrash)
	}
	for name, err := range callAll(t, reflect.ValueOf(NewUpdaterAPI(nil))) {
		if err == nil {
			t.Errorf("UpdaterAPI.%s succeeds in the browser: is the updater still gated by a capability?", name)
		}
	}
	if caps.Updater {
		t.Error("every UpdaterAPI method fails in the browser, but updater is true")
	}
	if got := (&VaultCryptoAPI{}).DiskEncryption(); got != "unknown" || caps.DiskEncryptionCheck {
		t.Errorf("DiskEncryption = %q, diskEncryptionCheck %v: the browser cannot tell", got, caps.DiskEncryptionCheck)
	}
	// Refused before the app is touched (nil here): keeping a mount's copy as a folder.
	if _, err := NewSharingAPI(nil).RemoveMount("01890a5d-ac96-774b-bcce-b302099a8057", true); err == nil || caps.DetachedCopies {
		t.Errorf("RemoveMount(keepCopy): err %v, detachedCopies %v: it must fail and the capability be off", err, caps.DetachedCopies)
	}
}
