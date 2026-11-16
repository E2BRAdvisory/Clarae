package sync

// The move of the synchronized settings from the former configuration folder to the current one
// (features.config_dir_v2, ADR-0052) and the guard that keeps a path that is never synchronized from
// being written by a pull.

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

var (
	oldCfg = pathrules.LegacyConfigDirs[0]
	newCfg = pathrules.ConfigDir
)

func moveOn(e *Engine) { e.cfg.ConfigDirV2 = func() bool { return true } }

// With the flag on a synced setting moves to the current folder with its identity, and the move is
// pushed as a move of the same file with its base revision, not as a deletion and a new file. One
// file of the former folder stays (it has an error), so the folder is not renamed as a whole.
func TestConfigMovesWithItsIdentity(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	moveOn(e)
	f := syncedFile(t, e, remote, dir, oldCfg+"/editor.json", []byte(`{"font":14}`))
	g := syncedFile(t, e, remote, dir, oldCfg+"/appearance.json", []byte("{}"))
	stay := syncedFile(t, e, remote, dir, oldCfg+"/hotkeys.json", []byte("{}"))
	stay.LastError = "an error that keeps the file where it is"
	if err := e.cfg.DB.PutFile(ctx, stay); err != nil {
		t.Fatal(err)
	}

	if err := e.Sync(ctx); err != nil { // the move happens at the end of this idle cycle
		t.Fatal(err)
	}
	if exists(dir, oldCfg+"/editor.json") || readFile(t, dir, newCfg+"/editor.json") != `{"font":14}` ||
		readFile(t, dir, newCfg+"/appearance.json") != "{}" {
		t.Fatal("the files did not move")
	}
	if !exists(dir, oldCfg+"/hotkeys.json") {
		t.Fatal("the file with an error moved")
	}
	row := rowOf(t, e, f.FileID)
	if row.Path != newCfg+"/editor.json" || row.State != StateLocalMoved || row.MovedFrom != oldCfg+"/editor.json" || row.ServerRev != 1 {
		t.Fatalf("row after the move: %+v", row)
	}

	// The next cycle pushes the moves.
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	for id, to := range map[string]string{f.FileID: newCfg + "/editor.json", g.FileID: newCfg + "/appearance.json"} {
		moves := remote.committed(syncproto.OpMove, id)
		if len(moves) != 1 || moves[0].BaseRev == nil || *moves[0].BaseRev != 1 || moves[0].Path != to {
			t.Fatalf("move commits of %s: %+v, want one to %s on base 1", id, moves, to)
		}
		if row := rowOf(t, e, id); row.State != StateSynced || row.ServerRev != 2 || row.Path != to {
			t.Fatalf("row after the push: %+v", row)
		}
	}
	if n := len(remote.committed(syncproto.OpDelete, "")); n != 0 {
		t.Fatalf("%d deletions were committed", n)
	}
	if row := rowOf(t, e, stay.FileID); row.Path != oldCfg+"/hotkeys.json" || row.State != StateSynced {
		t.Fatalf("the file that stayed: %+v", row)
	}
}

// When every file of the former folder moves, a shared vault sends one folder rename (ADR-0040): the
// server expands it into the moves of the same files, so the identities hold all the same.
func TestConfigMoveOfTheWholeFolderIsOneFolderRename(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	moveOn(e)
	f := syncedFile(t, e, remote, dir, oldCfg+"/editor.json", []byte(`{"font":14}`))
	g := syncedFile(t, e, remote, dir, oldCfg+"/hotkeys.json", []byte("{}"))
	for i := 0; i < 2; i++ {
		if err := e.Sync(ctx); err != nil {
			t.Fatal(err)
		}
	}
	prefix := remote.committed(syncproto.OpMovePrefix, "")
	if len(prefix) != 1 || prefix[0].From != oldCfg || prefix[0].To != newCfg {
		t.Fatalf("folder renames: %+v", prefix)
	}
	if n := len(remote.committed(syncproto.OpDelete, "")); n != 0 {
		t.Fatalf("%d deletions were committed", n)
	}
	for _, id := range []string{f.FileID, g.FileID} {
		if row := rowOf(t, e, id); row.State != StateSynced || row.MovedFrom != "" {
			t.Fatalf("row: %+v", row)
		}
	}
	if rowOf(t, e, f.FileID).Path != newCfg+"/editor.json" || rowOf(t, e, g.FileID).Path != newCfg+"/hotkeys.json" {
		t.Fatal("the rows did not follow the files")
	}
}

