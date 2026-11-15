package webview

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/rs/zerolog"
)

// recorder collects the events a Manager sends.
type recorder struct {
	mu sync.Mutex
	ev []recorded
}

type recorded struct {
	name    string
	payload any
}

func (r *recorder) emit(name string, payload any) {
	r.mu.Lock()
	r.ev = append(r.ev, recorded{name, payload})
	r.mu.Unlock()
}

func (r *recorder) all() []recorded {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.ev)
}

// named returns the payloads of the events called name, oldest first.
func (r *recorder) named(name string) []any {
	var out []any
	for _, e := range r.all() {
		if e.name == name {
			out = append(out, e.payload)
		}
	}
	return out
}

// await waits for n events called name and returns their payloads.
func (r *recorder) await(t *testing.T, name string, n int) []any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if got := r.named(name); len(got) >= n {
			return got
		}
		if time.Now().After(deadline) {
			t.Fatalf("waited for %d %q events, got %d (%v)", n, name, len(r.named(name)), r.all())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// settle gives the pump time to deliver what is queued, for the tests of what must NOT arrive.
func (r *recorder) settle(m *Manager) {
	for range 3 {
		m.report(Event{ID: "settle", Kind: EvFocus})
		time.Sleep(15 * time.Millisecond)
	}
}

type env struct {
	t    *testing.T
	m    *Manager
	f    *Fake
	rec  *recorder
	now  time.Time
	nmu  sync.Mutex
	sent []string // addresses sent to the system browser
	omu  sync.Mutex
}

func newEnv(t *testing.T) *env {
	t.Helper()
	e := &env{t: t, f: NewFake(), rec: &recorder{}, now: time.Unix(1_000_000, 0)}
	e.m = NewManager(Options{
		Driver: func() Driver { return e.f },
		Emit:   e.rec.emit,
		OpenExternal: func(u string) {
			e.omu.Lock()
			e.sent = append(e.sent, u)
			e.omu.Unlock()
		},
		Logger: zerolog.Nop(),
		Now: func() time.Time {
			e.nmu.Lock()
			defer e.nmu.Unlock()
			return e.now
		},
	})
	t.Cleanup(e.m.Shutdown)
	return e
}

func (e *env) advance(d time.Duration) {
	e.nmu.Lock()
	e.now = e.now.Add(d)
	e.nmu.Unlock()
}

func (e *env) opened() []string {
	e.omu.Lock()
	defer e.omu.Unlock()
	return slices.Clone(e.sent)
}

var full = Bounds{X: 0.2, Y: 0.25, Width: 0.6, Height: 0.55}

func (e *env) open(vault, url string) string {
	e.t.Helper()
	id, err := e.m.Open(vault, url, full)
	if err != nil {
		e.t.Fatalf("Open(%q): %v", url, err)
	}
	return id
}

func TestOpenCreatesAViewOfTheVault(t *testing.T) {
	e := newEnv(t)
	a := e.open("v1", "https://example.com/app")
	b := e.open("v1", "https://example.org/")
	c := e.open("v2", "https://example.com/app")
	if a == b || b == c || a == c || a == "" {
		t.Fatalf("ids must be distinct and not empty: %q %q %q", a, b, c)
	}
	if e.m.Count("v1") != 2 || e.m.Count("v2") != 1 || e.m.Count("") != 3 {
		t.Fatalf("counts: v1 %d v2 %d all %d", e.m.Count("v1"), e.m.Count("v2"), e.m.Count(""))
	}
	views := e.f.Views()
	if len(views) != 3 {
		t.Fatalf("driver has %d views", len(views))
	}
	if views[0].URL != "https://example.com/app" || views[0].Bounds != full || !views[0].Visible {
		t.Fatalf("view: %+v", views[0])
	}
	// The session data follow the vault, not the application inside it.
	if views[0].DataStore != DataStoreID("v1") || views[1].DataStore != views[0].DataStore || views[2].DataStore == views[0].DataStore {
		t.Fatalf("data stores: %q %q %q", views[0].DataStore, views[1].DataStore, views[2].DataStore)
	}
	// The first report of the page reaches the UI with the ids.
	st := e.rec.await(t, "webview:state", 3)
	found := false
	for _, p := range st {
		if p := p.(StatePayload); p.ViewID == a {
			found = p.VaultID == "v1" && p.URL == "https://example.com/app"
		}
	}
	if !found {
		t.Fatalf("no state for %s in %v", a, st)
	}
}

func TestOpenRefusesWhatItShould(t *testing.T) {
	e := newEnv(t)
	for _, u := range []string{"", "file:///etc/passwd", "javascript:alert(1)", "clarae://open", "wails://wails/", "https://u:p@example.com/", "about:blank", "data:text/html,x", "blob:https://example.com/x"} {
		_, err := e.m.Open("v1", u, full)
		if !errors.Is(err, ErrInvalidURL) {
			t.Errorf("Open(%q) = %v, want ErrInvalidURL", u, err)
		}
	}
	for _, b := range []Bounds{{X: -0.1, Width: 0.5, Height: 0.5}, {Width: 1.2, Height: 1}, {X: 0.6, Width: 0.6, Height: 0.5}, {Height: -1}} {
		if _, err := e.m.Open("v1", "https://example.com/", b); !errors.Is(err, ErrBounds) {
			t.Errorf("Open with %+v = %v, want ErrBounds", b, err)
		}
	}
	if n := len(e.f.Calls()); n > 1 || e.m.Count("") != 0 { // the one call is the keys, set when the driver was resolved
		t.Fatalf("nothing may reach the driver: %v, %d views", e.f.Calls(), e.m.Count(""))
	}
}

func TestBoundsAreTrimmedNotInvented(t *testing.T) {
	e := newEnv(t)
	id, err := e.m.Open("v1", "https://example.com/", Bounds{X: 0.5, Y: 0, Width: 0.5000004, Height: 1.0004})
	if err != nil {
		t.Fatal(err)
	}
	v, _ := e.f.View(id)
	if v.Bounds.X+v.Bounds.Width > 1 || v.Bounds.Y+v.Bounds.Height > 1 {
		t.Fatalf("not trimmed: %+v", v.Bounds)
	}
	if err := e.m.SetBounds("v1", id, Bounds{X: 0.1, Y: 0.1, Width: 0.8, Height: 0.8}); err != nil {
		t.Fatal(err)
	}
	if v, _ := e.f.View(id); v.Bounds != (Bounds{X: 0.1, Y: 0.1, Width: 0.8, Height: 0.8}) {
		t.Fatalf("bounds: %+v", v.Bounds)
	}
	if err := e.m.SetBounds("v1", id, Bounds{Width: 2, Height: 1}); !errors.Is(err, ErrBounds) {
		t.Fatalf("SetBounds out of the window: %v", err)
	}
}

// A view belongs to its vault: another vault cannot reach it, and a view that does not exist is not found.
func TestViewsBelongToTheirVault(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "https://example.com/")
	calls := len(e.f.Calls())
	ops := map[string]func(vault string) error{
		"SetBounds":  func(v string) error { return e.m.SetBounds(v, id, full) },
		"SetVisible": func(v string) error { return e.m.SetVisible(v, id, false) },
		"Navigate":   func(v string) error { return e.m.Navigate(v, id, "https://example.org/") },
		"Back":       func(v string) error { return e.m.Back(v, id) },
		"Forward":    func(v string) error { return e.m.Forward(v, id) },
		"Reload":     func(v string) error { return e.m.Reload(v, id) },
		"Focus":      func(v string) error { return e.m.Focus(v, id) },
		"Close":      func(v string) error { return e.m.Close(v, id) },
	}
	for name, op := range ops {
		if err := op("v2"); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s from another vault = %v, want ErrNotFound", name, err)
		}
		if err := op(""); !errors.Is(err, ErrNotFound) {
			t.Errorf("%s with no vault = %v, want ErrNotFound", name, err)
		}
	}
	if len(e.f.Calls()) != calls {
		t.Fatalf("the driver was called: %v", e.f.Calls()[calls:])
	}
	if err := e.m.SetBounds("v1", "wv999", full); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown view: %v", err)
	}
	if err := e.m.SetBounds("v1", id, full); err != nil {
		t.Fatalf("the owner: %v", err)
	}
}

