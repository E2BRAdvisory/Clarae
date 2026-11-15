// Package webview is the core of the "applications" of a vault (M18, track E): a web page that opens
// in a browser embedded in a tab. The page runs in a native web view that the platform adds as a
// child of the window of the application (internal/shell/nativeview, macOS only); this package holds
// everything that does not depend on the platform and builds to WebAssembly like the rest of the
// core:
//
//   - the Driver interface that a platform implements, and Fake, an in-memory one for the tests;
//   - ValidateURL, the one rule for what a guest may be pointed at;
//   - Manager, which owns the views (identifier, vault, limits, data store, navigation policy, the
//     events towards the UI).
//
// A guest is untrusted web content. It gets no bridge, no message handler and no user script, only
// http and https reach its main frame, downloads, permission requests and new windows are refused,
// and a certificate error is a failed load, never a choice. The core never opens a view of its own
// accord: the UI asks for each one (a tab restored with the layout loads nothing until it is shown).
package webview

// Bounds is a rectangle of the window, normalised: every value is a fraction (0..1) of the content
// view of the window, with the origin at its top-left corner. The content view is what the web view
// of the application fills, so a UI that measures an element against its viewport (the rectangle
// divided by the size of the viewport) gets the same number whatever the pixel ratio of the display
// and whatever the zoom of the application.
type Bounds struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// EventKind says what a Driver reports about a guest.
type EventKind int

// What a driver reports (Event.Kind).
const (
	// EvState: URL, Title, Loading, CanGoBack and CanGoForward changed.
	EvState EventKind = iota + 1
	// EvNewWindow: the page asked for a new window (target=_blank, window.open); URL, UserGesture. Nothing was opened.
	EvNewWindow
	// EvBlocked: a navigation was cancelled by the platform; URL, Text is the reason (a BlockReason), MainFrame.
	EvBlocked
	// EvDownload: a download was refused; URL.
	EvDownload
	// EvPermission: a permission request was denied; Text names it (media-capture, file-chooser, ...), URL is the host that asked.
	EvPermission
	// EvKey: a reserved accelerator was pressed in the guest; Text is the accelerator.
	EvKey
	// EvError: a load failed; URL, Text (the message), Code (the code of the platform), Certificate.
	EvError
	// EvCrash: the process that renders the page ended.
	EvCrash
	// EvFocus: the guest took the keyboard focus.
	EvFocus
	// EvActivity: the user is working in the guest (a key, a click, a scroll). A driver reports it at
	// most every few seconds; the page never sees that it was reported.
	EvActivity
)

// Event is one report of a guest. A driver delivers it from a goroutine of its own, never from the
// thread of the UI toolkit: the consumer may block.
type Event struct {
	// ID is the identifier the Manager gave the view in Create.
	ID   string
	Kind EventKind
	URL  string
	// Title and Text depend on Kind (see the constants).
	Title string
	Text  string
	// Code is the error code of the platform (EvError).
	Code    int
	Loading bool
	// CanGoBack and CanGoForward are the state of the history (EvState).
	CanGoBack    bool
	CanGoForward bool
	// MainFrame: the target of a cancelled navigation was the top frame (EvBlocked).
	MainFrame bool
	// UserGesture: the user worked in the guest a moment ago and the guest is shown (EvNewWindow). A
	// window that a page asks for without one is not forwarded to the system browser.
	UserGesture bool
	// Certificate: the load failed because of the certificate of the server (EvError). There is
	// no way around it.
	Certificate bool
}

// Policy decides whether a navigation that the page chose (a link, a script, a redirect) may go on.
// The driver asks it synchronously, on the thread of the toolkit that needs the answer: it must
// return at once and never wait for that thread. mainFrame tells the top frame from a frame inside
// the page. Without a policy a driver refuses everything.
type Policy func(id, rawURL string, mainFrame bool) (allow bool)

// Driver is what a platform provides: a native web view as a child of the window of the
// application. Every method may be called from any goroutine; a driver moves the work to the
// thread of its toolkit. A view is identified by the id the Manager chooses, unique in the process.
type Driver interface {
	// Create adds a guest above the web view of the application. dataStore is the stable
	// identifier (a UUID) of its session data: guests that share it share cookies and storage.
	// The URL has been through ValidateURL.
	Create(id, rawURL string, b Bounds, dataStore string) error
	SetBounds(id string, b Bounds) error
	SetVisible(id string, visible bool) error
	// Navigate loads rawURL (validated by the caller).
	Navigate(id, rawURL string) error
	Back(id string) error
	Forward(id string) error
	Reload(id string) error
	// Focus gives the guest the keyboard focus.
	Focus(id string) error
	// Close removes the guest. It is not an error to close a guest the platform no longer knows. It
	// need not wait for the platform: the guest is gone before any later call of the driver is carried
	// out, which is all the Manager relies on. (A lock of a vault closes its views from the goroutine
	// of the sync loop, which the shutdown of the application waits for on the thread of the toolkit:
	// a Close that waited for that thread could deadlock the two.)
	Close(id string) error
	// CloseAll removes every guest (the application exits). It runs while the application quits, on
	// the thread of the toolkit (a shutdown hook) or on a goroutine of the watchdog that ends a quit
	// the toolkit left hanging: it must neither wait for that thread, which may be the caller or may be
	// gone, nor fail. On that thread it does the work at once; elsewhere it only queues it.
	CloseAll()
	// ReserveKeys sets the accelerators the guest hands to the application (EvKey) instead of
	// consuming them. The syntax is the one of ParseAccelerator.
	ReserveKeys(accelerators []string)
	// SetPolicy installs the navigation policy.
	SetPolicy(p Policy)
	// RemoveData deletes the session data (cookies, storage, caches) stored under dataStore. No
	// guest uses it when the Manager calls this.
	RemoveData(dataStore string) error
	// PersistentData reports whether session data survive a restart: false where the platform
	// can only give a guest a data store that lives in memory (macOS before 14).
	PersistentData() bool
	// Events is the stream of reports. It is closed only by a driver that is stopped for good
	// (tests): the Manager stops listening when it is closed.
	Events() <-chan Event
}
