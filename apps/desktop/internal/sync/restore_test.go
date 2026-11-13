package sync

// Unit tests of the bootstrap after a 410 CURSOR_EXPIRED (ADR-0046): a server
// that went back in time (last_seq, restored backup) gets back what it lost
// from this device, a compacted changelog (compaction_seq) keeps the tree as
// the truth, and no bootstrap overwrites local content without a snapshot.

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/syncproto"
)

// expiringRemote answers the next GET /changes with a 410 CURSOR_EXPIRED
// carrying expired as its extension members (decoded from JSON: numbers are
// float64), then behaves like the scripted server.
type expiringRemote struct {
	*scriptRemote
	expired map[string]any
}

func (r *expiringRemote) Changes(ctx context.Context, since int64, sinceID string, limit int) (transport.Changes, error) {
	r.mu.Lock()
	extra := r.expired
	r.expired = nil
	r.mu.Unlock()
	if extra != nil {
		return transport.Changes{}, &transport.ProblemError{StatusCode: http.StatusGone, Problem: syncproto.Problem{
			Status: http.StatusGone, Code: syncproto.CodeCursorExpired, Extra: extra,
		}}
	}
	return r.scriptRemote.Changes(ctx, since, sinceID, limit)
}

// restoreFixture is an engine whose cursor is at 20 while the server, restored
// from a backup (behind) or compacted, bootstraps from a tree as of seq 10.
func restoreFixture(t *testing.T, extra map[string]any) (*Engine, *expiringRemote, string, *[]string) {
	t.Helper()
	remote := &expiringRemote{scriptRemote: newScriptRemote(), expired: extra}
	e, dir := newTestEngine(t, remote, 0)
	if err := e.cfg.DB.SetCursor(context.Background(), 20, "", false); err != nil {
		t.Fatal(err)
	}
	var snapshots []string
	e.cfg.BeforeOverwrite = func(p string) {
		snapshots = append(snapshots, p+"="+readFile(t, dir, p))
	}
	return e, remote, dir, &snapshots
}

// localAt is a file this device holds, synced at revision rev with content.
func localAt(t *testing.T, e *Engine, remote *scriptRemote, dir, path string, rev int, content []byte) File {
	t.Helper()
	f := syncedFile(t, e, remote, dir, path, content)
	f.ServerRev, f.BaseRev = rev, rev
	if err := e.cfg.DB.PutFile(context.Background(), f); err != nil {
		t.Fatal(err)
	}
	return f
}

// restoredTo sets what the restored server holds of a file: revision rev with
// content at path (nil content: the server does not have the file at all).
func restoredTo(remote *scriptRemote, f File, path string, rev int, content []byte) transport.TreeEntry {
	if content == nil {
		remote.mu.Lock()
		delete(remote.cur, f.FileID)
		delete(remote.curHash, f.FileID)
		remote.mu.Unlock()
		return transport.TreeEntry{}
	}
	h := remote.put(f.FileID, rev, content)
	return transport.TreeEntry{Path: path, FileID: f.FileID, Rev: rev, Hash: h, Size: int64(len(content))}
}

func fileRow(t *testing.T, e *Engine, fileID string) (File, bool) {
	t.Helper()
	r, ok, err := e.cfg.DB.GetFileByID(context.Background(), fileID)
	if err != nil {
		t.Fatal(err)
	}
	return r, ok
}

var behind = map[string]any{"last_seq": float64(10)}