func TestTheCallsOfTheUIReachTheDriver(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "https://example.com/")
	for name, err := range map[string]error{
		"SetBounds":  e.m.SetBounds("v1", id, Bounds{X: 0, Y: 0, Width: 1, Height: 1}),
		"SetVisible": e.m.SetVisible("v1", id, false),
		"Navigate":   e.m.Navigate("v1", id, "https://example.org/x"),
		"Back":       e.m.Back("v1", id),
		"Forward":    e.m.Forward("v1", id),
		"Reload":     e.m.Reload("v1", id),
		"Focus":      e.m.Focus("v1", id),
	} {
		if err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	want := []string{"create " + id, "bounds " + id, "hide " + id, "navigate " + id, "back " + id, "forward " + id, "reload " + id, "focus " + id}
	got := e.f.Calls()
	for _, w := range want {
		if !slices.Contains(got, w) {
			t.Errorf("missing driver call %q in %v", w, got)
		}
	}
	v, _ := e.f.View(id)
	if v.URL != "https://example.org/x" || !v.CanGoBack() || v.CanGoForward() {
		t.Fatalf("after navigate, back, forward: %+v", v)
	}
	// An address the rules refuse never reaches the driver.
	n := len(e.f.Calls())
	if err := e.m.Navigate("v1", id, "javascript:alert(1)"); !errors.Is(err, ErrInvalidURL) {
		t.Fatalf("Navigate(javascript:) = %v", err)
	}
	if len(e.f.Calls()) != n {
		t.Fatal("a refused address reached the driver")
	}
}

func TestUseAfterClose(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "https://example.com/")
	if err := e.m.Close("v1", id); err != nil {
		t.Fatal(err)
	}
	if e.m.Count("") != 0 || len(e.f.Views()) != 0 {
		t.Fatalf("the view survived Close: %d, %v", e.m.Count(""), e.f.Views())
	}
	for name, err := range map[string]error{
		"SetBounds": e.m.SetBounds("v1", id, full),
		"Navigate":  e.m.Navigate("v1", id, "https://example.com/"),
		"Reload":    e.m.Reload("v1", id),
		"Close":     e.m.Close("v1", id),
	} {
		if !errors.Is(err, ErrNotFound) {
			t.Errorf("%s after Close = %v, want ErrNotFound", name, err)
		}
	}
	// What the page reports after the close is dropped.
	e.f.Emit(Event{ID: id, Kind: EvDownload, URL: "https://example.com/x"})
	e.rec.settle(e.m)
	if got := e.rec.named("webview:download"); len(got) != 0 {
		t.Fatalf("an event of a closed view reached the UI: %v", got)
	}
	// Closing by the UI sends no event: the UI knows.
	if got := e.rec.named("webview:closed"); len(got) != 0 {
		t.Fatalf("Close sent %v", got)
	}
}

