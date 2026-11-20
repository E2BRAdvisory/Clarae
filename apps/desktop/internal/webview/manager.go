package webview

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/events"
)

// The errors of Manager. A caller tells them apart with errors.Is.
var (
	// ErrUnavailable: there is no driver (a platform that has none, the browser build) or the
	// application is quitting.
	ErrUnavailable = errors.New("the embedded browser is not available")
	// ErrNotFound: no such view, or it belongs to another vault.
	ErrNotFound = errors.New("no such view")
	// ErrLimit: too many views are open.
	ErrLimit = errors.New("too many views are open")
	// ErrBounds: the rectangle is not a part of the window.
	ErrBounds = errors.New("invalid bounds")
	// ErrDriver wraps the failure of the platform.
	ErrDriver = errors.New("the platform could not do it")
	// ErrUnknownView is what a driver returns for an id it does not know; the Manager takes the view
	// as gone.
	ErrUnknownView = errors.New("unknown view")
)

// Limits on the views. A web view is a process and some hundred megabytes: the numbers are far
// above what a person keeps open in tabs and stop a loop of the UI.
const (
	MaxViewsPerVault = 32
	MaxViewsTotal    = 64
)

// newWindowInterval is the least time between two requests for a new window of a view that reach
// the system browser: a page that opens windows in a loop gets one.
const newWindowInterval = time.Second

// Options are what a Manager needs from the application.
type Options struct {
	// Driver returns the driver of the platform, or nil where there is none. It is called when
	// the first call needs it (the window of the application exists only once it runs) and again
	// while it answers nil; it must return at once.
	Driver func() Driver
	// Emit delivers the events to the UI (App.emit).
	Emit events.Emitter
	// OpenExternal sends an address to the system browser. It receives only what passed ValidateURL.
	OpenExternal func(rawURL string)
	// DataStore returns the identifier of the session data of a vault (nil = DataStoreID, derived from the
	// vault id). The application persists one per vault, so that a different vault that is later opened
	// at the same path does not inherit the cookies of the previous one.
	DataStore func(vaultID string) (string, error)
	// OnActivity is called when the user works in a view: the pointer and the keys never reach the
	// web view of the application, which is what the idle lock of a private vault listens to.
	OnActivity func()
	Logger     zerolog.Logger
	// Now is the clock (replaced in tests).
	Now func() time.Time
}

// Manager owns the views of the applications: who they belong to, how many there can be, what a
// page may navigate to, and the stream of events towards the UI. It never opens a view by itself.
//
// Locking. mu guards the table of views and the driver; initMu only serialises the first resolution of the driver. Neither is ever held while a driver is called after that first time
// (a driver call waits for the thread of the UI toolkit, which may be waiting for mu) and never
// while an event is sent. The navigation policy runs on that thread and takes mu briefly.
type Manager struct {
	opts Options
	log  zerolog.Logger

	initMu   sync.Mutex // serialises the resolution of the driver
	mu       sync.Mutex
	drv      Driver
	views    map[string]*view
	perVault map[string]int
	seq      uint64
	keys     []string
	closed   bool // Shutdown ran: nothing opens any more
	// broken: the driver said the platform cannot show views (ErrPlatformUnavailable) before it made any. For the
	// rest of the session driver() answers nil, so Available() is false and no call reaches the driver again.
	broken      bool
	everCreated bool // the driver made a view in this session

	// internal carries what the navigation policy reports to the pump (it must not send events on the thread of the toolkit).
	internal chan Event
	done     chan struct{}
}

