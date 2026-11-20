//go:build linux && cgo && gtk3 && !android && !server && !purego && nativeviewtest

package nativeview

// The live test of the Linux driver (M22, ADR-0062): it opens a real window (Wails v3 on GTK3, the same options as
// the application), puts real WebKitWebViews in it through a real webview.Manager, and checks what the page of an
// application can and cannot do. It needs a display: run it by hand on a Linux desktop, or under a virtual one
//
//	go test -tags 'gtk3 nativeviewtest' -count=1 -v -timeout 600s ./internal/shell/nativeview/
//	xvfb-run -a go test -tags 'gtk3 nativeviewtest' ...          (task test-nativeview-linux does it in a container)
//
// (from apps/desktop). The sandbox of WebKit (bubblewrap) must work: the test fails with
// WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS set, and in a container it needs the capabilities the task gives it
// (SYS_ADMIN, NET_ADMIN, seccomp and system paths unconfined). The GPU paths do not work there: set
// WEBKIT_DISABLE_COMPOSITING_MODE=1, as the task does. It needs no network. It prints a summary of its own at the
// end ("LIVE RESULT").

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"clarae/apps/desktop/internal/webview"
)

const placeholderPage = `<!doctype html><meta charset=utf-8><title>Clarae live test</title>
<body style="margin:0;background:#123b4a;color:#9ee"><div style="position:absolute;left:20%;top:25%;width:60%;height:55%;border:2px solid #4cc">placeholder of the view</div>`

// GDK key values and modifier bits (gdkkeysyms.h, gdktypes.h).
const (
	keyW       = 0x77
	keyX       = 0x78
	keyTab     = 0xff09
	keyF5      = 0xffc2
	maskShift  = 1 << 0
	maskCtrl   = 1 << 2
	maskAlt    = 1 << 3
	maskSuper  = 1 << 26
	keyISOLeft = 0xfe20
)

// recordingDriver is the driver as the Manager sees it, noting where the driver says the top frame goes.
type recordingDriver struct {
	webview.Driver
	mu    sync.Mutex
	mains []string // "id url", in the order the notices came
}

func (r *recordingDriver) SetFramePolicy(p webview.FramePolicy, n webview.MainFrameNotice) {
	r.Driver.(webview.FrameAwareDriver).SetFramePolicy(p, func(id, u string) {
		r.mu.Lock()
		r.mains = append(r.mains, id+" "+u)
		r.mu.Unlock()
		n(id, u)
	})
}

func (r *recordingDriver) mainsSince(n int) []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.mains[n:]...)
}

func (r *recordingDriver) mark() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.mains)
}

// live is the state shared by the tests: one window, one driver, one manager.
type live struct {
	app     *application.App
	win     *application.WebviewWindow
	drv     webview.Driver
	rec     *recordingDriver
	hooks   *Hooks
	mgr     *webview.Manager
	srv     *servers
	dataDir string

	activity atomic.Int64 // reports of the user working in a view (Options.OnActivity)

	mu       sync.Mutex
	events   []recorded
	external []string
	notes    []string
	skipped  []string
	passed   []string
}

type recorded struct {
	name    string
	payload any
}

func init() {
	// GTK and the loop of Wails must run on the thread that called main.
	runtime.LockOSThread()
}

var lv = &live{}

func (l *live) emit(name string, payload any) {
	l.mu.Lock()
	l.events = append(l.events, recorded{name, payload})
	l.mu.Unlock()
}

func (l *live) externalOpened() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.external...)
}

// mark is a point in the log of events, to ask for what came after it.
func (l *live) mark() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.events)
}

func (l *live) eventsSince(mark int, name string) []any {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []any
	for _, e := range l.events[mark:] {
		if e.name == name {
			out = append(out, e.payload)
		}
	}
	return out
}

