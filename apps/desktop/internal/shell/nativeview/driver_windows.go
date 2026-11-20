//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package nativeview

// The driver of Windows: a WebView2 controller added to the window of the application, beside the one
// Wails made for the application itself. It is on by default (ADR-0062) and falls back to the system browser when
// the runtime of WebView2 is missing or too old: New returns nil without a runtime, and a Create that finds the
// platform unable returns webview.ErrPlatformUnavailable. CLARAE_WEBVIEW=off turns it off (switch.go). On macOS the
// same job is guest_darwin.m.
//
// Technique. Every data store (every vault) has its own WebView2 environment with its own user data
// folder, <data dir>\webapps\<store>, hence its own browser process: nothing is shared with the web view
// of the application (its folder is <data dir>\webview) or with another vault. A guest is a second
// controller on the HWND of the window, made from that environment. Nothing of Wails is copied: the
// bridge of Wails (window.external.invoke) is not injected, IsWebMessageEnabled is off, no host object
// and no script is added, so the page has no channel to the application.
//
// Threads. Every COM object lives on the thread of the window (the one that runs the loop of Wails):
// the fields of driver and guest below the line "UI thread" are touched only there, and every method of
// the Driver that needs them moves to it with application.InvokeSync or InvokeAsync. A call that has to
// wait for WebView2 (Create) waits on a channel off that thread, never on it. Close and CloseAll do not
// wait (see webview.Driver).

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
	"golang.org/x/sys/windows"

	"clarae/apps/desktop/internal/shell/nativeview/webview2"
	"clarae/apps/desktop/internal/shell/nativeview/webview2/loader"
	"clarae/apps/desktop/internal/webview"
)

// Supported says whether this build has a driver: it does. Whether the machine can run it, and whether the environment
// turned it off (CLARAE_WEBVIEW=off, see switch.go), is what New and Create answer (no runtime of WebView2 gives no
// driver, and the page opens in the system browser). It stays true when the views are off so that the sweep of the
// session data (webviews_sweep.go) does not forget, at a start where they are off, the data of the vaults that it
// could not delete.
const Supported = true

const (
	// eventBuffer is the room for reports that Go has not read yet; a report that finds the queue full is
	// dropped (and counted), and the next state replaces it.
	eventBuffer = 512
	// createTimeout bounds the wait for WebView2 (the first start of a browser process is not quick).
	createTimeout = 60 * time.Second
	// removeDataTimeout bounds the deletion of a user data folder: the browser process of a closed view
	// takes a moment to let go of its files.
	removeDataTimeout = 30 * time.Second
	removeDataRetry   = 250 * time.Millisecond
	// activityInterval: a key in a guest is reported as activity at most this often.
	activityInterval = 5 * time.Second
)

// runtimeMissing is nil when a runtime of WebView2 is installed. The answer is kept for the session: a runtime that
// is installed while the application runs is found at the next start, as the sessions of the applications are not
// the kind of thing that appears midway.
var runtimeMissing = sync.OnceValue(loader.RuntimeInstalled)

var (
	errGuestClosed = errors.New("the view was closed while it was being made")
	errQuitting    = errors.New("the application is quitting")
)

// New returns the driver of the native web views of the window, or nil: while the driver is off
// (CLARAE_WEBVIEW=off), when no runtime of WebView2 is installed, when there is no data folder to keep the sessions in, and
// before the window exists. The core then answers "unavailable" and the page of an application opens in the system
// browser. dataDir is the data directory of the application; empty, the folder is derived from the one Wails was
// given for its own web view.
func New(win *application.WebviewWindow, dataDir string) webview.Driver {
	if win == nil || !enabledByEnvironment() {
		return nil
	}
	if runtimeMissing() != nil {
		return nil
	}
	root := webappsDir(dataDir)
	if root == "" {
		root = webappsRoot(application.Get().Config().Windows.WebviewUserDataPath)
	}
	if root == "" {
		return nil
	}
	d := &driver{
		win: win, webappsDir: root,
		events:   make(chan webview.Event, eventBuffer),
		reserved: map[string]bool{},
		reg:      &handlerSet{live: map[uintptr]any{}},
		guests:   map[string]*guest{},
		envs:     map[string]*environment{},
	}
	// The pixels of a view follow the window: a resize, a change of DPI, a minimise.
	for _, ev := range []events.WindowEventType{
		events.Windows.WindowDidResize, events.Windows.WindowDPIChanged,
		events.Windows.WindowMinimise, events.Windows.WindowUnMinimise,
		events.Windows.WindowMaximise, events.Windows.WindowUnMaximise,
		events.Windows.WindowRestore, events.Windows.WindowShow,
	} {
		win.OnWindowEvent(ev, func(*application.WindowEvent) { d.relayoutAll() })
	}
	return d
}