func TestLimits(t *testing.T) {
	e := newEnv(t)
	for i := range MaxViewsPerVault {
		if _, err := e.m.Open("v1", fmt.Sprintf("https://example.com/%d", i), full); err != nil {
			t.Fatalf("view %d: %v", i, err)
		}
	}
	if _, err := e.m.Open("v1", "https://example.com/x", full); !errors.Is(err, ErrLimit) {
		t.Fatalf("one too many in a vault: %v", err)
	}
	if _, err := e.m.Open("v2", "https://example.com/x", full); err != nil {
		t.Fatalf("another vault has its own room: %v", err)
	}
	for i := 0; e.m.Count("") < MaxViewsTotal; i++ {
		if _, err := e.m.Open(fmt.Sprintf("w%d", i), "https://example.com/", full); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := e.m.Open("fresh", "https://example.com/x", full); !errors.Is(err, ErrLimit) {
		t.Fatalf("one too many in all: %v", err)
	}
	// Closing makes room again.
	e.m.CloseVault("v1", ClosedVaultClosed)
	if _, err := e.m.Open("v1", "https://example.com/x", full); err != nil {
		t.Fatalf("after closing the vault: %v", err)
	}
}

func TestDriverFailures(t *testing.T) {
	e := newEnv(t)
	e.f.Fail(errors.New("no window"))
	if _, err := e.m.Open("v1", "https://example.com/", full); !errors.Is(err, ErrDriver) {
		t.Fatalf("Open with a failing driver: %v", err)
	}
	if e.m.Count("") != 0 {
		t.Fatal("a view that was not made is counted")
	}
	id := e.open("v1", "https://example.com/")
	e.f.Fail(errors.New("boom"))
	if err := e.m.Reload("v1", id); !errors.Is(err, ErrDriver) {
		t.Fatalf("Reload: %v", err)
	}
	if err := e.m.Reload("v1", id); err != nil {
		t.Fatalf("a failure is not sticky: %v", err)
	}
	// The platform lost the view: the Manager forgets it, too.
	e.f.Fail(ErrUnknownView)
	if err := e.m.Focus("v1", id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Focus on a view the platform lost: %v", err)
	}
	if e.m.Count("") != 0 {
		t.Fatal("the lost view is still counted")
	}
}

// Without a driver (a platform that has none, the browser) every call says so, and nothing is created.
func TestNoDriver(t *testing.T) {
	m := NewManager(Options{Logger: zerolog.Nop()})
	if m.Available() || m.PersistentData() {
		t.Fatal("a Manager without a driver is available")
	}
	checks := map[string]error{
		"SetBounds":   m.SetBounds("v", "wv1", full),
		"SetVisible":  m.SetVisible("v", "wv1", true),
		"Navigate":    m.Navigate("v", "wv1", "https://example.com/"),
		"Back":        m.Back("v", "wv1"),
		"Forward":     m.Forward("v", "wv1"),
		"Reload":      m.Reload("v", "wv1"),
		"Focus":       m.Focus("v", "wv1"),
		"Close":       m.Close("v", "wv1"),
		"ReserveKeys": m.ReserveKeys([]string{"cmd+w"}),
		"ClearData":   m.ClearData("v"),
	}
	_, checks["Open"] = m.Open("v", "https://example.com/", full)
	for name, err := range checks {
		if !errors.Is(err, ErrUnavailable) {
			t.Errorf("%s = %v, want ErrUnavailable", name, err)
		}
	}
	if m.CloseVault("v", ClosedVaultClosed) != 0 || m.CloseAll(ClosedQuit) != 0 {
		t.Fatal("nothing to close")
	}
	m.Shutdown()
	m.Shutdown()

	// A driver that appears later is picked up: the native window exists only once the application runs.
	f := NewFake()
	var ready bool
	m = NewManager(Options{Driver: func() Driver {
		if ready {
			return f
		}
		return nil
	}, Logger: zerolog.Nop()})
	defer m.Shutdown()
	if _, err := m.Open("v", "https://example.com/", full); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("before the window: %v", err)
	}
	ready = true
	if _, err := m.Open("v", "https://example.com/", full); err != nil {
		t.Fatalf("after the window: %v", err)
	}
}

// The policy is in place before the driver makes the first view: otherwise the first request of a
// page would be judged by nothing, or refused by a driver that has no policy.
type orderedFake struct {
	*Fake
	policyBeforeCreate bool
}

func (o *orderedFake) Create(id, u string, b Bounds, ds string) error {
	o.policyBeforeCreate = o.HasPolicy()
	return o.Fake.Create(id, u, b, ds)
}