// wait polls until pred(events since mark named name) holds.
func (l *live) wait(mark int, name string, d time.Duration, pred func(any) bool) (any, bool) {
	deadline := time.Now().Add(d)
	for {
		for _, p := range l.eventsSince(mark, name) {
			if pred == nil || pred(p) {
				return p, true
			}
		}
		if time.Now().After(deadline) {
			return nil, false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func (l *live) note(format string, a ...any) {
	s := fmt.Sprintf(format, a...)
	l.mu.Lock()
	l.notes = append(l.notes, s)
	l.mu.Unlock()
	fmt.Println("INFO   " + s)
}

// pass records that a check was made and held. A test that has already failed records nothing.
func (l *live) pass(t *testing.T, format string, a ...any) {
	if t.Failed() {
		return
	}
	s := fmt.Sprintf(format, a...)
	l.mu.Lock()
	l.passed = append(l.passed, s)
	l.mu.Unlock()
	fmt.Println("PASS   " + s)
}

var defaultBounds = webview.Bounds{X: 0.2, Y: 0.25, Width: 0.6, Height: 0.55}

// open makes a view of vault on url and waits until its page is loaded.
func (l *live) open(t *testing.T, vault, url string) string {
	t.Helper()
	id, err := l.mgr.Open(vault, url, defaultBounds)
	if err != nil {
		t.Fatalf("Open(%s): %v", url, err)
	}
	l.loaded(t, id)
	return id
}

func (l *live) loaded(t *testing.T, id string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if s, err := l.hooks.Eval(id, "return document.readyState", 5*time.Second); err == nil && s == "complete" {
			time.Sleep(150 * time.Millisecond)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("view %s did not load", id)
}

// js runs a script in the guest and returns its result.
func (l *live) js(t *testing.T, id, body string) string {
	t.Helper()
	s, err := l.hooks.Eval(id, body, 15*time.Second)
	if err != nil {
		t.Fatalf("script %q: %v", body, err)
	}
	return s
}

func (l *live) closeAll(t *testing.T) {
	t.Helper()
	l.mgr.CloseAll(webview.ClosedQuit)
	deadline := time.Now().Add(3 * time.Second)
	for l.hooks.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := l.hooks.Count(); n != 0 {
		t.Fatalf("%d guests left after CloseAll", n)
	}
}

// ---- the test servers ---------------------------------------------------------------------------

type servers struct {
	HTTP, TLS, Secret string
	hitsFavicon       atomic.Int64
	hitsCredentials   atomic.Int64 // requests that carried an Authorization header
	close             func()
}

const solidPage = `<!doctype html><meta charset=utf-8><title>solid</title><body style="margin:0;background:#ff00ff">
<input id=i style="font-size:28px;margin:20px" autofocus><br><textarea id=t style="font-size:20px"></textarea>
<script>window.__keys=[];addEventListener('keydown',e=>__keys.push((e.metaKey?'cmd+':'')+(e.ctrlKey?'ctrl+':'')+e.key));
document.getElementById('i').focus()</script>`

func startServers() *servers {
	s := &servers{}
	html := func(w http.ResponseWriter, body string) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = fmt.Fprint(w, body) //nolint:gosec // fixed test pages
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { html(w, solidPage) })
	mux.HandleFunc("/favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		s.hitsFavicon.Add(1)
		http.NotFound(w, r)
	})
	challenge := func(scheme string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "" {
				s.hitsCredentials.Add(1)
			}
			w.Header().Set("WWW-Authenticate", scheme)
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = fmt.Fprint(w, "<title>unauthorized</title>a page that asks for credentials")
		}
	}
	mux.HandleFunc("/basic", challenge(`Basic realm="live test"`))
	mux.HandleFunc("/digest", challenge(`Digest realm="live test", nonce="abc", qop="auth"`))
	mux.HandleFunc("/popup", func(w http.ResponseWriter, r *http.Request) {
		html(w, `<!doctype html><title>popup</title>
<a id=blank href="https://example.org/from-target-blank" target=_blank>blank</a>
<button id=wo onclick="window.open('https://example.org/from-window-open')">open</button>`)
	})
	mux.HandleFunc("/dl", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", `attachment; filename="clarae-live-test.bin"`)
		_, _ = fmt.Fprint(w, "payload")
	})
	mux.HandleFunc("/dl-link", func(w http.ResponseWriter, r *http.Request) {
		html(w, `<!doctype html><title>dl</title><a id=a href="/dl">download</a> <a id=b href="/dl" download="y.bin">download attribute</a>`)
	})
	mux.HandleFunc("/frames", func(w http.ResponseWriter, r *http.Request) {
		html(w, `<!doctype html><title>frames</title>
<iframe id=f1 src="file:///etc/hosts"></iframe><iframe id=f2 src="wails://wails/"></iframe>
<iframe id=f3 src="about:blank"></iframe><iframe id=f4 src="data:text/html,framed"></iframe>
<iframe id=f5 srcdoc="<p>srcdoc</p>"></iframe><iframe id=f6 name=named src="/inner"></iframe>`)
	})
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, r.URL.Query().Get("to"), http.StatusFound) //nolint:gosec // a test server that redirects where the test says
	})
	mux.HandleFunc("/inner", func(w http.ResponseWriter, r *http.Request) { html(w, "<title>inner</title>inner frame") })
	mux.HandleFunc("/dialogs", func(w http.ResponseWriter, r *http.Request) {
		html(w, `<!doctype html><title>dialogs</title>`)
	})
	mux.HandleFunc("/cookie-set", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "live", Value: r.URL.Query().Get("v"), MaxAge: 3600, Path: "/"}) //nolint:gosec // a test server on loopback
		html(w, "<title>set</title>ok")
	})
	mux.HandleFunc("/cookie-get", func(w http.ResponseWriter, r *http.Request) {
		v := "none"
		if c, err := r.Cookie("live"); err == nil {
			v = c.Value
		}
		html(w, "<title>get</title><body id=b>"+v)
	})
	h := httptest.NewServer(mux)
	t := httptest.NewTLSServer(mux)
	sec := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		html(w, "<title>secret</title>a service of the local machine")
	}))
	s.HTTP, s.TLS, s.Secret = h.URL, t.URL, sec.URL
	s.close = func() { h.Close(); t.Close(); sec.Close() }
	return s
}

// ---- the window ---------------------------------------------------------------------------------

func TestMain(m *testing.M) {
	runtime.LockOSThread()
	lv.srv = startServers()
	var err error
	if lv.dataDir, err = os.MkdirTemp("", "clarae-live-"); err != nil {
		fmt.Fprintln(os.Stderr, "temp dir:", err)
		os.Exit(2)
	}
	lv.app = application.New(application.Options{
		Name: "nativeview live test",
		Assets: application.AssetOptions{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = fmt.Fprint(w, placeholderPage)
		})},
		Linux: application.LinuxOptions{ProgramName: "clarae-live"},
	})
	// The window of apps/desktop/main.go.
	lv.win = lv.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "main", Title: "nativeview live test", Width: 1100, Height: 760, MinWidth: 720, MinHeight: 480,
		BackgroundColour:           application.NewRGB(16, 43, 58),
		EnableFileDrop:             false,
		DefaultContextMenuDisabled: true,
	})
	// A menu bar: the graft must keep it above the web view. The application sets none on Linux (shell.SetMenu is for
	// macOS), so CLARAE_LIVE_NO_MENU=1 runs the test without one, as it is.
	if os.Getenv("CLARAE_LIVE_NO_MENU") == "" {
		menu := application.NewMenu()
		file := menu.AddSubmenu("File")
		file.Add("Quit").OnClick(func(*application.Context) { lv.app.Quit() })
		lv.app.Menu.Set(menu)
	}

	lv.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go func() {
			for i := 0; i < 100 && lv.win.NativeWindow() == nil; i++ {
				time.Sleep(100 * time.Millisecond)
			}
			time.Sleep(1500 * time.Millisecond) // the page of the window is loaded and shown
			lv.drv = New(lv.win, lv.dataDir)
			if lv.drv == nil {
				fmt.Fprintln(os.Stderr, "New returned no driver: WebKitGTK too old, or CLARAE_WEBVIEW=off")
				os.Exit(4)
			}
			lv.hooks = TestHooks(lv.drv)
			lv.rec = &recordingDriver{Driver: lv.drv}
			lv.mgr = webview.NewManager(webview.Options{
				Driver:     func() webview.Driver { return lv.rec },
				Emit:       lv.emit,
				OnActivity: func() { lv.activity.Add(1) },
				OpenExternal: func(u string) {
					lv.mu.Lock()
					lv.external = append(lv.external, u)
					lv.mu.Unlock()
				},
				Logger: zerolog.New(zerolog.ConsoleWriter{Out: os.Stderr}).Level(zerolog.WarnLevel),
			})
			lv.win.Show()
			lv.win.Focus()
			time.Sleep(300 * time.Millisecond)
			c := m.Run()
			lv.report(c)
			lv.mgr.Shutdown()
			lv.srv.close()
			_ = os.RemoveAll(lv.dataDir)
			os.Exit(c) // Wails would end the process with 0 on Quit: the exit code of the tests is what counts
		}()
	})
	if err := lv.app.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "run:", err)
		os.Exit(2)
	}
	os.Exit(3) // the application ended before the tests did
}