// The flag is off when the engine was not given one and when it says false, which is what an
// administrator who turned config_dir_v2 off (the default is on since 1.7.0) makes the manager say.
func TestConfigStaysWhereItIsWithTheFlagOff(t *testing.T) {
	for name, flag := range map[string]func() bool{
		"no flag":        nil,
		"explicit false": func() bool { return false },
	} {
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			remote := newScriptRemote()
			e, dir := newTestEngine(t, remote, 0)
			e.cfg.ConfigDirV2 = flag
			f := syncedFile(t, e, remote, dir, oldCfg+"/editor.json", []byte("{}"))
			for i := 0; i < 2; i++ {
				if err := e.Sync(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if !exists(dir, oldCfg+"/editor.json") || exists(dir, newCfg+"/editor.json") || rowOf(t, e, f.FileID).Path != oldCfg+"/editor.json" {
				t.Fatal("a setting moved with features.config_dir_v2 off")
			}
			if n := len(remote.committed(syncproto.OpMove, "")); n != 0 {
				t.Fatalf("%d moves were committed", n)
			}
		})
	}
}

// Whatever is not a plain synced setting stays: nothing is lost and nothing is overwritten.
func TestConfigMoveLeavesWhatIsNotSafe(t *testing.T) {
	ctx := context.Background()
	type tc struct {
		name  string
		setup func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File)
	}
	for _, c := range []tc{
		{"the current folder has the file", func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File) {
			writeFile(t, dir, newCfg+"/editor.json", []byte("current"))
		}},
		{"the current folder has a row of that name that is not synced", func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File) {
			g := File{Path: newCfg + "/editor.json", FileID: newFileID(), ServerRev: 1, BaseRev: 1, State: StateLocalNew, LocalHash: "x"}
			if err := e.cfg.DB.PutFile(ctx, g); err != nil {
				t.Fatal(err)
			}
		}},
		{"a local edit not yet scanned", func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File) {
			writeFile(t, dir, oldCfg+"/editor.json", []byte(`{"font":99}`))
		}},
		{"a local change recorded", func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File) {
			f.State = StateLocalModify
			if err := e.cfg.DB.PutFile(ctx, f); err != nil {
				t.Fatal(err)
			}
		}},
		{"a remote change parked", func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File) {
			e.candidates[f.FileID] = transportChange{}
		}},
		{"an error on the row", func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File) {
			f.LastError = quarantinedError
			if err := e.cfg.DB.PutFile(ctx, f); err != nil {
				t.Fatal(err)
			}
		}},
		{"a conflict copy", func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File) {
			f.ConflictOf = newFileID()
			if err := e.cfg.DB.PutFile(ctx, f); err != nil {
				t.Fatal(err)
			}
		}},
		{"the share is read-only", func(t *testing.T, e *Engine, remote *scriptRemote, dir string, f File) {
			e.cfg.ReadOnly = true
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			remote := newScriptRemote()
			e, dir := newTestEngine(t, remote, 0)
			moveOn(e)
			f := syncedFile(t, e, remote, dir, oldCfg+"/editor.json", []byte(`{"font":14}`))
			c.setup(t, e, remote, dir, f)
			before := rowOf(t, e, f.FileID)
			e.migrateConfigDir(ctx)
			if !exists(dir, oldCfg+"/editor.json") {
				t.Fatal("the file left the former folder")
			}
			if got := rowOf(t, e, f.FileID); got != before {
				t.Fatalf("row changed: %+v -> %+v", before, got)
			}
			if exists(dir, newCfg+"/editor.json") && readFile(t, dir, newCfg+"/editor.json") != "current" {
				t.Fatal("the current folder holds a copy it did not have")
			}
		})
	}
}

