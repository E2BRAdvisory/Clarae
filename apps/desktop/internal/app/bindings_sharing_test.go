package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/auth"
	syncpkg "memobrain/apps/desktop/internal/sync"
)

const testShareID = "0198f1c2-aaaa-7bbb-8ccc-000000000041"

// prepareMount makes dir the mount of share (as AcceptShare leaves it).
func prepareMount(t *testing.T, dir string) {
	t.Helper()
	share := testShareID
	mm := syncpkg.MountMeta{ShareID: share, CloudVaultID: "cloud-1", Scope: "share:" + share, Permission: syncpkg.PermEditor, Name: "Team", OwnerName: "ada", ResourceType: "folder"}
	if err := syncpkg.PrepareMount(context.Background(), dir, mm, syncpkg.SessionInfo{ServerURL: "http://cloud.test"}); err != nil {
		t.Fatal(err)
	}
}

// RemoveMount takes only a share id: a path, or an id that only names the folder through the file
// system, never reaches RemoveAll.
func TestRemoveMountRefusesAnInvalidShareID(t *testing.T) {
	a, _, _ := newTestApp(t)
	s := NewSharingAPI(a)
	// A folder outside the mounts directory that looks like a mount.
	victim := filepath.Join(a.opts.DataDir, "victim")
	prepareMount(t, victim)
	mount := filepath.Join(a.mountsDir(), testShareID)
	prepareMount(t, mount)

	for _, id := range []string{"../victim", testShareID + "/.", "./" + testShareID, "", "../mounts/" + testShareID} {
		if _, err := s.RemoveMount(id, false); err == nil || !strings.HasPrefix(err.Error(), "invalid:") {
			t.Errorf("RemoveMount(%q) = %v, want an invalid id", id, err)
		}
	}
	for _, dir := range []string{victim, mount} {
		// The folder itself (the browser core keeps sync.db in sqlite-wasm).
		if _, err := os.Stat(filepath.Join(dir, ".memobrain")); err != nil {
			t.Fatalf("%s was touched: %v", dir, err)
		}
	}
}

// RemoveMount closes the open vault of the mount before deleting its folder, whatever the form
// of the id the UI gives (here upper case, which a case-insensitive file system would resolve to
// the same folder).
func TestRemoveMountClosesTheOpenVault(t *testing.T) {
	a, _, _ := newTestApp(t)
	s := NewSharingAPI(a)
	dir := filepath.Join(a.mountsDir(), testShareID)
	prepareMount(t, dir)
	info, err := a.openVault(dir)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.RemoveMount(strings.ToUpper(testShareID), false); err != nil {
		t.Fatal(err)
	}
	if _, err := a.vault(info.ID); err == nil {
		t.Fatal("the vault of the removed mount is still open")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatalf("the mount folder is still there: %v", err)
	}
	if _, err := s.RemoveMount(testShareID, false); err == nil || !strings.HasPrefix(err.Error(), "not-found:") {
		t.Fatalf("removing it again: %v, want not-found", err)
	}
}

// Keeping a copy closes the vault too and moves the folder out of the mounts directory.
func TestRemoveMountKeepsACopy(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("the browser has no detached copies (capability detachedCopies)")
	}
	a, _, _ := newTestApp(t)
	s := NewSharingAPI(a)
	dir := filepath.Join(a.mountsDir(), testShareID)
	prepareMount(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "plan.md"), []byte("the plan"), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := a.openVault(dir)
	if err != nil {
		t.Fatal(err)
	}
	kept, err := s.RemoveMount(testShareID, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := a.vault(info.ID); err == nil {
		t.Fatal("the vault of the mount is still open")
	}
	if b, err := os.ReadFile(filepath.Join(kept.Path, "plan.md")); err != nil || string(b) != "the plan" {
		t.Fatalf("kept copy: %q, %v", b, err)
	}
	if _, ok, err := syncpkg.ReadMount(context.Background(), kept.Path); ok || err != nil {
		t.Fatalf("the kept copy is still a mount: %v %v", ok, err)
	}
}

// Requests made while a reconcile runs are one more run, never a second one at the same time.
func TestCoalescerRunsOneAtATime(t *testing.T) {
	var c coalescer
	var running, most, runs atomic.Int32
	release := make(chan struct{})
	started := make(chan struct{}, 16)
	fn := func() {
		n := running.Add(1)
		for {
			m := most.Load()
			if n <= m || most.CompareAndSwap(m, n) {
				break
			}
		}
		runs.Add(1)
		started <- struct{}{}
		<-release
		running.Add(-1)
	}
	idle := func() bool {
		c.mu.Lock()
		defer c.mu.Unlock()
		return !c.running
	}
	c.do(fn)
	<-started
	for range 20 {
		c.do(fn)
	}
	close(release)
	deadline := time.Now().Add(5 * time.Second)
	for !idle() {
		if time.Now().After(deadline) {
			t.Fatal("the coalescer never went idle")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if most.Load() != 1 || runs.Load() != 2 {
		t.Fatalf("at most %d at once, %d runs; want 1 at once and 2 runs", most.Load(), runs.Load())
	}
	c.do(fn) // idle again: a new request runs
	for runs.Load() != 3 {
		if time.Now().After(deadline) {
			t.Fatal("a request after idle did not run")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// sessionHost is a host that owns the cloud sign-in (as the browser page does).
type sessionHost struct {
	Host
	hosted *auth.Hosted
}

func (h sessionHost) Session() *auth.Hosted { return h.hosted }

// A sharing call on a black-holed network returns at its deadline instead of after the
// transport's retries (minutes).
func TestSharingBindingsHaveADeadline(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		select { // a server that never answers
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	prev := sharingCallTimeout
	sharingCallTimeout = 300 * time.Millisecond
	t.Cleanup(func() { sharingCallTimeout = prev })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	host := sessionHost{hosted: &auth.Hosted{ServerURL: srv.URL, Token: func(context.Context) (string, error) { return "t", nil }}}
	a := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Version: "test", Host: host})
	a.ctx = ctx
	a.setEmitter(func(string, any) {})
	a.auth.Restore(ctx)
	// The sign-in itself hangs on the same server: wait until it is under way, so the call below
	// is the only one that finishes.
	deadline := time.Now().Add(5 * time.Second)
	for a.auth.State().Status != auth.StatusSigningIn {
		if time.Now().After(deadline) {
			t.Fatalf("the hosted sign-in did not start: %+v", a.auth.State())
		}
		time.Sleep(5 * time.Millisecond)
	}

	s := NewSharingAPI(a)
	done := make(chan error, 1)
	start := time.Now()
	go func() { _, err := s.SearchDirectoryUsers("ada"); done <- err }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a call that got no answer succeeded")
		}
		if took := time.Since(start); took > 5*time.Second {
			t.Fatalf("the call took %v", took)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a sharing call hangs on a black-holed network")
	}
}