// view is one guest.
type view struct {
	id, vault string
	// userAddrs are the private hosts (host:port, see URLInfo.Authority) that the user chose, by opening
	// the view on one or navigating it to one. A page may go to one of them whatever page it is on. A
	// navigation of the user to a public host empties the set: what was chosen for one site is not
	// extended to the next one.
	userAddrs map[string]bool
	// curPrivate: the main frame is, as far as the policy has seen, on a private host. A page on a
	// private host may go to other private hosts (a tool of the local network links its neighbours); a
	// page on a public host that was reached from one may not.
	curPrivate bool
	// pendingPublic: the last navigation of unknown frame that was let through went to a public host and the top frame
	// has not said since that it is there (MainFrameNotice). It may be the top frame leaving a private host, or a frame
	// inside the page: only a redirect that follows it needs the difference (see framePolicy).
	pendingPublic bool
	visible       bool
	created       bool // the driver has made it
	lastNewWindow time.Time
}

// choose records an address the user picked (Open, Navigate).
func (v *view) choose(info URLInfo) {
	if !info.Private {
		v.userAddrs = nil
		return
	}
	if v.userAddrs == nil {
		v.userAddrs = map[string]bool{}
	}
	v.userAddrs[info.Authority] = true
}

// mayGoTo says whether a page of this view may take the main frame (or open a window) at an address
// without the user having asked: public hosts always; a private one only when the user chose it or the
// page is itself on a private host. Called with Manager.mu held.
func (v *view) mayGoTo(info URLInfo, onPrivate bool) bool {
	return !info.Private || onPrivate || v.userAddrs[info.Authority]
}

// NewManager returns a Manager with no views.
func NewManager(o Options) *Manager {
	if o.Now == nil {
		o.Now = time.Now
	}
	return &Manager{
		opts: o, log: o.Logger.With().Str("module", "webview").Logger(),
		views: map[string]*view{}, perVault: map[string]int{},
		internal: make(chan Event, 64), done: make(chan struct{}),
	}
}

// driver returns the driver, resolving it on first use; nil when there is none. The driver is
// published only once its policy, its reserved keys and the stream of its events are in place, so
// no view is made before the policy that judges its first request.
func (m *Manager) driver() Driver {
	m.mu.Lock()
	d, closed, broken := m.drv, m.closed, m.broken
	m.mu.Unlock()
	if broken {
		return nil
	}
	if d != nil || closed || m.opts.Driver == nil {
		return d
	}
	m.initMu.Lock()
	defer m.initMu.Unlock()
	m.mu.Lock()
	d, closed = m.drv, m.closed
	keys := append([]string(nil), m.keys...)
	m.mu.Unlock()
	if d != nil || closed {
		return d
	}
	if d = m.opts.Driver(); d == nil {
		return nil
	}
	d.SetPolicy(m.policy)
	if fd, ok := d.(FrameAwareDriver); ok {
		fd.SetFramePolicy(m.framePolicy, m.mainFrameStarted)
	}
	d.ReserveKeys(keys)
	go m.pump(d.Events())
	m.mu.Lock()
	m.drv = d
	m.mu.Unlock()
	return d
}

// Available reports whether there is a driver: whether the platform can show a view. It is false for the rest of
// the session once the driver has said, before making any view, that the platform cannot (ErrPlatformUnavailable).
func (m *Manager) Available() bool { return m.driver() != nil }

// PersistentData reports whether the session data of the applications survive a restart.
func (m *Manager) PersistentData() bool {
	d := m.driver()
	return d != nil && d.PersistentData()
}

// Count returns the number of open views (of a vault, or all when vaultID is "").
func (m *Manager) Count(vaultID string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if vaultID == "" {
		return len(m.views)
	}
	return m.perVault[vaultID]
}

// ---- the calls of the UI ---------------------------------------------------------------------