type driver struct {
	win        *application.WebviewWindow
	webappsDir string
	events     chan webview.Event
	dropped    atomic.Int64

	policyMu sync.RWMutex
	policy   webview.Policy
	keysMu   sync.RWMutex
	reserved map[string]bool

	reg      *handlerSet
	closing  atomic.Bool   // CloseAll was called: no new view
	uiThread atomic.Uint32 // the thread id of the window, once known
	relayout atomic.Bool   // a relayout is queued

	// ---- UI thread ----
	environmentMade bool // an environment was made in this session: the runtime starts
	guests          map[string]*guest
	envs            map[string]*environment // by data store
}

var _ webview.Driver = (*driver)(nil)

// environment is the WebView2 environment of a data store.
type environment struct {
	store, folder string
	com           *webview2.ICoreWebView2Environment
	started       bool
	ready         bool
	waiters       []func(error)
	users         int // views that use it, being made or made
}

// guest is a view: a controller and its web view.
type guest struct {
	id, store string
	env       *environment
	norm      webview.Bounds
	visible   bool

	ctrl    *webview2.ICoreWebView2Controller
	web     *webview2.ICoreWebView2
	release []func() // our references to the handlers we gave WebView2

	done     chan error // the answer of Create, once
	finished bool
	closed   bool

	loading      bool
	focused      bool
	navURL       string // the address of the main navigation that started last
	certFailed   bool   // WebView2 reported a certificate error for navURL
	lastActivity time.Time
}

// ---- threads ----------------------------------------------------------------------------------

// onUI runs f on the thread of the window and returns at once.
func (d *driver) onUI(f func()) {
	application.InvokeAsync(func() {
		d.uiThread.Store(windows.GetCurrentThreadId())
		f()
	})
}

// callUI runs f on the thread of the window and waits for it.
func (d *driver) callUI(f func() error) error {
	return application.InvokeSyncWithError(func() error {
		d.uiThread.Store(windows.GetCurrentThreadId())
		return f()
	})
}

func (d *driver) onUIThread() bool {
	t := d.uiThread.Load()
	return t != 0 && windows.GetCurrentThreadId() == t
}

func (d *driver) hwnd() uintptr { return uintptr(d.win.NativeWindow()) }

func (d *driver) emit(e webview.Event) {
	select {
	case d.events <- e:
	default:
		d.dropped.Add(1)
	}
}

// ---- Driver: create ---------------------------------------------------------------------------

func (d *driver) Create(id, rawURL string, b webview.Bounds, dataStore string) error {
	if err := webview.ValidateURL(rawURL); err != nil {
		return errors.New("create: address refused (only http and https)")
	}
	if _, err := userDataFolder(d.webappsDir, dataStore); err != nil {
		return fmt.Errorf("create: %w", err)
	}
	if d.closing.Load() {
		return fmt.Errorf("create: %w", errQuitting)
	}
	g := &guest{id: id, store: strings.ToLower(dataStore), norm: b, visible: true, done: make(chan error, 1)}
	d.onUI(func() { d.begin(g, rawURL) })

	t := time.NewTimer(createTimeout)
	defer t.Stop()
	select {
	case err := <-g.done:
		if err != nil {
			return fmt.Errorf("create: %w", err)
		}
		return nil
	case <-t.C:
		d.onUI(func() { d.closeGuest(g) })
		return fmt.Errorf("create: WebView2 did not answer in %v", createTimeout)
	}
}