// The server went back from revision 5 to 3: the device's newer content is
// republished on top of revision 3, never replaced by it, and a change parked
// from the lost timeline is forgotten rather than merged.
func TestServerBehindRepublishesNewerRevision(t *testing.T) {
	ctx := context.Background()
	e, remote, dir, snaps := restoreFixture(t, behind)
	a := localAt(t, e, remote.scriptRemote, dir, "a.md", 5, []byte("# a at revision 5"))
	b := localAt(t, e, remote.scriptRemote, dir, "b.md", 3, []byte("# b as this device has it"))
	c := localAt(t, e, remote.scriptRemote, dir, "moved/c.md", 5, []byte("# c"))
	remote.tree = transport.Tree{AsOfSeq: 10, Items: []transport.TreeEntry{
		restoredTo(remote.scriptRemote, a, "a.md", 3, []byte("# a at revision 3")),
		restoredTo(remote.scriptRemote, b, "b.md", 3, []byte("# b, other content at the same revision")),
		restoredTo(remote.scriptRemote, c, "c.md", 3, []byte("# c")), // revisions 4 and 5 moved it
	}}
	lost := remote.put("lost-blob", 1, []byte("# a at revision 6, from another device"))
	if err := e.cfg.DB.PutPending(ctx, transportChange{Seq: 18, FileID: a.FileID, Op: "modify", Path: "a.md", Rev: 6, BlobHash: lost}, e.cfg.Now()); err != nil {
		t.Fatal(err)
	}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "a.md"); got != "# a at revision 5" {
		t.Fatalf("a.md = %q, the restored revision replaced the newer one", got)
	}
	if got := readFile(t, dir, "b.md"); got != "# b as this device has it" {
		t.Fatalf("b.md = %q", got)
	}
	if got := readFile(t, dir, "moved/c.md"); got != "# c" {
		t.Fatalf("moved/c.md = %q", got)
	}
	if len(*snaps) != 0 {
		t.Fatalf("snapshots taken although nothing was overwritten: %v", *snaps)
	}
	for _, tc := range []struct {
		f       File
		content string
	}{{a, "# a at revision 5"}, {b, "# b as this device has it"}} {
		mods := remote.committed(syncproto.OpModify, tc.f.FileID)
		if len(mods) != 1 || mods[0].BaseRev == nil || *mods[0].BaseRev != 3 || mods[0].BlobHash != hashOf([]byte(tc.content)) {
			t.Fatalf("%s: modifies %+v, want one on base revision 3", tc.f.Path, mods)
		}
		if r, _ := fileRow(t, e, tc.f.FileID); r.State != StateSynced || r.ServerRev != 4 || r.BaseRev != 4 {
			t.Fatalf("%s: row %+v", tc.f.Path, r)
		}
	}
	moves := remote.committed(syncproto.OpMove, c.FileID)
	if len(moves) != 1 || moves[0].Path != "moved/c.md" || *moves[0].BaseRev != 3 {
		t.Fatalf("c.md: moves %+v, want one to moved/c.md on base revision 3", moves)
	}
	if mods := remote.committed(syncproto.OpModify, c.FileID); len(mods) != 0 {
		t.Fatalf("c.md: content sent again although unchanged: %+v", mods)
	}
	if r, _ := fileRow(t, e, c.FileID); r.State != StateSynced || r.Path != "moved/c.md" || r.ServerRev != 4 {
		t.Fatalf("c.md: row %+v", r)
	}
	if p := pendingIDs(t, e); len(p) != 0 {
		t.Fatalf("candidates of the lost timeline kept: %v", p)
	}
	if got := cursor(t, e); got != 10 {
		t.Fatalf("cursor = %d, want the tree's 10", got)
	}
}

// A device that already has what the server republished (the same blob, at
// the restored revision) only takes the revision: nothing is sent.
func TestServerBehindAdoptsIdenticalRepublish(t *testing.T) {
	ctx := context.Background()
	e, remote, dir, _ := restoreFixture(t, behind)
	content := []byte("# same everywhere")
	a := localAt(t, e, remote.scriptRemote, dir, "a.md", 5, content)
	remote.tree = transport.Tree{AsOfSeq: 10, Items: []transport.TreeEntry{restoredTo(remote.scriptRemote, a, "a.md", 4, content)}}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if n := len(remote.committed(syncproto.OpModify, "")); n != 0 {
		t.Fatalf("%d modifies sent for content the server already has", n)
	}
	if r, _ := fileRow(t, e, a.FileID); r.State != StateSynced || r.ServerRev != 4 || r.BaseRev != 4 {
		t.Fatalf("row %+v", r)
	}
}

