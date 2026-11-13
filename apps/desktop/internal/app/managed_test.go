package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"clarae/apps/desktop/internal/history"
	"clarae/apps/desktop/internal/sync/transport"
)

func intPtr(n int) *int { return &n }

func TestEffectiveLockMinutes(t *testing.T) {
	for _, c := range []struct {
		name       string
		user       *int
		managed    int64
		hasManaged bool
		locked     bool
		want       int
	}{
		{"nothing set: never", nil, 0, false, false, 0},
		{"administrator default", nil, 30, true, false, 30},
		{"the user overrides the default", intPtr(5), 30, true, false, 5},
		{"the user may choose never", intPtr(0), 30, true, false, 0},
		{"a locked key wins", intPtr(0), 15, true, true, 15},
		{"user only", intPtr(60), 0, false, false, 60},
		{"clamped to a day", intPtr(5000), 0, false, false, maxVaultLockMinutes},
		{"negative is never", nil, -3, true, false, 0},
	} {
		if got := effectiveLockMinutes(c.user, c.managed, c.hasManaged, c.locked); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

func TestKeyLocked(t *testing.T) {
	for _, c := range []struct {
		locked []string
		key    string
		want   bool
	}{
		{[]string{"security.vault_lock_minutes"}, "security.vault_lock_minutes", true},
		{[]string{"security"}, "security.vault_lock_minutes", true},
		{[]string{"sec"}, "security.vault_lock_minutes", false},
		{[]string{"sync.interval_seconds"}, "sync.max_file_size_bytes", false},
		{nil, "sync.interval_seconds", false},
	} {
		if got := keyLocked(c.locked, c.key); got != c.want {
			t.Errorf("keyLocked(%v, %s) = %v", c.locked, c.key, got)
		}
	}
}

// refreshWith applies an effective configuration as if the server had sent it.
func refreshWith(t *testing.T, a *App, cfg map[string]any, locked ...string) {
	t.Helper()
	fetch := func(context.Context, string) (transport.EffectiveConfig, string, bool, error) {
		return transport.EffectiveConfig{Version: 1, Config: cfg, LockedKeys: locked}, "etag", true, nil
	}
	if _, err := a.config.Refresh(context.Background(), "https://cloud.test", fetch); err != nil {
		t.Fatal(err)
	}
	a.applyConfig()
}

// D5: the idle timeout reaches the key manager from the Config Profile and
// from the user's setting, with the precedence of the other managed keys.
func TestLockTimeoutFromProfileAndSettings(t *testing.T) {
	a, _, _ := newTestApp(t)
	if got := a.crypto.LockTimeout(); got != 0 {
		t.Fatalf("default timeout %v, want never", got)
	}
	refreshWith(t, a, map[string]any{"security": map[string]any{"vault_lock_minutes": float64(30)}})
	if got := a.crypto.LockTimeout(); got != 30*time.Minute {
		t.Fatalf("profile default not applied: %v", got)
	}
	settings := &SettingsAPI{app: a}
	if err := settings.Set(AppSettings{Theme: "system", VaultLockMinutes: intPtr(5)}); err != nil {
		t.Fatal(err)
	}
	if got := a.crypto.LockTimeout(); got != 5*time.Minute {
		t.Fatalf("user choice not applied: %v", got)
	}
	refreshWith(t, a, map[string]any{"security": map[string]any{"vault_lock_minutes": float64(15)}}, "security.vault_lock_minutes")
	if got := a.crypto.LockTimeout(); got != 15*time.Minute {
		t.Fatalf("locked profile value not enforced: %v", got)
	}
	if err := settings.Set(AppSettings{VaultLockMinutes: intPtr(-1)}); err == nil {
		t.Fatal("negative timeout accepted")
	}
	if err := settings.Set(AppSettings{VaultLockMinutes: intPtr(maxVaultLockMinutes + 1)}); err == nil {
		t.Fatal("timeout over a day accepted")
	}
}

// §2.9: before a merge replaces local content the server does not have, the
// local history keeps it.
func TestSnapshotBeforeOverwrite(t *testing.T) {
	a, info, root := newTestApp(t)
	if err := os.WriteFile(filepath.Join(root, "note.md"), []byte("my unsynced words"), 0o600); err != nil {
		t.Fatal(err)
	}
	a.snapshotBeforeOverwrite(info.ID, "note.md")
	v, err := a.vault(info.ID)
	if err != nil {
		t.Fatal(err)
	}
	snaps, err := v.History.List("note.md")
	if err != nil {
		t.Fatal(err)
	}
	if len(snaps) != 1 || snaps[0].Reason != history.ReasonPreSyncOverride {
		t.Fatalf("snapshots %+v, want one pre-sync-overwrite", snaps)
	}
	// Unknown vaults and missing files are ignored, never a panic.
	a.snapshotBeforeOverwrite("nope", "note.md")
	a.snapshotBeforeOverwrite(info.ID, "missing.md")
}

// ADR-0034 release N+1: v2 key envelopes are written by default
// (features.envelope_v2 on in the schema); a profile can turn them off, and a
// non-boolean value falls back to the default.
func TestEnvelopeV2FromProfile(t *testing.T) {
	a, _, _ := newTestApp(t)
	if !a.crypto.EnvelopeV2() {
		t.Fatal("v2 envelopes must be on by default")
	}
	refreshWith(t, a, map[string]any{"features": map[string]any{"envelope_v2": false}})
	if a.crypto.EnvelopeV2() {
		t.Fatal("features.envelope_v2 false not applied")
	}
	refreshWith(t, a, map[string]any{"features": map[string]any{"envelope_v2": "no"}})
	if !a.crypto.EnvelopeV2() {
		t.Fatal("a non-boolean value must take the default (on)")
	}
}

// ADR-0042 release N+1: enc2 path tokens are written by default
// (features.path_v2 on in the schema); a profile can turn them off, and a
// profile without the key takes the default again.
func TestPathV2FromProfile(t *testing.T) {
	a, _, _ := newTestApp(t)
	if !a.crypto.PathV2() {
		t.Fatal("enc2 paths must be on by default")
	}
	refreshWith(t, a, map[string]any{"features": map[string]any{"path_v2": false}})
	if a.crypto.PathV2() {
		t.Fatal("features.path_v2 false not applied")
	}
	refreshWith(t, a, map[string]any{"features": map[string]any{}})
	if !a.crypto.PathV2() {
		t.Fatal("removing the flag must restore the default (on)")
	}
}