func (l *live) report(code int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	fmt.Println("LIVE RESULT: Linux", runtime.GOARCH, "exit code", code)
	for _, s := range l.passed {
		fmt.Println("LIVE PASS  ", s)
	}
	for _, s := range l.skipped {
		fmt.Println("LIVE SKIP  ", s)
	}
}

// ---- the tests ----------------------------------------------------------------------------------

func TestLiveGraftKeepsTheWindowAsWailsMadeIt(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	path, pos, n, err := lv.hooks.GraftInfo()
	if err != nil {
		t.Fatal(err)
	}
	// The window of Wails, with the overlay between the box and its web view; the menu bar is still first.
	if !strings.HasSuffix(path, "GtkBox>GtkOverlay>WebKitWebView") {
		t.Fatalf("the web view of the application is at %s", path)
	}
	wantN, wantPos := 2, 1 // the menu bar at 0, the overlay at 1
	if os.Getenv("CLARAE_LIVE_NO_MENU") != "" {
		wantN, wantPos = 1, 0
	}
	if n != wantN || pos != wantPos {
		t.Fatalf("the box has %d children and the overlay is at %d: want %d and %d", n, pos, wantN, wantPos)
	}
	if err := lv.hooks.CreateElsewhere(); err == nil || !strings.Contains(err.Error(), webview.ErrPlatformUnavailable.Error()) {
		t.Fatalf("a window that is not the one of Wails: %v, want ErrPlatformUnavailable", err)
	}
	if err := lv.hooks.CallOffMain(); err != nil {
		t.Fatal(err)
	}
	_ = id
	lv.pass(t, "the web view of the application sits in a GtkOverlay in the box of Wails (%s), after the menu bar if there is one; a window that is not made like that is refused as unavailable; calls off the main thread are refused", path)
}

func TestLivePageAndUserAgent(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	got := lv.js(t, id, `return JSON.stringify({href: location.href, title: document.title, ua: navigator.userAgent, top: window.top === window.self})`)
	var r struct {
		Href, Title, UA string
		Top             bool
	}
	if err := json.Unmarshal([]byte(got), &r); err != nil {
		t.Fatal(err)
	}
	if r.Title != "solid" || !strings.HasPrefix(r.Href, lv.srv.HTTP) || !r.Top {
		t.Fatalf("page: %+v", r)
	}
	if !strings.Contains(r.UA, "Safari/605.1.15") || !strings.Contains(r.UA, "AppleWebKit") {
		t.Fatalf("user agent %q is not a Safari-like one", r.UA)
	}
	if strings.Contains(r.UA, "wails") {
		t.Fatalf("the user agent of the application leaked into a guest: %q", r.UA)
	}
	if _, ok := lv.wait(0, "webview:state", 5*time.Second, func(p any) bool {
		s := p.(webview.StatePayload)
		return s.ViewID == id && s.Title == "solid" && !s.Loading
	}); !ok {
		t.Fatal("no webview:state with the title of the page")
	}
	time.Sleep(1500 * time.Millisecond)
	if n := lv.srv.hitsFavicon.Load(); n != 0 {
		t.Fatalf("the favicon was requested %d times", n)
	}
	if lv.hooks.Inspectable(id) {
		t.Fatal("the web inspector is on in a guest")
	}
	if !lv.hooks.SandboxEnabled(id) {
		t.Fatal("the web context of a guest has no sandbox")
	}
	if v := os.Getenv("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"); v != "" {
		t.Fatalf("WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=%s: the test must run with the sandbox (a driver refuses to make a guest without it)", v)
	}
	lv.pass(t, "a view loads a page served locally (0 favicon requests, inspector off, sandbox of WebKit on); the user agent is Safari-like: %s", r.UA)
}

