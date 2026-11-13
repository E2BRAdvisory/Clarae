package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/rs/zerolog"
	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/app"
	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/rpc"
	"clarae/apps/desktop/internal/shell"
)

// recordingHost keeps what the core sends to the window and its error dialogs.
type recordingHost struct {
	app.Host
	mu     sync.Mutex
	events []string
	errs   []string
	saveTo string // the path SaveFile answers with ("" cancels)
}

func (h *recordingHost) SaveFile(context.Context, app.SaveDialog) (string, error) {
	return h.saveTo, nil
}
func (h *recordingHost) Delivered(context.Context, string) {}

func (h *recordingHost) Emit(_ context.Context, name string, _ any) {
	h.mu.Lock()
	h.events = append(h.events, name)
	h.mu.Unlock()
}

func (h *recordingHost) ErrorDialog(_ context.Context, _, msg string) {
	h.mu.Lock()
	h.errs = append(h.errs, msg)
	h.mu.Unlock()
}

// newBridge is the real core (app.New, the real services and dispatcher) behind a CoreBridge, with
// the lifecycle of main.go.
func newBridge(t *testing.T, dataDir string) (*CoreBridge, *shell.Lifecycle, *app.App, *recordingHost) {
	t.Helper()
	h := &recordingHost{}
	a := app.New(app.Options{DataDir: dataDir, Logger: zerolog.Nop(), Version: "test", KeyStore: crypto.NewMemoryStore(), Host: h})
	d := rpc.New()
	for _, s := range a.Services() {
		if err := d.Register(s); err != nil {
			t.Fatal(err)
		}
	}
	lc := shell.NewLifecycle(a, nil)
	b := NewCoreBridge(d, lc, shell.NewUploadStore())
	if err := b.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.ServiceShutdown() })
	return b, lc, a, h
}

func call[T any](t *testing.T, b *CoreBridge, service, method string, args ...any) T {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	out, err := b.Call(service, method, raw)
	if err != nil {
		t.Fatalf("%s.%s: %v", service, method, err)
	}
	var v T
	if err := json.Unmarshal(out, &v); err != nil {
		t.Fatalf("%s.%s: result %s: %v", service, method, out, err)
	}
	return v
}

