package sync

// Unit tests of the client integrity fixes of M12 (W2.1): no local change is
// dropped by a restore of a deleted file, a remote deletion, a token rewrite
// or a conflict resolution; quarantined entries are retried, lifted and
// counted; the manager never touches an engine outside its lock nor resets a
// state a cycle is still writing.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	stdsync "sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/syncproto"
)

// scanNow runs one scan as a cycle would (under the cycle lock).
func scanNow(t *testing.T, e *Engine) {
	t.Helper()
	if err := e.Exclusive(func() error { return e.scan(context.Background()) }); err != nil {
		t.Fatal(err)
	}
}

func rowOf(t *testing.T, e *Engine, fileID string) File {
	t.Helper()
	r, ok, err := e.cfg.DB.GetFileByID(context.Background(), fileID)
	if err != nil || !ok {
		t.Fatalf("row of %s: ok=%v err=%v", fileID, ok, err)
	}
	return r
}

// An edit made offline, then the file deleted and restored before any push:
// the restored file still carries the edit, which must be sent (not taken for
// the server's content and later overwritten).
func TestRestoredFileKeepsUnsentEdit(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "a.md", []byte(baseText))

	writeFile(t, dir, "a.md", []byte(localText))
	scanNow(t, e)
	if r := rowOf(t, e, f.FileID); r.State != StateLocalModify {
		t.Fatalf("after the edit: %s", r.State)
	}
	if err := os.Remove(filepath.Join(dir, "a.md")); err != nil {
		t.Fatal(err)
	}
	scanNow(t, e)
	if r := rowOf(t, e, f.FileID); r.State != StateLocalDeleted {
		t.Fatalf("after the deletion: %s", r.State)
	}
	writeFile(t, dir, "a.md", []byte(localText)) // restored from the trash
	scanNow(t, e)
	if r := rowOf(t, e, f.FileID); r.State != StateLocalModify {
		t.Fatalf("restored with an unsent edit: state %s, want %s", r.State, StateLocalModify)
	}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	mods := remote.committed(syncproto.OpModify, f.FileID)
	if len(mods) != 1 || mods[0].BlobHash != hashOf([]byte(localText)) {
		t.Fatalf("modify commits %+v: want the edit sent once", mods)
	}
	if r := rowOf(t, e, f.FileID); r.State != StateSynced || r.ServerHash != hashOf([]byte(localText)) {
		t.Fatalf("row %+v", r)
	}
}

// A file restored with exactly the server's content is synced again, and one
// whose move was not sent yet keeps that move.
func TestRestoredFileStateFollowsTheServer(t *testing.T) {
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	same := syncedFile(t, e, remote, dir, "same.md", []byte("# same\n"))
	moved := syncedFile(t, e, remote, dir, "old.md", []byte("# moved\n"))

	mustRename(t, dir, "old.md", "new.md")
	scanNow(t, e)
	if r := rowOf(t, e, moved.FileID); r.State != StateLocalMoved || r.MovedFrom != "old.md" {
		t.Fatalf("after the rename: %+v", r)
	}
	for _, p := range []string{"same.md", "new.md"} {
		if err := os.Remove(filepath.Join(dir, p)); err != nil {
			t.Fatal(err)
		}
	}
	scanNow(t, e)
	put(t, dir, "same.md", "# same\n")
	put(t, dir, "new.md", "# moved\n")
	scanNow(t, e)

	if r := rowOf(t, e, same.FileID); r.State != StateSynced {
		t.Fatalf("restored unchanged: %+v", r)
	}
	r := rowOf(t, e, moved.FileID)
	if r.State != StateLocalMoved || r.MovedFrom != "old.md" || r.Path != "new.md" || r.Dirty {
		t.Fatalf("restored after a move not sent yet: %+v, want a clean move from old.md", r)
	}
	syncOK(t, e)
	if mvs := remote.committed(syncproto.OpMove, moved.FileID); len(mvs) != 1 || mvs[0].Path != "new.md" {
		t.Fatalf("move commits %+v", mvs)
	}
}

