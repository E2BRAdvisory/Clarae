//go:build windows

//nolint:gosec // G103: a call into COM passes pointers as integers; each is the pointer of a COM object, or of a local that outlives the call
package nativeview

// What a guest is allowed, in one place (the counterpart of the list at the top of guest_darwin.m):
//
//   - No bridge. The settings turn off the channel of messages (IsWebMessageEnabled) and the host
//     objects; no handler of WebMessageReceived exists, and no script is ever added to a document.
//   - Only http and https in the top frame (the policy of Go, asked for every navigation, redirects
//     included; this file refuses the rest as well) and, in frames inside the page, also about, blob and
//     data.
//   - Downloads are cancelled before they write anything. Permission requests are denied. A new window is
//     not opened: its address is reported to Go.
//   - A certificate error cancels the load; the built-in error page, which is where WebView2 offers to go
//     on, is turned off. A login (basic authentication) and a client certificate are cancelled, never
//     answered.
//   - No developer tools, no context menu, no accelerator keys of the browser, no autofill, no password
//     manager, no zoom or pinch, no swipe, no status bar, no dialogs of the page.
//
// A guest cannot be made when the runtime of WebView2 lacks an interface this needs (the download, the
// certificate error, the client certificate and the basic authentication events, and the settings above
// are from versions of the runtime from 2020 to 2023): an old runtime must not run a guest with less
// protection, so the view is refused and the page opens in the system browser.
//
// What WebView2 cannot do, and macOS does (the file chooser is not denied: it is a dialog of the user's
// choice; keys and the pointer are not seen, only keys: see noteActivity; integrated authentication of
// Windows, NTLM and Kerberos, is the runtime's own business) is written where it matters below and in the
// matrix of manual tests.

import (
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"clarae/apps/desktop/internal/shell/nativeview/webview2"
	"clarae/apps/desktop/internal/shell/nativeview/webview2/loader"
	"clarae/apps/desktop/internal/webview"
)

// ---- COM objects of Go -------------------------------------------------------------------------

// handlerSet keeps alive the COM objects that WebView2 holds raw pointers to: until it has let go of the
// last reference.
type handlerSet struct {
	mu   sync.Mutex
	live map[uintptr]any
}

func (s *handlerSet) drop(self uintptr) {
	s.mu.Lock()
	delete(s.live, self)
	s.mu.Unlock()
}

// comBase is the IUnknown of a handler. The count starts at one: the reference of the driver, dropped
// with Release when the view ends. WebView2 takes its own with AddRef.
type comBase struct {
	refs atomic.Uint32
	self uintptr
	set  *handlerSet
}

// hold registers a handler (obj, which embeds base through its implementation) and returns it.
func hold[T any](s *handlerSet, base *comBase, obj *T) *T {
	base.self = uintptr(unsafe.Pointer(obj))
	base.set = s
	base.refs.Store(1)
	s.mu.Lock()
	s.live[base.self] = obj
	s.mu.Unlock()
	return obj
}

var iidIUnknown = webview2.NewGUID("{00000000-0000-0000-C000-000000000046}")

// ptrOf turns an address that came as an integer (the arguments of a callback) into a pointer, the way
// vet accepts for memory that is not Go's.
func ptrOf(u uintptr) unsafe.Pointer { return *(*unsafe.Pointer)(unsafe.Pointer(&u)) }

// QueryInterface answers for IUnknown only: WebView2 does not ask a handler for anything else, and E_NOINTERFACE
// is the honest answer to a question that is asked.
func (c *comBase) QueryInterface(riid, ppv uintptr) uintptr {
	out := (*uintptr)(ptrOf(ppv))
	if out == nil {
		return uintptr(windows.E_POINTER)
	}
	if id := (*webview2.GUID)(ptrOf(riid)); id != nil && webview2.IsEqualGUID(id, iidIUnknown) {
		c.refs.Add(1)
		*out = c.self
		return uintptr(windows.S_OK)
	}
	*out = 0
	return uintptr(windows.E_NOINTERFACE)
}

func (c *comBase) AddRef() uintptr { return uintptr(c.refs.Add(1)) }

func (c *comBase) Release() uintptr {
	n := c.refs.Add(^uint32(0)) // minus one
	if n == 0 && c.set != nil {
		c.set.drop(c.self)
	}
	return uintptr(n)
}