// After a pass that moved nothing the next one waits; moves wake it up again.
func TestConfigMoveRechecksLater(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	moveOn(e)
	now := time.Unix(1_700_000_000, 0)
	e.cfg.Now = func() time.Time { return now }

	e.migrateConfigDir(ctx) // nothing to move
	f := syncedFile(t, e, remote, dir, oldCfg+"/editor.json", []byte("{}"))
	e.migrateConfigDir(ctx) // too soon: not even looked at
	if !exists(dir, oldCfg+"/editor.json") {
		t.Fatal("the pass ran before its time")
	}
	now = now.Add(configMoveRecheck + time.Second)
	e.migrateConfigDir(ctx)
	if exists(dir, oldCfg+"/editor.json") || rowOf(t, e, f.FileID).Path != newCfg+"/editor.json" {
		t.Fatal("the pass did not run when it was due")
	}
}

// A crash between the rename on disk and the hint to the engine: the scan finds the file under its
// new name (same content, same name) and keeps its identity, and the next pass finds nothing to do.
func TestConfigMoveSurvivesACrashAfterTheRename(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	moveOn(e)
	f := syncedFile(t, e, remote, dir, oldCfg+"/editor.json", []byte(`{"font":14}`))
	// What MoveConfig did before the process died.
	if _, moved, err := e.cfg.FS.MoveConfig(f.Path, f.LocalHash); err != nil || !moved {
		t.Fatalf("MoveConfig: %v %v", moved, err)
	}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	row := rowOf(t, e, f.FileID)
	if row.Path != newCfg+"/editor.json" || row.State != StateSynced || row.MovedFrom != "" {
		t.Fatalf("row: %+v", row)
	}
	if n := len(remote.committed(syncproto.OpDelete, "")); n != 0 {
		t.Fatalf("%d deletions were committed", n)
	}
	if len(remote.committed(syncproto.OpMove, f.FileID))+len(remote.committed(syncproto.OpMovePrefix, "")) != 1 {
		t.Fatalf("the move was not sent as one move: %+v", remote.commits)
	}
}

