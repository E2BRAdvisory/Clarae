//go:build darwin && cgo && nativeviewtest

package nativeview

// The live test of the macOS driver: it opens a real window (Wails v3, the same options as the
// application), puts real WKWebViews in it through a real webview.Manager, and checks what the page of
// an application can and cannot do. Run it by hand on a Mac, with the screen on:
//
//	go test -tags nativeviewtest -count=1 -v -timeout 600s ./internal/shell/nativeview/
//
// (from apps/desktop; from the repository root: task test-nativeview). It needs the network for two of
// its checks: a public site that forbids framing (github.com, or CLARAE_NATIVEVIEW_PUBLIC) and the name
// *.localtest.me, which resolves to 127.0.0.1 and is "public" for the rules of the private network; a
// check whose network is missing says so and is skipped, never counted as passed. It prints a summary
// of its own at the end ("LIVE RESULT").

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
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

// live is the state shared by the tests: one window, one driver, one manager.
type live struct {
	app   *application.App
	win   *application.WebviewWindow
	drv   webview.Driver
	hooks *Hooks
	mgr   *webview.Manager
	srv   *servers

	activity atomic.Int64 // reports of the user working in a view (Options.OnActivity)

	mu       sync.Mutex
	events   []recorded
	external []string
	menu     map[string]*atomic.Int64
	notes    []string
	skipped  []string
	passed   []string
}

type recorded struct {
	name    string
	payload any
	at      time.Time
}

var lv = &live{menu: map[string]*atomic.Int64{"close": {}, "print": {}}}

