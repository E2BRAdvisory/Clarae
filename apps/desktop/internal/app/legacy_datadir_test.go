package app

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/store"
	"clarae/shared/envcompat"
)

// seedRecent writes the recent vaults of an application database, which it creates.
func seedRecent(t *testing.T, dataDir string, rows [][3]string) {
	t.Helper()
	db, err := store.Open(context.Background(), filepath.Join(dataDir, "app.db"), store.KindApp)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, r := range rows {
		if _, err := db.Exec(`INSERT INTO recent_vaults (path, name, last_opened_at) VALUES (?, ?, ?)`, r[0], r[1], r[2]); err != nil {
			t.Fatal(err)
		}
	}
}

func recentPaths(t *testing.T, a *App) map[string]string {
	t.Helper()
	rows, err := a.appDB.Query(`SELECT path, last_opened_at FROM recent_vaults`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var p, at string
		if err := rows.Scan(&p, &at); err != nil {
			t.Fatal(err)
		}
		out[p] = at
	}
	return out
}

// After the move of the data directory the vaults inside it (mounts, kept folders) are remembered
// at their new place, and the vaults the user chose elsewhere are left alone.
func TestStartupPointsTheRecentVaultsAtTheMovedDataDirectory(t *testing.T) {
	base := t.TempDir()
	legacy := filepath.Join(base, "old")
	dataDir := filepath.Join(base, "new")
	userVault := filepath.Join(base, "Documents", "Notes")
	seedRecent(t, dataDir, [][3]string{
		{filepath.Join(legacy, "mounts", "share-1"), "Team", "2026-05-01T10:00:00Z"},
		{filepath.Join(legacy, "kept", "gone-share"), "Kept", "2026-05-02T10:00:00Z"},
		{userVault, "Notes", "2026-05-03T10:00:00Z"},
		{legacy + "-other" + string(filepath.Separator) + "x", "Sibling", "2026-05-04T10:00:00Z"}, // same prefix, other folder
	})

	a := New(Options{DataDir: dataDir, LegacyDataDir: legacy, Logger: zerolog.Nop(), Version: "test"})
	a.setEmitter(func(string, any) {})
	ctx := context.Background()
	a.Startup(ctx)
	t.Cleanup(func() { a.Shutdown(ctx) })

	got := recentPaths(t, a)
	want := map[string]string{
		filepath.Join(dataDir, "mounts", "share-1"):  "2026-05-01T10:00:00Z",
		filepath.Join(dataDir, "kept", "gone-share"): "2026-05-02T10:00:00Z",
		userVault: "2026-05-03T10:00:00Z",
		legacy + "-other" + string(filepath.Separator) + "x": "2026-05-04T10:00:00Z",
	}
	if len(got) != len(want) {
		t.Fatalf("recent vaults = %v", got)
	}
	for p, at := range want {
		if got[p] != at {
			t.Errorf("%s = %q, want %q (all: %v)", p, got[p], at, got)
		}
	}
	// The list the UI gets has the vaults under their new ids.
	list, err := a.recentVaults()
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range list {
		if v.ID != vaultID(v.Path) {
			t.Errorf("%s has id %q", v.Path, v.ID)
		}
	}
}

// A start that was interrupted after the move and before the update finds the work to do, and a start
// that has nothing to do changes nothing.
func TestRewriteRecentVaultPathsIsIdempotentAndKeepsTheLaterDate(t *testing.T) {
	base := t.TempDir()
	legacy, dataDir := filepath.Join(base, "old"), filepath.Join(base, "new")
	moved := filepath.Join(dataDir, "mounts", "s")
	seedRecent(t, dataDir, [][3]string{
		{filepath.Join(legacy, "mounts", "s"), "Team", "2026-05-09T10:00:00Z"}, // the entry of 1.x
		{moved, "Team", "2026-05-01T10:00:00Z"},                                // already known under the new path
	})
	db, err := store.Open(context.Background(), filepath.Join(dataDir, "app.db"), store.KindApp)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	n, err := rewriteRecentVaultPaths(ctx, db, legacy, dataDir)
	if err != nil || n != 1 {
		t.Fatalf("first run: %d, %v", n, err)
	}
	var count int
	var at string
	if err := db.QueryRow(`SELECT count(*), max(last_opened_at) FROM recent_vaults`).Scan(&count, &at); err != nil || count != 1 || at != "2026-05-09T10:00:00Z" {
		t.Fatalf("after: %d rows, date %q, %v", count, at, err)
	}
	if n, err := rewriteRecentVaultPaths(ctx, db, legacy, dataDir); err != nil || n != 0 {
		t.Fatalf("second run: %d, %v", n, err)
	}
}