func TestThePolicyIsInstalledBeforeTheFirstView(t *testing.T) {
	o := &orderedFake{Fake: NewFake()}
	m := NewManager(Options{Driver: func() Driver { return o }, Logger: zerolog.Nop()})
	defer m.Shutdown()
	if _, err := m.Open("v", "https://example.com/", full); err != nil {
		t.Fatal(err)
	}
	if !o.policyBeforeCreate {
		t.Fatal("the first view was made before the navigation policy was installed")
	}
}

func TestNavigationPolicy(t *testing.T) {
	e := newEnv(t)
	pub := e.open("v1", "https://example.com/")
	priv := e.open("v1", "http://localhost:3000/")

	type tc struct {
		name   string
		view   string
		url    string
		main   bool
		allow  bool
		reason BlockReason
	}
	for _, c := range []tc{
		{"https link", pub, "https://example.org/page", true, true, ""},
		{"http link", pub, "http://example.org/", true, true, ""},
		{"redirect to another origin", pub, "https://accounts.example.net/login?next=x", true, true, ""},
		{"clarae scheme", pub, "clarae://auth/callback?code=1", true, false, BlockScheme},
		{"wails scheme", pub, "wails://wails/index.html", true, false, BlockScheme},
		{"file", pub, "file:///etc/passwd", true, false, BlockScheme},
		{"javascript", pub, "javascript:alert(1)", true, false, BlockScheme},
		{"data", pub, "data:text/html,<script>alert(1)</script>", true, false, BlockScheme},
		{"blob", pub, "blob:https://example.com/9f", true, false, BlockScheme},
		{"about", pub, "about:blank", true, false, BlockScheme},
		{"unknown scheme", pub, "slack://channel?id=1", true, false, BlockScheme},
		{"credentials", pub, "https://admin:pw@example.org/", true, false, BlockCredentials},
		{"control character", pub, "https://example.org/\r\nx", true, false, BlockCharacters},
		{"loopback by name", pub, "http://localhost:5173/", true, false, BlockPrivateNetwork},
		{"loopback by address", pub, "http://127.0.0.1:41234/cb?code=x&state=y", true, false, BlockPrivateNetwork},
		{"loopback as a number", pub, "http://2130706433:41234/cb", true, false, BlockPrivateNetwork},
		{"loopback IPv6", pub, "http://[::1]:8080/", true, false, BlockPrivateNetwork},
		{"LAN", pub, "http://192.168.0.1/", true, false, BlockPrivateNetwork},
		{"metadata address", pub, "http://169.254.169.254/latest/meta-data/", true, false, BlockPrivateNetwork},
		{"local name", pub, "http://nas.local/", true, false, BlockPrivateNetwork},
		// a view that the user pointed at a private host may stay there, and may go out and come back
		{"private view to private", priv, "http://localhost:3000/other", true, true, ""},
		{"private view to LAN", priv, "http://192.168.0.1/", true, true, ""},
		{"private view to public", priv, "https://accounts.example.net/", true, true, ""},
		{"private view still refuses schemes", priv, "file:///etc/passwd", true, false, BlockScheme},
		// frames inside the page
		{"frame https", pub, "https://widgets.example.net/embed", false, true, ""},
		{"frame about:blank", pub, "about:blank", false, true, ""},
		{"frame srcdoc blob", pub, "blob:https://example.com/1", false, true, ""},
		{"frame data", pub, "data:text/html,x", false, true, ""},
		{"frame file", pub, "file:///etc/passwd", false, false, BlockScheme},
		{"frame wails", pub, "wails://wails/", false, false, BlockScheme},
		{"frame clarae", pub, "clarae://open", false, false, BlockScheme},
		{"frame javascript", pub, "javascript:void(0)", false, false, BlockScheme},
		{"frame loopback", pub, "http://localhost:3000/", false, true, ""}, // what the page embeds is the page's business: see Inspect
	} {
		before := len(e.rec.named("webview:blocked"))
		got := e.f.PageNavigates(c.view, c.url, c.main)
		if got != c.allow {
			t.Errorf("%s: PageNavigates(%q, main=%v) = %v, want %v", c.name, c.url, c.main, got, c.allow)
		}
		if c.allow {
			continue
		}
		blocked := e.rec.await(t, "webview:blocked", before+1)
		last := blocked[len(blocked)-1].(BlockedPayload)
		if last.Reason != c.reason || last.MainFrame != c.main || last.ViewID != c.view || last.VaultID != "v1" {
			t.Errorf("%s: blocked event %+v, want reason %q main %v", c.name, last, c.reason, c.main)
		}
	}
	// A view the Manager does not know is refused.
	if e.f.PageNavigates("wv-nope", "https://example.com/", true) {
		t.Error("a navigation of an unknown view was allowed")
	}
	// An allowed navigation shows in the state.
	e.f.PageNavigates(pub, "https://example.org/final", true)
	last := lastState(t, e.rec, pub)
	if last.URL != "https://example.org/final" || !last.CanGoBack {
		t.Fatalf("state: %+v", last)
	}
}