// The handlers. Each calls a function of the driver and answers S_OK (0): what the function decided is
// in the arguments it was given.
type (
	envDone struct {
		f func(hr loader.HRESULT, env *loader.ICoreWebView2Environment)
	}
	controllerDone struct {
		comBase
		f func(code uintptr, c *webview2.ICoreWebView2Controller)
	}
	navStarting struct {
		comBase
		f func(*webview2.ICoreWebView2NavigationStartingEventArgs)
	}
	navCompleted struct {
		comBase
		f func(*webview2.ICoreWebView2NavigationCompletedEventArgs)
	}
	newWindow struct {
		comBase
		f func(*webview2.ICoreWebView2NewWindowRequestedEventArgs)
	}
	permission struct {
		comBase
		f func(*webview2.ICoreWebView2PermissionRequestedEventArgs)
	}
	download struct {
		comBase
		f func(*webview2.ICoreWebView2DownloadStartingEventArgs)
	}
	serverCert struct {
		comBase
		f func(*webview2.ICoreWebView2ServerCertificateErrorDetectedEventArgs)
	}
	clientCert struct {
		comBase
		f func(*webview2.ICoreWebView2ClientCertificateRequestedEventArgs)
	}
	basicAuth struct {
		comBase
		f func(*webview2.ICoreWebView2BasicAuthenticationRequestedEventArgs)
	}
	processFailed struct {
		comBase
		f func(*webview2.ICoreWebView2ProcessFailedEventArgs)
	}
	accelKey struct {
		comBase
		f func(*webview2.ICoreWebView2AcceleratorKeyPressedEventArgs)
	}
	focusChanged struct {
		comBase
		f func()
	}
	sourceChanged struct {
		comBase
		f func()
	}
	titleChanged struct {
		comBase
		f func()
	}
	historyChanged struct {
		comBase
		f func()
	}
)

func (h *envDone) EnvironmentCompleted(hr loader.HRESULT, env *loader.ICoreWebView2Environment) loader.HRESULT {
	h.f(hr, env)
	return 0
}

func (h *controllerDone) CreateCoreWebView2ControllerCompleted(code uintptr, c *webview2.ICoreWebView2Controller) uintptr {
	h.f(code, c)
	return 0
}

func (h *navStarting) NavigationStarting(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2NavigationStartingEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *navCompleted) NavigationCompleted(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2NavigationCompletedEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *newWindow) NewWindowRequested(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2NewWindowRequestedEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *permission) PermissionRequested(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2PermissionRequestedEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *download) DownloadStarting(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2DownloadStartingEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *serverCert) ServerCertificateErrorDetected(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2ServerCertificateErrorDetectedEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *clientCert) ClientCertificateRequested(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2ClientCertificateRequestedEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *basicAuth) BasicAuthenticationRequested(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2BasicAuthenticationRequestedEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *processFailed) ProcessFailed(_ *webview2.ICoreWebView2, a *webview2.ICoreWebView2ProcessFailedEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *accelKey) AcceleratorKeyPressed(_ *webview2.ICoreWebView2Controller, a *webview2.ICoreWebView2AcceleratorKeyPressedEventArgs) uintptr {
	h.f(a)
	return 0
}

func (h *focusChanged) FocusChanged(_ *webview2.ICoreWebView2Controller, _ *webview2.IUnknown) uintptr {
	h.f()
	return 0
}

func (h *sourceChanged) SourceChanged(_ *webview2.ICoreWebView2, _ *webview2.ICoreWebView2SourceChangedEventArgs) uintptr {
	h.f()
	return 0
}

func (h *titleChanged) DocumentTitleChanged(_ *webview2.ICoreWebView2, _ *webview2.IUnknown) uintptr {
	h.f()
	return 0
}

func (h *historyChanged) HistoryChanged(_ *webview2.ICoreWebView2, _ *webview2.IUnknown) uintptr {
	h.f()
	return 0
}

// deny is what a handler does if its body panics: the refusal it was there to give. A panic in a callback
// of COM, on a thread that is not Go's to unwind, would take the application down.
func deny(refuse func()) {
	if r := recover(); r != nil {
		refuse()
	}
}

// ---- the wiring of a view ---------------------------------------------------------------------