// The server holds a file at a path that is never synchronized (a client of an older version put a
// sync.db in a private vault, where the cloud cannot read paths): it is not written, in a pull and in
// a bootstrap alike, the database of this device is untouched, and the cursor moves past it.
func TestPullDoesNotWriteAPathThatIsNeverSynchronized(t *testing.T) {
	ctx := context.Background()
	excluded := []string{
		newCfg + "/sync.db", newCfg + "/index.db-wal", newCfg + "/workspace.json", newCfg + "/cache/outbox/x",
		newCfg + "/snapshots/2026/a.md", oldCfg + "/sync.db", oldCfg + "/workspace.json", ".clarae-tmp-123", "Notes/.DS_Store",
	}
	for _, mode := range []string{"pull", "bootstrap"} {
		t.Run(mode, func(t *testing.T) {
			remote := newScriptRemote()
			e, dir := newTestEngine(t, remote, 0)
			if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1"); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, newCfg, "workspace.json"), []byte("my layout"), 0o644); err != nil {
				t.Fatal(err)
			}
			var items []transport.TreeEntry
			for i, p := range excluded {
				id := newFileID()
				content := []byte("planted " + p)
				h := remote.put(id, 1, content)
				seq := int64(i + 1)
				remote.changes = append(remote.changes, transport.Change{Seq: seq, FileID: id, Op: "create", Path: p, Rev: 1, BlobHash: h, AuthorID: "other"})
				items = append(items, transport.TreeEntry{Path: p, FileID: id, Rev: 1, Hash: h})
			}
			ok := newFileID()
			okHash := remote.put(ok, 1, []byte("# fine"))
			remote.changes = append(remote.changes, transport.Change{Seq: int64(len(excluded) + 1), FileID: ok, Op: "create", Path: "Notes/fine.md", Rev: 1, BlobHash: okHash, AuthorID: "other"})
			items = append(items, transport.TreeEntry{Path: "Notes/fine.md", FileID: ok, Rev: 1, Hash: okHash})
			if mode == "bootstrap" {
				remote.tree = transport.Tree{AsOfSeq: int64(len(excluded) + 1), Items: items}
				if err := e.cfg.DB.DeleteMeta(ctx, MetaBootstrapped); err != nil {
					t.Fatal(err)
				}
			}

			if err := e.Sync(ctx); err != nil {
				t.Fatal(err)
			}
			if got := readFile(t, dir, "Notes/fine.md"); got != "# fine" {
				t.Fatalf("an ordinary file was not applied: %q", got)
			}
			if got := readFile(t, dir, newCfg+"/workspace.json"); got != "my layout" {
				t.Fatalf("the local layout was overwritten: %q", got)
			}
			for _, p := range excluded {
				if p == newCfg+"/workspace.json" || p == newCfg+"/sync.db" {
					continue // the files this device owns are checked below
				}
				if exists(dir, p) {
					t.Errorf("%s was written", p)
				}
			}
			// The sync database is still the one of this device (in the browser core it is not a file).
			if runtime.GOOS != "js" {
				head := make([]byte, 16)
				f, err := os.Open(filepath.Join(dir, newCfg, "sync.db"))
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = f.Close() }()
				if _, err := f.Read(head); err != nil || string(head) != "SQLite format 3\x00" {
					t.Fatalf("sync.db was replaced: %q %v", head, err)
				}
			}
			rows, err := e.cfg.DB.Files(ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, r := range rows {
				if pathrules.IsExcluded(r.Path, false) {
					t.Errorf("a row was made for %s", r.Path)
				}
			}
			if mode == "pull" && cursor(t, e) != int64(len(excluded)+1) {
				t.Fatalf("cursor = %d: the change that is not written must not hold the pull", cursor(t, e))
			}
		})
	}
}

// The current folder has the file and the former one is a clean leftover: the leftover's row is
// deleted on the server (an ordinary delete on its base revision, so the revision stays in the
// history there), the file leaves the disk, and the current settings are untouched. A copy that
// differs from the current one goes to the vault's trash first.
func TestConfigDropsTheShadowedFormerFile(t *testing.T) {
	for _, same := range []bool{true, false} {
		name := "same content"
		if !same {
			name = "different content"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			remote := newScriptRemote()
			e, dir := newTestEngine(t, remote, 0)
			moveOn(e)
			legacyContent := []byte(`{"font":14}`)
			curContent := legacyContent
			if !same {
				curContent = []byte(`{"font":18}`)
			}
			old := syncedFile(t, e, remote, dir, oldCfg+"/editor.json", legacyContent)
			cur := syncedFile(t, e, remote, dir, newCfg+"/editor.json", curContent)
			other := syncedFile(t, e, remote, dir, oldCfg+"/hotkeys.json", []byte("{}")) // moves, not dropped

			if err := e.Sync(ctx); err != nil { // the pass runs at the end of this idle cycle
				t.Fatal(err)
			}
			if exists(dir, oldCfg+"/editor.json") {
				t.Fatal("the shadowed file is still in the former folder")
			}
			if readFile(t, dir, newCfg+"/editor.json") != string(curContent) {
				t.Fatal("the current settings changed")
			}
			trashed := ".trash/" + oldCfg + "/editor.json"
			if same && exists(dir, trashed) {
				t.Fatal("an identical copy was kept in the trash")
			}
			if !same && readFile(t, dir, trashed) != string(legacyContent) {
				t.Fatal("the differing version was not kept in the trash")
			}
			row := rowOf(t, e, old.FileID)
			if row.State != StateLocalDeleted || row.ServerRev != 1 {
				t.Fatalf("row of the leftover: %+v", row)
			}

			if err := e.Sync(ctx); err != nil { // the next cycle pushes it
				t.Fatal(err)
			}
			dels := remote.committed(syncproto.OpDelete, old.FileID)
			if len(dels) != 1 || dels[0].BaseRev == nil || *dels[0].BaseRev != 1 {
				t.Fatalf("delete commits of the leftover: %+v", dels)
			}
			if n := len(remote.committed(syncproto.OpDelete, cur.FileID)); n != 0 {
				t.Fatalf("the current settings were deleted on the server (%d)", n)
			}
			if got := rowOf(t, e, cur.FileID); got.State != StateSynced || got.Path != newCfg+"/editor.json" {
				t.Fatalf("row of the current settings: %+v", got)
			}
			if got := rowOf(t, e, other.FileID); got.Path != newCfg+"/hotkeys.json" {
				t.Fatalf("the other file did not move: %+v", got)
			}
		})
	}
}