// The shim calls the real bindings through Call: open a vault, write a note, read it back, then
// write again with a stale hash and get the "<code>: <text>" error the workbench branches on.
func TestCoreBridgeRunsTheRealBindings(t *testing.T) {
	b, _, _, _ := newBridge(t, t.TempDir())
	root := filepath.Join(t.TempDir(), "vault")
	info := call[app.VaultInfo](t, b, "VaultAPI", "OpenVault", root)
	if info.ID == "" {
		t.Fatalf("no vault: %+v", info)
	}
	w := call[app.WriteResult](t, b, "VaultAPI", "WriteNote", info.ID, "a.md", "# one\n", "")
	if w.Hash == "" {
		t.Fatalf("no hash: %+v", w)
	}
	n := call[app.NoteContent](t, b, "VaultAPI", "ReadNote", info.ID, "a.md")
	if n.Content != "# one\n" || n.Hash != w.Hash {
		t.Fatalf("read back %+v", n)
	}
	// An external change, then a write that still carries the old hash.
	if err := os.WriteFile(filepath.Join(root, "a.md"), []byte("# changed outside\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	args, _ := json.Marshal([]any{info.ID, "a.md", "# two\n", w.Hash})
	out, err := b.Call("VaultAPI", "WriteNote", args)
	if err == nil {
		t.Fatalf("a stale hash must conflict, got %s", out)
	}
	if code, _, _ := strings.Cut(err.Error(), ": "); code != app.ErrCodeConflict {
		t.Fatalf("error %q: want the code %q first, untouched", err, app.ErrCodeConflict)
	}
}

func TestCoreBridgeErrorsAndMethods(t *testing.T) {
	b, _, a, _ := newBridge(t, t.TempDir())
	for _, c := range []struct{ svc, method, args, want string }{
		{"Nope", "X", `[]`, "unknown service"},
		{"VaultAPI", "Nope", `[]`, "unknown method"},
		{"VaultAPI", "OpenVault", `[]`, "takes 1 arguments, got 0"},
		{"VaultAPI", "OpenVault", `"not an array"`, "must be a JSON array"},
	} {
		if _, err := b.Call(c.svc, c.method, json.RawMessage(c.args)); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s.%s%s: want %q, got %v", c.svc, c.method, c.args, c.want, err)
		}
	}
	// Every service of the application is callable, with the methods the dispatcher lists.
	m := b.Methods()
	if len(m) != len(a.Services()) {
		t.Fatalf("%d services listed, the application has %d", len(m), len(a.Services()))
	}
	if !contains(m["VaultAPI"], "OpenVault") || !contains(m["AuthAPI"], "Login") {
		t.Fatalf("methods = %v", m)
	}
	// The bridge itself is not part of the list: the shim must not build a binding for it.
	if _, ok := m["CoreBridge"]; ok {
		t.Fatal("CoreBridge lists itself")
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// A panic outside the dispatcher's own recovery reaches Wails, which rejects the promise; a panic
// inside a binding is already an error here. Either way the call does not take the process down.
func TestCoreBridgeBindingPanicIsAnError(t *testing.T) {
	d := rpc.New()
	if err := d.Register(&boom{}); err != nil {
		t.Fatal(err)
	}
	b := NewCoreBridge(d, shell.NewLifecycle(noCore{}, nil), shell.NewUploadStore())
	_, err := b.Call("boom", "Now", nil)
	if err == nil || !strings.Contains(err.Error(), "panicked") {
		t.Fatalf("want a panic turned into an error, got %v", err)
	}
}

type boom struct{}

func (*boom) Now() { panic("kaboom") }

type noCore struct{}

func (noCore) Startup(context.Context)  {}
func (noCore) DomReady(context.Context) {}
func (noCore) Shutdown(context.Context) {}

// ServiceStartup never fails, and the error of app.db (here: the data dir is a file) reaches the
// host as a dialog request, not as an error that would stop Run before a window exists.
func TestServiceStartupNeverFailsAndReportsAppDBToTheHost(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(bad, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, _, h := newBridge(t, bad) // newBridge fails the test if ServiceStartup returns an error
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.errs) != 1 || !strings.Contains(h.errs[0], "Cannot open the application database") {
		t.Fatalf("dialogs = %v", h.errs)
	}
}

// DomReady is the signal of the shim: a clarae:// URL that arrived before waits for it, then
// reaches the frontend once, in order.
func TestDomReadyDeliversTheQueuedURL(t *testing.T) {
	b, _, a, h := newBridge(t, t.TempDir())
	a.HandleURL("clarae://open?vault=V&file=a.md")
	h.mu.Lock()
	n := len(h.events)
	h.mu.Unlock()
	if n != 0 {
		t.Fatalf("an event was sent before the ready signal: %v", h.events)
	}
	b.DomReady()
	b.DomReady() // a page reload sends it again: nothing is delivered twice
	h.mu.Lock()
	defer h.mu.Unlock()
	got := 0
	for _, e := range h.events {
		if e == app.EventOpenRequest.Name() {
			got++
		}
	}
	if got != 1 {
		t.Fatalf("app:open-request sent %d times, want 1 (%v)", got, h.events)
	}
}

// The context of the core is not cancelled by Wails before the shutdown hooks (v3 cancels its own
// first): the lifecycle owns it, and ServiceShutdown/OnShutdown/Run's return can all call Stop.
func TestStopIsRepeatable(t *testing.T) {
	b, lc, _, _ := newBridge(t, t.TempDir())
	lc.Stop()
	if err := b.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	lc.Stop()
}

func TestSingleInstanceOptions(t *testing.T) {
	var got []string
	o := singleInstanceOptions("/data/a", func(args []string) { got = args })
	if !strings.HasPrefix(o.UniqueID, "dev.clarae.desktop.i") {
		t.Fatalf("id %q", o.UniqueID)
	}
	if o.EncryptionKey == ([32]byte{}) {
		t.Fatal("the messages between instances are not encrypted")
	}
	if p := singleInstanceOptions("/data/b", func([]string) {}); p.UniqueID == o.UniqueID || p.EncryptionKey == o.EncryptionKey {
		t.Fatal("two data dirs share a lock")
	}
	// v3 hands the whole os.Args of the second instance, program name first.
	o.OnSecondInstanceLaunch(application.SecondInstanceData{Args: []string{"/bin/clarae", "clarae://open?vault=V"}})
	if len(got) != 2 || got[0] != "/bin/clarae" {
		t.Fatalf("args = %v", got)
	}
}
