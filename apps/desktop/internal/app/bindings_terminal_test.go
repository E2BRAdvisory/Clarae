//go:build !js && !windows

package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/store"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/terminal"
)

// termHost is a Host with no window that records what the terminal asks of it.
type termHost struct {
	headlessHost
	mu      sync.Mutex
	opens   int
	closes  int
	openErr error
	closed  func() // what the core gave to SetTerminalWindowClosed
}

func (h *termHost) OpenTerminalWindow(context.Context) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.opens++
	return h.openErr
}

func (h *termHost) CloseTerminalWindow(context.Context) {
	h.mu.Lock()
	h.closes++
	h.mu.Unlock()
}

func (h *termHost) SetTerminalWindowClosed(f func()) {
	h.mu.Lock()
	h.closed = f
	h.mu.Unlock()
}

func (h *termHost) counts() (int, int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.opens, h.closes
}

var _ TerminalWindowHost = (*termHost)(nil)

// termHarness is an app with a vault open and a terminal Manager that runs /bin/sh, with the events recorded.
type termHarness struct {
	a    *App
	host *termHost
	vid  string
	root string
	home string

	mu     sync.Mutex
	exits  []terminal.ExitPayload
	layout []terminal.Mode
}

func newTermHarness(t *testing.T) *termHarness {
	t.Helper()
	ctx := context.Background()
	dataDir := t.TempDir()
	host := &termHost{}
	a := New(Options{DataDir: dataDir, Logger: zerolog.Nop(), Version: "test", Host: host})
	a.ctx = ctx
	h := &termHarness{a: a, host: host, home: evalDir(t, t.TempDir())}
	a.setEmitter(func(name string, payload any) {
		h.mu.Lock()
		defer h.mu.Unlock()
		switch p := payload.(type) {
		case terminal.ExitPayload:
			h.exits = append(h.exits, p)
		case terminal.LayoutPayload:
			h.layout = append(h.layout, p.Mode)
		}
	})
	// The manager of New runs the shell of the user: tests run /bin/sh, with a home of their own.
	a.terminal.m = terminal.NewManager(terminal.Options{
		Emit:   a.emit,
		Window: terminalWindow{a},
		Shell:  func() (terminal.Spec, error) { return terminal.Spec{Path: "/bin/sh"}, nil },
		Home:   func() (string, error) { return h.home, nil },
	})
	db, err := store.Open(ctx, filepath.Join(dataDir, "app.db"), store.KindApp)
	if err != nil {
		t.Fatal(err)
	}
	a.appDB = db
	h.root = filepath.Join(t.TempDir(), "vault")
	info, err := a.openVault(h.root)
	if err != nil {
		t.Fatal(err)
	}
	h.vid = info.ID
	t.Cleanup(func() {
		a.terminal.m.Shutdown()
		a.mu.Lock()
		for id, v := range a.vaults {
			a.closeVaultLocked(id, v)
		}
		a.mu.Unlock()
		_ = db.Close()
	})
	return h
}

func evalDir(t *testing.T, d string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(d)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func (h *termHarness) exitsOf() []terminal.ExitPayload {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]terminal.ExitPayload(nil), h.exits...)
}

func (h *termHarness) layouts() []terminal.Mode {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]terminal.Mode(nil), h.layout...)
}

// mount opens a mount at the given level and returns its vault id.
func (h *termHarness) mount(t *testing.T, share, permission string) (string, syncpkg.MountMeta) {
	t.Helper()
	dir := filepath.Join(h.a.mountsDir(), share)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	mm := syncpkg.MountMeta{ShareID: share, CloudVaultID: "cloud-" + share, Scope: "share:" + share, Permission: permission, Name: "Team", OwnerName: "ada", ResourceType: "folder"}
	if err := syncpkg.PrepareMount(context.Background(), dir, mm, syncpkg.SessionInfo{ServerURL: "http://cloud.test"}); err != nil {
		t.Fatal(err)
	}
	info, err := h.a.openVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	return info.ID, mm
}