// Moved and edited on this device while another deleted the file: the move
// cannot be sent (the server refuses to move a deleted file), the edit wins
// and the file comes back on every device at its new path.
func TestMovedAndEditedFileDeletedElsewhereIsRevived(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, map[string]string{"note.md": "# note\n"})

	mustRename(t, adir, "note.md", "renamed.md")
	scanNow(t, a)
	put(t, adir, "renamed.md", "# note\nedited on A\n")
	scanNow(t, a) // A is offline: nothing is sent yet

	if err := os.Remove(filepath.Join(bdir, "note.md")); err != nil {
		t.Fatal(err)
	}
	syncOK(t, b)

	syncOK(t, a)
	allSynced(t, a)
	if got := s.paths(); len(got) != 1 || got[0] != "renamed.md" {
		t.Fatalf("server paths %v, want the file revived as renamed.md", got)
	}
	syncOK(t, b)
	if got := diskFiles(t, bdir); got["renamed.md"] != "# note\nedited on A\n" || len(got) != 1 {
		t.Fatalf("B has %v", got)
	}
	if got := diskFiles(t, adir); got["renamed.md"] != "# note\nedited on A\n" || len(got) != 1 {
		t.Fatalf("A has %v", got)
	}
}

// A remote deletion turns a move still to send (with or without an edit) into
// a revival at the new path: the server refuses to move a deleted file.
func TestRemoteDeleteTurnsPendingMoveIntoRevival(t *testing.T) {
	ctx := context.Background()
	for _, dirty := range []bool{false, true} {
		e, _ := newTestEngine(t, newScriptRemote(), 0)
		r := File{Path: "b.md", FileID: newFileID(), ServerRev: 1, BaseRev: 1, State: StateLocalMoved, MovedFrom: "a.md", Dirty: dirty, Attempts: MaxAttempts, LastError: "parked"}
		if err := e.cfg.DB.PutFile(ctx, r); err != nil {
			t.Fatal(err)
		}
		if _, err := e.applyDelete(ctx, r, true, transport.Change{FileID: r.FileID, Op: "delete", Rev: 2}); err != nil {
			t.Fatal(err)
		}
		got := rowOf(t, e, r.FileID)
		if got.State != StateLocalModify || !got.Tombstoned || got.MovedFrom != "" || got.Dirty || got.ServerRev != 2 || got.Path != "b.md" || got.Attempts != 0 {
			t.Fatalf("dirty=%v: row %+v, want a revival at b.md on rev 2", dirty, got)
		}
	}
}

// The prepare of a move kept for a file the server deleted (a row left by an
// older version) sends the revival instead of a move the server refuses.
func TestTombstonedMoveIsSentAsRevival(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, map[string]string{"note.md": "# note\n"})
	if err := os.Remove(filepath.Join(bdir, "note.md")); err != nil {
		t.Fatal(err)
	}
	syncOK(t, b)

	ctx := context.Background()
	rows, err := a.cfg.DB.Files(ctx)
	if err != nil || len(rows) != 1 {
		t.Fatalf("rows %v, %v", rows, err)
	}
	r := rows[0]
	mustRename(t, adir, "note.md", "renamed.md")
	r.Path, r.MovedFrom, r.State, r.Tombstoned, r.ServerRev = "renamed.md", "note.md", StateLocalMoved, true, s.files[r.FileID].rev
	if err := a.cfg.DB.PutFile(ctx, r); err != nil {
		t.Fatal(err)
	}
	if err := a.cfg.DB.SetCursor(ctx, s.seq(), "", true); err != nil {
		t.Fatal(err)
	}
	mark := s.mark()
	syncOK(t, a)
	if n := countOps(s.sent(mark), syncproto.OpMove); n != 0 {
		t.Fatalf("%d moves sent for a deleted file", n)
	}
	allSynced(t, a)
	if got := s.paths(); len(got) != 1 || got[0] != "renamed.md" {
		t.Fatalf("server paths %v", got)
	}
}

// Another device rewrites the path token of a file (enc1 -> enc2 migration,
// same clear path) while this one has renamed it and not pushed yet: the
// local rename is kept and sent on the new revision.
func TestTokenRewriteKeepsPendingLocalRename(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, _, dir := newPrivateEngine(t, remote)
	f := syncedFile(t, e, remote, dir, "a.md", []byte("# a\n"))

	mustRename(t, dir, "a.md", "b.md")
	remote.mu.Lock()
	remote.cur[f.FileID] = 2
	remote.changes = []transport.Change{{Seq: 1, FileID: f.FileID, Op: "move", Path: "enc:a.md", PrevPath: "enc:a.md", Rev: 2, BlobHash: f.ServerHash}}
	remote.mu.Unlock()

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if exists(dir, "a.md") || readFile(t, dir, "b.md") != "# a\n" {
		t.Fatalf("disk: %v", diskFiles(t, dir))
	}
	mvs := remote.committed(syncproto.OpMove, f.FileID)
	if len(mvs) != 1 || mvs[0].Path != "enc:b.md" || *mvs[0].BaseRev != 2 {
		t.Fatalf("move commits %+v: want the local rename on base 2", mvs)
	}
	if r := rowOf(t, e, f.FileID); r.State != StateSynced || r.Path != "b.md" {
		t.Fatalf("row %+v", r)
	}
}