// Files created after the restore point are not listed by the server: they
// are uploaded again (same id) instead of being trashed, and a file deleted
// here meanwhile is simply forgotten, without a delete sent.
func TestServerBehindReuploadsFilesItLost(t *testing.T) {
	ctx := context.Background()
	e, remote, dir, _ := restoreFixture(t, behind)
	n := localAt(t, e, remote.scriptRemote, dir, "notes/new.md", 2, []byte("# created after the restore point"))
	gone := localAt(t, e, remote.scriptRemote, dir, "gone.md", 1, []byte("# deleted here"))
	restoredTo(remote.scriptRemote, n, "", 0, nil)
	restoredTo(remote.scriptRemote, gone, "", 0, nil)
	if err := os.Remove(filepath.Join(dir, "gone.md")); err != nil {
		t.Fatal(err)
	}
	if err := e.cfg.DB.PutOutbox(ctx, OutboxEntry{Path: n.Path, OpID: "op-of-the-lost-timeline", Kind: "create", LocalHash: n.LocalHash, BlobHash: n.LocalHash}, e.cfg.Now()); err != nil {
		t.Fatal(err)
	}
	remote.tree = transport.Tree{AsOfSeq: 10}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "notes/new.md"); got != "# created after the restore point" {
		t.Fatalf("notes/new.md = %q", got)
	}
	creates := remote.committed(syncproto.OpCreate, n.FileID)
	if len(creates) != 1 || creates[0].Path != "notes/new.md" || creates[0].OpID == "op-of-the-lost-timeline" {
		t.Fatalf("creates %+v, want one with a new operation id", creates)
	}
	if r, _ := fileRow(t, e, n.FileID); r.State != StateSynced || r.ServerRev != 1 {
		t.Fatalf("notes/new.md: row %+v", r)
	}
	if _, ok := fileRow(t, e, gone.FileID); ok {
		t.Fatal("the row of a file deleted here and unknown to the server was kept")
	}
	if dels := remote.committed(syncproto.OpDelete, ""); len(dels) != 0 {
		t.Fatalf("deletes sent: %+v", dels)
	}
}

// Where the restored server is still ahead of this device, its revision is
// applied as in any bootstrap, after a snapshot of the local content.
func TestServerBehindStillAppliesNewerServerRevision(t *testing.T) {
	ctx := context.Background()
	e, remote, dir, snaps := restoreFixture(t, behind)
	a := localAt(t, e, remote.scriptRemote, dir, "a.md", 2, []byte("# a at revision 2"))
	remote.tree = transport.Tree{AsOfSeq: 10, Items: []transport.TreeEntry{
		restoredTo(remote.scriptRemote, a, "a.md", 4, []byte("# a at revision 4")),
	}}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "a.md"); got != "# a at revision 4" {
		t.Fatalf("a.md = %q", got)
	}
	if len(*snaps) != 1 || (*snaps)[0] != "a.md=# a at revision 2" {
		t.Fatalf("snapshots %v, want the local revision 2 kept", *snaps)
	}
	if n := len(remote.commits); n != 0 {
		t.Fatalf("%d operations sent", n)
	}
	if r, _ := fileRow(t, e, a.FileID); r.State != StateSynced || r.ServerRev != 4 {
		t.Fatalf("row %+v", r)
	}
}

// A cursor older than the changelog window keeps the tree authoritative:
// files it does not list are trashed, other content replaces the local one,
// which is snapshotted first.
func TestCompactedCursorKeepsTreeAuthoritative(t *testing.T) {
	ctx := context.Background()
	e, remote, dir, snaps := restoreFixture(t, map[string]any{"compaction_seq": float64(15)})
	a := localAt(t, e, remote.scriptRemote, dir, "a.md", 5, []byte("# a here"))
	del := localAt(t, e, remote.scriptRemote, dir, "deleted.md", 2, []byte("# deleted on the server"))
	restoredTo(remote.scriptRemote, del, "", 0, nil)
	remote.tree = transport.Tree{AsOfSeq: 30, Items: []transport.TreeEntry{
		restoredTo(remote.scriptRemote, a, "a.md", 7, []byte("# a on the server")),
	}}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "a.md"); got != "# a on the server" {
		t.Fatalf("a.md = %q", got)
	}
	if len(*snaps) != 1 || (*snaps)[0] != "a.md=# a here" {
		t.Fatalf("snapshots %v, want the local a.md kept", *snaps)
	}
	if _, err := os.Stat(filepath.Join(dir, "deleted.md")); !os.IsNotExist(err) {
		t.Fatalf("deleted.md still in place: %v", err)
	}
	if _, ok := fileRow(t, e, del.FileID); ok {
		t.Fatal("the row of a file deleted on the server was kept")
	}
	if n := len(remote.commits); n != 0 {
		t.Fatalf("%d operations sent: %+v", n, remote.commits)
	}
	if got := cursor(t, e); got != 30 {
		t.Fatalf("cursor = %d, want 30", got)
	}
}