func waitTerm(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// The directory comes from the vault the core knows, not from the caller: the root of the vault when
// it is open, the home directory when the id is empty or not an open vault.
func TestTerminalOpenResolvesTheDirectoryFromTheVault(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)

	s, err := api.Open(h.vid, 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	v, _ := h.a.vault(h.vid)
	if s.Cwd != v.Info.Path || s.VaultID != h.vid || s.ID == "" || s.Shell != "sh" || s.Title != filepath.Base(v.Info.Path) {
		t.Fatalf("session = %+v, vault path %q", s, v.Info.Path)
	}

	for name, id := range map[string]string{
		"no vault":      "",
		"unknown vault": "0123456789abcdef",
		"a path":        "/etc", // the frontend cannot name a directory: this is just an id nobody has
		"traversal":     "../..",
	} {
		s, err := api.Open(id, 80, 24)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if s.Cwd != h.home || s.VaultID != "" {
			t.Errorf("%s: session %+v, want the home directory %q and no vault", name, s, h.home)
		}
	}
	list, err := api.List()
	if err != nil || len(list) != 5 {
		t.Fatalf("List = %d sessions, %v", len(list), err)
	}
	if list[0].ID != s.ID && list[0].Cwd != v.Info.Path {
		t.Errorf("List is not oldest first: %+v", list[0])
	}
}

// A vault that is read-only for the user (a viewer of a share) does not open a terminal; CanOpen says so.
func TestTerminalIsRefusedOnAReadOnlyVault(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)
	viewer, mm := h.mount(t, "share-ro", syncpkg.PermViewer)

	chk, err := api.CanOpen(viewer)
	if err != nil || chk.Allowed || chk.Reason != "read-only" {
		t.Fatalf("CanOpen(viewer) = %+v, %v", chk, err)
	}
	if _, err := api.Open(viewer, 80, 24); codeOf(err) != ErrCodeTerminalReadOnly {
		t.Fatalf("Open on a viewer mount: %v, want the code %s", err, ErrCodeTerminalReadOnly)
	}
	if list, _ := api.List(); len(list) != 0 {
		t.Fatalf("a refused Open left %d sessions", len(list))
	}

	// The vault of the user, and the home directory, are fine.
	for _, id := range []string{h.vid, "", "unknown"} {
		if chk, err := api.CanOpen(id); err != nil || !chk.Allowed || chk.Reason != "" {
			t.Errorf("CanOpen(%q) = %+v, %v", id, chk, err)
		}
	}
	// The same mount, raised to editor, opens one.
	mm.Permission = syncpkg.PermEditor
	if err := h.a.sync.UpdateMount(context.Background(), viewer, mm); err != nil {
		t.Fatal(err)
	}
	if chk, _ := api.CanOpen(viewer); !chk.Allowed {
		t.Errorf("CanOpen(editor) = %+v", chk)
	}
	if s, err := api.Open(viewer, 80, 24); err != nil || s.VaultID != viewer {
		t.Errorf("Open on an editor mount: %+v, %v", s, err)
	}
}