// editingRemote edits a local file the first time the changelog is read: an
// edit made between the scan and the pull of a round.
type editingRemote struct {
	*scriptRemote
	once stdsync.Once
	edit func()
}

func (r *editingRemote) Changes(ctx context.Context, since int64, sinceID string, limit int) (transport.Changes, error) {
	r.once.Do(r.edit)
	return r.scriptRemote.Changes(ctx, since, sinceID, limit)
}

// A remote deletion of a file edited after the scan: the edit wins, the file
// is kept (not trashed) and revived on the server.
func TestRemoteDeleteKeepsFileEditedAfterScan(t *testing.T) {
	ctx := context.Background()
	sr := newScriptRemote()
	remote := &editingRemote{scriptRemote: sr}
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, sr, dir, "a.md", []byte(baseText))
	remote.edit = func() { writeFile(t, dir, "a.md", []byte(localText)) }
	sr.mu.Lock()
	sr.cur[f.FileID] = 2
	sr.changes = []transport.Change{{Seq: 1, FileID: f.FileID, Op: "delete", Rev: 2}}
	sr.mu.Unlock()

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "a.md"); got != localText {
		t.Fatalf("a.md = %q", got)
	}
	mods := sr.committed(syncproto.OpModify, f.FileID)
	if len(mods) != 1 || mods[0].Path != "a.md" || mods[0].BlobHash != hashOf([]byte(localText)) || *mods[0].BaseRev != 2 {
		t.Fatalf("modify commits %+v: want the revival of the edit", mods)
	}
	if r := rowOf(t, e, f.FileID); r.State != StateSynced || r.Tombstoned {
		t.Fatalf("row %+v", r)
	}
}

// An unreadable server entry is quarantined and counted in the status; a
// newer, readable revision lifts it.
func TestQuarantineLiftedByNewerRevision(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, _, dir := newPrivateEngine(t, remote)
	if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1"); err != nil {
		t.Fatal(err)
	}
	id := newFileID()
	h1 := remote.put(id, 1, []byte("# one"))
	remote.changes = []transport.Change{{Seq: 1, FileID: id, Op: "create", Path: "garbage", Rev: 1, BlobHash: h1}}
	remote.tree = transport.Tree{AsOfSeq: 1, Items: []transport.TreeEntry{{Path: "garbage", FileID: id, Rev: 1, Hash: h1}}}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if q := quarantinedIDs(t, e); !q[id] {
		t.Fatalf("quarantine %v", q)
	}
	if st := e.Status(); st.Quarantined != 1 {
		t.Fatalf("status quarantined = %d, want 1", st.Quarantined)
	}

	h2 := remote.put(id, 2, []byte("# two"))
	remote.mu.Lock()
	remote.changes = append(remote.changes, transport.Change{Seq: 2, FileID: id, Op: "modify", Path: "enc:q.md", Rev: 2, BlobHash: h2})
	remote.mu.Unlock()
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "q.md"); got != "# two" {
		t.Fatalf("q.md = %q", got)
	}
	if q := quarantinedIDs(t, e); len(q) != 0 {
		t.Fatalf("quarantine %v after a readable revision", q)
	}
	if st := e.Status(); st.Quarantined != 0 {
		t.Fatalf("status quarantined = %d, want 0", st.Quarantined)
	}
}

