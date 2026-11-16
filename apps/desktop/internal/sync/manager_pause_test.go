package sync

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/rs/zerolog"
)

// PauseAll (sign-out) stops every loop and nothing more: files and the engine stay, and
// SessionChanged with a live session restarts the loop.
func TestManagerPauseAllStopsLoopsAndKeepsEngines(t *testing.T) {
	srv := &revokingServer{folderServer: newFolderServer(), revoked: map[string]bool{}}
	sess := &switchSession{deviceID: "dev-1"}
	m := NewManager(sess, nil, zerolog.Nop(), nil)
	m.remoteFor = func(string) Remote { return srv }
	fs := linkedVault(t)
	if err := m.Attach(context.Background(), "v", fs); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach("v") })
	mv, _ := m.get("v")
	_ = mv.db.SetMeta(context.Background(), MetaDeviceID, "dev-1")
	_ = mv.db.SetMeta(context.Background(), MetaUserID, "u")
	if err := os.WriteFile(filepath.Join(fs.Root(), "a.md"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m.SyncNow("v"); err != nil {
		t.Fatal(err)
	}
	waitTill(t, "a.md uploaded", func() bool { return slices.Contains(srv.paths(), "a.md") })

	m.PauseAll(context.Background())
	m.mu.Lock()
	running, hasEngine := mv.running, mv.engine != nil
	m.mu.Unlock()
	if running || !hasEngine {
		t.Fatalf("after PauseAll: running=%v engine=%v", running, hasEngine)
	}
	if _, err := os.Stat(filepath.Join(fs.Root(), "a.md")); err != nil {
		t.Fatal(err)
	}

	// The session lives on: the loop starts again.
	m.SessionChanged()
	waitTill(t, "the loop restarts", func() bool {
		m.mu.Lock()
		defer m.mu.Unlock()
		return mv.running
	})
}