func lastState(t *testing.T, r *recorder, id string) StatePayload {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		var last StatePayload
		for _, p := range r.named("webview:state") {
			if s := p.(StatePayload); s.ViewID == id {
				last = s
			}
		}
		if last.ViewID == id {
			time.Sleep(20 * time.Millisecond) // let a queued one land
			for _, p := range r.named("webview:state") {
				if s := p.(StatePayload); s.ViewID == id {
					last = s
				}
			}
			return last
		}
		if time.Now().After(deadline) {
			t.Fatalf("no state for %s", id)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// What the user navigates to by hand may be private, and from then on the page may go there by itself.
func TestNavigateByTheUserWidensThePolicy(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "https://example.com/")
	if e.f.PageNavigates(id, "http://192.168.1.10/", true) {
		t.Fatal("the page took the view to the LAN by itself")
	}
	if err := e.m.Navigate("v1", id, "http://192.168.1.10/admin"); err != nil {
		t.Fatalf("the user chose it: %v", err)
	}
	if !e.f.PageNavigates(id, "http://192.168.1.10/other", true) {
		t.Fatal("after the user chose a private host the page may stay on it")
	}
}

func TestEventsOfThePlatformReachTheUI(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "https://example.com/")
	other := e.open("v2", "https://example.com/")
	long := strings.Repeat("é", 5000)
	for _, ev := range []Event{
		{ID: id, Kind: EvState, URL: "https://example.com/a", Title: long, Loading: true, CanGoBack: true},
		{ID: id, Kind: EvDownload, URL: "https://example.com/x.zip"},
		{ID: id, Kind: EvPermission, Text: "media-capture", URL: "example.com"},
		{ID: id, Kind: EvKey, Text: "CMD+W"},
		{ID: id, Kind: EvKey, Text: "not a key"},
		{ID: id, Kind: EvError, URL: "https://expired.example/", Text: "certificate has expired", Code: -1201, Certificate: true},
		{ID: id, Kind: EvCrash},
		{ID: other, Kind: EvFocus},
		{ID: id, Kind: EvBlocked, URL: "file:///x", Text: "scheme", MainFrame: true},
		{ID: id, Kind: EvBlocked, URL: "x:y", Text: "something the platform made up"},
	} {
		e.f.Emit(ev)
	}
	st := e.rec.await(t, "webview:state", 3) // two Creates and this one
	var got StatePayload
	for _, p := range st {
		if s := p.(StatePayload); s.URL == "https://example.com/a" {
			got = s
		}
	}
	if got.ViewID != id || got.VaultID != "v1" || !got.Loading || !got.CanGoBack || got.CanGoForward {
		t.Fatalf("state: %+v", got)
	}
	if len(got.Title) > 1024 || len(got.Title) == 0 || !utf8.ValidString(got.Title) {
		t.Fatalf("the title of a page is bounded and stays valid UTF-8: %d bytes", len(got.Title))
	}
	if d := e.rec.await(t, "webview:download", 1)[0].(DownloadPayload); d.ViewID != id || d.URL != "https://example.com/x.zip" {
		t.Fatalf("download: %+v", d)
	}
	if p := e.rec.await(t, "webview:permission", 1)[0].(PermissionPayload); p.Permission != "media-capture" || p.Origin != "example.com" || p.VaultID != "v1" {
		t.Fatalf("permission: %+v", p)
	}
	e.rec.await(t, "webview:key", 1)
	e.rec.settle(e.m)
	keys := e.rec.named("webview:key")
	if len(keys) != 1 || keys[0].(KeyPayload).Accelerator != "cmd+w" {
		t.Fatalf("keys: %v (the accelerator is canonical, and one that is not valid is dropped)", keys)
	}
	if le := e.rec.await(t, "webview:load-error", 1)[0].(LoadErrorPayload); !le.Certificate || le.Code != -1201 || le.URL != "https://expired.example/" {
		t.Fatalf("load error: %+v", le)
	}
	if c := e.rec.await(t, "webview:crashed", 1)[0].(CrashedPayload); c.ViewID != id {
		t.Fatalf("crash: %+v", c)
	}
	if f := e.rec.await(t, "webview:focus", 1)[0].(FocusPayload); f.ViewID != other || f.VaultID != "v2" {
		t.Fatalf("focus: %+v", f)
	}
	bl := e.rec.await(t, "webview:blocked", 2)
	if b := bl[0].(BlockedPayload); b.Reason != BlockScheme || !b.MainFrame {
		t.Fatalf("blocked: %+v", b)
	}
	if b := bl[1].(BlockedPayload); b.Reason != BlockOther || b.MainFrame {
		t.Fatalf("blocked: %+v", b)
	}
}

func TestNewWindowGoesToTheSystemBrowserOrNowhere(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "https://example.com/")
	priv := e.open("v1", "http://localhost:3000/")

	ask := func(view, url string) NewWindowPayload {
		before := len(e.rec.named("webview:new-window"))
		e.f.Emit(Event{ID: view, Kind: EvNewWindow, URL: url, UserGesture: true})
		got := e.rec.await(t, "webview:new-window", before+1)
		return got[len(got)-1].(NewWindowPayload)
	}
	if p := ask(id, "https://docs.example.org/page"); !p.Opened || p.Reason != "" {
		t.Fatalf("a valid address: %+v", p)
	}
	if got := e.opened(); len(got) != 1 || got[0] != "https://docs.example.org/page" {
		t.Fatalf("system browser: %v", got)
	}
	// Nothing opens in the application, and nothing goes to the system for an address the rules refuse.
	e.advance(2 * newWindowInterval)
	for url, reason := range map[string]BlockReason{
		"javascript:alert(1)":                BlockScheme,
		"file:///etc/passwd":                 BlockScheme,
		"clarae://open?vault=x":              BlockScheme,
		"wails://wails/":                     BlockScheme,
		"https://user:pw@example.org/":       BlockCredentials,
		"http://127.0.0.1:41234/cb?code=abc": BlockPrivateNetwork,
		"":                                   BlockEmpty,
	} {
		if p := ask(id, url); p.Opened || p.Reason != reason {
			t.Errorf("%q: %+v, want refused as %q", url, p, reason)
		}
	}
	if got := e.opened(); len(got) != 1 {
		t.Fatalf("an address that failed the rules reached the system: %v", got)
	}
	// A view of a private application may send its own people to the local network.
	if p := ask(priv, "http://192.168.1.1/"); !p.Opened {
		t.Fatalf("private view: %+v", p)
	}
}