// Nothing is dropped unless both copies are what sync.db knows: an unsent edit of the former file,
// or of the current one, an unsynced current row, a flag that is off, a read-only share.
func TestConfigDropLeavesWhatIsNotSafe(t *testing.T) {
	ctx := context.Background()
	type tc struct {
		name  string
		setup func(t *testing.T, e *Engine, dir string, old, cur File)
	}
	for _, c := range []tc{
		{"unsent edit of the former file", func(t *testing.T, e *Engine, dir string, old, cur File) {
			writeFile(t, dir, old.Path, []byte("edited, not yet scanned"))
		}},
		{"unsent edit of the current file", func(t *testing.T, e *Engine, dir string, old, cur File) {
			writeFile(t, dir, cur.Path, []byte("edited, not yet scanned"))
		}},
		{"the current file is gone from the disk", func(t *testing.T, e *Engine, dir string, old, cur File) {
			if err := os.Remove(filepath.Join(dir, cur.Path)); err != nil {
				t.Fatal(err)
			}
		}},
		{"the current row has a local change", func(t *testing.T, e *Engine, dir string, old, cur File) {
			cur.State = StateLocalModify
			if err := e.cfg.DB.PutFile(ctx, cur); err != nil {
				t.Fatal(err)
			}
		}},
		{"the current row is a tombstone", func(t *testing.T, e *Engine, dir string, old, cur File) {
			cur.Tombstoned = true
			if err := e.cfg.DB.PutFile(ctx, cur); err != nil {
				t.Fatal(err)
			}
		}},
		{"the former row has a local change", func(t *testing.T, e *Engine, dir string, old, cur File) {
			old.State = StateLocalModify
			if err := e.cfg.DB.PutFile(ctx, old); err != nil {
				t.Fatal(err)
			}
		}},
		{"a remote change of the former file is parked", func(t *testing.T, e *Engine, dir string, old, cur File) {
			e.candidates[old.FileID] = transportChange{}
		}},
		{"the flag is off", func(t *testing.T, e *Engine, dir string, old, cur File) {
			e.cfg.ConfigDirV2 = func() bool { return false }
		}},
		{"the share is read-only", func(t *testing.T, e *Engine, dir string, old, cur File) {
			e.cfg.ReadOnly = true
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			remote := newScriptRemote()
			e, dir := newTestEngine(t, remote, 0)
			moveOn(e)
			old := syncedFile(t, e, remote, dir, oldCfg+"/editor.json", []byte(`{"font":14}`))
			cur := syncedFile(t, e, remote, dir, newCfg+"/editor.json", []byte(`{"font":18}`))
			c.setup(t, e, dir, old, cur)
			before := rowOf(t, e, old.FileID)
			e.migrateConfigDir(ctx)
			if !exists(dir, old.Path) {
				t.Fatal("the former file left the disk")
			}
			if c.name == "unsent edit of the former file" && readFile(t, dir, old.Path) != "edited, not yet scanned" {
				t.Fatal("an unsent edit was lost")
			}
			if exists(dir, ".trash") {
				t.Fatal("something went to the trash")
			}
			if got := rowOf(t, e, old.FileID); got != before {
				t.Fatalf("row changed: %+v -> %+v", before, got)
			}
		})
	}
}
