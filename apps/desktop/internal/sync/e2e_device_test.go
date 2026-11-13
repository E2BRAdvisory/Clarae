//go:build integration

package sync_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	stdsync "sync"
	"testing"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/crypto"
	syncpkg "clarae/apps/desktop/internal/sync"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/apps/desktop/internal/vault"
)

// revocableSession is the account as the application shows it to the manager: its device can be
// revoked (Info answers "not signed in", DeviceRevoked) and replaced by a new registration.
type revocableSession struct {
	c    *transport.Client
	mu   stdsync.Mutex
	info syncpkg.SessionInfo
}

func (s *revocableSession) Client() *transport.Client { return s.c }

func (s *revocableSession) Info() (syncpkg.SessionInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.info, !s.info.DeviceRevoked
}

func (s *revocableSession) update(f func(*syncpkg.SessionInfo)) {
	s.mu.Lock()
	f(&s.info)
	s.mu.Unlock()
}

// A device revoked from another device stops synchronizing against the real cloud, keeps the
// file written meanwhile, and pushes it once the account registers a new device.
func TestManagerDeviceRevokedAndRegisteredAgain(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	c := newClient(t, "rita")
	me, err := c.GetMe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := c.RegisterDevice(ctx, transport.DeviceRegistration{Name: "rita-laptop", Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	sess := &revocableSession{c: c, info: syncpkg.SessionInfo{ServerURL: serverURL, DeviceID: dev.Id.String(), UserID: me.Id.String(), DeviceName: "rita-laptop"}}
	m := syncpkg.NewManager(sess, crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore()}), zerolog.Nop(), nil)
	revoked := make(chan string, 1)
	m.SetHooks(syncpkg.Hooks{DeviceRevoked: func(id string) {
		sess.update(func(i *syncpkg.SessionInfo) { i.DeviceRevoked = true })
		m.SessionChanged()
		select {
		case revoked <- id:
		default:
		}
	}})
	m.Start(ctx)
	t.Cleanup(m.Shutdown)

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "Kept.md"), []byte("before\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := m.Attach(ctx, "v", fs); err != nil {
		t.Fatal(err)
	}
	link, err := m.Link(ctx, "v", "revoked-device", "shared", "")
	if err != nil {
		t.Fatal(err)
	}
	onServer := func(path string) func() bool {
		return func() bool {
			tree, err := c.GetTree(ctx, link.CloudVaultID)
			if err != nil {
				return false
			}
			for _, it := range tree.Items {
				if it.Path == path {
					return true
				}
			}
			return false
		}
	}
	eventually(t, "Kept.md uploaded", onServer("Kept.md"))

	// Revoked from another device (the console does the same call).
	if err := c.RevokeDevice(ctx, dev.Id.String()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Late.md"), []byte("written after the revocation\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m.SyncNow("v"); err != nil {
		t.Fatal(err)
	}
	if id := <-revoked; id != dev.Id.String() {
		t.Fatalf("revoked device reported as %q", id)
	}
	st, err := m.Status(ctx, "v")
	if err != nil {
		t.Fatal(err)
	}
	if st.Phase != syncpkg.PhaseOffline || st.Error != syncpkg.DeviceRevokedMessage || st.Pending == 0 {
		t.Fatalf("status while revoked: %+v", st)
	}
	if err := m.SyncNow("v"); !errors.Is(err, syncpkg.ErrDeviceRevoked) {
		t.Fatalf("SyncNow while revoked: %v", err)
	}
	if onServer("Late.md")() {
		t.Fatal("Late.md reached the cloud from a revoked device")
	}

	// Registered again: the pending file goes out with the new device.
	dev2, err := c.RegisterDevice(ctx, transport.DeviceRegistration{Name: "rita-laptop", Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	sess.update(func(i *syncpkg.SessionInfo) { i.DeviceID, i.DeviceRevoked = dev2.Id.String(), false })
	m.SessionChanged()
	eventually(t, "Late.md uploaded with the new device", onServer("Late.md"))
	eventually(t, "idle, nothing pending", func() bool {
		st, err := m.Status(ctx, "v")
		return err == nil && st.Phase == syncpkg.PhaseIdle && st.Pending == 0
	})
}