func TestLiveBoundsFollowTheWindow(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	check := func(label string, b webview.Bounds) float64 {
		t.Helper()
		var worst float64
		f, err := lv.hooks.Frame(id)
		if err != nil {
			t.Fatal(err)
		}
		exp := [4]float64{b.X * f.CW, b.Y * f.CH, b.Width * f.CW, b.Height * f.CH}
		for i, got := range [4]float64{f.X, f.Y, f.W, f.H} {
			d := got - exp[i]
			if d < 0 {
				d = -d
			}
			if d > worst {
				worst = d
			}
		}
		if worst > 1.5 {
			t.Errorf("%s: frame (%.1f, %.1f, %.1f, %.1f) px, expected (%.1f, %.1f, %.1f, %.1f) in an area of %.0fx%.0f: off by %.2f px",
				label, f.X, f.Y, f.W, f.H, exp[0], exp[1], exp[2], exp[3], f.CW, f.CH, worst)
		}
		return worst
	}
	worst := check("at the start", defaultBounds)
	for _, sz := range [][2]int{{1280, 820}, {900, 600}, {760, 500}, {1100, 760}} {
		lv.win.SetSize(sz[0], sz[1])
		time.Sleep(800 * time.Millisecond) // the overlay follows, and the guest with it, at the next allocation
		if w := check(fmt.Sprintf("window %dx%d", sz[0], sz[1]), defaultBounds); w > worst {
			worst = w
		}
	}
	nb := webview.Bounds{X: 0.1, Y: 0.1, Width: 0.8, Height: 0.5}
	if err := lv.mgr.SetBounds("vault-a", id, nb); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if w := check("after SetBounds", nb); w > worst {
		worst = w
	}
	// Logical hit test: the guest inside its rectangle, the application outside it.
	f, _ := lv.hooks.Frame(id)
	in := lv.hooks.HitTest(id, f.X+f.W/2, f.Y+f.H/2)
	out := lv.hooks.HitTest(id, f.X-30, f.Y+f.H/2)
	if in != 1 || out != 2 {
		t.Fatalf("hit test: centre %d (want 1), 30 px outside %d (want 2)", in, out)
	}
	// Hidden, a guest is not there.
	if err := lv.mgr.SetVisible("vault-a", id, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	if f, _ := lv.hooks.Frame(id); f.Visible || lv.hooks.HitTest(id, f.X+f.W/2, f.Y+f.H/2) != 2 {
		t.Fatalf("a hidden guest is still hit: %+v", f)
	}
	if err := lv.mgr.SetVisible("vault-a", id, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)

	// What is drawn: the page of the guest (magenta) where the guest is, the page of the application (dark blue)
	// where it is not.
	f, _ = lv.hooks.Frame(id)
	near := func(r, g, b, wr, wg, wb int) bool {
		d := func(a, b int) int {
			if a > b {
				return a - b
			}
			return b - a
		}
		return d(r, wr) < 8 && d(g, wg) < 8 && d(b, wb) < 8
	}
	if r, g, b, err := lv.hooks.Pixel(f.X+f.W/2, f.Y+f.H/2); err != nil || !near(r, g, b, 255, 0, 255) {
		t.Errorf("at the centre of the guest the colour is (%d, %d, %d), err %v: want the magenta of its page", r, g, b, err)
	}
	if r, g, b, err := lv.hooks.Pixel(5, f.Y+f.H/2); err != nil || !near(r, g, b, 18, 59, 74) {
		t.Errorf("at the left of the guest the colour is (%d, %d, %d), err %v: want the dark blue of the page of the application", r, g, b, err)
	}

	// A real pointer event, through the X server: inside the guest it reaches the guest, outside it the web
	// view of the application.
	f, _ = lv.hooks.Frame(id)
	if os.Getenv("CLARAE_TRACE_EVENTS") != "" {
		lv.hooks.TraceEvents()
	}
	inWin, inName := lv.hooks.WindowAt(f.X+f.W/2, f.Y+f.H/2)
	outWin, outName := lv.hooks.WindowAt(f.X-30, f.Y+f.H/2)
	lv.note("the X server has, under the centre of the guest, a window of %s (%d); 30 px left of it, one of %s (%d)", inName, inWin, outName, outWin)
	if inWin != 1 || outWin != 2 {
		t.Errorf("the window under the pointer: inside the guest %d (%s), outside %d (%s): want the guest, then the application", inWin, inName, outWin, outName)
	}
	g0, a0 := lv.hooks.Clicks(id)
	lv.hooks.PostClick(f.X+f.W/2, f.Y+f.H/2)
	time.Sleep(400 * time.Millisecond)
	g1, a1 := lv.hooks.Clicks(id)
	lv.hooks.PostClick(f.X-30, f.Y+f.H/2)
	time.Sleep(400 * time.Millisecond)
	g2, a2 := lv.hooks.Clicks(id)
	if g1 == g0 && a1 == a0 && g2 == g1 && a2 == a1 {
		lv.note("the X server delivered no pointer event (no XTest?): input routing was not tried")
	} else if g1 != g0+1 || a1 != a0 || g2 != g1 || a2 != a1+1 {
		t.Errorf("clicks: inside the guest guest %d->%d app %d->%d; outside guest %d->%d app %d->%d (want the guest, then the application)", g0, g1, a0, a1, g1, g2, a1, a2)
	}
	lv.pass(t, "bounds are fractions of the area of the web view of the application: worst error %.2f px over 5 window sizes and a SetBounds; hit test inside=guest outside=application; hidden=not hit; clicks: guest %d->%d app %d->%d, then guest %d->%d app %d->%d", worst, g0, g1, a0, a1, g1, g2, a1, a2)
}

func TestLiveNothingOfTheApplicationIsReachable(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	got := lv.js(t, id, `
		const out = {
			origin: location.origin,
			wails: typeof window.wails, runtime: typeof window._wails, call: typeof window.go, external: typeof window.external,
			chrome: typeof window.chrome,
			handlers: window.webkit && window.webkit.messageHandlers ? Object.keys(window.webkit.messageHandlers) : [],
			webkit: typeof window.webkit,
		};
		try { await fetch('wails://wails/index.html'); out.wailsFetch = 'reached'; } catch (e) { out.wailsFetch = 'refused'; }
		try { const r = await fetch('/wails/runtime.js'); out.runtimeJS = r.status; } catch (e) { out.runtimeJS = 'error'; }
		return JSON.stringify(out);`)
	var r struct {
		Origin   string
		Wails    string
		Runtime  string
		Call     string
		Chrome   string
		Handlers []string
		Fetch    string `json:"wailsFetch"`
	}
	if err := json.Unmarshal([]byte(got), &r); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(r.Origin, "http://127.0.0.1:") || r.Wails != "undefined" || r.Runtime != "undefined" || r.Call != "undefined" || r.Chrome != "undefined" || len(r.Handlers) != 0 || r.Fetch != "refused" {
		t.Fatalf("the page reaches the application: %s", got)
	}
	lv.pass(t, "a guest sees no bridge, no runtime, no message handler and cannot fetch the application's scheme: %s", got)
}

func TestLiveSchemesAndFramesAreRefused(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	start := lv.js(t, id, `return location.href`)
	reported, byWebKit := 0, []string{}
	for _, target := range []string{"file:///etc/hosts", "clarae://auth/callback?code=x&state=y", "wails://wails/index.html", "ftp://example.com/"} {
		mark := lv.mark()
		lv.js(t, id, fmt.Sprintf(`setTimeout(() => { location.href = %q }, 10); return 'scheduled'`, target))
		p, ok := lv.wait(mark, "webview:blocked", 3*time.Second, func(p any) bool { return p.(webview.BlockedPayload).ViewID == id })
		if ok {
			reported++
			// WebKitGTK does not say the frame: the refusal is not called a navigation of the top frame.
			if b := p.(webview.BlockedPayload); b.Reason != webview.BlockScheme || b.MainFrame {
				t.Errorf("%s: %+v (a refusal of a navigation of unknown frame, not reported as the top frame's)", target, b)
			}
		} else {
			byWebKit = append(byWebKit, target)
		}
		time.Sleep(300 * time.Millisecond)
		if now := lv.js(t, id, `return location.href`); now != start {
			t.Errorf("%s: the page moved to %s", target, now)
		}
	}
	for _, target := range byWebKit {
		if !strings.HasPrefix(target, "file:") {
			t.Errorf("%s was refused by nobody we can see (no webview:blocked)", target)
		}
	}
	lv.note("top frame: %d targets refused and reported by the policy of the core; refused by WebKit before the policy: %v", reported, byWebKit)

	// Where the top frame goes is not told by the decisions of the policy (they are the same for a frame): the driver
	// tells it when the top frame really starts to load, on a link, a script and a redirect, and not for a frame.
	m0 := lv.rec.mark()
	lv.js(t, id, `setTimeout(() => { location.href = "/inner" }, 10); return 'scheduled'`)
	lv.loaded(t, id)
	time.Sleep(300 * time.Millisecond)
	if got := lv.rec.mainsSince(m0); len(got) != 1 || got[0] != id+" "+lv.srv.HTTP+"/inner" {
		t.Errorf("the top frame went to /inner by a script, the notices are %v", got)
	}
	m0 = lv.rec.mark()
	lv.js(t, id, `setTimeout(() => { location.href = "/redirect?to=" + encodeURIComponent("/solid") }, 10); return 'scheduled'`)
	time.Sleep(1500 * time.Millisecond)
	notices := lv.rec.mainsSince(m0)
	// WebKitGTK publishes the address of a redirected load when it has been followed, not before: the notices end at
	// the address the top frame was sent to, and the policy covers the step in between (a redirect that follows a
	// navigation of unknown frame to a public host is not taken to start from the private page).
	if len(notices) < 1 || !strings.HasSuffix(notices[len(notices)-1], "/solid") {
		t.Errorf("the top frame was redirected, the notices are %v, want the last to be the address it was sent to", notices)
	}
	if err := lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/"); err != nil {
		t.Fatal(err)
	}
	lv.loaded(t, id)
	start = lv.js(t, id, `return location.href`)

	// A page that takes the top frame to a data URL: WebKit itself refuses, so the page stays put (the driver lets
	// about:, blob: and data: through, as what a page builds its frames with: see isMainFrame).
	lv.js(t, id, `setTimeout(() => { location.href = "data:text/html,<title>moved</title>moved" }, 10); return 'scheduled'`)
	time.Sleep(1200 * time.Millisecond)
	if now := lv.js(t, id, `return location.href`); now != start {
		t.Errorf("the top frame went to a data URL: %s", now)
	}

	// Frames inside the page: the ones that point at wails: and file: do not load, the others do. WebKitGTK does
	// not say which frame a navigation is for, so the frame that is refused is reported as a navigation of the top
	// frame (see isMainFrame).
	mark := lv.mark()
	m0 = lv.rec.mark()
	if err := lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/frames"); err != nil {
		t.Fatal(err)
	}
	lv.loaded(t, id)
	time.Sleep(1500 * time.Millisecond)
	if got := lv.rec.mainsSince(m0); len(got) != 1 || got[0] != id+" "+lv.srv.HTTP+"/frames" {
		t.Errorf("a page with frames: the notices of the top frame are %v, want only the page itself (the frames, /inner among them, are not the top frame)", got)
	}
	refused := map[string]bool{}
	for _, p := range lv.eventsSince(mark, "webview:blocked") {
		b := p.(webview.BlockedPayload)
		refused[b.URL] = true
	}
	if !refused["wails://wails/"] {
		t.Errorf("the wails: frame was not refused and reported: %v", refused)
	}
	got := lv.js(t, id, `const r = {}; for (const f of document.querySelectorAll('iframe')) { try { r[f.id] = f.contentDocument ? f.contentDocument.body.innerText.slice(0, 20) : 'cross-origin'; } catch (e) { r[f.id] = 'blocked'; } } return JSON.stringify(r)`)
	var frames map[string]string
	_ = json.Unmarshal([]byte(got), &frames)
	lv.note("frames (file:, wails:, about:, data:, srcdoc, a named one): %s; reported as refused: %v", got, refused)
	if !strings.Contains(frames["f5"], "srcdoc") || !strings.Contains(frames["f6"], "inner frame") || frames["f4"] == "" {
		t.Errorf("a srcdoc, data: or same-site frame did not load (a data: frame is a document of an opaque origin: cross-origin to the page): %s", got)
	}
	if f2 := frames["f2"]; f2 != "" && f2 != "blocked" && f2 != "cross-origin" {
		t.Errorf("the wails: frame has content: %s", got)
	}
	lv.pass(t, "clarae:, wails:, ftp: in the top frame are cancelled and reported, file: is refused by WebKit, a data: URL does not take the top frame, the page stays put (%d reported); frames: wails: is refused, srcdoc, data: and a same-site frame load: %s", reported, got)
}