// begin (UI thread) registers the view and gets its environment.
func (d *driver) begin(g *guest, rawURL string) {
	switch {
	case d.closing.Load():
		g.finish(errQuitting)
		return
	case d.guests[g.id] != nil:
		g.finish(errors.New("the view already exists"))
		return
	case d.hwnd() == 0:
		g.finish(errors.New("the window has no native handle yet"))
		return
	}
	e, err := d.environmentOf(g.store)
	if err != nil {
		g.finish(err)
		return
	}
	d.guests[g.id] = g
	g.env = e
	e.users++
	d.whenReady(e, func(err error) {
		switch {
		case g.closed:
			// Closed (a lock, the end of the application, the timeout of Create) while the environment was made.
		case err != nil:
			d.fail(g, err)
		default:
			d.makeController(g, rawURL)
		}
	})
}

// fail ends the making of a view with an error and removes it.
func (d *driver) fail(g *guest, err error) {
	g.finish(err)
	d.closeGuest(g)
}

func (g *guest) finish(err error) {
	if g.finished {
		return
	}
	g.finished = true
	g.done <- err
}

// environmentOf (UI thread) returns the environment of a data store, making the record when there is none.
func (d *driver) environmentOf(store string) (*environment, error) {
	if e := d.envs[store]; e != nil {
		return e, nil
	}
	folder, err := userDataFolder(d.webappsDir, store)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(folder, 0o700); err != nil {
		return nil, fmt.Errorf("the folder of the session data: %w", err)
	}
	e := &environment{store: store, folder: folder}
	d.envs[store] = e
	return e, nil
}

// whenReady (UI thread) calls then once the environment exists, or failed. The environment is made
// asynchronously, with no nested loop of messages: the completion arrives on this thread through the loop
// of Wails.
func (d *driver) whenReady(e *environment, then func(error)) {
	if e.ready {
		then(nil)
		return
	}
	e.waiters = append(e.waiters, then)
	if e.started {
		return
	}
	e.started = true
	h := &envDone{}
	h.f = func(hr loader.HRESULT, com *loader.ICoreWebView2Environment) {
		var err error
		switch {
		case hr < 0 || com == nil:
			err = fmt.Errorf("the WebView2 environment could not be made: %w", webview2.Error(hr)) //nolint:gosec // an HRESULT is 32 bits
			if !d.environmentMade {
				// The first environment of the session failed: the runtime does not start here, whatever the vault.
				err = fmt.Errorf("%w: %w", webview.ErrPlatformUnavailable, err)
			}
		default:
			com.AddRef() // the loader releases its own when this returns
			e.com = (*webview2.ICoreWebView2Environment)(unsafe.Pointer(com))
			e.ready = true
			d.environmentMade = true
		}
		d.environmentDone(e, err)
	}
	// The environment has the options of nothing in particular: the user data folder is the only one. A
	// second environment on a folder with other options fails (0x8007139F), and no other kind of
	// environment shares our folders.
	if err := loader.CreateCoreWebView2EnvironmentWithOptions(h, loader.WithUserDataFolder(e.folder)); err != nil {
		// No runtime, or one whose library does not load: nothing will work, for any view.
		d.environmentDone(e, fmt.Errorf("%w: WebView2 is not available: %w", webview.ErrPlatformUnavailable, err))
	}
}

// environmentDone (UI thread) hands the answer to everyone who waited for it. A failure is not kept: the
// next view tries again.
func (d *driver) environmentDone(e *environment, err error) {
	waiters := e.waiters
	e.waiters = nil
	if err != nil {
		e.started = false
		if d.envs[e.store] == e {
			delete(d.envs, e.store)
		}
	}
	for _, w := range waiters {
		w(err)
	}
	d.dropEnvironmentIfIdle(e)
}

// dropEnvironmentIfIdle (UI thread) lets go of an environment that no view uses: the browser process of
// its user data folder ends, and the folder can be deleted (RemoveData).
func (d *driver) dropEnvironmentIfIdle(e *environment) {
	if e.users > 0 || !e.ready || d.envs[e.store] != e {
		return
	}
	delete(d.envs, e.store)
	e.ready = false
	if e.com != nil {
		webview2.Release(unsafe.Pointer(e.com))
		e.com = nil
	}
}