// The quarantine is read again by the next run of the engine (an update of the
// application may read what the old one could not), and the error it left on
// the file is cleared once the entry is applied.
func TestQuarantineRetriedOnNextRun(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, _, dir := newPrivateEngine(t, remote)
	f := syncedFile(t, e, remote, dir, "x.md", []byte("# x"))
	h := remote.put(f.FileID, 2, []byte("# x, edited elsewhere"))
	remote.changes = []transport.Change{{Seq: 1, FileID: f.FileID, Op: "modify", Path: "garbage", Rev: 2, BlobHash: h}}
	remote.tree = transport.Tree{AsOfSeq: 1, Items: []transport.TreeEntry{{Path: "garbage", FileID: f.FileID, Rev: 2, Hash: h}}}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if r := rowOf(t, e, f.FileID); r.LastError != quarantinedError {
		t.Fatalf("row %+v", r)
	}

	// The same entry, now readable (the token as this version reads it).
	remote.mu.Lock()
	remote.tree = transport.Tree{AsOfSeq: 1, Items: []transport.TreeEntry{{Path: "enc:x.md", FileID: f.FileID, Rev: 2, Hash: h}}}
	remote.mu.Unlock()
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if q := quarantinedIDs(t, e); len(q) != 1 {
		t.Fatalf("retried within the same run: %v", q)
	}

	e2 := New(e.cfg) // a restart
	if err := e2.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "x.md"); got != "# x, edited elsewhere" {
		t.Fatalf("x.md = %q", got)
	}
	if q := quarantinedIDs(t, e2); len(q) != 0 {
		t.Fatalf("quarantine %v", q)
	}
	if r := rowOf(t, e2, f.FileID); r.LastError != "" || r.State != StateSynced || r.ServerRev != 2 {
		t.Fatalf("row %+v", r)
	}
	if st := e2.Status(); st.Quarantined != 0 {
		t.Fatalf("status quarantined = %d", st.Quarantined)
	}
}

// A bootstrap reads every entry again: the quarantined ones it can read now
// are lifted, the ones still unreadable stay.
func TestBootstrapLiftsReadableQuarantine(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, _, dir := newPrivateEngine(t, remote)
	if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1"); err != nil {
		t.Fatal(err)
	}
	ok, bad := newFileID(), newFileID()
	hOK, hBad := remote.put(ok, 1, []byte("# ok")), remote.put(bad, 1, []byte("# bad"))
	for _, q := range []struct{ id, hash string }{{ok, hOK}, {bad, hBad}} {
		if err := e.cfg.DB.Quarantine(ctx, q.id, 1, "test", time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.cfg.DB.DeleteMeta(ctx, MetaBootstrapped); err != nil {
		t.Fatal(err)
	}
	remote.tree = transport.Tree{AsOfSeq: 3, Items: []transport.TreeEntry{
		{Path: "enc:ok.md", FileID: ok, Rev: 1, Hash: hOK},
		{Path: "garbage", FileID: bad, Rev: 1, Hash: hBad},
	}}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "ok.md"); got != "# ok" {
		t.Fatalf("ok.md = %q", got)
	}
	if q := quarantinedIDs(t, e); len(q) != 1 || !q[bad] {
		t.Fatalf("quarantine %v, want only the unreadable entry", q)
	}
}

// --- manager ------------------------------------------------------------------

// signedOutManager attaches linked shared vaults to a manager whose session is
// revoked: engines exist, no loop runs.
func signedOutManager(t *testing.T, emit func(string, any), ids ...string) *Manager {
	t.Helper()
	m := NewManager(&switchSession{deviceID: "d", revoked: true}, nil, zerolog.Nop(), emit)
	for _, id := range ids {
		if err := m.Attach(context.Background(), id, linkedVault(t)); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { m.Detach(id) })
	}
	return m
}