// Rows with work of their own keep it on top of the restored revision: a local
// edit is sent on that base, a local deletion is sent as such (the file is not
// brought back), a file parked in conflict on the lost timeline is retried,
// and an edit that overrode a deletion is sent as a plain modify.
func TestServerBehindRebasesLocalChanges(t *testing.T) {
	ctx := context.Background()
	e, remote, dir, snaps := restoreFixture(t, behind)
	edited := localAt(t, e, remote.scriptRemote, dir, "edited.md", 5, []byte("# edited at revision 5"))
	deleted := localAt(t, e, remote.scriptRemote, dir, "deleted.md", 5, []byte("# deleted here"))
	conflicted := localAt(t, e, remote.scriptRemote, dir, "conflicted.md", 5, []byte("# parked in conflict"))
	tomb := localAt(t, e, remote.scriptRemote, dir, "tomb.md", 5, []byte("# kept over a deletion"))
	remote.tree = transport.Tree{AsOfSeq: 10, Items: []transport.TreeEntry{
		restoredTo(remote.scriptRemote, edited, "edited.md", 3, []byte("# edited at revision 3")),
		restoredTo(remote.scriptRemote, deleted, "deleted.md", 3, []byte("# deleted at revision 3")),
		restoredTo(remote.scriptRemote, conflicted, "conflicted.md", 3, []byte("# conflicted at revision 3")),
		restoredTo(remote.scriptRemote, tomb, "tomb.md", 3, []byte("# tomb at revision 3")),
	}}
	writeFile(t, dir, "edited.md", []byte("# edited at revision 5, then here"))
	if err := os.Remove(filepath.Join(dir, "deleted.md")); err != nil {
		t.Fatal(err)
	}
	conflicted.State, conflicted.Attempts, conflicted.LastError = StateConflict, MaxAttempts, "too many concurrent edits: resolve manually"
	tomb.State, tomb.ServerRev, tomb.Tombstoned = StateLocalModify, 6, true
	for _, f := range []File{conflicted, tomb} {
		if err := e.cfg.DB.PutFile(ctx, f); err != nil {
			t.Fatal(err)
		}
	}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if len(*snaps) != 0 {
		t.Fatalf("snapshots taken although nothing was overwritten: %v", *snaps)
	}
	for _, tc := range []struct {
		f       File
		content string
	}{
		{edited, "# edited at revision 5, then here"},
		{conflicted, "# parked in conflict"},
		{tomb, "# kept over a deletion"},
	} {
		if got := readFile(t, dir, tc.f.Path); got != tc.content {
			t.Fatalf("%s = %q", tc.f.Path, got)
		}
		mods := remote.committed(syncproto.OpModify, tc.f.FileID)
		if len(mods) != 1 || *mods[0].BaseRev != 3 || mods[0].BlobHash != hashOf([]byte(tc.content)) || mods[0].Path != "" {
			t.Fatalf("%s: modifies %+v, want one on base revision 3", tc.f.Path, mods)
		}
		if r, _ := fileRow(t, e, tc.f.FileID); r.State != StateSynced || r.ServerRev != 4 || r.Tombstoned {
			t.Fatalf("%s: row %+v", tc.f.Path, r)
		}
	}
	dels := remote.committed(syncproto.OpDelete, deleted.FileID)
	if len(dels) != 1 || *dels[0].BaseRev != 3 {
		t.Fatalf("deleted.md: deletes %+v, want one on base revision 3", dels)
	}
	if _, err := os.Stat(filepath.Join(dir, "deleted.md")); !os.IsNotExist(err) {
		t.Fatalf("deleted.md brought back: %v", err)
	}
	if _, ok := fileRow(t, e, deleted.FileID); ok {
		t.Fatal("the row of the deleted file was kept")
	}
}

