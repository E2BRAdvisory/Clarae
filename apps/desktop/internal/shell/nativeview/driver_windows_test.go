//go:build windows

//nolint:gosec // G103: the tests pass pointers to COM-style functions as integers, as the driver does
package nativeview

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"

	"clarae/apps/desktop/internal/shell/nativeview/webview2"
	"clarae/apps/desktop/internal/webview"
)

// What does not need a window: the switch, the fallback errors and the IUnknown of the handlers. Written on a machine
// that is not Windows and compiled there (go test -c); it has not been run.

func TestDriverIsOnUnlessSwitchedOff(t *testing.T) {
	if !Supported {
		t.Error("Supported is false: this build has a driver, whatever the switch says")
	}
	// No window: no driver, and nothing that needs a window or the runtime is touched.
	if d := New(nil, ""); d != nil {
		t.Error("New returned a driver with no window")
	}
}

// A runtime that lacks an interface the driver needs is a platform that cannot show views, not a failure of one
// view: the Manager turns it into the fallback to the system browser.
func TestAnOldRuntimeIsAPlatformThatCannotShowViews(t *testing.T) {
	err := fmt.Errorf("download handler: %w", errMissing)
	if !errors.Is(err, webview.ErrPlatformUnavailable) {
		t.Errorf("%v is not webview.ErrPlatformUnavailable", err)
	}
	if errors.Is(errors.New("something else"), webview.ErrPlatformUnavailable) {
		t.Error("an unrelated error is taken for it")
	}
	if !strings.Contains(errMissing.Error(), "1.0.2210.55") {
		t.Errorf("the message does not say what to update to: %v", errMissing)
	}
}

type testHandler struct{ comBase }

func newTestHandler(s *handlerSet) (*testHandler, *testHandler) {
	h := &testHandler{}
	return h, hold(s, &h.comBase, h)
}

func TestHandlerIUnknown(t *testing.T) {
	s := &handlerSet{live: map[uintptr]any{}}
	h, obj := newTestHandler(s)
	if len(s.live) != 1 || h.refs.Load() != 1 || obj != h {
		t.Fatalf("hold: %d live, %d refs", len(s.live), h.refs.Load())
	}

	// IUnknown: the same object, one more reference.
	var out uintptr
	if hr := h.QueryInterface(uintptr(unsafe.Pointer(iidIUnknown)), uintptr(unsafe.Pointer(&out))); hr != uintptr(windows.S_OK) {
		t.Fatalf("QueryInterface(IUnknown) = %#x", hr)
	}
	if out != h.self || h.refs.Load() != 2 {
		t.Errorf("QueryInterface(IUnknown): out %#x (self %#x), refs %d", out, h.self, h.refs.Load())
	}

	// Anything else: no interface, and the out pointer is cleared.
	other := webview2.NewGUID("{b96d755e-0319-4e92-a296-23436f46a1fc}")
	out = 42
	hr := h.QueryInterface(uintptr(unsafe.Pointer(other)), uintptr(unsafe.Pointer(&out)))
	if uint32(hr) != uint32(windows.E_NOINTERFACE) || out != 0 || h.refs.Load() != 2 {
		t.Errorf("QueryInterface(other) = %#x, out %#x, refs %d", hr, out, h.refs.Load())
	}
	// No place to put the answer.
	if hr := h.QueryInterface(uintptr(unsafe.Pointer(iidIUnknown)), 0); uint32(hr) != uint32(windows.E_POINTER) {
		t.Errorf("QueryInterface(nil out) = %#x", hr)
	}

	// The object stays registered until the last reference goes.
	if n := h.AddRef(); n != 3 {
		t.Errorf("AddRef = %d", n)
	}
	for _, want := range []uintptr{2, 1} {
		if n := h.Release(); n != want || len(s.live) != 1 {
			t.Fatalf("Release = %d (want %d), %d live", n, want, len(s.live))
		}
	}
	if n := h.Release(); n != 0 || len(s.live) != 0 {
		t.Errorf("the last Release = %d, %d live: the object is still kept", n, len(s.live))
	}
}