// A share lowered to viewer ends the shells opened in it, with the reason; the ones of other vaults go on.
func TestSessionsOfAVaultThatBecomesReadOnlyEnd(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)
	mount, mm := h.mount(t, "share-rw", syncpkg.PermEditor)

	a, err := api.Open(mount, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	b, err := api.Open(mount, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	other, err := api.Open(h.vid, 80, 24)
	if err != nil {
		t.Fatal(err)
	}

	mm.Permission = syncpkg.PermViewer
	if err := h.a.sync.UpdateMount(context.Background(), mount, mm); err != nil {
		t.Fatal(err)
	}
	waitTerm(t, "the two exit events", func() bool { return len(h.exitsOf()) == 2 })
	got := map[string]terminal.ExitReason{}
	for _, e := range h.exitsOf() {
		got[e.ID] = e.Reason
	}
	if got[a.ID] != terminal.ReasonReadOnly || got[b.ID] != terminal.ReasonReadOnly || len(got) != 2 {
		t.Errorf("exits = %v, want %s and %s with reason read-only", got, a.ID, b.ID)
	}
	list, _ := api.List()
	if len(list) != 1 || list[0].ID != other.ID {
		t.Errorf("sessions left: %+v, want only the one of the vault of the user", list)
	}
}

// Opening races the lowering of the share: a session that starts after the hook ran is ended by Open itself.
func TestOpenRechecksReadOnlyAfterTheShellStarted(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)
	mount, mm := h.mount(t, "share-race", syncpkg.PermEditor)
	// The shell of this manager takes its time to be chosen: the share is lowered meanwhile.
	h.a.terminal.m = terminal.NewManager(terminal.Options{
		Emit:   h.a.emit,
		Window: terminalWindow{h.a},
		Shell: func() (terminal.Spec, error) {
			mm.Permission = syncpkg.PermViewer
			if err := h.a.sync.UpdateMount(context.Background(), mount, mm); err != nil {
				t.Error(err)
			}
			return terminal.Spec{Path: "/bin/sh"}, nil
		},
	})
	if _, err := api.Open(mount, 80, 24); codeOf(err) != ErrCodeTerminalReadOnly {
		t.Fatalf("Open = %v, want %s", err, ErrCodeTerminalReadOnly)
	}
	if list, _ := api.List(); len(list) != 0 {
		t.Fatalf("a session survived: %+v", list)
	}
}

func TestTerminalBindingErrorsHaveCodes(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)
	if code := codeOf(api.Write("nope", "x")); code != ErrCodeTerminalNotFound {
		t.Errorf("Write to an unknown session: %q", code)
	}
	if code := codeOf(api.Resize("nope", 80, 24)); code != ErrCodeTerminalNotFound {
		t.Errorf("Resize of an unknown session: %q", code)
	}
	if _, err := api.Snapshot("nope"); codeOf(err) != ErrCodeTerminalNotFound {
		t.Errorf("Snapshot of an unknown session: %v", err)
	}
	if err := api.Close("nope"); err != nil {
		t.Errorf("Close of an unknown session: %v", err)
	}
	s, err := api.Open("", 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if code := codeOf(api.Write(s.ID, strings.Repeat("x", terminal.MaxWrite+1))); code != ErrCodeTerminalTooLarge {
		t.Errorf("a paste over the limit: %q", code)
	}
	if err := api.Write(s.ID, "echo hi\n"); err != nil {
		t.Fatal(err)
	}
	waitTerm(t, "the snapshot", func() bool {
		snap, err := api.Snapshot(s.ID)
		return err == nil && strings.Contains(snap.Data, "hi") && snap.Seq > 0
	})
	if err := api.Close(s.ID); err != nil {
		t.Fatal(err)
	}
	if list, _ := api.List(); len(list) != 0 {
		t.Errorf("sessions after Close: %+v", list)
	}
	// The limit.
	for i := range terminal.MaxSessions {
		if _, err := api.Open("", 80, 24); err != nil {
			t.Fatalf("session %d: %v", i, err)
		}
	}
	if _, err := api.Open("", 80, 24); codeOf(err) != ErrCodeTerminalLimit {
		t.Errorf("the 17th session: %v, want %s", err, ErrCodeTerminalLimit)
	}
}

