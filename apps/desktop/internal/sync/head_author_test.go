package sync

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/rs/zerolog"

	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/store"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/apps/desktop/internal/vault"
	"clarae/shared/pathrules"
)

// The engine records who made the revision a row's content comes from: the author of a change it applies, and
// its own account for a commit that the server accepts.
func TestHeadAuthorFollowsTheRevisionOfTheContent(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "a.md", []byte("# one"))
	if r, _ := fileRow(t, e, f.FileID); r.HeadAuthor != "" {
		t.Fatalf("a row written without an author has one: %q", r.HeadAuthor)
	}

	// A remote modification by "other" replaces the content (the first entry of the changelog here).
	blob := remote.put(f.FileID, 2, []byte("# two"))
	remote.mu.Lock()
	remote.changes = append(remote.changes, transport.Change{Seq: 1, FileID: f.FileID, Op: "modify", Path: f.Path, Rev: 2, BlobHash: blob, AuthorID: "other"})
	remote.mu.Unlock()
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if r, _ := fileRow(t, e, f.FileID); r.HeadAuthor != "other" || r.ServerRev != 2 || r.State != StateSynced {
		t.Fatalf("after a remote change: %+v", r)
	}

	// A local edit that the server accepts is this account's.
	writeFile(t, dir, "a.md", []byte("# three"))
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if r, _ := fileRow(t, e, f.FileID); r.HeadAuthor != "u" || r.ServerRev != 3 || r.State != StateSynced {
		t.Fatalf("after an accepted commit: %+v", r)
	}

	// A file this device does not have yet comes with its author.
	g := File{FileID: newFileID(), Path: "b.md"}
	h := remote.put(g.FileID, 1, []byte("# b"))
	remote.mu.Lock()
	remote.changes = append(remote.changes, transport.Change{Seq: 2, FileID: g.FileID, Op: "create", Path: "b.md", Rev: 1, BlobHash: h, Size: 3, AuthorID: "third"})
	remote.mu.Unlock()
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if r, ok := fileRow(t, e, g.FileID); !ok || r.HeadAuthor != "third" {
		t.Fatalf("a file created remotely: %+v", r)
	}
}

// A row saved before the column existed reads as an unknown author, and the migration keeps the rest.
func TestHeadAuthorMigrationKeepsOldRows(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	sdb, err := store.Open(ctx, filepath.Join(dir, ".clarae", "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sdb.Close() }()
	db := NewDB(sdb)
	if _, err := sdb.ExecContext(ctx, `INSERT INTO sync_files (path, file_id, server_rev, base_rev, server_hash, local_hash, state) VALUES ('old.md','id1',3,3,'h','h','synced')`); err != nil {
		t.Fatal(err)
	}
	f, ok, err := db.GetFile(ctx, "old.md")
	if err != nil || !ok || f.HeadAuthor != "" || f.ServerRev != 3 || f.State != StateSynced {
		t.Fatalf("%+v %v %v", f, ok, err)
	}
	f.HeadAuthor = "me"
	if err := db.PutFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	if g, _, _ := db.GetFile(ctx, "old.md"); g.HeadAuthor != "me" {
		t.Fatalf("the author is not stored: %+v", g)
	}
}

// authorFixture attaches a vault linked as kind with session user "u" and returns the manager.
func authorFixture(t *testing.T, kind string, link bool) *Manager {
	t.Helper()
	var fs *vault.FS
	if link {
		fs = linkedVault(t)
		sdb, err := store.Open(context.Background(), filepath.Join(fs.Root(), pathrules.ConfigDir, "sync.db"), store.KindSync)
		if err != nil {
			t.Fatal(err)
		}
		if err := NewDB(sdb).SetMeta(context.Background(), MetaKind, kind); err != nil {
			t.Fatal(err)
		}
		_ = sdb.Close()
	} else {
		var err error
		if fs, err = vault.NewFS(t.TempDir()); err != nil {
			t.Fatal(err)
		}
	}
	m := NewManager(offlineSession{}, crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore()}), zerolog.Nop(), func(string, any) {})
	if err := m.Attach(context.Background(), "v", fs); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach("v") })
	return m
}

func putRow(t *testing.T, m *Manager, f File) {
	t.Helper()
	mv, err := m.get("v")
	if err != nil {
		t.Fatal(err)
	}
	if err := mv.db.PutFile(context.Background(), f); err != nil {
		t.Fatal(err)
	}
}

func TestSameAuthorOnDisk(t *testing.T) {
	ctx := context.Background()
	const disk = "disk-hash"
	row := func(mod func(*File)) File {
		f := File{Path: "d.excalidraw", FileID: newFileID(), ServerRev: 2, BaseRev: 2, ServerHash: disk, LocalHash: disk, State: StateSynced, HeadAuthor: "u"}
		mod(&f)
		return f
	}
	cases := []struct {
		name string
		kind string
		link bool
		f    *File
		hash string
		want bool
	}{
		{"not linked", "", false, nil, disk, true},
		{"private vault, server version of another author", "private", true, ptr(row(func(f *File) { f.HeadAuthor = "other" })), disk, true},
		{"shared, a file the sync has not seen", "shared", true, nil, disk, true},
		{"shared, on disk since the last scan", "shared", true, ptr(row(func(f *File) { f.HeadAuthor = "other" })), "newer-hash", true},
		{"shared, local edit already recorded", "shared", true, ptr(row(func(f *File) { f.State, f.HeadAuthor = StateLocalModify, "other" })), disk, true},
		{"shared, new local file", "shared", true, ptr(row(func(f *File) { f.State, f.ServerRev, f.HeadAuthor = StateLocalNew, 0, "" })), disk, true},
		{"shared, moved with edits", "shared", true, ptr(row(func(f *File) { f.State, f.Dirty, f.HeadAuthor = StateLocalMoved, true, "other" })), disk, true},
		{"shared, server version of another author", "shared", true, ptr(row(func(f *File) { f.HeadAuthor = "other" })), disk, false},
		{"shared, server version of this account", "shared", true, ptr(row(func(f *File) {})), disk, true},
		{"shared, moved without edits, another author", "shared", true, ptr(row(func(f *File) { f.State, f.HeadAuthor = StateLocalMoved, "other" })), disk, false},
		{"shared, row without an author", "shared", true, ptr(row(func(f *File) { f.HeadAuthor = "" })), disk, false},
		{"shared, parked in conflict", "shared", true, ptr(row(func(f *File) { f.State = StateConflict })), disk, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := authorFixture(t, c.kind, c.link)
			if c.f != nil {
				putRow(t, m, *c.f)
			}
			if got := m.SameAuthorOnDisk(ctx, "v", "d.excalidraw", c.hash); got != c.want {
				t.Fatalf("SameAuthorOnDisk = %v, want %v", got, c.want)
			}
		})
	}

	t.Run("vault not open", func(t *testing.T) {
		m := authorFixture(t, "", false)
		if !m.SameAuthorOnDisk(ctx, "nope", "x.md", disk) {
			t.Fatal("a vault that is not open has no other author")
		}
	})
	t.Run("sync.db unreadable", func(t *testing.T) {
		m := authorFixture(t, "shared", true)
		broken, cancel := context.WithCancel(ctx)
		cancel()
		if m.SameAuthorOnDisk(broken, "v", "d.excalidraw", disk) {
			t.Fatal("an unreadable sync.db must not count as the user's own")
		}
	})
}

func ptr[T any](v T) *T { return &v }