func (l *live) emit(name string, payload any) {
	l.mu.Lock()
	l.events = append(l.events, recorded{name, payload, time.Now()})
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

// eventsSince returns the payloads named name logged after mark.
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
func (l *live) wait(t *testing.T, mark int, name string, d time.Duration, pred func(any) bool) (any, bool) {
	t.Helper()
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

func (l *live) skip(t *testing.T, format string, a ...any) {
	t.Helper()
	s := fmt.Sprintf(t.Name()+": "+format, a...)
	l.mu.Lock()
	l.skipped = append(l.skipped, s)
	l.mu.Unlock()
	fmt.Println("SKIP   " + s)
	t.Skip(s)
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
	deadline := time.Now().Add(25 * time.Second)
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
	if n := l.hooks.Count(); n != 0 {
		t.Fatalf("%d guests left after CloseAll", n)
	}
}

// ---- the test servers ---------------------------------------------------------------------------

type servers struct {
	HTTP, TLS, Secret string
	hitsSecret        atomic.Int64
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
<a id=filelink href="file:///etc/hosts" target=_blank>file</a>
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
	mux.HandleFunc("/redirect", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, r.URL.Query().Get("to"), http.StatusFound) //nolint:gosec // a test server that redirects where the test says
	})
	mux.HandleFunc("/frames", func(w http.ResponseWriter, r *http.Request) {
		html(w, `<!doctype html><title>frames</title>
<iframe id=f1 src="file:///etc/hosts"></iframe><iframe id=f2 src="wails://wails/"></iframe>
<iframe id=f3 src="about:blank"></iframe><iframe id=f4 src="data:text/html,framed"></iframe>
<iframe id=f5 srcdoc="<p>srcdoc</p>"></iframe>`)
	})
	mux.HandleFunc("/xfo", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "frame-ancestors 'none'")
		html(w, solidPage)
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
		s.hitsSecret.Add(1)
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
	lv.app = application.New(application.Options{
		Name: "nativeview live test",
		Assets: application.AssetOptions{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html")
			_, _ = fmt.Fprint(w, placeholderPage)
		})},
		Mac: application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
	})
	// The window of apps/desktop/main.go.
	lv.win = lv.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name: "main", Title: "nativeview live test", Width: 1100, Height: 760, MinWidth: 720, MinHeight: 480,
		BackgroundColour:           application.NewRGB(16, 43, 58),
		EnableFileDrop:             false,
		DefaultContextMenuDisabled: true,
		Mac:                        application.MacWindow{TitleBar: application.MacTitleBarHiddenInset},
	})
	// A menu with the accelerators a guest competes for.
	menu := application.NewMenu()
	appMenu := menu.AddSubmenu("live test")
	appMenu.AddRole(application.Quit)
	file := menu.AddSubmenu("File")
	file.Add("Close tab").SetAccelerator("CmdOrCtrl+w").OnClick(func(*application.Context) { lv.menu["close"].Add(1) })
	file.Add("Print").SetAccelerator("CmdOrCtrl+p").OnClick(func(*application.Context) { lv.menu["print"].Add(1) })
	edit := menu.AddSubmenu("Edit")
	edit.AddRole(application.Copy)
	edit.AddRole(application.Paste)
	edit.AddRole(application.SelectAll)
	lv.app.Menu.Set(menu)

	lv.app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go func() {
			for i := 0; i < 100 && lv.win.NativeWindow() == nil; i++ {
				time.Sleep(100 * time.Millisecond)
			}
			time.Sleep(1200 * time.Millisecond) // the page of the window is loaded and shown
			lv.drv = New(lv.win)
			lv.hooks = TestHooks(lv.drv)
			lv.mgr = webview.NewManager(webview.Options{
				Driver:     func() webview.Driver { return lv.drv },
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
			lv.hooks.Activate()
			time.Sleep(300 * time.Millisecond)
			c := m.Run()
			lv.report(c)
			lv.mgr.Shutdown()
			lv.srv.close()
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
	fmt.Println("LIVE RESULT: macOS", runtime.GOARCH, "exit code", code)
	for _, s := range l.passed {
		fmt.Println("LIVE PASS  ", s)
	}
	for _, s := range l.skipped {
		fmt.Println("LIVE SKIP  ", s)
	}
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

// ---- the tests ----------------------------------------------------------------------------------

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
	if !strings.Contains(r.UA, "Safari/605.1.15") || !strings.Contains(r.UA, "Version/") || !strings.Contains(r.UA, "AppleWebKit") {
		t.Fatalf("user agent %q is not a Safari's", r.UA)
	}
	if _, ok := lv.wait(t, 0, "webview:state", 5*time.Second, func(p any) bool {
		s := p.(webview.StatePayload)
		return s.ViewID == id && s.Title == "solid" && !s.Loading
	}); !ok {
		t.Fatal("no webview:state with the title of the page")
	}
	// Nothing here asks for the icon of a page, and the web inspector is off.
	time.Sleep(1500 * time.Millisecond)
	if n := lv.srv.hitsFavicon.Load(); n != 0 {
		t.Fatalf("the favicon was requested %d times", n)
	}
	if lv.hooks.Inspectable(id) {
		t.Fatal("the web inspector can attach to a guest")
	}
	lv.pass(t, "a view loads a page served locally (0 favicon requests, inspector off); the user agent is Safari-like: %s", r.UA)
}

func TestLiveSiteThatForbidsFraming(t *testing.T) {
	defer lv.closeAll(t)
	url := os.Getenv("CLARAE_NATIVEVIEW_PUBLIC")
	if url == "" {
		url = "https://github.com"
	}
	// The local page that sends X-Frame-Options: DENY and frame-ancestors 'none': the same mechanism, no network.
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/xfo")
	if got := lv.js(t, id, `return document.title`); got != "solid" {
		t.Fatalf("the page with X-Frame-Options: DENY did not load: %q", got)
	}
	lv.closeAll(t)
	conn, err := net.DialTimeout("tcp", "github.com:443", 5*time.Second)
	if err != nil {
		lv.skip(t, "no network, the public site was not tried (the local X-Frame-Options page loaded)")
	}
	_ = conn.Close()
	id, err = lv.mgr.Open("vault-a", url, defaultBounds)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	var title, top string
	for time.Now().Before(deadline) {
		if rs, err := lv.hooks.Eval(id, "return document.readyState", 5*time.Second); err == nil && rs == "complete" {
			title = lv.js(t, id, `return document.title`)
			top = lv.js(t, id, `return String(window.top === window.self) + ' ' + String(document.body ? document.body.innerText.length : -1)`)
			if title != "" {
				break
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	if !strings.Contains(strings.ToLower(title), "github") {
		t.Fatalf("%s did not load in a view: title %q", url, title)
	}
	lv.pass(t, "%s (X-Frame-Options: DENY) loads in a view: title %q, top-level and body length %s", url, title, top)
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
		if worst > 1.0 {
			t.Errorf("%s: frame (%.1f, %.1f, %.1f, %.1f) pt, expected (%.1f, %.1f, %.1f, %.1f) in a content view of %.0fx%.0f: off by %.2f pt",
				label, f.X, f.Y, f.W, f.H, exp[0], exp[1], exp[2], exp[3], f.CW, f.CH, worst)
		}
		return worst
	}
	worst := check("at the start", defaultBounds)
	for _, sz := range [][2]int{{1280, 820}, {900, 600}, {760, 500}, {1100, 760}} {
		lv.win.SetSize(sz[0], sz[1])
		time.Sleep(600 * time.Millisecond) // the content view follows, and the guest with it, in the same run of the loop
		if w := check(fmt.Sprintf("window %dx%d", sz[0], sz[1]), defaultBounds); w > worst {
			worst = w
		}
	}
	nb := webview.Bounds{X: 0.1, Y: 0.1, Width: 0.8, Height: 0.5}
	if err := lv.mgr.SetBounds("vault-a", id, nb); err != nil {
		t.Fatal(err)
	}
	if w := check("after SetBounds", nb); w > worst {
		worst = w
	}
	// Clicks and scrolls reach the guest inside its rectangle and the web view of the application outside it.
	f, _ := lv.hooks.Frame(id)
	in := lv.hooks.HitTest(id, f.X+f.W/2, f.Y+f.H/2)
	out := lv.hooks.HitTest(id, f.X-30, f.Y+f.H/2)
	corner := lv.hooks.HitTest(id, f.X+f.W-2, f.Y+f.H-2)
	if in != 1 || out != 2 || corner != 1 {
		t.Fatalf("hit test: centre %d (want 1), 30 pt outside %d (want 2), corner %d (want 1)", in, out, corner)
	}
	// Hidden, a guest receives nothing.
	if err := lv.mgr.SetVisible("vault-a", id, false); err != nil {
		t.Fatal(err)
	}
	if f, _ := lv.hooks.Frame(id); !f.Hidden || lv.hooks.HitTest(id, f.X+f.W/2, f.Y+f.H/2) != 2 {
		t.Fatalf("a hidden guest is still hit: %+v", f)
	}
	if err := lv.mgr.SetVisible("vault-a", id, true); err != nil {
		t.Fatal(err)
	}
	lv.pass(t, "bounds are fractions of the content view: worst error %.2f pt over 5 window sizes and a SetBounds; hit test inside=guest outside=application; hidden=not hit", worst)
}

func TestLiveNothingOfTheApplicationIsReachable(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	got := lv.js(t, id, `
		const out = {
			origin: location.origin,
			wails: typeof window.wails, runtime: typeof window._wails, call: typeof window.go,
			chrome: typeof window.chrome,
			handlers: window.webkit && window.webkit.messageHandlers ? Object.keys(window.webkit.messageHandlers) : [],
			webkit: typeof window.webkit,
		};
		try { await fetch('wails://wails/index.html'); out.wailsFetch = 'reached'; } catch (e) { out.wailsFetch = 'refused'; }
		try { const r = await fetch('/wails/runtime.js'); out.runtimeJS = r.status; } catch (e) { out.runtimeJS = 'error'; }
		out.cookie = document.cookie;
		return JSON.stringify(out);`)
	var r struct {
		Origin   string
		Wails    string
		Runtime  string
		Call     string
		Chrome   string
		Handlers []string
		Webkit   string
		Fetch    string `json:"wailsFetch"`
		RuntimeJ any    `json:"runtimeJS"`
	}
	if err := json.Unmarshal([]byte(got), &r); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(r.Origin, "http://127.0.0.1:") || r.Wails != "undefined" || r.Runtime != "undefined" || r.Call != "undefined" || r.Chrome != "undefined" || len(r.Handlers) != 0 || r.Fetch != "refused" {
		t.Fatalf("the page reaches the application: %s", got)
	}
	lv.pass(t, "a guest sees no bridge, no runtime, no message handler and cannot fetch the application's scheme: %s", got)
}

func TestLiveSchemesAreRefused(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	start := lv.js(t, id, `return location.href`)
	// What reaches the policy of the core is reported. file: from a web page never gets that far: WebKit
	// itself refuses a navigation from a web page to a local resource.
	reported, byWebKit := 0, []string{}
	for _, target := range []string{"file:///etc/hosts", "clarae://auth/callback?code=x&state=y", "wails://wails/index.html", "data:text/html,<script>alert(1)</script>", "slack://open", "ftp://example.com/", "about:blank"} {
		mark := lv.mark()
		lv.js(t, id, fmt.Sprintf(`setTimeout(() => { location.href = %q }, 10); return 'scheduled'`, target))
		p, ok := lv.wait(t, mark, "webview:blocked", 3*time.Second, func(p any) bool { return p.(webview.BlockedPayload).ViewID == id })
		if ok {
			reported++
			if b := p.(webview.BlockedPayload); b.Reason != webview.BlockScheme || !b.MainFrame {
				t.Errorf("%s: %+v", target, b)
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
		if !strings.HasPrefix(target, "file:") && !strings.HasPrefix(target, "about:") {
			t.Errorf("%s was refused by nobody we can see (no webview:blocked)", target)
		}
	}
	lv.note("top frame: %d targets refused and reported by the policy of the core; refused by WebKit before the policy: %v", reported, byWebKit)
	// A click on a link does the same.
	mark := lv.mark()
	lv.js(t, id, `const a = document.createElement('a'); a.id = 'x'; a.href = 'clarae://open?vault=x'; document.body.appendChild(a); a.click(); return 'clicked'`)
	if _, ok := lv.wait(t, mark, "webview:blocked", 8*time.Second, nil); !ok {
		t.Error("a click on a clarae: link was not refused")
	}
	// Frames inside the page: the ones that point at wails: and file: do not load.
	mark = lv.mark()
	if err := lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/frames"); err != nil {
		t.Fatal(err)
	}
	lv.loaded(t, id)
	time.Sleep(1000 * time.Millisecond)
	blocked := 0
	for _, p := range lv.eventsSince(mark, "webview:blocked") {
		if b := p.(webview.BlockedPayload); !b.MainFrame && b.Reason == webview.BlockScheme {
			blocked++
		}
	}
	if blocked < 1 {
		t.Errorf("no frame was refused: the wails: frame must be")
	}
	got := lv.js(t, id, `const r = {}; for (const f of document.querySelectorAll('iframe')) { try { r[f.id] = f.contentDocument ? f.contentDocument.body.innerText.slice(0, 20) : 'cross-origin'; } catch (e) { r[f.id] = 'blocked'; } } return JSON.stringify(r)`)
	lv.note("frames (wails:, file:, about:, data:, srcdoc): %s; %d refused by the policy", got, blocked)
	if !strings.Contains(got, "srcdoc") {
		t.Errorf("a srcdoc frame did not load: %s", got)
	}
	var frames map[string]string
	_ = json.Unmarshal([]byte(got), &frames)
	if f2 := frames["f2"]; f2 != "" && f2 != "blocked" && f2 != "cross-origin" { // a frame that did not load is an empty document
		t.Errorf("the wails: frame has content: %s", got)
	}
	lv.pass(t, "clarae:, wails:, data:, slack:, ftp: in the top frame are cancelled and reported, file: is refused by WebKit, the page stays put (%d reported); a wails: frame inside a page is refused, srcdoc loads", reported)
}

func TestLiveRedirectsAndThePrivateNetwork(t *testing.T) {
	defer lv.closeAll(t)
	// 1. A view opened on a private host (this machine) may follow a redirect to another private host.
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	before := lv.srv.hitsSecret.Load()
	if err := lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/redirect?to="+lv.srv.Secret+"/"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for lv.srv.hitsSecret.Load() == before && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if lv.srv.hitsSecret.Load() == before {
		t.Fatal("a view opened on a private host could not follow a redirect to a private host (control)")
	}
	lv.closeAll(t)

	// 2. A redirect to a scheme that is not allowed.
	id = lv.open(t, "vault-a", lv.srv.HTTP+"/")
	mark := lv.mark()
	_ = lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/redirect?to=clarae://auth/callback%3Fcode%3Dx")
	if _, ok := lv.wait(t, mark, "webview:blocked", 8*time.Second, nil); !ok {
		lv.note("a 302 to clarae: produced no webview:blocked (WebKit refuses a scheme it cannot load by itself: it reports a load error)")
		if _, ok := lv.wait(t, mark, "webview:load-error", 3*time.Second, nil); !ok {
			t.Error("a 302 to clarae: was neither refused nor reported as an error")
		}
	}
	lv.closeAll(t)

	// 3. A page that is not on a private host cannot take the view there, by a redirect or by a script.
	host := "app.localtest.me"
	if addrs, err := net.LookupHost(host); err != nil || len(addrs) == 0 || addrs[0] != "127.0.0.1" {
		lv.skip(t, "%s does not resolve to 127.0.0.1 here (%v): the redirect from a public name to the private network was not tried; the control and the scheme checks above ran", host, err)
	}
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(lv.srv.HTTP, "http://"))
	public := "http://" + host + ":" + port
	before = lv.srv.hitsSecret.Load()
	id = lv.open(t, "vault-a", public+"/")
	mark = lv.mark()
	_ = lv.mgr.Navigate("vault-a", id, public+"/redirect?to="+lv.srv.Secret+"/") // user choice: a name that is public
	if p, ok := lv.wait(t, mark, "webview:blocked", 8*time.Second, nil); !ok {
		t.Fatal("a redirect from a public name to 127.0.0.1 was not cancelled")
	} else if b := p.(webview.BlockedPayload); b.Reason != webview.BlockPrivateNetwork {
		t.Fatalf("blocked as %q, want private-network", b.Reason)
	}
	time.Sleep(500 * time.Millisecond)
	if lv.srv.hitsSecret.Load() != before {
		t.Fatal("the service of the local machine received the request that was cancelled")
	}
	// A script of the page does the same.
	mark = lv.mark()
	lv.js(t, id, fmt.Sprintf(`setTimeout(() => { location.href = %q }, 10); return 'scheduled'`, lv.srv.Secret+"/by-script"))
	if _, ok := lv.wait(t, mark, "webview:blocked", 8*time.Second, nil); !ok {
		t.Fatal("a script of a public page took the view to 127.0.0.1")
	}
	time.Sleep(500 * time.Millisecond)
	if lv.srv.hitsSecret.Load() != before {
		t.Fatal("the service of the local machine was reached by a script of a public page")
	}
	lv.pass(t, "a 302 and a script on a public name (%s) cannot take the view to 127.0.0.1: cancelled before the request, the local service got 0 hits; a view opened on a private host follows private redirects", host)
}

func TestLiveNewWindowsAndDownloadsAndPermissions(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/popup")
	windows := len(lv.app.Window.GetAll())

	// A page that asks for a window with no user in front of it gets none, not even in the system browser
	// (callAsyncJavaScript is a script of the page, which WebKit lets click links; there was no key and no
	// click in the guest).
	mark := lv.mark()
	lv.js(t, id, `document.getElementById('blank').click(); return 'clicked'`)
	if p, ok := lv.wait(t, mark, "webview:new-window", 8*time.Second, nil); !ok {
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
	lv.hooks.KeyDown(id, "x", 7)
	lv.js(t, id, `document.getElementById('blank').click(); return 'clicked'`)
	if p, ok := lv.wait(t, mark, "webview:new-window", 8*time.Second, nil); !ok {
		t.Fatal("target=_blank produced no webview:new-window")
	} else if nw := p.(webview.NewWindowPayload); !nw.Opened || nw.URL != "https://example.org/from-target-blank" {
		t.Fatalf("new window with a gesture: %+v", nw)
	}
	time.Sleep(1500 * time.Millisecond) // the rate limit is one a second, and the gesture lasts two seconds
	mark2 := lv.mark()
	lv.hooks.KeyDown(id, "x", 7)
	lv.js(t, id, `document.getElementById('wo').click(); return 'clicked'`)
	_, sawWindowOpen := lv.wait(t, mark2, "webview:new-window", 5*time.Second, nil)
	ext := lv.externalOpened()
	lv.note("window.open with a key typed before: event=%v; opened in the system browser: %v", sawWindowOpen, ext)
	// A guest that is hidden gets none, gesture or not.
	if err := lv.mgr.SetVisible("vault-a", id, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1500 * time.Millisecond)
	before := len(lv.externalOpened())
	lv.hooks.KeyDown(id, "x", 7)
	mark3 := lv.mark()
	lv.js(t, id, `document.getElementById('blank').click(); return 'clicked'`)
	if p, ok := lv.wait(t, mark3, "webview:new-window", 5*time.Second, nil); ok && p.(webview.NewWindowPayload).Opened {
		t.Fatal("a hidden guest sent a window to the system browser")
	}
	if len(lv.externalOpened()) != before {
		t.Fatal("a hidden guest opened the system browser")
	}
	if err := lv.mgr.SetVisible("vault-a", id, true); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond)
	// A new window to something that is not http(s) is refused.
	mark = lv.mark()
	lv.hooks.KeyDown(id, "x", 7)
	lv.js(t, id, `document.getElementById('filelink').click(); return 'clicked'`)
	if p, ok := lv.wait(t, mark, "webview:new-window", 3*time.Second, func(p any) bool { return strings.HasPrefix(p.(webview.NewWindowPayload).URL, "file:") }); ok {
		if nw := p.(webview.NewWindowPayload); nw.Opened || nw.Reason != webview.BlockScheme {
			t.Fatalf("a file: new window: %+v", nw)
		}
	} else {
		lv.note("target=_blank to a file: address: refused by WebKit before the delegate, no event")
	}
	for _, u := range lv.externalOpened() {
		if !strings.HasPrefix(u, "https://example.org/") {
			t.Fatalf("something else reached the system browser: %v", lv.externalOpened())
		}
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
	if _, ok := lv.wait(t, mark, "webview:download", 8*time.Second, nil); !ok {
		t.Error("a link to an attachment was not reported as a refused download")
	}
	mark = lv.mark()
	lv.js(t, id, `document.getElementById('b').click(); return 'clicked'`)
	if _, ok := lv.wait(t, mark, "webview:download", 8*time.Second, nil); !ok {
		t.Error("a link with the download attribute was not reported as a refused download")
	}
	mark = lv.mark()
	if err := lv.mgr.Navigate("vault-a", id, lv.srv.HTTP+"/dl"); err != nil {
		t.Fatal(err)
	}
	if _, ok := lv.wait(t, mark, "webview:download", 8*time.Second, nil); !ok {
		t.Error("navigating to an attachment was not reported as a refused download")
	}
	home, _ := os.UserHomeDir()
	if _, err := os.Stat(home + "/Downloads/clarae-live-test.bin"); err == nil {
		t.Fatal("a file was downloaded")
	}

	// Permissions. A page that is not on a secure origin has none of these APIs, so the test goes to
	// localhost, which WebKit treats as secure (127.0.0.1 it does not).
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
	// On a secure origin of the web (https), where the APIs are there: the delegate must deny.
	if conn, err := net.DialTimeout("tcp", "example.com:443", 5*time.Second); err == nil {
		_ = conn.Close()
		if err := lv.mgr.Navigate("vault-a", id, "https://example.com/"); err != nil {
			t.Fatal(err)
		}
		lv.loaded(t, id)
		mark = lv.mark()
		got2 := lv.js(t, id, `
			const out = {origin: location.origin, mediaDevices: typeof navigator.mediaDevices};
			if (navigator.mediaDevices) { try { await Promise.race([navigator.mediaDevices.getUserMedia({audio: true}).then(() => out.media = 'GRANTED'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))]); } catch (e) { out.media = e.name; } }
			return JSON.stringify(out);`)
		lv.note("permissions on https: %s", got2)
		if strings.Contains(got2, "GRANTED") {
			t.Fatalf("microphone granted on https: %s", got2)
		}
		if p, ok := lv.wait(t, mark, "webview:permission", 3*time.Second, nil); ok {
			lv.note("webview:permission %+v", p)
			got += " | https: " + got2 + fmt.Sprintf(" | event %+v", p)
		} else {
			got += " | https: " + got2 + " | no event"
		}
	}
	if _, ok := lv.wait(t, mark, "webview:permission", 3*time.Second, func(p any) bool { return p.(webview.PermissionPayload).Permission == "media-capture" }); !ok {
		lv.note("no webview:permission for media-capture (the request was refused before it reached the delegate)")
	}
	lv.pass(t, "target=_blank and window.open do not open a window (1 guest, %d window); only an https address reached the system browser; downloads by link, attribute and navigation are refused and reported; getUserMedia, Notification and geolocation are not granted: %s", windows, got)
}

func TestLiveCertificatesCannotBeBypassed(t *testing.T) {
	defer lv.closeAll(t)
	mark := lv.mark()
	id, err := lv.mgr.Open("vault-a", lv.srv.TLS+"/", defaultBounds)
	if err != nil {
		t.Fatal(err)
	}
	p, ok := lv.wait(t, mark, "webview:load-error", 15*time.Second, nil)
	if !ok {
		t.Fatal("a self-signed certificate was not reported")
	}
	le := p.(webview.LoadErrorPayload)
	if !le.Certificate || le.ViewID != id {
		t.Fatalf("load error %+v", le)
	}
	if s, _ := lv.hooks.Eval(id, "return document.title + '|' + location.protocol", 5*time.Second); strings.Contains(s, "solid") {
		t.Fatalf("the page of an untrusted server loaded: %q", s)
	}
	// Again: still no way in.
	mark = lv.mark()
	if err := lv.mgr.Reload("vault-a", id); err != nil {
		t.Fatal(err)
	}
	if _, ok := lv.wait(t, mark, "webview:load-error", 15*time.Second, nil); !ok {
		t.Fatal("the second load of an untrusted server did not fail")
	}
	lv.pass(t, "a self-signed https server fails the load with certificate=true (code %d: %s), twice; no bypass exists", le.Code, le.Message)
}

// The keys are offered to the window and the menu the way NSApplication does for a key that is pressed
// (Hooks.KeyEquivalent): a test process started from a terminal is usually not the active application,
// and then no posted event reaches it. What is proved is the part that is ours: the guest takes a
// reserved key before the main menu does, and gives it back when it is hidden.
func TestLiveAuthenticationChallengesAreRefused(t *testing.T) {
	defer lv.closeAll(t)
	before := lv.srv.hitsCredentials.Load()
	for _, path := range []string{"/basic", "/digest"} {
		mark := lv.mark()
		id, err := lv.mgr.Open("vault-a", lv.srv.HTTP+path, defaultBounds)
		if err != nil {
			t.Fatal(err)
		}
		if _, ok := lv.wait(t, mark, "webview:blocked", 10*time.Second, func(p any) bool { return p.(webview.BlockedPayload).ViewID == id }); !ok {
			t.Errorf("%s: a challenge for credentials was not refused and reported", path)
		}
		time.Sleep(500 * time.Millisecond)
		_ = lv.mgr.Close("vault-a", id)
	}
	if lv.srv.hitsCredentials.Load() != before {
		t.Errorf("a request carried credentials")
	}
	lv.pass(t, "a server that asks for credentials (Basic, Digest) is refused and reported: the challenge is cancelled and no credential is sent (the body of the 401 is shown; Negotiate raises no challenge here)")
}

func TestLiveReservedKeys(t *testing.T) {
	defer lv.closeAll(t)
	if err := lv.mgr.ReserveKeys([]string{"cmd+w", "cmd+p", "ctrl+tab", "f5", "cmd+shift+1", "cmd+shift+p"}); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lv.mgr.ReserveKeys(nil) }()
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	if err := lv.mgr.Focus("vault-a", id); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if f, _ := lv.hooks.Frame(id); !f.FirstResp {
		t.Fatalf("the guest does not have the focus: %+v", f)
	}
	a, k, mn := lv.hooks.AppState()
	lv.note("application active=%v, window key=%v main=%v (the keys are offered to the window, not typed on the keyboard)", a, k, mn)
	const (
		cmd   = 1 << 20
		ctrl  = 1 << 18
		shift = 1 << 17
	)
	waitMenu := func(counter string, want int64) bool {
		for i := 0; i < 40 && lv.menu[counter].Load() < want; i++ {
			time.Sleep(25 * time.Millisecond)
		}
		return lv.menu[counter].Load() >= want
	}
	closeBefore, printBefore := lv.menu["close"].Load(), lv.menu["print"].Load()

	// The events are what a keyboard makes (the key code and the layout in use give the characters, with
	// Shift applied to them: Cmd+Shift+1 is "!" in characters and in charactersIgnoringModifiers).
	for _, c := range []struct {
		name  string
		code  uint16
		flags uint64
		want  string
	}{
		{"Cmd+W", 13, cmd, "cmd+w"},
		{"Cmd+P", 35, cmd, "cmd+p"},
		{"Ctrl+Tab", 48, ctrl, "ctrl+tab"},
		{"Cmd+Shift+1", 18, cmd | shift, "shift+cmd+1"},
		{"Cmd+Shift+P", 35, cmd | shift, "shift+cmd+p"},
		{"F5", 96, 0, "f5"},
	} {
		mark := lv.mark()
		window, menu, info := lv.hooks.KeyEquivalent(c.code, c.flags)
		if !window || menu {
			t.Errorf("%s: taken by the window=%v, by the menu=%v: the guest must take it (%s)", c.name, window, menu, info)
		}
		p, ok := lv.wait(t, mark, "webview:key", 5*time.Second, nil)
		if !ok || p.(webview.KeyPayload).Accelerator != c.want || p.(webview.KeyPayload).ViewID != id {
			t.Errorf("%s: webview:key %v %v, want %s (%s)", c.name, p, ok, c.want, info)
		}
	}
	time.Sleep(300 * time.Millisecond)
	if lv.menu["close"].Load() != closeBefore || lv.menu["print"].Load() != printBefore {
		t.Errorf("the menu of the application also fired: close %d->%d print %d->%d", closeBefore, lv.menu["close"].Load(), printBefore, lv.menu["print"].Load())
	}
	// Shown but without the focus (the editor of the application has it, the application sits beside it): the
	// guest takes nothing, Cmd+W and Cmd+P are the application's.
	lv.hooks.FocusMain()
	time.Sleep(300 * time.Millisecond)
	if f, _ := lv.hooks.Frame(id); f.Hidden || f.FirstResp {
		t.Fatalf("the setup is wrong: hidden %v, guest has the focus %v", f.Hidden, f.FirstResp)
	}
	mark := lv.mark()
	closeBefore = lv.menu["close"].Load()
	lv.hooks.KeyEquivalent(13, cmd)
	lv.hooks.KeyEquivalent(35, cmd)
	time.Sleep(400 * time.Millisecond)
	if n := len(lv.eventsSince(mark, "webview:key")); n != 0 {
		t.Errorf("a shown guest without the focus took %d reserved keys", n)
	}
	if !waitMenu("close", closeBefore+1) {
		t.Errorf("Cmd+W did not reach the menu of the application while the guest was shown without the focus")
	}
	// With no first responder at all every view is asked, and the guest, shown, is one of them: it must still
	// refuse (the main web view may or may not have answered first).
	lv.hooks.ResignFocus()
	time.Sleep(200 * time.Millisecond)
	mark = lv.mark()
	lv.hooks.KeyEquivalent(13, cmd)
	time.Sleep(300 * time.Millisecond)
	if n := len(lv.eventsSince(mark, "webview:key")); n != 0 {
		t.Errorf("a guest that does not have the focus took Cmd+W when no view had it")
	}
	if err := lv.mgr.Focus("vault-a", id); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	// Hidden, the guest gives the keys back: Cmd+W is the menu's.
	if err := lv.mgr.SetVisible("vault-a", id, false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if f, _ := lv.hooks.Frame(id); f.FirstResp {
		t.Errorf("a hidden guest keeps the focus: %+v", f)
	}
	mark = lv.mark()
	closeBefore = lv.menu["close"].Load()
	window, menu, _ := lv.hooks.KeyEquivalent(13, cmd)
	time.Sleep(300 * time.Millisecond)
	if n := len(lv.eventsSince(mark, "webview:key")); n != 0 {
		t.Errorf("a hidden guest took Cmd+W: %d key events", n)
	}
	// The window may pass it to the menu itself (Wails does), or leave it to the application: either way the item fires.
	if !waitMenu("close", closeBefore+1) {
		t.Errorf("with the guest hidden, Cmd+W did not reach the menu of the application (window=%v menu=%v, fired %d)", window, menu, lv.menu["close"].Load()-closeBefore)
	}
	// Copy and paste are the page's: they cannot be reserved.
	if err := lv.mgr.ReserveKeys([]string{"cmd+c"}); err == nil {
		t.Error("cmd+c could be reserved")
	}
	lv.pass(t, "a reserved key (cmd+w, cmd+p, ctrl+tab, cmd+shift+1) offered to the window is taken by the focused guest and reaches Go as webview:key, never the menu; hidden, the guest gives Cmd+W back to the menu; copy and paste cannot be reserved")
}

func TestLiveFocusAndActivity(t *testing.T) {
	defer lv.closeAll(t)
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	lv.hooks.FocusMain()
	time.Sleep(200 * time.Millisecond)
	mark := lv.mark()
	if err := lv.mgr.Focus("vault-a", id); err != nil {
		t.Fatal(err)
	}
	if _, ok := lv.wait(t, mark, "webview:focus", 5*time.Second, func(p any) bool { return p.(webview.FocusPayload).ViewID == id }); !ok {
		t.Error("giving the guest the focus produced no webview:focus")
	}
	// A key typed in the guest reaches its page (the guest does not swallow what it was not told to).
	lv.js(t, id, `document.getElementById('i').focus(); document.getElementById('i').value = ''; return 'ok'`)
	activityBefore := lv.activity.Load()
	lv.hooks.KeyDown(id, "x", 7)
	time.Sleep(400 * time.Millisecond)
	if typed := lv.js(t, id, `return document.getElementById('i').value`); typed != "x" {
		t.Errorf("a plain key was not typed into the page: %q", typed)
	}
	// ... and counts as the user working (the idle lock of a private vault listens to it, and a guest hides its
	// keys and clicks from the web view of the application).
	if lv.activity.Load() <= activityBefore {
		t.Error("a key typed in the guest was not reported as activity")
	}
	lv.pass(t, "giving the guest the focus reports webview:focus; a plain key reaches the page and is reported as activity")
}

func TestLiveRepeatedOpenAndClose(t *testing.T) {
	const cycles = 100
	start := time.Now()
	for i := 0; i < cycles; i++ {
		id, err := lv.mgr.Open("vault-a", lv.srv.HTTP+"/", defaultBounds)
		if err != nil {
			t.Fatalf("cycle %d: %v", i, err)
		}
		if i%10 == 0 {
			lv.loaded(t, id)
		}
		if err := lv.mgr.Close("vault-a", id); err != nil {
			t.Fatalf("cycle %d close: %v", i, err)
		}
		if n := lv.hooks.Count(); n != 0 {
			t.Fatalf("cycle %d: %d guests after Close", i, n)
		}
	}
	// A burst of views at once, then the whole vault.
	for i := 0; i < 8; i++ {
		if _, err := lv.mgr.Open("vault-a", lv.srv.HTTP+"/", defaultBounds); err != nil {
			t.Fatal(err)
		}
	}
	if n := lv.mgr.CloseVault("vault-a", webview.ClosedVaultClosed); n != 8 || lv.hooks.Count() != 0 {
		t.Fatalf("CloseVault closed %d, %d guests left", n, lv.hooks.Count())
	}
	if err := lv.hooks.CallOffMain(); err != nil {
		t.Fatal(err)
	}
	if d := lv.hooks.Dropped(); d != 0 {
		lv.note("%d reports were dropped by a full queue", d)
	}
	lv.pass(t, "%d open/close cycles and a burst of 8 views closed with CloseVault in %v: no guest left; a call off the main thread is refused", cycles, time.Since(start).Round(time.Millisecond))
}

func TestLiveSessionsPerVaultAndClearData(t *testing.T) {
	defer lv.closeAll(t)
	if !lv.drv.PersistentData() {
		lv.skip(t, "macOS before 14: the session data live in memory only (declared, not tested)")
	}
	read := func(vault string) string {
		t.Helper()
		id := lv.open(t, vault, lv.srv.HTTP+"/cookie-get")
		defer func() { _ = lv.mgr.Close(vault, id) }()
		return lv.js(t, id, `return document.getElementById('b').innerText`)
	}
	set := func(vault, v string) {
		t.Helper()
		id := lv.open(t, vault, lv.srv.HTTP+"/cookie-set?v="+v)
		_ = lv.mgr.Close(vault, id)
	}
	// Start from nothing (a previous run may have left a cookie in the store of this vault id).
	_ = lv.mgr.ClearData("vault-a")
	_ = lv.mgr.ClearData("vault-b")
	if got := read("vault-a"); got != "none" {
		t.Fatalf("a cleared store has a cookie: %q", got)
	}
	set("vault-a", "alpha")
	if got := read("vault-a"); got != "alpha" {
		t.Fatalf("the session of vault-a does not persist across views: %q", got)
	}
	if got := read("vault-b"); got != "none" {
		t.Fatalf("vault-b sees the cookie of vault-a: %q", got)
	}
	id := lv.open(t, "vault-a", lv.srv.HTTP+"/")
	if k := lv.hooks.StoreKind(id); k != 1 {
		t.Fatalf("store kind %d, want 1 (identified)", k)
	}
	mark := lv.mark()
	if err := lv.mgr.ClearData("vault-a"); err != nil {
		t.Fatal(err)
	}
	if _, ok := lv.wait(t, mark, "webview:closed", 3*time.Second, func(p any) bool { return p.(webview.ClosedPayload).ViewID == id }); !ok {
		t.Fatal("ClearData did not close the view that held the store")
	}
	if got := read("vault-a"); got != "none" {
		t.Fatalf("ClearData left the cookie: %q", got)
	}
	// The session of the other vault is untouched.
	set("vault-b", "beta")
	_ = lv.mgr.ClearData("vault-a")
	if got := read("vault-b"); got != "beta" {
		t.Fatalf("ClearData of vault-a removed the session of vault-b: %q", got)
	}
	_ = lv.mgr.ClearData("vault-b")
	lv.pass(t, "sessions are per vault (a cookie of vault-a is not seen by vault-b), survive closing a view, and ClearData removes them for that vault only")
}

// Wails runs the shutdown hook, and so App.Shutdown and CloseAll, on the main thread: the driver must do the
// work there without dispatching to itself (that would wait for the thread that waits), and from a goroutine
// it must queue the work and never wait.
func TestLiveShutdownWithViewsOpen(t *testing.T) {
	open := func() *webview.Manager {
		m := webview.NewManager(webview.Options{Driver: func() webview.Driver { return lv.drv }, Emit: lv.emit, Logger: zerolog.Nop()})
		for i := 0; i < 3; i++ {
			if _, err := m.Open("vault-z", lv.srv.HTTP+"/", defaultBounds); err != nil {
				t.Fatal(err)
			}
		}
		if n := lv.hooks.Count(); n != 3 {
			t.Fatalf("%d guests, want 3", n)
		}
		return m
	}
	// On the main thread, as the shutdown hook does.
	m := open()
	start := time.Now()
	done := make(chan struct{})
	go func() {
		application.InvokeSync(m.Shutdown)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown from the main thread hangs")
	}
	if n := lv.hooks.Count(); n != 0 {
		t.Fatalf("%d guests after Shutdown on the main thread", n)
	}
	onMain := time.Since(start)
	// From a goroutine, as the watchdog does: it returns at once, and the work is done by the main thread.
	m = open()
	start = time.Now()
	m.Shutdown()
	fromGoroutine := time.Since(start)
	deadline := time.Now().Add(3 * time.Second)
	for lv.hooks.Count() != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if n := lv.hooks.Count(); n != 0 {
		t.Fatalf("%d guests after Shutdown from a goroutine", n)
	}
	if fromGoroutine > time.Second {
		t.Fatalf("Shutdown from a goroutine took %v", fromGoroutine)
	}
	lv.pass(t, "Shutdown closes the views that are open at exit: from the main thread in %v (no self-dispatch), from a goroutine in %v (queued, never waited for)", onMain.Round(time.Millisecond), fromGoroutine.Round(time.Millisecond))
}