// wire (UI thread) sets the settings of a view and registers its handlers. Any failure fails the view:
// a guest runs with every one of them or not at all.
func (d *driver) wire(g *guest) error {
	var first error
	check := func(what string, err error) {
		if err != nil && first == nil {
			first = fmt.Errorf("%s: %w", what, err)
		}
	}
	web, ctrl := g.web, g.ctrl

	// ---- settings
	s, err := web.GetSettings()
	if err != nil || s == nil {
		return fmt.Errorf("settings: %w", orFailed(err))
	}
	defer webview2.Release(unsafe.Pointer(s))
	check("web messages off", s.PutIsWebMessageEnabled(false)) // window.chrome.webview.postMessage: no channel to the host
	check("host objects off", s.PutAreHostObjectsAllowed(false))
	check("developer tools off", s.PutAreDevToolsEnabled(false))
	check("context menu off", s.PutAreDefaultContextMenusEnabled(false)) // "open in new window", "save as", "inspect"
	// Dialogs of the page (alert, confirm, prompt, beforeunload): none is shown, and with no handler for
	// ScriptDialogOpening each is dismissed: an alert goes on, a confirm says no, a prompt says nothing,
	// as in guest_darwin.m.
	check("dialogs off", s.PutAreDefaultScriptDialogsEnabled(false))
	check("status bar off", s.PutIsStatusBarEnabled(false))
	check("zoom control off", s.PutIsZoomControlEnabled(false))
	check("built-in error page off", s.PutIsBuiltInErrorPageEnabled(false)) // where the browser offers to go on past a certificate
	if s3 := s.GetICoreWebView2Settings3(); s3 != nil {
		defer webview2.Release(unsafe.Pointer(s3))
		check("browser keys off", s3.PutAreBrowserAcceleratorKeysEnabled(false)) // print, save, find, devtools, reload
	} else {
		check("settings 3", errMissing)
	}
	if s4 := s.GetICoreWebView2Settings4(); s4 != nil {
		defer webview2.Release(unsafe.Pointer(s4))
		check("password saving off", s4.PutIsPasswordAutosaveEnabled(false))
		check("autofill off", s4.PutIsGeneralAutofillEnabled(false))
	} else {
		check("settings 4", errMissing)
	}
	if s5 := s.GetICoreWebView2Settings5(); s5 != nil {
		defer webview2.Release(unsafe.Pointer(s5))
		check("pinch zoom off", s5.PutIsPinchZoomEnabled(false))
	} else {
		check("settings 5", errMissing)
	}
	if s6 := s.GetICoreWebView2Settings6(); s6 != nil {
		defer webview2.Release(unsafe.Pointer(s6))
		check("swipe navigation off", s6.PutIsSwipeNavigationEnabled(false))
	} else {
		check("settings 6", errMissing)
	}
	// The user agent stays the one of the runtime (Edge): a Chromium that called itself Safari would be a
	// lie that sites see through (guest_darwin.m does it because WebKit is Safari's engine).
	if first != nil {
		return first
	}

	// ---- navigation: the policy of Go, for the top frame and for the frames inside the page
	nav := func(main bool) *navStarting {
		h := &navStarting{}
		h.f = func(a *webview2.ICoreWebView2NavigationStartingEventArgs) {
			defer deny(func() { _ = a.PutCancel(true) })
			d.navigationStarting(g, a, main)
		}
		return h
	}
	top := nav(true)
	_, err = web.AddNavigationStarting(own(d, g, &top.comBase, webview2.NewICoreWebView2NavigationStartingEventHandler(top)))
	check("navigation handler", err)
	frame := nav(false)
	_, err = web.AddFrameNavigationStarting(own(d, g, &frame.comBase, webview2.NewICoreWebView2NavigationStartingEventHandler(frame)))
	check("frame navigation handler", err)

	done := &navCompleted{}
	done.f = func(a *webview2.ICoreWebView2NavigationCompletedEventArgs) { d.navigationCompleted(g, a) }
	_, err = web.AddNavigationCompleted(own(d, g, &done.comBase, webview2.NewICoreWebView2NavigationCompletedEventHandler(done)))
	check("navigation completed handler", err)

	// ---- state
	src := &sourceChanged{f: func() { d.push(g) }}
	_, err = web.AddSourceChanged(own(d, g, &src.comBase, webview2.NewICoreWebView2SourceChangedEventHandler(src)))
	check("source handler", err)
	title := &titleChanged{f: func() { d.push(g) }}
	_, err = web.AddDocumentTitleChanged(own(d, g, &title.comBase, webview2.NewICoreWebView2DocumentTitleChangedEventHandler(title)))
	check("title handler", err)
	hist := &historyChanged{f: func() { d.push(g) }}
	_, err = web.AddHistoryChanged(own(d, g, &hist.comBase, webview2.NewICoreWebView2HistoryChangedEventHandler(hist)))
	check("history handler", err)
	crash := &processFailed{}
	crash.f = func(a *webview2.ICoreWebView2ProcessFailedEventArgs) { d.processFailed(g, a) }
	_, err = web.AddProcessFailed(own(d, g, &crash.comBase, webview2.NewICoreWebView2ProcessFailedEventHandler(crash)))
	check("process handler", err)

	// ---- what the page asks for: nothing is opened, nothing is given
	nw := &newWindow{}
	nw.f = func(a *webview2.ICoreWebView2NewWindowRequestedEventArgs) {
		defer deny(func() { _ = a.PutHandled(true) })
		d.newWindowRequested(g, a)
	}
	_, err = web.AddNewWindowRequested(own(d, g, &nw.comBase, webview2.NewICoreWebView2NewWindowRequestedEventHandler(nw)))
	check("new window handler", err)
	pm := &permission{}
	pm.f = func(a *webview2.ICoreWebView2PermissionRequestedEventArgs) {
		defer deny(func() { _ = a.PutState(webview2.COREWEBVIEW2_PERMISSION_STATE_DENY) })
		d.permissionRequested(g, a)
	}
	_, err = web.AddPermissionRequested(own(d, g, &pm.comBase, webview2.NewICoreWebView2PermissionRequestedEventHandler(pm)))
	check("permission handler", err)

	// The events of the newer interfaces (the runtime must have them: see the top of the file).
	if w4 := web.GetICoreWebView2_4(); w4 != nil {
		defer webview2.Release(unsafe.Pointer(w4))
		dl := &download{}
		dl.f = func(a *webview2.ICoreWebView2DownloadStartingEventArgs) {
			defer deny(func() { _ = a.PutCancel(true); _ = a.PutHandled(true) })
			d.downloadStarting(g, a)
		}
		_, err = w4.AddDownloadStarting(own(d, g, &dl.comBase, webview2.NewICoreWebView2DownloadStartingEventHandler(dl)))
		check("download handler", err)
	} else {
		check("downloads (ICoreWebView2_4)", errMissing)
	}
	if w5 := web.GetICoreWebView2_5(); w5 != nil {
		defer webview2.Release(unsafe.Pointer(w5))
		cc := &clientCert{}
		cc.f = func(a *webview2.ICoreWebView2ClientCertificateRequestedEventArgs) {
			defer deny(func() { _ = a.PutCancel(true); _ = a.PutHandled(true) })
			d.clientCertificateRequested(g, a)
		}
		_, err = w5.AddClientCertificateRequested(own(d, g, &cc.comBase, webview2.NewICoreWebView2ClientCertificateRequestedEventHandler(cc)))
		check("client certificate handler", err)
	} else {
		check("client certificates (ICoreWebView2_5)", errMissing)
	}
	if w10 := web.GetICoreWebView2_10(); w10 != nil {
		defer webview2.Release(unsafe.Pointer(w10))
		ba := &basicAuth{}
		ba.f = func(a *webview2.ICoreWebView2BasicAuthenticationRequestedEventArgs) {
			defer deny(func() { _ = a.PutCancel(true) })
			d.basicAuthenticationRequested(g, a)
		}
		_, err = w10.AddBasicAuthenticationRequested(own(d, g, &ba.comBase, webview2.NewICoreWebView2BasicAuthenticationRequestedEventHandler(ba)))
		check("authentication handler", err)
	} else {
		check("basic authentication (ICoreWebView2_10)", errMissing)
	}
	if w14 := web.GetICoreWebView2_14(); w14 != nil {
		defer webview2.Release(unsafe.Pointer(w14))
		sc := &serverCert{}
		sc.f = func(a *webview2.ICoreWebView2ServerCertificateErrorDetectedEventArgs) {
			defer deny(func() { _ = a.PutAction(webview2.COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL) })
			d.serverCertificateError(g, a)
		}
		_, err = w14.AddServerCertificateErrorDetected(own(d, g, &sc.comBase, webview2.NewICoreWebView2ServerCertificateErrorDetectedEventHandler(sc)))
		check("certificate handler", err)
	} else {
		check("certificate errors (ICoreWebView2_14)", errMissing)
	}

	// ---- the keyboard: reserved shortcuts, focus and activity
	ak := &accelKey{}
	ak.f = func(a *webview2.ICoreWebView2AcceleratorKeyPressedEventArgs) { d.acceleratorKey(g, a) }
	_, err = ctrl.AddAcceleratorKeyPressed(own(d, g, &ak.comBase, webview2.NewICoreWebView2AcceleratorKeyPressedEventHandler(ak)))
	check("accelerator handler", err)
	got := &focusChanged{f: func() {
		g.focused = true
		d.emit(webview.Event{ID: g.id, Kind: webview.EvFocus})
		d.noteActivity(g)
	}}
	_, err = ctrl.AddGotFocus(own(d, g, &got.comBase, webview2.NewICoreWebView2FocusChangedEventHandler(got)))
	check("focus handler", err)
	lost := &focusChanged{f: func() { g.focused = false }}
	_, err = ctrl.AddLostFocus(own(d, g, &lost.comBase, webview2.NewICoreWebView2FocusChangedEventHandler(lost)))
	check("focus lost handler", err)
	return first
}