// conflictFixture records an open conflict on note.md (synced, holding the
// server version) whose copy holds this device's version.
func conflictFixture(t *testing.T, m *Manager) (eng *Engine, dir string, c Conflict) {
	t.Helper()
	ctx := context.Background()
	eng = engineOfVault(t, m, "v")
	dir = eng.cfg.FS.Root()
	put(t, dir, "note.md", "server version\n")
	put(t, dir, "note (conflict).md", "my version\n")
	h, size, err := eng.cfg.FS.HashFile("note.md")
	if err != nil {
		t.Fatal(err)
	}
	f := File{Path: "note.md", FileID: newFileID(), ServerRev: 2, BaseRev: 2, ServerHash: h, LocalHash: h, LocalSize: size, State: StateSynced}
	if err := eng.cfg.DB.PutFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	c, err = eng.cfg.DB.AddConflict(ctx, Conflict{FileID: f.FileID, Path: "note.md", CopyPath: "note (conflict).md", Strategy: "conflict_copy", RemoteRev: 2, CreatedAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	return eng, dir, c
}

func openConflicts(t *testing.T, eng *Engine) int {
	t.Helper()
	n, err := eng.cfg.DB.OpenConflictCount(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// keep-local and merged never replace content the user was not shown.
func TestResolveConflictRefusesFileChangedSinceShown(t *testing.T) {
	ctx := context.Background()
	m := signedOutManager(t, nil, "v")
	eng, dir, c := conflictFixture(t, m)
	v, err := m.ConflictTexts(ctx, "v", c.ID)
	if err != nil || v.Current != "server version\n" || v.Ours != "my version\n" || v.CurrentHash == "" {
		t.Fatalf("texts %+v, %v", v, err)
	}
	put(t, dir, "note.md", "typed after the view\n")

	for _, action := range []ConflictAction{KeepLocal, UseMerged} {
		if err := m.ResolveConflict(ctx, "v", c.ID, action, "merged text\n", ""); !errors.Is(err, ErrConflictChanged) {
			t.Fatalf("%s: err = %v, want ErrConflictChanged", action, err)
		}
	}
	if got := readFile(t, dir, "note.md"); got != "typed after the view\n" {
		t.Fatalf("note.md = %q", got)
	}
	if !exists(dir, "note (conflict).md") || openConflicts(t, eng) != 1 {
		t.Fatal("the refused resolution removed the copy or closed the conflict")
	}

	// Shown again: the new content may now be replaced.
	if _, err := m.ConflictTexts(ctx, "v", c.ID); err != nil {
		t.Fatal(err)
	}
	var snapshots []string
	eng.cfg.BeforeOverwrite = func(p string) { snapshots = append(snapshots, p) }
	if err := m.ResolveConflict(ctx, "v", c.ID, UseMerged, "merged text\n", ""); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "note.md"); got != "merged text\n" || exists(dir, "note (conflict).md") || openConflicts(t, eng) != 0 {
		t.Fatalf("after the resolution: note.md = %q", got)
	}
	if len(snapshots) != 1 || snapshots[0] != "note.md" {
		t.Fatalf("snapshots %v: the replaced content must be kept in the history", snapshots)
	}
}

// An explicit expected hash wins over the remembered view.
func TestResolveConflictExplicitExpectedHash(t *testing.T) {
	ctx := context.Background()
	m := signedOutManager(t, nil, "v")
	_, dir, c := conflictFixture(t, m)
	if err := m.ResolveConflict(ctx, "v", c.ID, KeepLocal, "", hashOf([]byte("something else\n"))); !errors.Is(err, ErrConflictChanged) {
		t.Fatalf("err = %v", err)
	}
	if err := m.ResolveConflict(ctx, "v", c.ID, KeepLocal, "", hashOf([]byte("server version\n"))); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "note.md"); got != "my version\n" {
		t.Fatalf("note.md = %q", got)
	}
}

// The file is followed through a rename: the old path is never re-created.
func TestResolveConflictFollowsRename(t *testing.T) {
	ctx := context.Background()
	m := signedOutManager(t, nil, "v")
	eng, dir, c := conflictFixture(t, m)
	mustRename(t, dir, "note.md", "moved/note.md")
	if err := eng.Renamed(ctx, "note.md", "moved/note.md"); err != nil {
		t.Fatal(err)
	}
	v, err := m.ConflictTexts(ctx, "v", c.ID)
	if err != nil || v.Current != "server version\n" {
		t.Fatalf("texts %+v, %v", v, err)
	}
	if err := m.ResolveConflict(ctx, "v", c.ID, KeepLocal, "", ""); err != nil {
		t.Fatal(err)
	}
	if exists(dir, "note.md") {
		t.Fatal("keep-local re-created the file at its old path")
	}
	if got := readFile(t, dir, "moved/note.md"); got != "my version\n" {
		t.Fatalf("moved/note.md = %q", got)
	}
}

// A deleted file is not brought back by a resolution.
func TestResolveConflictRefusesDeletedFile(t *testing.T) {
	ctx := context.Background()
	m := signedOutManager(t, nil, "v")
	eng, dir, c := conflictFixture(t, m)
	if _, err := m.ConflictTexts(ctx, "v", c.ID); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, "note.md")); err != nil {
		t.Fatal(err)
	}
	scanNow(t, eng)
	if err := m.ResolveConflict(ctx, "v", c.ID, KeepLocal, "", ""); !errors.Is(err, ErrConflictChanged) {
		t.Fatalf("err = %v", err)
	}
	if exists(dir, "note.md") {
		t.Fatal("the deleted file was re-created")
	}
	put(t, dir, "note.md", "another file at the old path\n")
	if _, err := m.ConflictTexts(ctx, "v", c.ID); err == nil {
		t.Fatal("the view showed another file as the conflict's current version")
	}
	// keep-remote and keep-both need no file.
	if err := m.ResolveConflict(ctx, "v", c.ID, KeepBoth, "", ""); err != nil {
		t.Fatal(err)
	}
}