// Open creates a view of vaultID on rawURL and returns its id. The address has been through
// ValidateURL; a private host is allowed because the caller (the user, through the UI) chose it.
func (m *Manager) Open(vaultID, rawURL string, b Bounds) (string, error) {
	d := m.driver()
	if d == nil {
		return "", ErrUnavailable
	}
	info, err := Inspect(rawURL)
	if err != nil {
		return "", err
	}
	b, err = checkBounds(b)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	switch {
	case m.closed:
		m.mu.Unlock()
		return "", ErrUnavailable
	case m.perVault[vaultID] >= MaxViewsPerVault || len(m.views) >= MaxViewsTotal:
		m.mu.Unlock()
		return "", ErrLimit
	}
	m.seq++
	id := "wv" + strconv.FormatUint(m.seq, 10)
	v := &view{id: id, vault: vaultID, visible: true, curPrivate: info.Private}
	v.choose(info)
	m.views[id] = v // before the driver makes it: its first reports find the view
	m.perVault[vaultID]++
	m.mu.Unlock()

	store, err := m.storeOf(vaultID)
	if err != nil {
		m.forget(id)
		return "", fmt.Errorf("%w: %w", ErrDriver, err)
	}
	if err := d.Create(id, rawURL, b, store); err != nil {
		m.forget(id)
		if errors.Is(err, ErrPlatformUnavailable) {
			m.markUnavailable(err)
			return "", fmt.Errorf("%w: %w", ErrUnavailable, err)
		}
		return "", fmt.Errorf("%w: %w", ErrDriver, err)
	}
	m.mu.Lock()
	cur, still := m.views[id]
	broken := m.broken
	if still && !broken {
		cur.created = true
		m.everCreated = true
	}
	m.mu.Unlock()
	if broken { // another Open found the platform unable while this one was made: the session is on the fallback
		m.forget(id)
		_ = d.Close(id)
		return "", ErrUnavailable
	}
	if !still { // the vault was closed, or the application is quitting, while the driver worked
		_ = d.Close(id)
		return "", ErrNotFound
	}
	m.log.Debug().Str("view", id).Str("url", describe(rawURL)).Msg("view opened")
	return id, nil
}

// markUnavailable takes the driver as unavailable for the rest of the session, when the platform said it cannot show
// views (Driver.Create returned ErrPlatformUnavailable) and nothing was ever shown: a driver that already runs views
// keeps them (the failure is then one of that view, and the caller is told it as "unavailable" all the same).
func (m *Manager) markUnavailable(cause error) {
	m.mu.Lock()
	first := !m.broken && !m.everCreated
	if first {
		m.broken = true
	}
	m.mu.Unlock()
	if first {
		m.log.Warn().Err(cause).Msg("native web views are not available on this system: applications open in the system browser")
	}
}

// SetBounds moves and resizes a view.
func (m *Manager) SetBounds(vaultID, id string, b Bounds) error {
	b, err := checkBounds(b)
	if err != nil {
		return err
	}
	return m.call(vaultID, id, func(d Driver) error { return d.SetBounds(id, b) })
}

// SetVisible shows or hides a view (a hidden one keeps its page).
func (m *Manager) SetVisible(vaultID, id string, visible bool) error {
	return m.call(vaultID, id, func(d Driver) error {
		m.mu.Lock()
		if v := m.views[id]; v != nil {
			v.visible = visible
		}
		m.mu.Unlock()
		return d.SetVisible(id, visible)
	})
}

// Navigate points a view at rawURL. Like Open it takes the address as the user's choice: a private host is
// allowed, and added to the ones the page may come back to; a public host empties that set (see view.userAddrs).
// Back and Forward are not a choice of an address: a history entry on a private host that the page no
// longer may reach is refused, and the UI navigates there by hand.
func (m *Manager) Navigate(vaultID, id, rawURL string) error {
	info, err := Inspect(rawURL)
	if err != nil {
		return err
	}
	return m.call(vaultID, id, func(d Driver) error {
		m.mu.Lock()
		if v := m.views[id]; v != nil {
			v.choose(info) // before the load: its first request is judged by the policy
		}
		m.mu.Unlock()
		return d.Navigate(id, rawURL)
	})
}

// Back goes back in the history of a view.
func (m *Manager) Back(vaultID, id string) error {
	return m.call(vaultID, id, func(d Driver) error { return d.Back(id) })
}

// Forward goes forward in the history of a view.
func (m *Manager) Forward(vaultID, id string) error {
	return m.call(vaultID, id, func(d Driver) error { return d.Forward(id) })
}

// Reload loads the page of a view again.
func (m *Manager) Reload(vaultID, id string) error {
	return m.call(vaultID, id, func(d Driver) error { return d.Reload(id) })
}

// Focus gives a view the keyboard focus.
func (m *Manager) Focus(vaultID, id string) error {
	return m.call(vaultID, id, func(d Driver) error { return d.Focus(id) })
}

// Close closes a view the UI is done with. No event follows: the UI knows.
func (m *Manager) Close(vaultID, id string) error {
	d := m.driver()
	if d == nil {
		return ErrUnavailable
	}
	m.mu.Lock()
	v := m.views[id]
	if v == nil || v.vault != vaultID {
		m.mu.Unlock()
		return ErrNotFound
	}
	m.dropLocked(id)
	m.mu.Unlock()
	if err := d.Close(id); err != nil && !errors.Is(err, ErrUnknownView) {
		return fmt.Errorf("%w: %w", ErrDriver, err)
	}
	return nil
}

// CloseVault closes every view of a vault and tells the UI (EventClosed). It reports how many it
// closed. A vault with none, or no driver at all, is not an error.
func (m *Manager) CloseVault(vaultID string, why CloseReason) int {
	return m.closeMatching(func(v *view) bool { return v.vault == vaultID }, why, false)
}

// CloseVaultQuietly closes every view of a vault on the request of the UI, which knows: no event follows.
func (m *Manager) CloseVaultQuietly(vaultID string) int {
	return m.closeMatching(func(v *view) bool { return v.vault == vaultID }, "", true)
}

// CloseAll closes every view and tells the UI.
func (m *Manager) CloseAll(why CloseReason) int {
	return m.closeMatching(func(*view) bool { return true }, why, false)
}

func (m *Manager) closeMatching(match func(*view) bool, why CloseReason, quiet bool) int {
	m.mu.Lock()
	d := m.drv
	var gone []view
	for id, v := range m.views {
		if match(v) {
			gone = append(gone, *v)
			m.dropLocked(id)
		}
	}
	m.mu.Unlock()
	for _, v := range gone {
		if d != nil {
			if err := d.Close(v.id); err != nil && !errors.Is(err, ErrUnknownView) {
				m.log.Warn().Err(err).Str("view", v.id).Msg("close view")
			}
		}
		if !quiet {
			EventClosed.Send(m.opts.Emit, ClosedPayload{ViewID: v.id, VaultID: v.vault, Reason: why})
		}
	}
	return len(gone)
}

// Shutdown closes every view for good: nothing opens afterwards, and the stream of events stops. It
// is for the end of the process and safe to call more than once. It calls the driver on the goroutine
// that calls it, which at exit is the thread of the UI toolkit (Driver.CloseAll says why a driver
// must not wait there).
func (m *Manager) Shutdown() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	d := m.drv
	var gone []view
	for id, v := range m.views {
		gone = append(gone, *v)
		m.dropLocked(id)
	}
	close(m.done)
	m.mu.Unlock()
	if d != nil {
		d.CloseAll()
	}
	for _, v := range gone {
		EventClosed.Send(m.opts.Emit, ClosedPayload{ViewID: v.id, VaultID: v.vault, Reason: ClosedQuit})
	}
}

// ReserveKeys sets the accelerators the views hand to the application (EventKey) instead of
// consuming them. The list replaces the previous one; it applies to every view, whatever its vault.
// See ParseAccelerator for the syntax.
func (m *Manager) ReserveKeys(accelerators []string) error {
	if len(accelerators) > MaxAccelerators {
		return fmt.Errorf("%w: more than %d", ErrAccelerator, MaxAccelerators)
	}
	seen := map[string]bool{}
	var keys []string
	for _, a := range accelerators {
		c, err := ParseAccelerator(a)
		if err != nil {
			return err
		}
		if !seen[c] {
			seen[c] = true
			keys = append(keys, c)
		}
	}
	d := m.driver()
	if d == nil {
		return ErrUnavailable
	}
	m.mu.Lock()
	m.keys = keys
	m.mu.Unlock()
	d.ReserveKeys(keys)
	return nil
}

// ClearData closes the views of a vault (EventClosed with ClosedDataCleared: the UI opens them
// again if it wants to) and deletes the session data of its applications on this device: cookies,
// local storage, caches. Other vaults are not touched.
func (m *Manager) ClearData(vaultID string) error {
	d := m.driver()
	if d == nil {
		return ErrUnavailable
	}
	store, err := m.storeOf(vaultID)
	if err != nil {
		return fmt.Errorf("%w: %w", ErrDriver, err)
	}
	m.CloseVault(vaultID, ClosedDataCleared)
	if err := d.RemoveData(store); err != nil {
		return fmt.Errorf("%w: %w", ErrDriver, err)
	}
	return nil
}

// RemoveStore deletes the session data kept under a data store identifier, for a vault the
// application no longer knows (the sweep of the orphaned stores). Unlike ClearData it names the
// store and not the vault, closes no view and does not create the identifier of a vault that never had
// one: the caller has made sure that no view of the Manager uses it. A store the platform never
// created is not an error. ErrUnavailable when there is no driver (yet).
func (m *Manager) RemoveStore(store string) error {
	d := m.driver()
	if d == nil {
		return ErrUnavailable
	}
	if err := d.RemoveData(store); err != nil {
		return fmt.Errorf("%w: %w", ErrDriver, err)
	}
	return nil
}

// storeOf is the identifier of the session data of a vault.
func (m *Manager) storeOf(vaultID string) (string, error) {
	if m.opts.DataStore != nil {
		return m.opts.DataStore(vaultID)
	}
	return DataStoreID(vaultID), nil
}

// ---- internals -------------------------------------------------------------------------------

// call runs a driver call on a view of vaultID.
func (m *Manager) call(vaultID, id string, f func(Driver) error) error {
	d := m.driver()
	if d == nil {
		return ErrUnavailable
	}
	m.mu.Lock()
	v := m.views[id]
	ok := v != nil && v.vault == vaultID && v.created
	m.mu.Unlock()
	if !ok {
		return ErrNotFound
	}
	if err := f(d); err != nil {
		if errors.Is(err, ErrUnknownView) {
			m.forget(id)
			return ErrNotFound
		}
		return fmt.Errorf("%w: %w", ErrDriver, err)
	}
	return nil
}

// forget drops a view from the table.
func (m *Manager) forget(id string) {
	m.mu.Lock()
	m.dropLocked(id)
	m.mu.Unlock()
}

func (m *Manager) dropLocked(id string) {
	v := m.views[id]
	if v == nil {
		return
	}
	delete(m.views, id)
	if m.perVault[v.vault]--; m.perVault[v.vault] <= 0 {
		delete(m.perVault, v.vault)
	}
}

func (m *Manager) viewOf(id string) (view, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v := m.views[id]
	if v == nil {
		return view{}, false
	}
	return *v, true
}

// checkBounds refuses a rectangle that is not part of the window and trims what a rounding error
// leaves outside it.
func checkBounds(b Bounds) (Bounds, error) {
	const eps = 1e-3
	for _, f := range []float64{b.X, b.Y, b.Width, b.Height} {
		if math.IsNaN(f) || math.IsInf(f, 0) || f < -eps || f > 1+eps {
			return Bounds{}, ErrBounds
		}
	}
	clamp := func(f float64) float64 { return math.Min(1, math.Max(0, f)) }
	b.X, b.Y = clamp(b.X), clamp(b.Y)
	b.Width, b.Height = clamp(b.Width), clamp(b.Height)
	if b.X+b.Width > 1+eps || b.Y+b.Height > 1+eps {
		return Bounds{}, ErrBounds
	}
	b.Width, b.Height = math.Min(b.Width, 1-b.X), math.Min(b.Height, 1-b.Y)
	return b, nil
}