// own registers a handler of a view (hold) and notes our reference to it, which is dropped when the view
// ends. It returns the object to give to WebView2.
func own[T any](d *driver, g *guest, base *comBase, obj *T) *T {
	g.release = append(g.release, func() { base.Release() })
	return hold(d.reg, base, obj)
}

type missingError struct{}

func (missingError) Error() string {
	return "the WebView2 runtime is too old for this (it needs 1.0.2210.55 or later: update it)"
}

var errMissing error = missingError{}

// ---- what a handler does ----------------------------------------------------------------------

// allow asks the policy of Go whether a navigation may go on, and checks the scheme as well.
func (d *driver) allow(id, rawURL string, mainFrame bool) bool {
	d.policyMu.RLock()
	p := d.policy
	d.policyMu.RUnlock()
	if p == nil || !p(id, rawURL, mainFrame) {
		return false // Go reports what it refuses
	}
	if !navigationScheme(rawURL, mainFrame) {
		d.emit(webview.Event{ID: id, Kind: webview.EvBlocked, URL: rawURL, Text: string(webview.BlockScheme), MainFrame: mainFrame})
		return false
	}
	return true
}

func (d *driver) navigationStarting(g *guest, a *webview2.ICoreWebView2NavigationStartingEventArgs, main bool) {
	uri, err := a.GetUri()
	if err != nil || !d.allow(g.id, uri, main) {
		_ = a.PutCancel(true) // an address that cannot be read is not one that may be loaded
		return
	}
	if main {
		g.loading, g.navURL, g.certFailed = true, uri, false
		d.push(g)
	}
}