func TestNewWindowIsThrottled(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "https://example.com/")
	ask := func() NewWindowPayload {
		before := len(e.rec.named("webview:new-window"))
		e.f.Emit(Event{ID: id, Kind: EvNewWindow, URL: "https://example.org/", UserGesture: true})
		got := e.rec.await(t, "webview:new-window", before+1)
		return got[len(got)-1].(NewWindowPayload)
	}
	if !ask().Opened {
		t.Fatal("the first must open")
	}
	for range 5 {
		if p := ask(); p.Opened || p.Reason != BlockThrottled {
			t.Fatalf("a page that opens windows in a loop gets one: %+v", p)
		}
	}
	e.advance(newWindowInterval)
	if !ask().Opened {
		t.Fatal("a second later it opens again")
	}
	if n := len(e.opened()); n != 2 {
		t.Fatalf("system browser opened %d times", n)
	}
}

func TestCloseVault(t *testing.T) {
	e := newEnv(t)
	a1 := e.open("v1", "https://example.com/")
	a2 := e.open("v1", "https://example.org/")
	b := e.open("v2", "https://example.com/")
	if n := e.m.CloseVault("v1", ClosedVaultLocked); n != 2 {
		t.Fatalf("closed %d views", n)
	}
	if e.m.Count("v1") != 0 || e.m.Count("v2") != 1 {
		t.Fatalf("counts: %d %d", e.m.Count("v1"), e.m.Count("v2"))
	}
	if vs := e.f.Views(); len(vs) != 1 || vs[0].ID != b {
		t.Fatalf("the driver still has %v", vs)
	}
	closed := e.rec.named("webview:closed")
	ids := []string{}
	for _, p := range closed {
		c := p.(ClosedPayload)
		if c.VaultID != "v1" || c.Reason != ClosedVaultLocked {
			t.Fatalf("closed: %+v", c)
		}
		ids = append(ids, c.ViewID)
	}
	slices.Sort(ids)
	if want := []string{a1, a2}; !slices.Equal(ids, want) {
		t.Fatalf("closed events for %v, want %v", ids, want)
	}
	if err := e.m.SetBounds("v1", a1, full); !errors.Is(err, ErrNotFound) {
		t.Fatalf("use after CloseVault: %v", err)
	}
	if n := e.m.CloseVault("v1", ClosedVaultClosed); n != 0 {
		t.Fatalf("a vault with no views: %d", n)
	}
	if n := e.m.CloseVault("nobody", ClosedVaultClosed); n != 0 {
		t.Fatalf("an unknown vault: %d", n)
	}
	// The driver forgot the view already: CloseVault does not mind.
	c := e.open("v3", "https://example.com/")
	_ = e.f.Close(c)
	if n := e.m.CloseVault("v3", ClosedVaultClosed); n != 1 {
		t.Fatalf("a view the platform lost: %d", n)
	}
}

func TestCloseAllAndShutdown(t *testing.T) {
	e := newEnv(t)
	e.open("v1", "https://example.com/")
	e.open("v2", "https://example.com/")
	if n := e.m.CloseAll(ClosedQuit); n != 2 {
		t.Fatalf("CloseAll closed %d", n)
	}
	if len(e.f.Views()) != 0 || e.m.Count("") != 0 {
		t.Fatal("views left")
	}
	// The application can still open views after CloseAll (it is not the end of the process).
	e.open("v1", "https://example.com/")
	e.m.Shutdown()
	e.m.Shutdown() // twice is fine
	if e.f.CloseAllCalls() != 1 || len(e.f.Views()) != 0 {
		t.Fatalf("Shutdown: %d CloseAll calls, %d views", e.f.CloseAllCalls(), len(e.f.Views()))
	}
	if _, err := e.m.Open("v1", "https://example.com/", full); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Open after Shutdown: %v", err)
	}
	e.rec.await(t, "webview:closed", 3)
}