func TestLiveNewWindowsDownloadsAndPermissions(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/popup")
	windows := len(lv.app.Window.GetAll())

	// A page that asks for a window with no user in front of it gets none, not even in the system browser.
	mark := lv.mark()
	lv.js(t, id, `document.getElementById('blank').click(); return 'clicked'`)
	if p, ok := lv.wait(mark, "webview:new-window", 8*time.Second, nil); !ok {
		t.Fatal("target=_blank produced no webview:new-window")
	} else if nw := p.(webview.NewWindowPayload); nw.Opened {
		t.Fatalf("a window asked for without a gesture reached the system browser: %+v", nw)
	}
	time.Sleep(1200 * time.Millisecond)
	if n := len(lv.externalOpened()); n != 0 {
		t.Fatalf("the system browser was opened %d times without a gesture", n)
	}
	// With the user working in the guest a moment before (a key typed in it), the same click is forwarded.
	mark = lv.mark()
	lv.hooks.PostKey(id, keyX, 0)
	lv.js(t, id, `document.getElementById('blank').click(); return 'clicked'`)
	if p, ok := lv.wait(mark, "webview:new-window", 8*time.Second, nil); !ok {
		t.Fatal("target=_blank produced no webview:new-window")
	} else if nw := p.(webview.NewWindowPayload); !nw.Opened || nw.URL != "https://example.org/from-target-blank" {
		t.Fatalf("new window with a gesture: %+v", nw)
	}
	// A guest that is hidden gets none, gesture or not.
	time.Sleep(1500 * time.Millisecond)
	if err := lv.mgr.SetVisible("vault-a", id, false); err != nil {
		t.Fatal(err)
	}
	before := len(lv.externalOpened())
	lv.hooks.PostKey(id, keyX, 0)
	mark = lv.mark()
	lv.js(t, id, `document.getElementById('blank').click(); return 'clicked'`)
	if p, ok := lv.wait(mark, "webview:new-window", 5*time.Second, nil); ok && p.(webview.NewWindowPayload).Opened {
		t.Fatal("a hidden guest sent a window to the system browser")
	}
	if len(lv.externalOpened()) != before {
		t.Fatal("a hidden guest opened the system browser")
	}
	if err := lv.mgr.SetVisible("vault-a", id, true); err != nil {
		t.Fatal(err)
	}
	if n := lv.hooks.Count(); n != 1 {
		t.Fatalf("%d guests after the popups, want 1", n)
	}
	if n := len(lv.app.Window.GetAll()); n != windows {
		t.Fatalf("%d windows, want %d: a popup opened a window", n, windows)
	}

	// Downloads.
	if err := lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/dl-link"); err != nil {
		t.Fatal(err)
	}
	lv.loaded(t, id)
	mark = lv.mark()
	lv.js(t, id, `document.getElementById('a').click(); return 'clicked'`)
	if _, ok := lv.wait(mark, "webview:download", 8*time.Second, nil); !ok {
		t.Error("a link to an attachment was not reported as a refused download")
	}
	mark = lv.mark()
	lv.js(t, id, `document.getElementById('b').click(); return 'clicked'`)
	if _, ok := lv.wait(mark, "webview:download", 8*time.Second, nil); !ok {
		t.Error("a link with the download attribute was not reported as a refused download")
	}
	mark = lv.mark()
	if err := lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/dl"); err != nil {
		t.Fatal(err)
	}
	if _, ok := lv.wait(mark, "webview:download", 8*time.Second, nil); !ok {
		t.Error("navigating to an attachment was not reported as a refused download")
	}
	home, _ := os.UserHomeDir()
	for _, dir := range []string{"Downloads", ""} {
		if _, err := os.Stat(filepath.Join(home, dir, "clarae-live-test.bin")); err == nil {
			t.Fatal("a file was downloaded")
		}
	}

	// The dialogs of the page are answered by the driver and never wait for a person.
	if err := lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/dialogs"); err != nil {
		t.Fatal(err)
	}
	lv.loaded(t, id)
	dialogs := lv.js(t, id, `alert('hi'); const c = confirm('sure?'); const p = prompt('name?', 'dflt'); return JSON.stringify({confirm: c, prompt: p})`)
	if !strings.Contains(dialogs, `"confirm":false`) {
		t.Errorf("confirm() was not answered no: %s", dialogs)
	}

	// Permissions. localhost is a secure origin for WebKit (127.0.0.1 is too, for the page: both have the APIs).
	if err := lv.mgr.Navigate("vault-a", id, strings.Replace(lv.srv.HTTP, "127.0.0.1", "localhost", 1)+"/"); err != nil {
		t.Fatal(err)
	}
	lv.loaded(t, id)
	mark = lv.mark()
	got := lv.js(t, id, `
		const out = {origin: location.origin, secure: window.isSecureContext};
		out.mediaDevices = typeof navigator.mediaDevices;
		try { await Promise.race([navigator.mediaDevices.getUserMedia({audio: true, video: true}).then(() => out.media = 'GRANTED'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]); }
		catch (e) { out.media = e.name + ':' + e.message; }
		out.notification = typeof Notification === 'undefined' ? 'absent' : Notification.permission;
		if (typeof Notification !== 'undefined') { try { out.notificationAsked = await Notification.requestPermission(); } catch (e) { out.notificationAsked = 'error'; } }
		out.geo = await new Promise(res => { if (!navigator.geolocation) return res('absent'); const t = setTimeout(() => res('no answer'), 6000); navigator.geolocation.getCurrentPosition(() => { clearTimeout(t); res('GRANTED'); }, e => { clearTimeout(t); res('denied:' + e.code); }); });
		return JSON.stringify(out);`)
	lv.note("permissions on localhost: %s", got)
	if strings.Contains(got, "GRANTED") || strings.Contains(got, `"granted"`) {
		t.Fatalf("a permission was granted: %s", got)
	}
	var seen []string
	for _, p := range lv.eventsSince(mark, "webview:permission") {
		seen = append(seen, p.(webview.PermissionPayload).Permission)
	}
	lv.pass(t, "target=_blank and window.open do not open a window (1 guest, %d window); only an https address reached the system browser, and only with a key typed before and the view shown; downloads by link, attribute and navigation are refused and reported; alert/confirm/prompt do not wait; getUserMedia, Notification and geolocation are not granted (denied as %v): %s", windows, seen, got)
}

