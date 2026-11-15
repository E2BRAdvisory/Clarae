//go:build darwin && cgo

package nativeview

/*
#cgo CFLAGS: -x objective-c -fobjc-arc -mmacosx-version-min=13.0
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#include <stdlib.h>
#include <pthread.h>
#include "guest_darwin.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/webview"
)

// Supported is true: this build has a driver.
const Supported = true

// eventBuffer is the room for reports that Go has not read yet. The callback of AppKit never waits: a
// report that finds the queue full is dropped (and counted), and the next state replaces it.
const eventBuffer = 512

// removeDataTimeout bounds the wait for WebKit to delete a data store.
const removeDataTimeout = 30 * time.Second

// The callbacks of the Objective-C side are plain C functions: they find the driver here. There is one
// window, so one driver.
var current atomic.Pointer[driver]

type driver struct {
	win     *application.WebviewWindow
	events  chan webview.Event
	dropped atomic.Int64

	policyMu sync.RWMutex
	policy   webview.Policy

	reqSeq  atomic.Int64
	pending sync.Map // int64 -> chan reply
}

type reply struct {
	ok  bool
	msg string
}

// New returns the driver of the native web views of the window.
func New(win *application.WebviewWindow) webview.Driver {
	d := &driver{win: win, events: make(chan webview.Event, eventBuffer)}
	current.Store(d)
	return d
}

var _ webview.Driver = (*driver)(nil)

//export goGuestEvent
func goGuestEvent(id *C.char, kind C.int, a, b *C.char, f1, f2, f3 C.int) {
	// On the main thread, inside AppKit: copy, queue, return. Never block here.
	d := current.Load()
	if d == nil {
		return
	}
	ev := webview.Event{ID: C.GoString(id), Kind: webview.EventKind(kind)}
	as, bs := C.GoString(a), C.GoString(b)
	switch ev.Kind {
	case webview.EvState:
		ev.URL, ev.Title, ev.Loading, ev.CanGoBack, ev.CanGoForward = as, bs, f1 != 0, f2 != 0, f3 != 0
	case webview.EvBlocked:
		ev.URL, ev.Text, ev.MainFrame = as, bs, f1 != 0
	case webview.EvError:
		ev.URL, ev.Text, ev.Code, ev.Certificate = as, bs, int(f1), f2 != 0
	case webview.EvPermission:
		ev.Text, ev.URL = as, bs
	case webview.EvNewWindow:
		ev.URL, ev.UserGesture = as, f1 != 0
	case webview.EvDownload:
		ev.URL = as
	case webview.EvKey:
		ev.Text = as
	}
	select {
	case d.events <- ev:
	default:
		d.dropped.Add(1)
	}
}

//export goGuestPolicy
func goGuestPolicy(id, rawURL *C.char, mainFrame C.int) C.int {
	// Also on the main thread, and AppKit waits for the answer: the policy of the Manager decides
	// at once (a lookup and a parse) and leaves its report for another goroutine.
	d := current.Load()
	if d == nil {
		return 0
	}
	d.policyMu.RLock()
	p := d.policy
	d.policyMu.RUnlock()
	if p == nil || !p(C.GoString(id), C.GoString(rawURL), mainFrame != 0) {
		return 0
	}
	return 1
}

//export goGuestReply
func goGuestReply(req C.long, ok C.int, msg *C.char) {
	d := current.Load()
	if d == nil {
		return
	}
	if ch, found := d.pending.LoadAndDelete(int64(req)); found {
		ch.(chan reply) <- reply{ok: ok != 0, msg: C.GoString(msg)}
	}
}

// failure turns a return code of the Objective-C side into an error.
func failure(code C.int, what string) error {
	switch {
	case code >= 0:
		return nil
	case code == C.GuestErrUnknown:
		return webview.ErrUnknownView
	case code == C.GuestErrThread:
		return fmt.Errorf("%s: not on the main thread", what)
	case code == C.GuestErrURL:
		return fmt.Errorf("%s: address refused (only http and https)", what)
	case code == C.GuestErrNoWindow:
		return fmt.Errorf("%s: the window has no content view yet", what)
	case code == C.GuestErrExists:
		return fmt.Errorf("%s: the view already exists", what)
	}
	return fmt.Errorf("%s: error %d", what, int(code))
}

// onMain runs f on the main thread and returns what it returns.
func onMain(f func() C.int) C.int { return application.InvokeSyncWithResult(f) }

func withID(id string, f func(cid *C.char) C.int) C.int {
	cid := C.CString(id)
	defer C.free(unsafe.Pointer(cid))
	return onMain(func() C.int { return f(cid) })
}

func (d *driver) Create(id, rawURL string, b webview.Bounds, dataStore string) error {
	if err := webview.ValidateURL(rawURL); err != nil {
		return errors.New("create: address refused (only http and https)")
	}
	w := d.win.NativeWindow()
	if w == nil {
		return errors.New("create: no native window")
	}
	cid, curl, cstore := C.CString(id), C.CString(rawURL), C.CString(dataStore)
	defer C.free(unsafe.Pointer(cid))
	defer C.free(unsafe.Pointer(curl))
	defer C.free(unsafe.Pointer(cstore))
	return failure(onMain(func() C.int {
		return C.guestCreate(w, cid, curl, C.double(b.X), C.double(b.Y), C.double(b.Width), C.double(b.Height), cstore)
	}), "create")
}

func (d *driver) SetBounds(id string, b webview.Bounds) error {
	return failure(withID(id, func(cid *C.char) C.int {
		return C.guestSetBounds(cid, C.double(b.X), C.double(b.Y), C.double(b.Width), C.double(b.Height))
	}), "set bounds")
}

func (d *driver) SetVisible(id string, visible bool) error {
	n := C.int(0)
	if visible {
		n = 1
	}
	return failure(withID(id, func(cid *C.char) C.int { return C.guestSetVisible(cid, n) }), "set visible")
}

func (d *driver) Navigate(id, rawURL string) error {
	if err := webview.ValidateURL(rawURL); err != nil {
		return errors.New("navigate: address refused (only http and https)")
	}
	curl := C.CString(rawURL)
	defer C.free(unsafe.Pointer(curl))
	return failure(withID(id, func(cid *C.char) C.int { return C.guestNavigate(cid, curl) }), "navigate")
}

func (d *driver) Back(id string) error {
	return failure(withID(id, func(cid *C.char) C.int { return C.guestBack(cid) }), "back")
}

func (d *driver) Forward(id string) error {
	return failure(withID(id, func(cid *C.char) C.int { return C.guestForward(cid) }), "forward")
}

func (d *driver) Reload(id string) error {
	return failure(withID(id, func(cid *C.char) C.int { return C.guestReload(cid) }), "reload")
}

func (d *driver) Focus(id string) error {
	return failure(withID(id, func(cid *C.char) C.int { return C.guestFocus(cid) }), "focus")
}

// Close queues the removal for the main thread and returns: the sync loop closes the views of a vault
// that is locked, while the shutdown of the application, on the main thread, waits for that loop (a
// Close that waited for the main thread would deadlock the two). The queue is in order, so the guest
// is gone before the next call of the driver, and before the event that tells the UI about the lock,
// which Wails also delivers through the main thread.
func (d *driver) Close(id string) error {
	cid := C.CString(id)
	application.InvokeAsync(func() {
		defer C.free(unsafe.Pointer(cid))
		C.guestClose(cid) // a guest that is not there (already closed) is not an error
	})
	return nil
}

// CloseAll removes every guest. It is called while the application quits: from a shutdown hook, which
// Wails runs on the main thread (the work is done at once, and a dispatch to that thread from here
// would wait for ourselves), or from the watchdog that ends a quit Wails left hanging, on a goroutine
// (the work is queued for the main thread and never waited for: a main thread that is gone must not
// stop the process from exiting).
func (d *driver) CloseAll() {
	if C.pthread_main_np() != 0 {
		C.guestCloseAll()
		return
	}
	application.InvokeAsync(func() { C.guestCloseAll() })
}

func (d *driver) ReserveKeys(accelerators []string) {
	cs := C.CString(strings.Join(accelerators, ","))
	defer C.free(unsafe.Pointer(cs))
	application.InvokeSync(func() { C.guestReserveKeys(cs) })
}

func (d *driver) SetPolicy(p webview.Policy) {
	d.policyMu.Lock()
	d.policy = p
	d.policyMu.Unlock()
}

func (d *driver) PersistentData() bool { return C.guestPersistent() != 0 }

func (d *driver) Events() <-chan webview.Event { return d.events }

// RemoveData starts the deletion on the main thread and waits for WebKit's answer off it.
func (d *driver) RemoveData(dataStore string) error {
	cs := C.CString(dataStore)
	defer C.free(unsafe.Pointer(cs))
	r, err := d.async(func(req C.long) C.int { return C.guestRemoveData(cs, req) }, "remove data", removeDataTimeout)
	if err != nil {
		return err
	}
	if !r.ok {
		return fmt.Errorf("remove data: %s", r.msg)
	}
	return nil
}

// async starts an operation that answers in goGuestReply and waits for the answer off the main thread
// (waiting on it would stop the very loop that produces the answer).
func (d *driver) async(start func(req C.long) C.int, what string, timeout time.Duration) (reply, error) {
	req := d.reqSeq.Add(1)
	ch := make(chan reply, 1)
	d.pending.Store(req, ch)
	if err := failure(onMain(func() C.int { return start(C.long(req)) }), what); err != nil {
		d.pending.Delete(req)
		return reply{}, err
	}
	select {
	case r := <-ch:
		return r, nil
	case <-time.After(timeout):
		d.pending.Delete(req)
		return reply{}, fmt.Errorf("%s: no answer from WebKit in %v", what, timeout)
	}
}