// A move still to send from where the restored server has the file is kept,
// also when the reconcile runs again (an interrupted bootstrap is retried):
// the server's older path never wins over it.
func TestServerBehindKeepsPendingMoveOnRetry(t *testing.T) {
	ctx := context.Background()
	e, remote, dir, _ := restoreFixture(t, behind)
	c := localAt(t, e, remote.scriptRemote, dir, "moved/c.md", 5, []byte("# c"))
	remote.tree = transport.Tree{AsOfSeq: 10, Items: []transport.TreeEntry{
		restoredTo(remote.scriptRemote, c, "c.md", 3, []byte("# c")),
	}}
	for range 2 {
		if err := e.bootstrap(ctx, bootstrapReconcileUpload); err != nil {
			t.Fatal(err)
		}
	}
	if r, _ := fileRow(t, e, c.FileID); r.State != StateLocalMoved || r.Path != "moved/c.md" || r.MovedFrom != "c.md" || r.ServerRev != 3 {
		t.Fatalf("row %+v, want a move from c.md on revision 3", r)
	}
	if got := readFile(t, dir, "moved/c.md"); got != "# c" {
		t.Fatalf("moved/c.md = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "c.md")); !os.IsNotExist(err) {
		t.Fatalf("the file went back to the server's older path: %v", err)
	}
}

// A reconcile interrupted half-way is resumed as a reconcile, also when the
// server no longer answers 410 (other devices republished past this device's
// cursor): the rows it did not reach yet still have revisions the server
// lost, and files it no longer lists, which a plain pull would never settle.
func TestServerBehindResumesInterruptedReconcile(t *testing.T) {
	ctx := context.Background()
	e, remote, dir, _ := restoreFixture(t, behind)
	a := localAt(t, e, remote.scriptRemote, dir, "a.md", 5, []byte("# a at revision 5"))
	b := localAt(t, e, remote.scriptRemote, dir, "b.md", 2, []byte("# b at revision 2"))
	z := localAt(t, e, remote.scriptRemote, dir, "z.md", 2, []byte("# z created after the restore point"))
	restoredTo(remote.scriptRemote, z, "", 0, nil)
	newer := restoredTo(remote.scriptRemote, b, "b.md", 4, []byte("# b at revision 4"))
	remote.tree = transport.Tree{AsOfSeq: 10, Items: []transport.TreeEntry{
		restoredTo(remote.scriptRemote, a, "a.md", 3, []byte("# a at revision 3")),
		newer,
	}}
	remote.mu.Lock()
	remote.failBlob[newer.Hash] = errors.New("storage backend unavailable")
	remote.mu.Unlock()

	if err := e.Sync(ctx); err == nil {
		t.Fatal("the bootstrap did not fail on the unavailable blob")
	}
	if got, _ := e.cfg.DB.Meta(ctx, MetaBootstrapped); got != bootstrapReconcilePending {
		t.Fatalf("bootstrapped = %q after an interrupted reconcile", got)
	}
	remote.mu.Lock()
	delete(remote.failBlob, newer.Hash)
	remote.mu.Unlock()
	// remote.expired is spent: GET /changes answers normally from now on.
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "b.md"); got != "# b at revision 4" {
		t.Fatalf("b.md = %q", got)
	}
	if creates := remote.committed(syncproto.OpCreate, z.FileID); len(creates) != 1 {
		t.Fatalf("z.md: creates %+v, want it uploaded again", creates)
	}
	if mods := remote.committed(syncproto.OpModify, a.FileID); len(mods) != 1 || *mods[0].BaseRev != 3 {
		t.Fatalf("a.md: modifies %+v, want one on base revision 3", mods)
	}
	if got, _ := e.cfg.DB.Meta(ctx, MetaBootstrapped); got != "1" {
		t.Fatalf("bootstrapped = %q after the reconcile completed", got)
	}
}