// The old folder was not moved (the new data directory was started on its own, next to it): a vault
// that is still where its entry says is not pointed at a folder that does not exist.
func TestRewriteRecentVaultPathsLeavesAVaultThatWasNotMoved(t *testing.T) {
	base := t.TempDir()
	legacy, dataDir := filepath.Join(base, "old"), filepath.Join(base, "new")
	stay := filepath.Join(legacy, "mounts", "still-here")
	if err := os.MkdirAll(stay, 0o700); err != nil {
		t.Fatal(err)
	}
	seedRecent(t, dataDir, [][3]string{{stay, "Team", "2026-05-01T10:00:00Z"}})
	db, err := store.Open(context.Background(), filepath.Join(dataDir, "app.db"), store.KindApp)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if n, err := rewriteRecentVaultPaths(context.Background(), db, legacy, dataDir); err != nil || n != 0 {
		t.Fatalf("rewritten: %d, %v", n, err)
	}
	var p string
	if err := db.QueryRow(`SELECT path FROM recent_vaults`).Scan(&p); err != nil || p != stay {
		t.Fatalf("path = %q, %v", p, err)
	}
}

func TestRelativeTo(t *testing.T) {
	sep := string(filepath.Separator)
	dir := filepath.Join(sep+"data", "Old")
	for _, tc := range []struct {
		path, rel string
		ok        bool
	}{
		{dir + sep + "mounts" + sep + "a", "mounts" + sep + "a", true},
		{dir + sep + "mounts" + sep + ".." + sep + "kept", "kept", true},
		{dir, "", false},
		{dir + sep, "", false},
		{dir + "x" + sep + "a", "", false},
		{sep + "data", "", false},
		{sep + "elsewhere" + sep + "Old" + sep + "a", "", false},
	} {
		rel, ok := relativeTo(tc.path, dir)
		if rel != tc.rel || ok != tc.ok {
			t.Errorf("relativeTo(%q) = %q, %v; want %q, %v", tc.path, rel, ok, tc.rel, tc.ok)
		}
	}
}

// The administrator's switch that turns the updates off, under its old name, is honoured, and the
// log says that the name is the old one, once.
func TestEnvValueFallsBackToTheOldNameAndWarnsOnce(t *testing.T) {
	const name = "TEST_ENV_VALUE"
	warnedEnv.Delete(name)
	t.Setenv(envcompat.Prefix+name, "")
	t.Setenv(envcompat.LegacyPrefix+name, "off")
	var mu sync.Mutex
	var buf bytes.Buffer
	logger := zerolog.New(writerFunc(func(p []byte) (int, error) { mu.Lock(); defer mu.Unlock(); return buf.Write(p) }))

	for i := 0; i < 3; i++ {
		if got := envValue(logger, name); got != "off" {
			t.Fatalf("value = %q", got)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if n := strings.Count(buf.String(), "environment variable"); n != 1 {
		t.Fatalf("%d warnings, want 1: %s", n, buf.String())
	}
	if !strings.Contains(buf.String(), envcompat.LegacyPrefix+name) || !strings.Contains(buf.String(), envcompat.Prefix+name) {
		t.Fatalf("the warning must name both variables: %s", buf.String())
	}
}

func TestEnvValuePrefersTheNewNameWithoutWarning(t *testing.T) {
	const name = "TEST_ENV_VALUE_NEW"
	warnedEnv.Delete(name)
	t.Setenv(envcompat.Prefix+name, "new")
	t.Setenv(envcompat.LegacyPrefix+name, "old")
	var buf bytes.Buffer
	if got := envValue(zerolog.New(&buf), name); got != "new" || buf.Len() != 0 {
		t.Fatalf("value = %q, log = %q", got, buf.String())
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }
