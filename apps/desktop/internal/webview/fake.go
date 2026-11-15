package webview

import (
	"slices"
	"sync"
)

// Fake is a Driver that keeps its views in memory. It is the driver of the tests of this package, of
// the bindings and of the lifecycle of the application: it records what it is asked, and lets a test
// play the page (PageNavigates, Emit). It is not a stand-in for a platform: a build without a native
// driver has no driver at all (Manager then answers ErrUnavailable), because a view that only
// pretends to show a page would be worse than none.
type Fake struct {
	mu         sync.Mutex
	persistent bool
	views      map[string]*FakeView
	order      []string // ids, in creation order
	policy     Policy
	keys       []string
	calls      []string
	removed    []string
	closeAlls  int
	failNext   error
	events     chan Event
	stopped    bool
}

// FakeView is the state of a view of a Fake.
type FakeView struct {
	ID        string
	URL       string
	Title     string
	Bounds    Bounds
	Visible   bool
	Focused   bool
	DataStore string
	history   []string
	pos       int
}

// CanGoBack and CanGoForward are the state of the history of the view.
func (v FakeView) CanGoBack() bool    { return v.pos > 0 }
func (v FakeView) CanGoForward() bool { return v.pos+1 < len(v.history) }

var _ Driver = (*Fake)(nil)

// NewFake returns an empty Fake whose session data persist (see SetPersistent).
func NewFake() *Fake {
	return &Fake{persistent: true, views: map[string]*FakeView{}, events: make(chan Event, 256)}
}

// SetPersistent sets what PersistentData answers.
func (f *Fake) SetPersistent(p bool) {
	f.mu.Lock()
	f.persistent = p
	f.mu.Unlock()
}

// Fail makes the next call of the driver (any method) return err.
func (f *Fake) Fail(err error) {
	f.mu.Lock()
	f.failNext = err
	f.mu.Unlock()
}

// enter records a call and returns the failure a test asked for.
func (f *Fake) enter(call string) error {
	f.calls = append(f.calls, call)
	err := f.failNext
	f.failNext = nil
	return err
}

// Calls returns what the driver was asked, in order ("create wv1", "navigate wv1", "close wv1", ...).
func (f *Fake) Calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// Views returns the views that exist, in creation order.
func (f *Fake) Views() []FakeView {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]FakeView, 0, len(f.order))
	for _, id := range f.order {
		out = append(out, *f.views[id])
	}
	return out
}

// View returns one view.
func (f *Fake) View(id string) (FakeView, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	v, ok := f.views[id]
	if !ok {
		return FakeView{}, false
	}
	return *v, true
}

// Keys returns the reserved accelerators last set.
func (f *Fake) Keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.keys)
}

// RemovedStores returns the data stores RemoveData was asked to delete.
func (f *Fake) RemovedStores() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.removed)
}

// CloseAllCalls counts the calls of CloseAll.
func (f *Fake) CloseAllCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closeAlls
}

// HasPolicy reports whether a navigation policy was installed.
func (f *Fake) HasPolicy() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.policy != nil
}

// Emit plays a report of the platform (a download refused, a key pressed, a crash).
func (f *Fake) Emit(ev Event) {
	f.mu.Lock()
	stopped := f.stopped
	f.mu.Unlock()
	if stopped {
		return
	}
	select {
	case f.events <- ev:
	default:
	}
}

// Stop ends the stream of events, as a driver that is stopped for good does.
func (f *Fake) Stop() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.stopped {
		f.stopped = true
		close(f.events)
	}
}

// PageNavigates plays a navigation the page decides (a link, a redirect): the navigation policy
// judges it, like the platform asks it. It reports whether it went on; if it did, the view shows the
// address, with a state event.
func (f *Fake) PageNavigates(id, rawURL string, mainFrame bool) bool {
	f.mu.Lock()
	p := f.policy
	f.mu.Unlock()
	if p == nil || !p(id, rawURL, mainFrame) {
		return false
	}
	if mainFrame {
		f.mu.Lock()
		if v, ok := f.views[id]; ok {
			f.visit(v, rawURL)
		}
		f.mu.Unlock()
	}
	return true
}

// visit loads rawURL in a view and reports the new state (f.mu held).
func (f *Fake) visit(v *FakeView, rawURL string) {
	if len(v.history) > 0 {
		v.history = v.history[:v.pos+1] // what was forward is gone
	}
	v.history = append(v.history, rawURL)
	v.pos = len(v.history) - 1
	v.URL = rawURL
	f.state(v)
}

// state queues the state of a view (f.mu held).
func (f *Fake) state(v *FakeView) {
	if f.stopped {
		return
	}
	select {
	case f.events <- Event{ID: v.ID, Kind: EvState, URL: v.URL, Title: v.Title, CanGoBack: v.CanGoBack(), CanGoForward: v.CanGoForward()}:
	default:
	}
}

func (f *Fake) Create(id, rawURL string, b Bounds, dataStore string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.enter("create " + id); err != nil {
		return err
	}
	v := &FakeView{ID: id, Bounds: b, Visible: true, DataStore: dataStore}
	f.views[id] = v
	f.order = append(f.order, id)
	f.visit(v, rawURL)
	return nil
}

// with runs fn on a view, or returns ErrUnknownView.
func (f *Fake) with(call, id string, fn func(*FakeView)) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.enter(call + " " + id); err != nil {
		return err
	}
	v, ok := f.views[id]
	if !ok {
		return ErrUnknownView
	}
	fn(v)
	return nil
}

func (f *Fake) SetBounds(id string, b Bounds) error {
	return f.with("bounds", id, func(v *FakeView) { v.Bounds = b })
}

func (f *Fake) SetVisible(id string, visible bool) error {
	call := "show"
	if !visible {
		call = "hide"
	}
	return f.with(call, id, func(v *FakeView) {
		v.Visible = visible
		if !visible {
			v.Focused = false
		}
	})
}

func (f *Fake) Navigate(id, rawURL string) error {
	return f.with("navigate", id, func(v *FakeView) { f.visit(v, rawURL) })
}

func (f *Fake) Back(id string) error {
	return f.with("back", id, func(v *FakeView) {
		if v.pos > 0 {
			v.pos--
			v.URL = v.history[v.pos]
			f.state(v)
		}
	})
}

func (f *Fake) Forward(id string) error {
	return f.with("forward", id, func(v *FakeView) {
		if v.pos+1 < len(v.history) {
			v.pos++
			v.URL = v.history[v.pos]
			f.state(v)
		}
	})
}

func (f *Fake) Reload(id string) error {
	return f.with("reload", id, func(v *FakeView) { f.state(v) })
}

func (f *Fake) Focus(id string) error {
	return f.with("focus", id, func(v *FakeView) {
		for _, o := range f.views {
			o.Focused = false
		}
		v.Focused = true
	})
}

func (f *Fake) Close(id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.enter("close " + id); err != nil {
		return err
	}
	if _, ok := f.views[id]; !ok {
		return nil // closing what is gone is not an error
	}
	delete(f.views, id)
	f.order = slices.DeleteFunc(f.order, func(o string) bool { return o == id })
	return nil
}

func (f *Fake) CloseAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "close-all")
	f.closeAlls++
	f.views = map[string]*FakeView{}
	f.order = nil
}

func (f *Fake) ReserveKeys(accelerators []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, "reserve-keys")
	f.keys = slices.Clone(accelerators)
}

func (f *Fake) SetPolicy(p Policy) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.policy = p
}

func (f *Fake) RemoveData(dataStore string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.enter("remove-data"); err != nil {
		return err
	}
	f.removed = append(f.removed, dataStore)
	return nil
}

func (f *Fake) PersistentData() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.persistent
}

func (f *Fake) Events() <-chan Event { return f.events }
