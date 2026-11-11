package app

import (
	"context"
	"path/filepath"
	"sync"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/store"
)

// recordingHost counts what the second-instance path asks of the window.
type recordingHost struct {
	Host
	mu    sync.Mutex
	shown int
}

func (h *recordingHost) ShowWindow(context.Context) { h.mu.Lock(); h.shown++; h.mu.Unlock() }

type sentEvent struct {
	name    string
	payload any
}

// newSignalApp is an App with a started context and a recording emitter, but no DomReady yet.
func newSignalApp(t *testing.T) (*App, *recordingHost, *[]sentEvent) {
	t.Helper()
	h := &recordingHost{Host: defaultHost()}
	a := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Version: "test", Host: h})
	a.ctx = context.Background()
	var mu sync.Mutex
	got := &[]sentEvent{}
	a.setEmitter(func(name string, payload any) {
		mu.Lock()
		*got = append(*got, sentEvent{name, payload})
		mu.Unlock()
	})
	return a, h, got
}

func openRequests(got []sentEvent) []OpenRequestPayload {
	var out []OpenRequestPayload
	for _, e := range got {
		if e.name == EventOpenRequest.Name() {
			out = append(out, e.payload.(OpenRequestPayload))
		}
	}
	return out
}

// A URL that reaches the first or a second instance waits for the frontend signal, even though the
// context is already there (v3 sets it before the window exists), and is delivered by DomReady.
func TestDeepLinksWaitForTheReadySignal(t *testing.T) {
	a, _, got := newSignalApp(t)
	a.HandleURL("memobrain://open?vault=A&file=a.md")
	a.OnSecondInstance([]string{"/bin/memobrain", "memobrain://open?vault=B&file=b.md"})
	if n := len(openRequests(*got)); n != 0 {
		t.Fatalf("%d open requests before DomReady, want 0 (queued)", n)
	}
	a.DomReady(context.Background())
	reqs := openRequests(*got)
	if len(reqs) != 2 || reqs[0].Vault != "A" || reqs[1].Vault != "B" {
		t.Fatalf("open requests after DomReady = %+v, want A then B", reqs)
	}
	// Later ones go straight through; the queue is not replayed by a second DomReady (a page reload).
	a.HandleURL("memobrain://open?vault=C")
	a.DomReady(context.Background())
	if reqs := openRequests(*got); len(reqs) != 3 || reqs[2].Vault != "C" {
		t.Fatalf("open requests = %+v, want A, B, C", reqs)
	}
}

func TestDeepLinksBeforeTheContext(t *testing.T) {
	a := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Version: "test"})
	var got []sentEvent
	a.setEmitter(func(name string, payload any) { got = append(got, sentEvent{name, payload}) })
	a.HandleURL("memobrain://open?vault=first") // the first instance's own command line, before Wails runs
	a.ctx = context.Background()
	a.DomReady(context.Background())
	if reqs := openRequests(got); len(reqs) != 1 || reqs[0].Vault != "first" {
		t.Fatalf("open requests = %+v", reqs)
	}
}

// Wails v3 hands the whole os.Args to a second instance: the program name and extra arguments are
// ignored, the first memobrain:// URL is the one handled, and the window comes to the front.
func TestOnSecondInstanceArgs(t *testing.T) {
	for _, tt := range []struct {
		name string
		args []string
		want []string // vaults of the open requests
	}{
		{"url alone", []string{"memobrain://open?vault=V&file=n.md"}, []string{"V"}},
		{"os.Args with program name", []string{"/Applications/MemoBrain", "memobrain://open?vault=V"}, []string{"V"}},
		{"extra arguments around the url", []string{"memobrain", "--data-dir", "/tmp/x", "MEMOBRAIN://open?vault=V", "--log-level=debug"}, []string{"V"}},
		{"only the first url", []string{"memobrain://open?vault=one", "memobrain://open?vault=two"}, []string{"one"}},
		{"no url", []string{"/bin/memobrain", "--flag", "file.md"}, nil},
		{"no arguments", nil, nil},
		{"unknown url", []string{"memobrain://nope"}, nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			a, h, got := newSignalApp(t)
			a.DomReady(context.Background())
			a.OnSecondInstance(tt.args)
			if h.shown != 1 {
				t.Errorf("ShowWindow called %d times, want 1", h.shown)
			}
			var vaults []string
			for _, r := range openRequests(*got) {
				vaults = append(vaults, r.Vault)
			}
			if len(vaults) != len(tt.want) || (len(vaults) > 0 && vaults[0] != tt.want[0]) {
				t.Errorf("open requests = %v, want %v", vaults, tt.want)
			}
		})
	}
}

func TestOnSecondInstanceBeforeStartup(t *testing.T) {
	h := &recordingHost{Host: defaultHost()}
	a := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Version: "test", Host: h})
	a.OnSecondInstance([]string{"memobrain://open?vault=V"}) // no context yet: no window to show, URL queued
	if h.shown != 0 {
		t.Fatalf("ShowWindow called before Startup")
	}
	a.mu.Lock()
	n := len(a.pending)
	a.mu.Unlock()
	if n != 1 {
		t.Fatalf("%d URLs queued, want 1", n)
	}
}

// Startup writes the context while a second instance may already be calling in (-race).
func TestStartupAndOnSecondInstanceRaceFree(t *testing.T) {
	h := &recordingHost{Host: defaultHost()}
	a := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Version: "test", Host: h})
	a.setEmitter(func(string, any) {})
	ctx := context.Background()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); a.Startup(ctx) }()
	go func() { defer wg.Done(); a.OnSecondInstance([]string{"memobrain://open?vault=V"}) }()
	wg.Wait()
	t.Cleanup(func() { a.Shutdown(ctx) })
	a.OnSecondInstance(nil)
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.shown == 0 {
		t.Fatal("ShowWindow not called once Startup has run")
	}
}

// The shell may call Shutdown from more than one place (an OnShutdown hook and an explicit quit).
func TestShutdownIsIdempotent(t *testing.T) {
	ctx := context.Background()
	a := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Version: "test"})
	a.setEmitter(func(string, any) {})
	db, err := store.Open(ctx, filepath.Join(a.opts.DataDir, "app.db"), store.KindApp)
	if err != nil {
		t.Fatal(err)
	}
	a.ctx, a.appDB = ctx, db
	if _, err := a.openVault(filepath.Join(t.TempDir(), "vault")); err != nil {
		t.Fatal(err)
	}
	a.Shutdown(ctx)
	a.Shutdown(ctx)
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.vaults) != 0 {
		t.Fatalf("%d vaults still open after Shutdown", len(a.vaults))
	}
}