func TestClearData(t *testing.T) {
	e := newEnv(t)
	a := e.open("v1", "https://example.com/")
	b := e.open("v2", "https://example.com/")
	if err := e.m.ClearData("v1"); err != nil {
		t.Fatal(err)
	}
	if got := e.f.RemovedStores(); len(got) != 1 || got[0] != DataStoreID("v1") {
		t.Fatalf("removed %v, want only the store of v1", got)
	}
	if _, ok := e.f.View(a); ok {
		t.Fatal("a view of v1 survived: it would hold the store open")
	}
	if _, ok := e.f.View(b); !ok {
		t.Fatal("the view of another vault was closed")
	}
	if c := e.rec.await(t, "webview:closed", 1)[0].(ClosedPayload); c.Reason != ClosedDataCleared || c.ViewID != a {
		t.Fatalf("closed: %+v", c)
	}
	// The closing comes before the removal: the store is not in use when it is deleted.
	calls := e.f.Calls()
	if i, j := slices.Index(calls, "close "+a), slices.Index(calls, "remove-data"); i < 0 || j < 0 || i > j {
		t.Fatalf("order of calls: %v", calls)
	}
	e.f.Fail(errors.New("store busy")) // a vault with no view: the next call of the driver is the removal
	if err := e.m.ClearData("v9"); !errors.Is(err, ErrDriver) {
		t.Fatalf("ClearData with a failing platform: %v", err)
	}
}

func TestReserveKeys(t *testing.T) {
	e := newEnv(t)
	if err := e.m.ReserveKeys([]string{"CMD+W", "cmd+w", "ctrl+shift+tab", "cmd+alt+left"}); err != nil {
		t.Fatal(err)
	}
	if got, want := e.f.Keys(), []string{"cmd+w", "ctrl+shift+tab", "alt+cmd+left"}; !slices.Equal(got, want) {
		t.Fatalf("reserved %v, want %v", got, want)
	}
	for _, bad := range [][]string{{"w"}, {"cmd+c"}, {"cmd+w", "nonsense"}, make([]string, MaxAccelerators+1)} {
		if err := e.m.ReserveKeys(bad); !errors.Is(err, ErrAccelerator) {
			t.Errorf("ReserveKeys(%v) = %v", bad[:min(2, len(bad))], err)
		}
	}
	if got := e.f.Keys(); len(got) != 3 {
		t.Fatalf("a refused list changed what was reserved: %v", got)
	}
	if err := e.m.ReserveKeys(nil); err != nil || len(e.f.Keys()) != 0 {
		t.Fatalf("an empty list reserves nothing: %v %v", err, e.f.Keys())
	}
	// A driver that is resolved after the call gets the list when it comes.
	f := NewFake()
	var ready bool
	m := NewManager(Options{Driver: func() Driver {
		if ready {
			return f
		}
		return nil
	}, Logger: zerolog.Nop()})
	defer m.Shutdown()
	ready = true
	if err := m.ReserveKeys([]string{"cmd+w"}); err != nil || !slices.Equal(f.Keys(), []string{"cmd+w"}) {
		t.Fatalf("%v %v", err, f.Keys())
	}
}

func TestPersistentData(t *testing.T) {
	e := newEnv(t)
	if !e.m.PersistentData() {
		t.Fatal("persistent")
	}
	e.f.SetPersistent(false)
	if e.m.PersistentData() {
		t.Fatal("a platform that cannot persist says so")
	}
}

// Opening and closing from many goroutines leaves the table and the driver in agreement.
func TestConcurrentOpenAndClose(t *testing.T) {
	e := newEnv(t)
	var wg sync.WaitGroup
	for g := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			vault := fmt.Sprintf("v%d", g%3)
			for i := range 40 {
				id, err := e.m.Open(vault, "https://example.com/", full)
				if err != nil {
					if errors.Is(err, ErrNotFound) || errors.Is(err, ErrLimit) {
						continue // the vault was closed while the view was made
					}
					t.Errorf("Open: %v", err)
					return
				}
				switch i % 4 {
				case 0:
					_ = e.m.Close(vault, id)
				case 1:
					e.m.CloseVault(vault, ClosedVaultClosed)
				case 2:
					_ = e.m.SetBounds(vault, id, full)
					e.f.PageNavigates(id, "https://example.org/", true)
				}
			}
		}()
	}
	wg.Wait()
	for _, v := range []string{"v0", "v1", "v2"} {
		e.m.CloseVault(v, ClosedVaultClosed)
	}
	if e.m.Count("") != 0 || len(e.f.Views()) != 0 {
		t.Fatalf("after closing everything: %d in the table, %d in the driver", e.m.Count(""), len(e.f.Views()))
	}
}

// Work in a view is activity of the user: the idle lock of a private vault must not fire under it.
func TestActivityInAViewIsReported(t *testing.T) {
	f := NewFake()
	var n atomic.Int64
	m := NewManager(Options{Driver: func() Driver { return f }, OnActivity: func() { n.Add(1) }, Logger: zerolog.Nop()})
	defer m.Shutdown()
	id, err := m.Open("v1", "https://example.com/", full)
	if err != nil {
		t.Fatal(err)
	}
	f.Emit(Event{ID: id, Kind: EvActivity})
	f.Emit(Event{ID: "wv-unknown", Kind: EvActivity}) // not a view of ours: nothing
	deadline := time.Now().Add(3 * time.Second)
	for n.Load() < 1 && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	time.Sleep(30 * time.Millisecond)
	if n.Load() != 1 {
		t.Fatalf("OnActivity called %d times", n.Load())
	}
}

