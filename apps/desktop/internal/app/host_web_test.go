//go:build js

package app

import (
	"context"
	"errors"
	"syscall/js"
	"testing"
	"time"
)

// promise returns a JavaScript promise whose executor is exec (nil: a promise that never settles).
func promise(t *testing.T, exec func(resolve, reject js.Value)) js.Value {
	t.Helper()
	f := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if exec != nil {
			exec(args[0], args[1])
		}
		return nil
	})
	t.Cleanup(f.Release)
	return js.Global().Get("Promise").New(f)
}

func TestAwaitHonoursTheContext(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := await(ctx, promise(t, nil))
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("got %v, want the deadline", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("await ignored the context of a promise that never settles")
	}
}

func TestAwaitResultsAndRejections(t *testing.T) {
	ctx := context.Background()
	v, err := await(ctx, promise(t, func(resolve, _ js.Value) { resolve.Invoke("ok") }))
	if err != nil || v.String() != "ok" {
		t.Fatalf("resolved: %v %v", v, err)
	}
	if v, err := await(ctx, js.ValueOf(7)); err != nil || v.Int() != 7 {
		t.Fatalf("plain value: %v %v", v, err)
	}
	errCtor := js.Global().Get("Error")
	for reason, want := range map[string]js.Value{
		"boom":     errCtor.New("boom"),
		"plain":    js.ValueOf("plain"),
		"rejected": js.Undefined(),
	} {
		_, err := await(ctx, promise(t, func(_, reject js.Value) { reject.Invoke(want) }))
		if err == nil || err.Error() != reason {
			t.Errorf("rejection %q: got %v", reason, err)
		}
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := await(cancelled, promise(t, nil)); !errors.Is(err, context.Canceled) {
		t.Fatalf("a cancelled context: %v", err)
	}
}

func TestWebDeviceStopsAtTheDeadline(t *testing.T) {
	host := js.Global().Get("Object").New()
	hang := js.FuncOf(func(js.Value, []js.Value) any { return promise(t, nil) })
	defer hang.Release()
	host.Set("loadDevice", hang)
	host.Set("saveDevice", hang)
	prev := js.Global().Get(hostName)
	js.Global().Set(hostName, host)
	defer js.Global().Set(hostName, prev)

	d := webDevice{}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, _, err := d.LoadDevice(ctx, "https://cloud.test"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("LoadDevice: %v", err)
	}
	if err := d.SaveDevice(ctx, "https://cloud.test", "dev", "user"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("SaveDevice: %v", err)
	}
}
