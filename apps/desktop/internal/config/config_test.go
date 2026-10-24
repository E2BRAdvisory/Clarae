package config

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	_ "modernc.org/sqlite"

	"nodus/apps/desktop/internal/sync/transport"
)

func memDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestRefreshCachesAndHonoursTheETag(t *testing.T) {
	ctx := context.Background()
	db := memDB(t)
	s := New(db)
	calls := 0
	fetch := func(_ context.Context, etag string) (transport.EffectiveConfig, string, bool, error) {
		calls++
		if etag == `"v1"` {
			return transport.EffectiveConfig{}, etag, false, nil // 304
		}
		return transport.EffectiveConfig{Version: 1, Config: map[string]any{"sync": map[string]any{"interval_seconds": 60.0}}, LockedKeys: []string{"sync.interval_seconds"}}, `"v1"`, true, nil
	}
	if cur := s.Current(); cur.Managed || cur.Version != 0 {
		t.Fatalf("before any fetch: %+v", cur)
	}
	changed, err := s.Refresh(ctx, "https://cloud.test", fetch)
	if err != nil || !changed {
		t.Fatalf("first refresh: %v %v", changed, err)
	}
	cur := s.Current()
	if !cur.Managed || cur.Version != 1 || len(cur.LockedKeys) != 1 || s.Version() != 1 {
		t.Fatalf("after: %+v", cur)
	}
	// Unchanged on the server: no change, the ETag is reused.
	if changed, err := s.Refresh(ctx, "https://cloud.test", fetch); err != nil || changed {
		t.Fatalf("second refresh: %v %v", changed, err)
	}

	// A new process starts offline with the cached configuration of that server only.
	s2 := New(db)
	s2.Load(ctx, "https://cloud.test")
	if got := s2.Current(); !got.Managed || got.Version != 1 || got.LockedKeys[0] != "sync.interval_seconds" {
		t.Fatalf("cache: %+v", got)
	}
	s2.Load(ctx, "https://other.test")
	if got := s2.Current(); got.Managed {
		t.Fatalf("another server must not inherit it: %+v", got)
	}
}

func TestAFailedRefreshKeepsTheLastValidConfiguration(t *testing.T) {
	ctx := context.Background()
	s := New(memDB(t))
	ok := func(context.Context, string) (transport.EffectiveConfig, string, bool, error) {
		return transport.EffectiveConfig{Version: 3, Config: map[string]any{"a": 1.0}}, `"v3"`, true, nil
	}
	if _, err := s.Refresh(ctx, "https://c.test", ok); err != nil {
		t.Fatal(err)
	}
	down := func(context.Context, string) (transport.EffectiveConfig, string, bool, error) {
		return transport.EffectiveConfig{}, "", false, errors.New("connection refused")
	}
	if changed, err := s.Refresh(ctx, "https://c.test", down); err == nil || changed {
		t.Fatalf("offline: %v %v", changed, err)
	}
	if got := s.Current(); got.Version != 3 || !got.Managed {
		t.Fatalf("the last valid configuration must stay: %+v", got)
	}
	if _, err := s.Refresh(ctx, "https://c.test", nil); err == nil {
		t.Error("signed out: nothing to fetch with")
	}
}