// The private hosts a user chose are a set, not a switch: a page that was reached from one cannot use it
// to go to the rest of the machine.
func TestAPageReachedFromAPrivateHostCannotGoToThePrivateNetwork(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "http://nas.local/")
	// The tool of the local network links a neighbour: fine, the page is on a private host.
	if !e.f.PageNavigates(id, "http://192.168.0.1/", true) {
		t.Fatal("a page on a private host could not go to another private host")
	}
	if !e.f.PageNavigates(id, "http://nas.local/other", true) {
		t.Fatal("the host the user chose is refused")
	}
	// It links a public site (a help page): from there the private network is closed.
	if !e.f.PageNavigates(id, "https://evil.example/", true) {
		t.Fatal("a public link was refused")
	}
	for _, target := range []string{
		"http://127.0.0.1:41234/cb?code=x&state=y", // the loopback listener of the sign-in
		"http://localhost:5173/",
		"http://192.168.0.1/",
		"http://[::ffff:127.0.0.1]:8080/",
		"http://[::127.0.0.1]/",
		"http://[64:ff9b::7f00:1]/",
	} {
		if e.f.PageNavigates(id, target, true) {
			t.Errorf("the public page took the view to %s", target)
		}
	}
	// A redirect, a script or a meta refresh are all navigations of the main frame: the same.
	// Coming back to the host the user chose is allowed (the single sign-on returns there).
	if !e.f.PageNavigates(id, "http://nas.local/auth/callback?code=1", true) {
		t.Fatal("the return to the host the user chose was refused")
	}
	// The same for a window the page asks for, from the public page.
	e.f.PageNavigates(id, "https://evil.example/again", true)
	e.f.Emit(Event{ID: id, Kind: EvNewWindow, URL: "http://127.0.0.1:41234/cb", UserGesture: true})
	nw := e.rec.await(t, "webview:new-window", 1)[0].(NewWindowPayload)
	if nw.Opened || nw.Reason != BlockPrivateNetwork || len(e.opened()) != 0 {
		t.Fatalf("new window: %+v, opened %v", nw, e.opened())
	}
	// The user goes to a public site by hand: the set of chosen hosts is emptied.
	if err := e.m.Navigate("v1", id, "https://example.org/"); err != nil {
		t.Fatal(err)
	}
	e.f.PageNavigates(id, "https://example.org/", true)
	if e.f.PageNavigates(id, "http://nas.local/", true) {
		t.Fatal("a host chosen for the previous site is still allowed after the user went to a public one")
	}
	// A new choice of the user adds one, with its port.
	if err := e.m.Navigate("v1", id, "http://localhost:3000/"); err != nil {
		t.Fatal(err)
	}
	e.f.PageNavigates(id, "https://example.org/x", true) // the public page again
	if e.f.PageNavigates(id, "http://localhost:5173/", true) {
		t.Fatal("another port of the host the user chose is allowed from a public page")
	}
	if !e.f.PageNavigates(id, "http://localhost:3000/app", true) {
		t.Fatal("the host:port the user chose is refused")
	}
}

// A page that opens a tab of the system browser on its own, or from a view that is not shown, gets none.
func TestNewWindowNeedsAUserGestureAndAShownView(t *testing.T) {
	e := newEnv(t)
	id := e.open("v1", "https://example.com/")
	ask := func(gesture bool) NewWindowPayload {
		before := len(e.rec.named("webview:new-window"))
		e.f.Emit(Event{ID: id, Kind: EvNewWindow, URL: "https://example.org/", UserGesture: gesture})
		got := e.rec.await(t, "webview:new-window", before+1)
		return got[len(got)-1].(NewWindowPayload)
	}
	if p := ask(false); p.Opened || p.Reason != BlockOther {
		t.Fatalf("without a gesture: %+v", p)
	}
	if err := e.m.SetVisible("v1", id, false); err != nil {
		t.Fatal(err)
	}
	if p := ask(true); p.Opened || p.Reason != BlockOther {
		t.Fatalf("from a hidden view: %+v", p)
	}
	if len(e.opened()) != 0 {
		t.Fatalf("the system browser was opened: %v", e.opened())
	}
	if err := e.m.SetVisible("v1", id, true); err != nil {
		t.Fatal(err)
	}
	if p := ask(true); !p.Opened {
		t.Fatalf("shown, with a gesture: %+v", p)
	}
}

// The identifier of the session data comes from the application when it has one.
func TestDataStoreComesFromTheApplication(t *testing.T) {
	f := NewFake()
	m := NewManager(Options{Driver: func() Driver { return f }, Logger: zerolog.Nop(),
		DataStore: func(v string) (string, error) { return "store-of-" + v, nil }})
	defer m.Shutdown()
	id, err := m.Open("v1", "https://example.com/", full)
	if err != nil {
		t.Fatal(err)
	}
	if v, _ := f.View(id); v.DataStore != "store-of-v1" {
		t.Fatalf("store %q", v.DataStore)
	}
	if err := m.ClearData("v1"); err != nil {
		t.Fatal(err)
	}
	if got := f.RemovedStores(); len(got) != 1 || got[0] != "store-of-v1" {
		t.Fatalf("removed %v", got)
	}
	m2 := NewManager(Options{Driver: func() Driver { return f }, Logger: zerolog.Nop(),
		DataStore: func(string) (string, error) { return "", errors.New("app.db is gone") }})
	defer m2.Shutdown()
	if _, err := m2.Open("v1", "https://example.com/", full); !errors.Is(err, ErrDriver) {
		t.Fatalf("a store that cannot be had: %v", err)
	}
	if m2.Count("") != 0 {
		t.Fatal("a view that was not made is counted")
	}
}