func TestLiveCertificatesCannotBeBypassed(t *testing.T) {
	defer lv.closeAll(t)
	mark := lv.mark()
	id, err := lv.mgr.Open("vault-a", lv.srv.TLS+"/", defaultBounds)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := lv.wait(mark, "webview:load-error", 15*time.Second, nil)
	if !ok {
		t.Fatal("a self-signed certificate was not reported")
	}
	le := p.(webview.LoadErrorPayload)
	if !le.Certificate || le.ViewID != id {
		t.Fatalf("load error %+v", le)
	}
	time.Sleep(500 * time.Millisecond)
	if n := len(lv.eventsSince(mark, "webview:load-error")); n != 1 {
		t.Errorf("the certificate error was reported %d times, want once", n)
	}
	if s, _ := lv.hooks.Eval(id, "return document.title + '|' + location.protocol", 5*time.Second); strings.Contains(s, "solid") {
		t.Fatalf("the page of an untrusted server loaded: %q", s)
	}
	// Again: still no way in.
	mark = lv.mark()
	if err := lv.mgr.Reload("vault-a", id); err != nil {
		t.Fatal(err)
	}
	if _, ok := lv.wait(mark, "webview:load-error", 15*time.Second, nil); !ok {
		t.Fatal("the second load of an untrusted server did not fail")
	}
	lv.pass(t, "a self-signed https server fails the load with certificate=true (%s), once per load, twice; no bypass exists", le.Message)
}