// makeController (UI thread) asks WebView2 for the controller of the view; the rest happens in the
// handler when it answers.
func (d *driver) makeController(g *guest, rawURL string) {
	h := &controllerDone{}
	h.f = func(code uintptr, c *webview2.ICoreWebView2Controller) {
		if g.closed {
			if c != nil {
				_ = c.Close() // WebView2 lets go of its own reference when this returns
			}
			return
		}
		if webview2.Failed(code) || c == nil {
			d.fail(g, fmt.Errorf("the WebView2 controller could not be made: %w", webview2.Error(code))) //nolint:gosec // an HRESULT is 32 bits
			return
		}
		c.AddRef()
		g.ctrl = c
		web, err := c.GetCoreWebView2()
		if err != nil || web == nil {
			d.fail(g, fmt.Errorf("the web view of the controller: %w", orFailed(err)))
			return
		}
		g.web = web
		if err := d.wire(g); err != nil {
			d.fail(g, err)
			return
		}
		d.layout(g)
		if err := web.Navigate(rawURL); err != nil {
			d.fail(g, fmt.Errorf("navigate: %w", err))
			return
		}
		g.finish(nil)
	}
	obj := hold(d.reg, &h.comBase, webview2.NewICoreWebView2CreateCoreWebView2ControllerCompletedHandler(h))
	g.release = append(g.release, func() { h.Release() })
	if err := g.env.com.CreateCoreWebView2Controller(webview2.HWND(d.hwnd()), obj); err != nil {
		d.fail(g, fmt.Errorf("the WebView2 controller: %w", err))
	}
}

func orFailed(err error) error {
	if err != nil {
		return err
	}
	return errors.New("no object")
}

// ---- Driver: what a view does -----------------------------------------------------------------

// guestOf (UI thread) finds a view that is made.
func (d *driver) guestOf(id string) (*guest, error) {
	g := d.guests[id]
	if g == nil || g.ctrl == nil || g.closed {
		return nil, webview.ErrUnknownView
	}
	return g, nil
}

func (d *driver) viewCall(id string, f func(g *guest) error) error {
	return d.callUI(func() error {
		g, err := d.guestOf(id)
		if err != nil {
			return err
		}
		return f(g)
	})
}

func (d *driver) SetBounds(id string, b webview.Bounds) error {
	return d.viewCall(id, func(g *guest) error {
		g.norm = b
		d.layout(g)
		return nil
	})
}

func (d *driver) SetVisible(id string, visible bool) error {
	return d.viewCall(id, func(g *guest) error {
		if !visible {
			d.releaseFocus(g)
		}
		g.visible = visible
		d.layout(g)
		return nil
	})
}

func (d *driver) Navigate(id, rawURL string) error {
	if err := webview.ValidateURL(rawURL); err != nil {
		return errors.New("navigate: address refused (only http and https)")
	}
	return d.viewCall(id, func(g *guest) error {
		if err := g.web.Navigate(rawURL); err != nil {
			return fmt.Errorf("navigate: %w", err)
		}
		return nil
	})
}

func (d *driver) Back(id string) error {
	return d.viewCall(id, func(g *guest) error { _ = g.web.GoBack(); return nil })
}

func (d *driver) Forward(id string) error {
	return d.viewCall(id, func(g *guest) error { _ = g.web.GoForward(); return nil })
}

func (d *driver) Reload(id string) error {
	return d.viewCall(id, func(g *guest) error {
		// Nothing was ever shown (the first load failed, a certificate error among them): there is no page
		// to reload, so the address is loaded again.
		if src, err := g.web.GetSource(); (err != nil || src == "" || src == "about:blank") && g.navURL != "" {
			_ = g.web.Navigate(g.navURL)
			return nil
		}
		_ = g.web.Reload()
		return nil
	})
}

func (d *driver) Focus(id string) error {
	return d.viewCall(id, func(g *guest) error {
		_ = g.ctrl.MoveFocus(webview2.COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC)
		return nil
	})
}

// Close queues the removal for the thread of the window and returns: the sync loop closes the views of a
// vault that is locked, while the shutdown of the application waits for that loop (a Close that waited
// for the thread of the window would deadlock the two). The queue is in order, so the view is gone
// before the next call of the driver.
func (d *driver) Close(id string) error {
	d.onUI(func() {
		if g := d.guests[id]; g != nil {
			d.closeGuest(g)
		}
	})
	return nil
}