func (d *driver) navigationCompleted(g *guest, a *webview2.ICoreWebView2NavigationCompletedEventArgs) {
	g.loading = false
	if ok, err := a.GetIsSuccess(); err == nil && !ok {
		status, _ := a.GetWebErrorStatus()
		if uint32(status) != webErrorCancelled { // our own refusal, or a newer navigation
			d.emit(webview.Event{
				ID: g.id, Kind: webview.EvError, URL: g.navURL, Text: webErrorText(uint32(status)), Code: int(status),
				Certificate: isCertificateStatus(uint32(status)) || g.certFailed,
			})
		}
	}
	d.push(g)
}

// push reports the state of the view: address, title, loading, history.
func (d *driver) push(g *guest) {
	if g.web == nil || g.closed {
		return
	}
	u, _ := g.web.GetSource()
	t, _ := g.web.GetDocumentTitle()
	back, _ := g.web.GetCanGoBack()
	fwd, _ := g.web.GetCanGoForward()
	d.emit(webview.Event{ID: g.id, Kind: webview.EvState, URL: u, Title: t, Loading: g.loading, CanGoBack: back, CanGoForward: fwd})
}

func (d *driver) processFailed(g *guest, a *webview2.ICoreWebView2ProcessFailedEventArgs) {
	kind, err := a.GetProcessFailedKind()
	if err != nil {
		return
	}
	switch kind {
	case webview2.COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED, webview2.COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED:
		d.emit(webview.Event{ID: g.id, Kind: webview.EvCrash})
	}
}

