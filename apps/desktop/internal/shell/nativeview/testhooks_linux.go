//go:build linux && cgo && gtk3 && !android && !server && !purego && nativeviewtest

package nativeview

/*
#cgo CFLAGS: -DCLARAE_NATIVEVIEW_TEST
#include <stdlib.h>
#include "guest_linux.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"strings"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/webview"
)

// What the live test needs to look inside the guests. It exists only with the build tag nativeviewtest and is
// never part of the application.

// Hooks gives a test the helpers of a driver made by New.
type Hooks struct{ d *driver }

// TestHooks returns the helpers of d, which must be a driver made by New.
func TestHooks(d webview.Driver) *Hooks { return &Hooks{d: d.(*driver)} }

// Frame is the rectangle of a guest in logical pixels, origin top-left of the area of the web view of the
// application, and the size of that area.
type Frame struct {
	X, Y, W, H, CW, CH float64
	Visible, HasFocus  bool
}

// Eval runs the body of an async function in the page of the guest and returns its result (a string as it is,
// anything else as JSON).
func (h *Hooks) Eval(id, js string, timeout time.Duration) (string, error) {
	cid, cjs := C.CString(id), C.CString(js)
	defer C.free(unsafe.Pointer(cid))
	defer C.free(unsafe.Pointer(cjs))
	r, err := h.d.async(func(req C.long) C.int { return C.guestEval(cid, cjs, req) }, "eval", timeout)
	if err != nil {
		return "", err
	}
	if !r.ok {
		return r.msg, errors.New("script: " + r.msg)
	}
	return r.msg, nil
}

// Frame returns where the guest is.
func (h *Hooks) Frame(id string) (Frame, error) {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	var x, y, w, hh, cw, ch C.double
	var vis, focus C.int
	code := application.InvokeSyncWithResult(func() C.int {
		return C.guestFrame(cid, &x, &y, &w, &hh, &cw, &ch, &vis, &focus)
	})
	if err := failure(code, "frame", ""); err != nil {
		return Frame{}, err
	}
	return Frame{float64(x), float64(y), float64(w), float64(hh), float64(cw), float64(ch), vis != 0, focus != 0}, nil
}

// HitTest says what is at a point of the area of the web view of the application: 1 the guest, 2 the web view of
// the application, 0 anything else.
func (h *Hooks) HitTest(id string, x, y float64) int {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	return int(application.InvokeSyncWithResult(func() C.int { return C.guestHitTest(cid, C.double(x), C.double(y)) }))
}

// Count is the number of guests the native side holds.
func (h *Hooks) Count() int {
	return int(application.InvokeSyncWithResult(func() C.int { return C.guestCount() }))
}

// Inspectable says whether the web inspector can attach to the guest.
func (h *Hooks) Inspectable(id string) bool {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	return application.InvokeSyncWithResult(func() C.int { return C.guestInspectable(cid) }) == 1
}

// UserAgent is the user agent of the guest.
func (h *Hooks) UserAgent(id string) string {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	var s string
	application.InvokeSync(func() { s = C.GoString(C.guestUserAgent(cid)) })
	return s
}

// PostKey hands a key (a GDK key value and the modifier bits of GDK) to the guest, as the keyboard does.
func (h *Hooks) PostKey(id string, keyval, state uint) {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	application.InvokeSync(func() { C.guestPostKey(cid, C.uint(keyval), C.uint(state)) })
}

// PostClick sends a click, through the X server, at a point of the area of the web view of the application.
func (h *Hooks) PostClick(x, y float64) {
	application.InvokeSync(func() { C.guestPostPointer(C.double(x), C.double(y), 1) })
	time.Sleep(80 * time.Millisecond)
	application.InvokeSync(func() { C.guestPostPointer(C.double(x), C.double(y), 2) })
}

// Clicks is the number of button presses that reached the guest, and the web view of the application.
func (h *Hooks) Clicks(id string) (guest, app int) {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	application.InvokeSync(func() { guest, app = int(C.guestClicks(cid)), int(C.guestAppClicks()) })
	return guest, app
}

// FocusMain gives the web view of the application the keyboard focus, and AppFocused says whether it has it.
func (h *Hooks) FocusMain() {
	w := h.d.win.NativeWindow()
	application.InvokeSync(func() { C.guestFocusMain(w) })
}

func (h *Hooks) AppFocused() bool {
	w := h.d.win.NativeWindow()
	return application.InvokeSyncWithResult(func() C.int { return C.guestAppFocused(w) }) != 0
}

// GraftInfo describes where the web view of the application is: the types of its ancestors from the window down
// ("GtkApplicationWindow>GtkBox>GtkOverlay>WebKitWebView"), its position among the children of the box and how
// many the box has.
func (h *Hooks) GraftInfo() (path string, position, children int, err error) {
	w := h.d.win.NativeWindow()
	buf := (*C.char)(C.malloc(512))
	defer C.free(unsafe.Pointer(buf))
	var pos, n C.int
	code := application.InvokeSyncWithResult(func() C.int { return C.guestGraftInfo(w, buf, 512, &pos, &n) })
	if err := failure(code, "graft info", ""); err != nil {
		return "", 0, 0, err
	}
	return C.GoString(buf), int(pos), int(n), nil
}

// CreateElsewhere asks the native side for a guest in a window that is not the one of Wails: it must refuse, as a
// platform that cannot show views.
func (h *Hooks) CreateElsewhere() error {
	buf := (*C.char)(C.malloc(256))
	defer C.free(unsafe.Pointer(buf))
	code := application.InvokeSyncWithResult(func() C.int { return C.guestCreateElsewhere(buf, 256) })
	return failure(code, "create elsewhere", C.GoString(buf))
}

// Dropped is the number of reports the queue had no room for.
func (h *Hooks) Dropped() int64 { return h.d.dropped.Load() }

// CallOffMain proves that a call that is not on the GTK main thread is refused, not carried out.
func (h *Hooks) CallOffMain() error {
	cid := C.CString("nope")
	defer C.free(unsafe.Pointer(cid))
	code := C.guestSetBounds(cid, 0, 0, 1, 1)
	if code == C.GuestErrThread {
		return nil
	}
	return fmt.Errorf("an off-thread call returned %d, want the thread error", int(code))
}

// Pixel is the colour drawn at a point of the area of the web view of the application.
func (h *Hooks) Pixel(x, y float64) (r, g, b int, err error) {
	var cr, cg, cb C.int
	code := application.InvokeSyncWithResult(func() C.int { return C.guestPixel(C.double(x), C.double(y), &cr, &cg, &cb) })
	if err := failure(code, "pixel", ""); err != nil {
		return 0, 0, 0, err
	}
	return int(cr), int(cg), int(cb), nil
}

// TraceEvents logs the pointer events GTK gets, to stderr.
func (h *Hooks) TraceEvents() { application.InvokeSync(func() { C.guestTraceEvents() }) }

// WindowAt moves the pointer to a point of the area of the web view of the application and says which widget owns
// the window the X server has there: 1 a guest, 2 the web view of the application (or the overlay), 0 other.
func (h *Hooks) WindowAt(x, y float64) (int, string) {
	buf := (*C.char)(C.malloc(128))
	defer C.free(unsafe.Pointer(buf))
	code := application.InvokeSyncWithResult(func() C.int { return C.guestWindowAt(C.double(x), C.double(y), buf, 128) })
	time.Sleep(100 * time.Millisecond)
	return int(code), C.GoString(buf)
}

// SandboxEnabled says whether the web context of the guest has the sandbox of WebKit on.
func (h *Hooks) SandboxEnabled(id string) bool {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	return application.InvokeSyncWithResult(func() C.int { return C.guestSandboxEnabled(cid) }) == 1
}

// SetClearing plays a RemoveData that is waiting for WebKit: the store refuses new views meanwhile.
func (h *Hooks) SetClearing(dataStore string, on bool) {
	cs := C.CString(strings.ToLower(dataStore))
	defer C.free(unsafe.Pointer(cs))
	n := C.int(0)
	if on {
		n = 1
	}
	application.InvokeSync(func() { C.guestSetClearing(cs, n) })
}
