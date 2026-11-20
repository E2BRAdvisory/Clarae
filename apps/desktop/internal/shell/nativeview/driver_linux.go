//go:build linux && cgo && gtk3 && !android && !server && !purego

package nativeview

/*
#cgo pkg-config: gtk+-3.0 webkit2gtk-4.1
#include <stdlib.h>
#include "guest_linux.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/webview"
)

// The driver of Linux (M22, ADR-0062): a WebKitWebView of WebKitGTK added to the window of the application, above
// the web view of Wails. It is the counterpart of driver_darwin.go (and guest_darwin.m) and of
// driver_windows.go. On macOS a guest is a child of the content view; here the window of Wails is
// GtkWindow > GtkBox "webview-box" > [menu bar] + WebKitWebView, and the first guest swaps the web view of
// Wails for a GtkOverlay that holds it, with the guests above it (guest_linux.c, graft). The build tags are the
// ones of the binding of Wails for GTK3 (pkg/application/linux_cgo_gtk3.go), the one the release is built with;
// a build with GTK4 or without cgo has no driver (driver_other.go).

// Supported is true: this build has a driver. Whether this machine can run it (WebKitGTK 2.40 or later, a window
// built as the driver expects) is what New and Create answer, and CLARAE_WEBVIEW=off turns it off (New returns nil,
// see switch.go): the Supported of a build is about what its code can hold, so the session data of the
// applications are never forgotten by a start where the views are off.
const Supported = true

const (
	// eventBuffer is the room for reports that Go has not read yet. The callback of GTK never waits: a report that
	// finds the queue full is dropped (and counted), and the next state replaces it.
	eventBuffer = 512
	// removeDataTimeout bounds the wait for WebKit to clear a data store, and the deletion of its folder.
	removeDataTimeout = 30 * time.Second
	removeDataRetry   = 250 * time.Millisecond
)

var errQuitting = errors.New("the application is quitting")

// The callbacks of the C side are plain C functions: they find the driver here. There is one window, so one driver.
var current atomic.Pointer[driver]

type driver struct {
	win        *application.WebviewWindow
	webappsDir string
	events     chan webview.Event
	dropped    atomic.Int64
	closing    atomic.Bool // CloseAll was called: no new view

	policyMu sync.RWMutex
	policy   webview.Policy
	frame    webview.FramePolicy     // for the navigations whose frame WebKitGTK does not say
	onMain   webview.MainFrameNotice // the top frame starts to load an address

	reqSeq  atomic.Int64
	pending sync.Map // int64 -> chan reply
}

type reply struct {
	ok  bool
	msg string
}

// webkitProblem is why the WebKitGTK of this process cannot run a guest ("" when it can); it needs no window and no
// thread, so it is asked once.
var webkitProblem = sync.OnceValue(func() string {
	buf := (*C.char)(C.malloc(256))
	defer C.free(unsafe.Pointer(buf))
	if C.guestWebKitOK(buf, 256) != 0 {
		return ""
	}
	return C.GoString(buf)
})

// New returns the driver of the native web views of the window, or nil: when the switch is off, when WebKitGTK is
// older than 2.40, when there is no data directory to keep the sessions in, and before the window exists. The core
// then answers "unavailable" and the page of an application opens in the system browser. dataDir is the data
// directory of the application (the sessions are in <dataDir>/webapps/<store>).
func New(win *application.WebviewWindow, dataDir string) webview.Driver {
	if win == nil || !enabledByEnvironment() || webkitProblem() != "" {
		return nil
	}
	root := webappsDir(dataDir)
	if root == "" {
		return nil
	}
	d := &driver{win: win, webappsDir: root, events: make(chan webview.Event, eventBuffer)}
	current.Store(d)
	return d
}

var (
	_ webview.Driver           = (*driver)(nil)
	_ webview.FrameAwareDriver = (*driver)(nil)
)

//export goGuestEvent
func goGuestEvent(id *C.char, kind C.int, a, b *C.char, f1, f2, f3 C.int) {
	// On the main thread, inside GTK: copy, queue, return. Never block here.
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
func goGuestPolicy(id, rawURL *C.char, frame, redirect C.int) C.int {
	// Also on the main thread, and GTK waits for the answer: the policy of the Manager decides at once (a lookup
	// and a parse) and leaves its report for another goroutine.
	d := current.Load()
	if d == nil {
		return 0
	}
	d.policyMu.RLock()
	p, fp := d.policy, d.frame
	d.policyMu.RUnlock()
	var allow bool
	switch {
	case fp != nil:
		kind := webview.FrameUnknown
		switch frame {
		case C.GuestFrameMain:
			kind = webview.FrameMain
		case C.GuestFrameSub:
			kind = webview.FrameSub
		}
		allow = fp(C.GoString(id), C.GoString(rawURL), kind, redirect != 0)
	case p != nil:
		// No frame-aware policy (a driver used without a Manager): what cannot be told from the top frame is judged as it.
		allow = p(C.GoString(id), C.GoString(rawURL), frame != C.GuestFrameSub)
	}
	if !allow {
		return 0
	}
	return 1
}

//export goGuestMainFrame
func goGuestMainFrame(id, rawURL *C.char) {
	d := current.Load()
	if d == nil {
		return
	}
	d.policyMu.RLock()
	n := d.onMain
	d.policyMu.RUnlock()
	if n != nil {
		n(C.GoString(id), C.GoString(rawURL))
	}
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

// failure turns a return code of the C side into an error. why is what the C side said for an error that has
// more to say (GuestErrUnavailable).
func failure(code C.int, what, why string) error {
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
		return fmt.Errorf("%s: the window is not there yet", what)
	case code == C.GuestErrExists:
		return fmt.Errorf("%s: the view already exists", what)
	case code == C.GuestErrStoreBusy:
		// An ordinary failure of the view, not a platform that cannot: the UI shows the card with its retry.
		return fmt.Errorf("%s: the session data of the vault are being deleted, try again", what)
	case code == C.GuestErrStore:
		return fmt.Errorf("%s: the session data could not be set up", what)
	case code == C.GuestErrUnavailable:
		return fmt.Errorf("%w: %s: %s", webview.ErrPlatformUnavailable, what, why)
	}
	return fmt.Errorf("%s: error %d", what, int(code))
}

// onMain runs f on the GTK main thread and returns what it returns.
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
	folder, err := userDataFolder(d.webappsDir, dataStore)
	if err != nil {
		return fmt.Errorf("create: %w", err)
	}
	if d.closing.Load() {
		return fmt.Errorf("create: %w", errQuitting)
	}
	w := d.win.NativeWindow()
	if w == nil {
		return errors.New("create: no native window")
	}
	// One folder per store, hence per vault: <data dir>/webapps/<store>/{data,cache}. The folders are made here,
	// off the GTK thread, with the rights of the owner only.
	dataDir, cacheDir := filepath.Join(folder, "data"), filepath.Join(folder, "cache")
	for _, dir := range []string{dataDir, cacheDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create: the folder of the session data: %w", err)
		}
	}
	cid, curl, cstore := C.CString(id), C.CString(rawURL), C.CString(strings.ToLower(dataStore))
	cdata, ccache := C.CString(dataDir), C.CString(cacheDir)
	cerr := (*C.char)(C.malloc(256))
	defer func() {
		for _, p := range []*C.char{cid, curl, cstore, cdata, ccache, cerr} {
			C.free(unsafe.Pointer(p))
		}
	}()
	*cerr = 0
	code := onMain(func() C.int {
		return C.guestCreate(w, cid, curl, C.double(b.X), C.double(b.Y), C.double(b.Width), C.double(b.Height), cstore, cdata, ccache, cerr, 256)
	})
	return failure(code, "create", C.GoString(cerr))
}

func (d *driver) SetBounds(id string, b webview.Bounds) error {
	return failure(withID(id, func(cid *C.char) C.int {
		return C.guestSetBounds(cid, C.double(b.X), C.double(b.Y), C.double(b.Width), C.double(b.Height))
	}), "set bounds", "")
}

func (d *driver) SetVisible(id string, visible bool) error {
	n := C.int(0)
	if visible {
		n = 1
	}
	return failure(withID(id, func(cid *C.char) C.int { return C.guestSetVisible(cid, n) }), "set visible", "")
}

func (d *driver) Navigate(id, rawURL string) error {
	if err := webview.ValidateURL(rawURL); err != nil {
		return errors.New("navigate: address refused (only http and https)")
	}
	curl := C.CString(rawURL)
	defer C.free(unsafe.Pointer(curl))
	return failure(withID(id, func(cid *C.char) C.int { return C.guestNavigate(cid, curl) }), "navigate", "")
}

func (d *driver) Back(id string) error {
	return failure(withID(id, func(cid *C.char) C.int { return C.guestBack(cid) }), "back", "")
}

func (d *driver) Forward(id string) error {
	return failure(withID(id, func(cid *C.char) C.int { return C.guestForward(cid) }), "forward", "")
}

func (d *driver) Reload(id string) error {
	return failure(withID(id, func(cid *C.char) C.int { return C.guestReload(cid) }), "reload", "")
}

func (d *driver) Focus(id string) error {
	return failure(withID(id, func(cid *C.char) C.int { return C.guestFocus(cid) }), "focus", "")
}

// Close queues the removal for the GTK main thread and returns: the sync loop closes the views of a vault that is
// locked, while the shutdown of the application, on the main thread, waits for that loop (a Close that waited for
// the main thread would deadlock the two). The queue is in order, so the guest is gone before the next call of the
// driver, and before the event that tells the UI about the lock, which Wails also delivers through the main thread.
func (d *driver) Close(id string) error {
	cid := C.CString(id)
	application.InvokeAsync(func() {
		defer C.free(unsafe.Pointer(cid))
		C.guestClose(cid) // a guest that is not there (already closed) is not an error
	})
	return nil
}

// CloseAll removes every guest. It is called while the application quits: from a shutdown hook, which Wails runs
// on the main thread (the work is done at once, and a dispatch to that thread from here would wait for ourselves),
// or from the watchdog that ends a quit Wails left hanging, on a goroutine (the work is queued for the main thread
// and never waited for: a main thread that is gone must not stop the process from exiting).
func (d *driver) CloseAll() {
	d.closing.Store(true)
	if C.guestOnMainThread() != 0 {
		C.guestCloseAll()
		return
	}
	application.InvokeAsync(func() { C.guestCloseAll() })
}

// ReserveKeys keeps, of the accelerators the core sends, the ones the keyboard of Linux can make and a page may be
// refused: nothing with cmd (the Command key of a Mac) and no editing shortcut (see reservedSet).
func (d *driver) ReserveKeys(accelerators []string) {
	var keys []string
	for a := range reservedSet(accelerators) {
		keys = append(keys, a)
	}
	cs := C.CString(strings.Join(keys, ","))
	defer C.free(unsafe.Pointer(cs))
	application.InvokeSync(func() { C.guestReserveKeys(cs) })
}

func (d *driver) SetPolicy(p webview.Policy) {
	d.policyMu.Lock()
	d.policy = p
	d.policyMu.Unlock()
}

// SetFramePolicy installs the policy for the navigations whose frame WebKitGTK does not say, and the notice of the top
// frame (see webview.FrameAwareDriver).
func (d *driver) SetFramePolicy(p webview.FramePolicy, onMainFrame webview.MainFrameNotice) {
	d.policyMu.Lock()
	d.frame, d.onMain = p, onMainFrame
	d.policyMu.Unlock()
}

// PersistentData: the data folder of the store keeps cookies and storage across a restart.
func (d *driver) PersistentData() bool { return true }

func (d *driver) Events() <-chan webview.Event { return d.events }

// RemoveData clears the data of a store that WebKit keeps in memory and lets go of its context (on the main
// thread, waiting for WebKit off it), then deletes the folder of the store. The Manager has closed the views of the
// store before. A store that was never made has no folder, which is not an error.
func (d *driver) RemoveData(dataStore string) error {
	folder, err := userDataFolder(d.webappsDir, dataStore)
	if err != nil {
		return fmt.Errorf("remove data: %w", err)
	}
	cs := C.CString(strings.ToLower(dataStore))
	defer C.free(unsafe.Pointer(cs))
	r, err := d.async(func(req C.long) C.int { return C.guestReleaseStore(cs, req) }, "remove data", removeDataTimeout)
	if err != nil {
		return err
	}
	if !r.ok {
		return fmt.Errorf("remove data: %s", r.msg)
	}
	deadline := time.Now().Add(removeDataTimeout)
	for {
		err := os.RemoveAll(folder)
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("remove data: %w", err)
		}
		time.Sleep(removeDataRetry)
	}
}

// async starts an operation that answers in goGuestReply and waits for the answer off the main thread (waiting on
// it would stop the very loop that produces the answer).
func (d *driver) async(start func(req C.long) C.int, what string, timeout time.Duration) (reply, error) {
	req := d.reqSeq.Add(1)
	ch := make(chan reply, 1)
	d.pending.Store(req, ch)
	if err := failure(onMain(func() C.int { return start(C.long(req)) }), what, ""); err != nil {
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