// policy is the navigation policy the driver asks (see Policy). It runs on the thread of the
// toolkit: it decides at once and leaves the event for the pump.
func (m *Manager) policy(id, rawURL string, mainFrame bool) bool {
	if mainFrame {
		return m.framePolicy(id, rawURL, FrameMain, false)
	}
	return m.framePolicy(id, rawURL, FrameSub, false)
}

// framePolicy is the policy for a navigation of a given kind of frame (see FramePolicy).
func (m *Manager) framePolicy(id, rawURL string, frame FrameKind, redirect bool) bool {
	if frame == FrameSub {
		if _, ok := m.viewOf(id); !ok {
			return false
		}
		// A frame inside the page: http and https, and the schemes a page builds its own frames with.
		if frameURLAllowed(rawURL) {
			return true
		}
		m.report(Event{ID: id, Kind: EvBlocked, URL: rawURL, Text: string(BlockScheme)})
		return false
	}
	// The top frame, or a frame that cannot be told from it: the same rules. Only the top frame is the page the next
	// navigation starts from (curPrivate): a navigation of unknown frame is not written down here, mainFrameStarted
	// does it when the top frame really starts to load.
	top := frame == FrameMain
	info, err := Inspect(rawURL)
	m.mu.Lock()
	v := m.views[id]
	if v == nil {
		m.mu.Unlock()
		return false
	}
	if err == nil {
		// The page the navigation starts from. For the step of a redirect that follows a navigation of unknown frame to a
		// public host, the top frame may already be there (the notice of the driver comes when the address changes, not
		// before the redirect is followed): a redirect back to the private network is then refused, whatever the page
		// was before. A frame inside the page that is redirected to the private network is refused too, which is the
		// stricter side.
		onPrivate := v.curPrivate && (!redirect || !v.pendingPublic)
		if !v.mayGoTo(info, onPrivate) {
			err = &URLError{Reason: BlockPrivateNetwork}
		}
	}
	if err == nil {
		if top {
			v.curPrivate = info.Private // the main frame is going there: it is the page the next navigation starts from
			v.pendingPublic = false
		} else {
			v.pendingPublic = !info.Private
		}
	}
	m.mu.Unlock()
	if err != nil {
		reason := BlockOther
		var ue *URLError
		if errors.As(err, &ue) {
			reason = ue.Reason
		}
		m.report(Event{ID: id, Kind: EvBlocked, URL: rawURL, Text: string(reason), MainFrame: top})
		return false
	}
	return true
}

// mainFrameStarted records where the top frame of a view is going, for a driver that could not say which frame the
// decisions of the policy were for (see MainFrameNotice).
func (m *Manager) mainFrameStarted(id, rawURL string) {
	info, err := Inspect(rawURL)
	if err != nil {
		return // not an address the top frame may have (about:blank, a page the platform made): nothing to learn
	}
	m.mu.Lock()
	if v := m.views[id]; v != nil {
		v.curPrivate = info.Private
		v.pendingPublic = false
	}
	m.mu.Unlock()
}

// frameURLAllowed: what a frame inside a page may load. The host rules (private hosts) apply to
// the top of a page, not to what it embeds.
func frameURLAllowed(raw string) bool {
	if len(raw) > MaxURLBytes {
		return false
	}
	i := strings.IndexByte(raw, ':')
	if i <= 0 {
		return false
	}
	switch strings.ToLower(raw[:i]) {
	case "http", "https", "about", "blob", "data":
		return true
	}
	return false
}

// report hands an event of the policy to the pump; a full queue drops it.
func (m *Manager) report(ev Event) {
	select {
	case m.internal <- ev:
	default:
	}
}

// pump turns the reports of the driver into events for the UI.
func (m *Manager) pump(in <-chan Event) {
	for {
		select {
		case ev, ok := <-in:
			if !ok {
				return
			}
			m.handle(ev)
		case ev := <-m.internal:
			m.handle(ev)
		case <-m.done:
			return
		}
	}
}