// Undock and Dock go through the host; the sessions stay; the layout event follows.
func TestTerminalUndockAndDock(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)
	s, _ := api.Open("", 80, 24)
	if st, err := api.State(); err != nil || st.Mode != "docked" {
		t.Fatalf("State = %+v, %v", st, err)
	}
	if err := api.Undock(); err != nil {
		t.Fatal(err)
	}
	if st, _ := api.State(); st.Mode != "detached" {
		t.Errorf("State after Undock = %+v", st)
	}
	if err := api.Dock(); err != nil {
		t.Fatal(err)
	}
	if st, _ := api.State(); st.Mode != "docked" {
		t.Errorf("State after Dock = %+v", st)
	}
	if opens, closes := h.host.counts(); opens != 1 || closes != 1 {
		t.Errorf("window opened %d times and closed %d, want 1 and 1", opens, closes)
	}
	if got := h.layouts(); len(got) != 2 || got[0] != terminal.ModeDetached || got[1] != terminal.ModeDocked {
		t.Errorf("layout events %v", got)
	}
	if list, _ := api.List(); len(list) != 1 || list[0].ID != s.ID {
		t.Errorf("the sessions changed: %+v", list)
	}
	h.host.openErr = errors.New("no window")
	if err := api.Undock(); codeOf(err) != ErrCodeTerminalFailed {
		t.Errorf("Undock with a host that cannot: %v", err)
	}
}

// The user closing the separate window (the host calls what the core gave it) ends every session and docks the panel.
func TestClosingTheWindowEndsTheSessions(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)
	// The App of the harness was built with the host: it registered its callback.
	h.host.mu.Lock()
	closed := h.host.closed
	h.host.mu.Unlock()
	if closed == nil {
		t.Fatal("the core did not ask the host to tell it when the window is closed")
	}
	_, _ = api.Open("", 80, 24)
	_, _ = api.Open(h.vid, 80, 24)
	if err := api.Undock(); err != nil {
		t.Fatal(err)
	}
	closed() // does not block: the host calls it on the thread of the window
	waitTerm(t, "the sessions to end", func() bool { return len(h.exitsOf()) == 2 })
	for _, e := range h.exitsOf() {
		if e.Reason != terminal.ReasonWindowClosed {
			t.Errorf("exit %+v", e)
		}
	}
	if st, _ := api.State(); st.Mode != "docked" {
		t.Errorf("State = %+v", st)
	}
	if _, closes := h.host.counts(); closes != 0 {
		t.Error("the core closed a window the user had closed")
	}
}

// Shutdown of the application ends the shells, and no new one starts.
func TestAppShutdownEndsTheTerminals(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)
	_, _ = api.Open("", 80, 24)
	_, _ = api.Open(h.vid, 80, 24)
	start := time.Now()
	h.a.shutdownTerminal()
	if d := time.Since(start); d > 2500*time.Millisecond {
		t.Errorf("shutdown took %v", d)
	}
	if list, _ := api.List(); len(list) != 0 {
		t.Errorf("sessions after shutdown: %+v", list)
	}
	if _, err := api.Open("", 80, 24); codeOf(err) != ErrCodeTerminalFailed {
		t.Errorf("Open after shutdown: %v", err)
	}
}

// App.Shutdown calls it first, before the vaults and the database go.
func TestAppShutdownCallsTheTerminalFirst(t *testing.T) {
	h := newTermHarness(t)
	api := NewTerminalAPI(h.a)
	_, _ = api.Open("", 80, 24)
	h.a.Shutdown(context.Background())
	if list, _ := api.List(); len(list) != 0 {
		t.Errorf("sessions after App.Shutdown: %+v", list)
	}
}

// The terminal is a capability of the desktop; the default shell resolves on the machine that runs the tests.
func TestTerminalCapabilityOnTheDesktop(t *testing.T) {
	desktop, _ := CapabilitiesFor("desktop")
	web, _ := CapabilitiesFor("web")
	if !desktop.Terminal || web.Terminal {
		t.Errorf("terminal: desktop %v, web %v", desktop.Terminal, web.Terminal)
	}
	if !platformCapabilities().Terminal {
		t.Error("the core says no terminal on a desktop")
	}
}