// Without a view, only content the server has may be replaced.
func TestResolveConflictWithoutViewProtectsLocalEdits(t *testing.T) {
	ctx := context.Background()
	m := signedOutManager(t, nil, "v")
	eng, dir, c := conflictFixture(t, m)
	put(t, dir, "note.md", "an edit not sent yet\n")
	if err := m.ResolveConflict(ctx, "v", c.ID, KeepLocal, "", ""); !errors.Is(err, ErrConflictChanged) {
		t.Fatalf("unscanned edit: err = %v", err)
	}
	scanNow(t, eng)
	if err := m.ResolveConflict(ctx, "v", c.ID, KeepLocal, "", ""); !errors.Is(err, ErrConflictChanged) {
		t.Fatalf("scanned edit: err = %v", err)
	}
	if got := readFile(t, dir, "note.md"); got != "an edit not sent yet\n" {
		t.Fatalf("note.md = %q", got)
	}

	put(t, dir, "note.md", "server version\n")
	scanNow(t, eng)
	if err := m.ResolveConflict(ctx, "v", c.ID, KeepLocal, "", ""); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "note.md"); got != "my version\n" {
		t.Fatalf("note.md = %q", got)
	}
}

// Kick reads the engine under the manager's lock (no race with Unlink).
func TestKickConcurrentWithUnlink(t *testing.T) {
	m := signedOutManager(t, nil, "v")
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			select {
			case <-stop:
				return
			default:
				m.Kick("v")
				runtime.Gosched() // the js/wasm runtime has one thread: let Unlink run
			}
		}
	}()
	time.Sleep(5 * time.Millisecond)
	if err := m.Unlink(context.Background(), "v"); err != nil {
		t.Fatal(err)
	}
	close(stop)
	<-done
}

// A vault unlinked while SessionChanged reports a revoked device is skipped,
// never dereferenced.
func TestSessionChangedSkipsVaultUnlinkedMeanwhile(t *testing.T) {
	var m *Manager
	var armed atomic.Bool
	emit := func(name string, payload any) {
		st, ok := payload.(Status)
		if name != EventStatus.Name() || !ok || !armed.CompareAndSwap(true, false) {
			return
		}
		other := "a"
		if st.VaultID == "a" {
			other = "b"
		}
		if err := m.Unlink(context.Background(), other); err != nil {
			t.Error(err)
		}
	}
	m = signedOutManager(t, emit, "a", "b")
	armed.Store(true)
	m.SessionChanged() // must not panic on the vault unlinked by the first status
	if armed.Load() {
		t.Fatal("no status was emitted")
	}
}

// Unlink waits for a cycle running outside the loop (the drain before a lock)
// before erasing the state, and the engine it held never runs again.
func TestUnlinkWaitsForCycleOutsideTheLoop(t *testing.T) {
	ctx := context.Background()
	m := signedOutManager(t, nil, "v")
	eng := engineOfVault(t, m, "v")
	mv, err := m.get("v")
	if err != nil {
		t.Fatal(err)
	}

	started, release := make(chan struct{}), make(chan struct{})
	cycle := make(chan error, 1)
	go func() {
		cycle <- eng.Exclusive(func() error { // stands for a drain's Sync
			close(started)
			<-release
			return eng.cfg.DB.PutFile(ctx, File{Path: "late.md", FileID: newFileID(), ServerRev: 7, State: StateSynced})
		})
	}()
	<-started
	unlinked := make(chan error, 1)
	go func() { unlinked <- m.Unlink(ctx, "v") }()
	select {
	case err := <-unlinked:
		t.Fatalf("Unlink returned (%v) while a cycle still held the engine", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-cycle; err != nil {
		t.Fatal(err)
	}
	if err := <-unlinked; err != nil {
		t.Fatal(err)
	}
	if rows, _ := mv.db.Files(ctx); len(rows) != 0 {
		t.Fatalf("rows left after Unlink: %+v", rows)
	}

	if err := eng.Sync(ctx); !errors.Is(err, ErrUnlinked) {
		t.Fatalf("a cycle of the unlinked engine: %v", err)
	}
	if v, _ := mv.db.Meta(ctx, MetaLastScan); v != "" {
		t.Fatal("the unlinked engine scanned the folder")
	}
	if rows, _ := mv.db.Files(ctx); len(rows) != 0 {
		t.Fatalf("the unlinked engine wrote %+v", rows)
	}
}