func TestLiveAuthenticationChallengesAreRefused(t *testing.T) {
	defer lv.closeAll(t)
	before := lv.srv.hitsCredentials.Load()
	for _, path := range []string{"/basic", "/digest"} {
		mark := lv.mark()
		id, err := lv.mgr.Open("vault-a", lv.srv.HTTP+path, defaultBounds)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := lv.wait(mark, "webview:blocked", 10*time.Second, func(p any) bool { return p.(webview.BlockedPayload).ViewID == id }); !ok {
			t.Errorf("%s: a challenge for credentials was not refused and reported", path)
		}
		time.Sleep(500 * time.Millisecond)
		_ = lv.mgr.Close("vault-a", id)
	}
	if lv.srv.hitsCredentials.Load() != before {
		t.Errorf("a request carried credentials")
	}
	lv.pass(t, "a server that asks for credentials (Basic, Digest) is refused and reported: the challenge is cancelled and no credential is sent")
}

func TestLiveReservedKeys(t *testing.T) {
	defer lv.closeAll(t)
	if err := lv.mgr.ReserveKeys([]string{"ctrl+w", "ctrl+shift+tab", "f5", "ctrl+alt+k"}); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lv.mgr.ReserveKeys(nil) }()
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	press := func(keyval, state uint) (string, bool) {
		mark := lv.mark()
		lv.hooks.PostKey(id, keyval, state)
		p, ok := lv.wait(mark, "webview:key", 500*time.Millisecond, func(p any) bool { return p.(webview.KeyPayload).ViewID == id })
		if !ok {
			return "", false
		}
		return p.(webview.KeyPayload).Accelerator, true
	}
	for _, c := range []struct {
		name         string
		key, state   uint
		want         string
		wantReported bool
	}{
		{"ctrl+w", keyW, maskCtrl, "ctrl+w", true},
		{"ctrl+shift+tab", keyISOLeft, maskCtrl | maskShift, "ctrl+shift+tab", true},
		{"f5", keyF5, 0, "f5", true},
		{"ctrl+alt+k", 0x6b, maskCtrl | maskAlt, "ctrl+alt+k", true},
		{"a key that is not reserved", keyX, 0, "", false},
		{"ctrl+x (editing: never reserved)", keyX, maskCtrl, "", false},
		{"ctrl+tab (not reserved here)", keyTab, maskCtrl, "", false},
		{"super+w", keyW, maskSuper, "", false},
	} {
		got, ok := press(c.key, c.state)
		if ok != c.wantReported || got != c.want {
			t.Errorf("%s: reported %v as %q, want %v as %q", c.name, ok, got, c.wantReported, c.want)
		}
	}
	// A key that is not reserved reaches the page; one that is does not.
	if got := lv.js(t, id, `return JSON.stringify(window.__keys)`); strings.Contains(got, "ctrl+w") {
		t.Errorf("a reserved key reached the page: %s", got)
	}
	lv.pass(t, "reserved accelerators (ctrl+w, ctrl+shift+tab, f5, ctrl+alt+k) are handed to Go and consumed; editing keys, unreserved keys and the logo key are not")
}

