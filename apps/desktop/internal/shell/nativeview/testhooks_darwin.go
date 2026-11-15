//go:build darwin && cgo && nativeviewtest

package nativeview

/*
#cgo CFLAGS: -DCLARAE_NATIVEVIEW_TEST
#include <stdlib.h>
#include "guest_darwin.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/webview"
)

// What the live test needs to look inside the guests. It exists only with the build tag
// nativeviewtest and is never part of the application.

// Hooks gives a test the helpers of a driver made by New.
type Hooks struct{ d *driver }

// TestHooks returns the helpers of d, which must be a driver made by New.
func TestHooks(d webview.Driver) *Hooks { return &Hooks{d: d.(*driver)} }

// Frame is the rectangle of a guest in points, origin top-left, and the size of the content view.
type Frame struct {
	X, Y, W, H, CW, CH float64
	Hidden, FirstResp  bool
}

// Eval runs the body of an async function in the page of the guest and returns its result (a string as
// it is, anything else as JSON).
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
	var hidden, fr C.int
	code := application.InvokeSyncWithResult(func() C.int {
		return C.guestFrame(cid, &x, &y, &w, &hh, &cw, &ch, &hidden, &fr)
	})
	if err := failure(code, "frame"); err != nil {
		return Frame{}, err
	}
	return Frame{float64(x), float64(y), float64(w), float64(hh), float64(cw), float64(ch), hidden != 0, fr != 0}, nil
}

// HitTest says what a click at a point (points of the content view, origin top-left) reaches: 1 the
// guest, 2 another web view (the one of the application), 0 anything else.
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

// StoreKind is 1 for a data store with an identifier, 2 for one in memory.
func (h *Hooks) StoreKind(id string) int {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	return int(application.InvokeSyncWithResult(func() C.int { return C.guestStoreKind(cid) }))
}

// PostKey posts a key down and a key up to the application, as the keyboard would.
func (h *Hooks) PostKey(chars, noMods string, keyCode uint16, flags uint64) {
	cc, cn := C.CString(chars), C.CString(noMods)
	defer C.free(unsafe.Pointer(cc))
	defer C.free(unsafe.Pointer(cn))
	w := h.d.win.NativeWindow()
	application.InvokeSync(func() { C.guestPostKey(w, cc, cn, C.ushort(keyCode), C.ulong(flags)) })
}

// PostClick posts a click at a point of the guest (points, origin top-left).
func (h *Hooks) PostClick(id string, x, y float64) {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	application.InvokeSync(func() { C.guestPostClick(cid, C.double(x), C.double(y)) })
}

// Activate brings the application to the front, so that it receives the keyboard.
func (h *Hooks) Activate() { application.InvokeSync(func() { C.guestActivateApp() }) }

// FocusMain gives the web view of the application the keyboard focus.
func (h *Hooks) FocusMain() {
	w := h.d.win.NativeWindow()
	application.InvokeSync(func() { C.guestFocusMain(w) })
}

// KeyEquivalent offers a key combination (a Cmd or Ctrl key) to the window and then to the menu, as the
// application does for a key that is pressed, and says who took it. The event is made as a keyboard makes
// it, from the key code and the layout in use: info says what it came out as.
func (h *Hooks) KeyEquivalent(keyCode uint16, flags uint64) (window, menu bool, info string) {
	w := h.d.win.NativeWindow()
	buf := (*C.char)(C.malloc(256))
	defer C.free(unsafe.Pointer(buf))
	var wh, mh C.int
	application.InvokeSync(func() { C.guestKeyEquivalent(w, C.ushort(keyCode), C.ulong(flags), &wh, &mh, buf, 256) })
	return wh != 0, mh != 0, C.GoString(buf)
}

// KeyDown hands a plain key to the guest.
func (h *Hooks) KeyDown(id, chars string, keyCode uint16) {
	cid, cc := C.CString(id), C.CString(chars)
	defer C.free(unsafe.Pointer(cid))
	defer C.free(unsafe.Pointer(cc))
	application.InvokeSync(func() { C.guestKeyDown(cid, cc, C.ushort(keyCode)) })
}

// ResignFocus leaves the window with no first responder: every view is asked about a key equivalent
// and none of them is the one that has the focus.
func (h *Hooks) ResignFocus() {
	w := h.d.win.NativeWindow()
	application.InvokeSync(func() { C.guestResignFocus(w) })
}

// AppState says whether the application is active and whether its window is the key and the main one.
func (h *Hooks) AppState() (active, key, main bool) {
	w := h.d.win.NativeWindow()
	var a, k, m C.int
	application.InvokeSync(func() { C.guestAppState(w, &a, &k, &m) })
	return a != 0, k != 0, m != 0
}

// Dropped is the number of reports the queue had no room for.
func (h *Hooks) Dropped() int64 { return h.d.dropped.Load() }

// CallOffMain proves that a call that is not on the main thread is refused, not carried out.
func (h *Hooks) CallOffMain() error {
	cid := C.CString("nope")
	defer C.free(unsafe.Pointer(cid))
	code := C.guestSetBounds(cid, 0, 0, 1, 1)
	if code == C.GuestErrThread {
		return nil
	}
	return fmt.Errorf("an off-thread call returned %d, want the thread error", int(code))
}