// clip bounds a text that comes from a page.
func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 { // do not cut a character in two
		n--
	}
	return s[:n]
}

func (m *Manager) handle(ev Event) {
	v, ok := m.viewOf(ev.ID)
	if !ok {
		return // closed meanwhile
	}
	emit := m.opts.Emit
	switch ev.Kind {
	case EvState:
		EventState.Send(emit, StatePayload{ViewID: v.id, VaultID: v.vault, URL: clip(ev.URL, MaxURLBytes), Title: clip(ev.Title, 1024),
			Loading: ev.Loading, CanGoBack: ev.CanGoBack, CanGoForward: ev.CanGoForward})
	case EvBlocked:
		reason := BlockReason(ev.Text)
		switch reason {
		case BlockEmpty, BlockTooLong, BlockCharacters, BlockMalformed, BlockScheme, BlockCredentials, BlockHost, BlockPort, BlockPrivateNetwork:
		default:
			reason = BlockOther
		}
		EventBlocked.Send(emit, BlockedPayload{ViewID: v.id, VaultID: v.vault, URL: clip(ev.URL, MaxURLBytes), Reason: reason, MainFrame: ev.MainFrame})
	case EvNewWindow:
		m.newWindow(v.id, v.vault, ev.URL, ev.UserGesture)
	case EvDownload:
		EventDownload.Send(emit, DownloadPayload{ViewID: v.id, VaultID: v.vault, URL: clip(ev.URL, MaxURLBytes)})
	case EvPermission:
		EventPermission.Send(emit, PermissionPayload{ViewID: v.id, VaultID: v.vault, Permission: clip(ev.Text, 64), Origin: clip(ev.URL, 255)})
	case EvKey:
		if c, err := ParseAccelerator(ev.Text); err == nil {
			EventKey.Send(emit, KeyPayload{ViewID: v.id, VaultID: v.vault, Accelerator: c})
		}
	case EvError:
		EventLoadError.Send(emit, LoadErrorPayload{ViewID: v.id, VaultID: v.vault, URL: clip(ev.URL, MaxURLBytes), Message: clip(ev.Text, 1024),
			Code: ev.Code, Certificate: ev.Certificate})
	case EvCrash:
		EventCrashed.Send(emit, CrashedPayload{ViewID: v.id, VaultID: v.vault})
	case EvFocus:
		EventFocus.Send(emit, FocusPayload{ViewID: v.id, VaultID: v.vault})
	case EvActivity:
		if m.opts.OnActivity != nil {
			m.opts.OnActivity()
		}
	}
}

// newWindow answers a page that asked for a new window: nothing opens in the application. An address
// goes to the system browser only if the user was working in the view a moment ago (a page that opens a
// tab of the browser on its own is a nuisance, and a hidden tab must never do it), it passes the rules of
// a navigation, and the view has not sent one in the last second.
func (m *Manager) newWindow(id, vault, rawURL string, gesture bool) {
	p := NewWindowPayload{ViewID: id, VaultID: vault, URL: clip(rawURL, MaxURLBytes)}
	info, err := Inspect(rawURL)
	m.mu.Lock()
	v := m.views[id]
	switch {
	case v == nil:
		m.mu.Unlock()
		return
	case err != nil:
		p.Reason = BlockOther
		var ue *URLError
		if errors.As(err, &ue) {
			p.Reason = ue.Reason
		}
	case !v.mayGoTo(info, v.curPrivate):
		p.Reason = BlockPrivateNetwork
	case !gesture || !v.visible || m.opts.OpenExternal == nil:
		p.Reason = BlockOther
	default:
		now := m.opts.Now()
		if !v.lastNewWindow.IsZero() && now.Sub(v.lastNewWindow) < newWindowInterval {
			p.Reason = BlockThrottled
		} else {
			v.lastNewWindow = now
			p.Opened = true
		}
	}
	m.mu.Unlock()
	if p.Opened {
		m.opts.OpenExternal(rawURL)
	}
	EventNewWindow.Send(m.opts.Emit, p)
}