// CloseAll removes every view. On the thread of the window (a shutdown hook) it is done at once; from
// anywhere else (the watchdog that ends a quit that hangs) it is only queued.
func (d *driver) CloseAll() {
	d.closing.Store(true)
	if d.onUIThread() {
		d.closeAllNow()
		return
	}
	d.onUI(d.closeAllNow)
}

func (d *driver) closeAllNow() {
	for _, g := range d.guests {
		d.closeGuest(g)
	}
}

// closeGuest (UI thread) ends a view, made or not, and what only it used.
func (d *driver) closeGuest(g *guest) {
	if g.closed {
		return
	}
	g.closed = true
	g.finish(errGuestClosed)
	if d.guests[g.id] == g {
		delete(d.guests, g.id)
	}
	d.releaseFocus(g)
	if g.ctrl != nil {
		_ = g.ctrl.Close() // ends the renderer of the view: nothing is called after this
	}
	if g.web != nil {
		webview2.Release(unsafe.Pointer(g.web))
		g.web = nil
	}
	if g.ctrl != nil {
		webview2.Release(unsafe.Pointer(g.ctrl))
		g.ctrl = nil
	}
	for _, r := range g.release {
		r()
	}
	g.release = nil
	if g.env != nil {
		g.env.users--
		d.dropEnvironmentIfIdle(g.env)
	}
}

// releaseFocus (UI thread) gives the focus back to the window of the application when a view that is
// going away (hidden, closed) has it: a view that is not there must not keep the keys.
func (d *driver) releaseFocus(g *guest) {
	if g.focused {
		g.focused = false
		setFocus(d.hwnd())
	}
}

// layout (UI thread) puts the view where its fractions say, in the pixels of the window now.
func (d *driver) layout(g *guest) {
	if g.ctrl == nil {
		return
	}
	h := d.hwnd()
	w, ht := clientSize(h)
	r := physicalRect(g.norm, w, ht)
	_ = g.ctrl.PutBounds(webview2.RECT{Left: r.Left, Top: r.Top, Right: r.Right, Bottom: r.Bottom})
	// A window that is minimised hides its views (what WebView2 recommends); a restore shows them again.
	_ = g.ctrl.PutIsVisible(g.visible && !isIconic(h))
	_ = g.ctrl.NotifyParentWindowPositionChanged()
}

// relayoutAll follows the window. Events of a resize come in swarms: one pass is queued at a time.
func (d *driver) relayoutAll() {
	if !d.relayout.CompareAndSwap(false, true) {
		return
	}
	d.onUI(func() {
		d.relayout.Store(false)
		for _, g := range d.guests {
			d.layout(g)
		}
	})
}

// ---- Driver: policy, keys, data ---------------------------------------------------------------

func (d *driver) SetPolicy(p webview.Policy) {
	d.policyMu.Lock()
	d.policy = p
	d.policyMu.Unlock()
}

func (d *driver) ReserveKeys(accelerators []string) {
	set := reservedSet(accelerators)
	d.keysMu.Lock()
	d.reserved = set
	d.keysMu.Unlock()
}

// PersistentData: the user data folder keeps cookies and storage across a restart.
func (d *driver) PersistentData() bool { return true }

func (d *driver) Events() <-chan webview.Event { return d.events }

// RemoveData deletes the user data folder of a data store: the environment of the store is let go of (the
// Manager has closed its views), and the folder is deleted when the browser process that held it is gone.
func (d *driver) RemoveData(dataStore string) error {
	folder, err := userDataFolder(d.webappsDir, dataStore)
	if err != nil {
		return fmt.Errorf("remove data: %w", err)
	}
	store := strings.ToLower(dataStore)
	// In the queue of the window, after the Close of the views that the Manager closed just before.
	if err := d.callUI(func() error {
		e := d.envs[store]
		if e == nil {
			return nil
		}
		if e.users > 0 {
			return errors.New("the session data are in use")
		}
		d.dropEnvironmentIfIdle(e)
		return nil
	}); err != nil {
		return fmt.Errorf("remove data: %w", err)
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