func TestLiveFocusAndActivity(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	if err := lv.mgr.Focus("vault-a", id); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	f, _ := lv.hooks.Frame(id)
	if !f.HasFocus {
		t.Fatalf("Focus did not give the guest the focus: %+v", f)
	}
	mark := lv.mark()
	_ = mark
	a0 := lv.activity.Load()
	lv.hooks.PostKey(id, keyX, 0)
	time.Sleep(300 * time.Millisecond)
	if lv.activity.Load() == a0 {
		t.Error("a key in a guest was not reported as activity")
	}
	// Hidden, the guest gives the focus back to the application.
	if err := lv.mgr.SetVisible("vault-a", id, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if !lv.hooks.AppFocused() {
		t.Error("the focus was not given back to the web view of the application when the guest was hidden")
	}
	lv.pass(t, "Focus gives the guest the keyboard focus, a key in it is reported as activity, hiding it gives the focus back to the application")
}

func TestLiveSessionsPerVaultAndClearData(t *testing.T) {
	defer lv.closeAll(t)
	a := lv.open(t, "vault-a", lv.srv.HTTP+"/cookie-set?v=alpha")
	b := lv.open(t, "vault-b", lv.srv.HTTP+"/cookie-get")
	_ = a
	if got := lv.js(t, b, `return document.getElementById('b').textContent`); got != "none" {
		t.Fatalf("vault-b sees the cookie of vault-a: %q", got)
	}
	// Same vault, another view: the cookie is there.
	a2 := lv.open(t, "vault-a", lv.srv.HTTP+"/cookie-get")
	if got := lv.js(t, a2, `return document.getElementById('b').textContent`); got != "alpha" {
		t.Fatalf("a second view of vault-a does not share its cookie: %q", got)
	}
	// The cookies are kept in the folder of the store, on disk: they survive a restart.
	store := webview.DataStoreID("vault-a")
	folder, err := userDataFolder(webappsDir(lv.dataDir), store)
	if err != nil {
		t.Fatal(err)
	}
	if !lv.mgr.PersistentData() {
		t.Error("PersistentData is false")
	}
	deadline := time.Now().Add(10 * time.Second)
	var size int64
	for time.Now().Before(deadline) {
		if st, err := os.Stat(filepath.Join(folder, "data", "cookies.sqlite")); err == nil && st.Size() > 0 {
			size = st.Size()
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	if size == 0 {
		t.Errorf("no cookie database in %s", folder)
	}
	// ClearData: the views of the vault are closed, the folder is deleted, the next view starts empty.
	if err := lv.mgr.ClearData("vault-a"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(folder); !os.IsNotExist(err) {
		t.Errorf("the folder of the store is still there after ClearData: %v", err)
	}
	if n := lv.mgr.Count("vault-a"); n != 0 {
		t.Errorf("%d views of vault-a after ClearData", n)
	}
	a3 := lv.open(t, "vault-a", lv.srv.HTTP+"/cookie-get")
	if got := lv.js(t, a3, `return document.getElementById('b').textContent`); got != "none" {
		t.Fatalf("the cookie survived ClearData: %q", got)
	}
	if got := lv.js(t, b, `return location.href`); !strings.Contains(got, "/cookie-get") {
		t.Errorf("another vault was touched by ClearData: %q", got)
	}
	lv.pass(t, "sessions are per vault (vault-b does not see vault-a's cookie, a second view of vault-a does), cookies are written to %s, ClearData deletes the folder and the next view starts empty without touching the other vault", folder)
}

// While the data of a store are being deleted a view of the store is refused, with an ordinary error (the UI offers to
// try again), not the one of a platform that cannot show views: the folder that is about to go must not get a live
// session, and the session must not be lost for good.
func TestLiveAStoreThatIsBeingDeletedRefusesNewViews(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-c", lv.srv.HTTP+"/")
	store := webview.DataStoreID("vault-c")
	lv.hooks.SetClearing(store, true)
	_, err := lv.mgr.Open("vault-c", lv.srv.HTTP+"/", defaultBounds)
	lv.hooks.SetClearing(store, false)
	if err == nil || !strings.Contains(err.Error(), "being deleted") {
		t.Fatalf("Open on a store that is being deleted: %v", err)
	}
	if errorsIs(err, webview.ErrUnavailable) || !errorsIs(err, webview.ErrDriver) {
		t.Fatalf("the refusal must be an ordinary driver failure, not the one of a platform that cannot: %v", err)
	}
	if !lv.mgr.Available() {
		t.Fatal("the Manager went to the fallback for a store that was being deleted")
	}
	if _, err := lv.mgr.Open("vault-c", lv.srv.HTTP+"/", defaultBounds); err != nil {
		t.Fatalf("the second try: %v", err)
	}
	_ = id
	lv.pass(t, "a store that is being deleted refuses a new view with an ordinary error (try again), the Manager stays available, and the view opens once the deletion is over")
}

func TestLiveRepeatedOpenAndClose(t *testing.T) {
	defer lv.closeAll(t)
	for i := range 12 {
		id, err := lv.mgr.Open("vault-a", lv.srv.HTTP+"/", defaultBounds)
		if err != nil {
			t.Fatalf("open %d: %v", i, err)
		}
		if i%3 == 0 {
			time.Sleep(150 * time.Millisecond)
		}
		if err := lv.mgr.Close("vault-a", id); err != nil {
			t.Fatalf("close %d: %v", i, err)
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for lv.hooks.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := lv.hooks.Count(); n != 0 {
		t.Fatalf("%d guests left", n)
	}
	if d := lv.hooks.Dropped(); d != 0 {
		t.Errorf("%d reports were dropped", d)
	}
	lv.pass(t, "12 views opened and closed in a row (some before they loaded) leave no guest behind and drop no report")
}

func TestLiveShutdownWithViewsOpen(t *testing.T) {
	// Last: the driver of the application is told to close everything, as at exit, and nothing is left.
	for range 3 {
		if _, err := lv.mgr.Open("vault-a", lv.srv.HTTP+"/", defaultBounds); err != nil {
			t.Fatal(err)
		}
	}
	lv.drv.CloseAll()
	deadline := time.Now().Add(3 * time.Second)
	for lv.hooks.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := lv.hooks.Count(); n != 0 {
		t.Fatalf("%d guests after CloseAll", n)
	}
	lv.pass(t, "CloseAll, as at exit, removes the guests that are open")
}

func errorsIs(err, target error) bool { return errors.Is(err, target) }