// newWindowRequested: nothing is opened; the address is reported. UserGesture is what WebView2 says (the
// request came from a click or a key) and that the view is shown; unlike macOS it cannot be refined by the
// time since the last key or click, which this driver does not see (see noteActivity).
func (d *driver) newWindowRequested(g *guest, a *webview2.ICoreWebView2NewWindowRequestedEventArgs) {
	_ = a.PutHandled(true)
	uri, _ := a.GetUri()
	gesture, _ := a.GetIsUserInitiated()
	d.emit(webview.Event{ID: g.id, Kind: webview.EvNewWindow, URL: uri, UserGesture: gesture && g.visible && !isIconic(d.hwnd())})
}

func (d *driver) permissionRequested(g *guest, a *webview2.ICoreWebView2PermissionRequestedEventArgs) {
	_ = a.PutState(webview2.COREWEBVIEW2_PERMISSION_STATE_DENY)
	kind, _ := a.GetPermissionKind()
	uri, _ := a.GetUri()
	d.emit(webview.Event{ID: g.id, Kind: webview.EvPermission, Text: permissionName(uint32(kind)), URL: originHost(uri)})
}

func (d *driver) downloadStarting(g *guest, a *webview2.ICoreWebView2DownloadStartingEventArgs) {
	_ = a.PutCancel(true)
	_ = a.PutHandled(true) // no download dialog either
	uri := ""
	if op, err := a.GetDownloadOperation(); err == nil && op != nil {
		uri, _ = op.GetUri()
		webview2.Release(unsafe.Pointer(op))
	}
	d.emit(webview.Event{ID: g.id, Kind: webview.EvDownload, URL: uri})
}

// serverCertificateError: never "always allow", never the default (the page of the browser that offers to
// go on). The load fails, and navigationCompleted reports it as a certificate error.
func (d *driver) serverCertificateError(g *guest, a *webview2.ICoreWebView2ServerCertificateErrorDetectedEventArgs) {
	_ = a.PutAction(webview2.COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)
	if uri, err := a.GetRequestUri(); err == nil && uri == g.navURL {
		g.certFailed = true
	}
}

// clientCertificateRequested: no certificate is offered, and the dialog of the system that would let the
// user pick one is not shown (guest_darwin.m cancels the challenge in the same way).
func (d *driver) clientCertificateRequested(g *guest, a *webview2.ICoreWebView2ClientCertificateRequestedEventArgs) {
	_ = a.PutCancel(true)
	_ = a.PutHandled(true)
	host, _ := a.GetHost()
	d.emit(webview.Event{ID: g.id, Kind: webview.EvBlocked, URL: host, Text: "authentication", MainFrame: true})
}

// basicAuthenticationRequested: no login is asked of the user or answered; the load fails and the UI is told.
func (d *driver) basicAuthenticationRequested(g *guest, a *webview2.ICoreWebView2BasicAuthenticationRequestedEventArgs) {
	_ = a.PutCancel(true)
	uri, _ := a.GetUri()
	d.emit(webview.Event{ID: g.id, Kind: webview.EvBlocked, URL: originHost(uri), Text: "authentication", MainFrame: true})
}

// acceleratorKey: the controller sees a key before the page does. A reserved one goes to Go (and so to the
// command of the application of the same name) and is consumed; every key counts as activity.
func (d *driver) acceleratorKey(g *guest, a *webview2.ICoreWebView2AcceleratorKeyPressedEventArgs) {
	kind, err := a.GetKeyEventKind()
	if err != nil {
		return
	}
	if kind != webview2.COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN && kind != webview2.COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN {
		return
	}
	d.noteActivity(g)
	vk, err := a.GetVirtualKey()
	if err != nil {
		return
	}
	acc := accelerator(keyDown(vkControl), keyDown(vkMenu), keyDown(vkShift), keyName(vk, layoutChar))
	if acc == "" {
		return
	}
	d.keysMu.RLock()
	reserved := d.reserved[acc]
	d.keysMu.RUnlock()
	if reserved {
		_ = a.PutHandled(true)
		d.emit(webview.Event{ID: g.id, Kind: webview.EvKey, Text: acc})
	}
}

// noteActivity tells Go that the user is working in the view, at most every few seconds: the keys and the
// pointer of a view never reach the web view of the application, which is what the idle lock of a private
// vault listens to. On Windows only the keys and the focus are seen: WebView2 gives the host no mouse or
// wheel events in this mode, so a user who only reads and scrolls an application is idle for the lock.
func (d *driver) noteActivity(g *guest) {
	now := time.Now()
	if now.Sub(g.lastActivity) < activityInterval {
		return
	}
	g.lastActivity = now
	d.emit(webview.Event{ID: g.id, Kind: webview.EvActivity})
}
