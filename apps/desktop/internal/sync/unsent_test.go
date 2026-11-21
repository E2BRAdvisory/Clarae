package sync

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"clarae/shared/syncproto"
)

// ADR-0066: a synchronized file whose path became excluded (the .git of a vault synchronized by an
// older version) is forgotten, never sent as a deletion; the server copy stays and a later server
// change to it is not written here.
func TestScanForgetsRowsThatBecameExcluded(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	head := syncedFile(t, e, remote, dir, ".git/HEAD", []byte("ref: refs/heads/main\n"))
	syncedFile(t, e, remote, dir, "Repo/.hg/store/data", []byte("hg"))
	note := syncedFile(t, e, remote, dir, "notes/a.md", []byte("# a\n"))
	if err := e.cfg.DB.PutOutbox(ctx, OutboxEntry{Path: ".git/HEAD", OpID: newFileID(), Kind: string(syncproto.OpModify)}, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := e.cfg.DB.PutPending(ctx, transportChange{FileID: head.FileID, Rev: 2, Op: "modify", Path: head.Path}, time.Now()); err != nil {
		t.Fatal(err)
	}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if len(remote.commits) != 0 {
		t.Fatalf("committed %+v: an excluded file must never be sent, a deletion least of all", remote.commits)
	}
	rows, err := e.cfg.DB.Files(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].FileID != note.FileID || rows[0].State != StateSynced {
		t.Fatalf("rows %+v: want only notes/a.md, synced", rows)
	}
	if n, _ := e.cfg.DB.OutboxCount(ctx); n != 0 {
		t.Fatalf("outbox has %d entries", n)
	}
	if p, _ := e.cfg.DB.Pending(ctx); len(p) != 0 {
		t.Fatalf("pending %v", p)
	}
	if got := readFile(t, dir, ".git/HEAD"); got != "ref: refs/heads/main\n" {
		t.Fatalf(".git/HEAD changed on disk: %q", got)
	}
	// Another device (of an older version) still changes it: not written here.
	remoteEdit(remote, 1, head, 3, []byte("ref: refs/heads/other\n"))
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, ".git/HEAD"); got != "ref: refs/heads/main\n" || len(remote.commits) != 0 {
		t.Fatalf(".git/HEAD = %q, commits %+v", got, remote.commits)
	}
}

// A synchronized file the user moves to an excluded name leaves its server path: that is still a
// deletion of the server file, as before ADR-0066 (only a server path that became excluded is
// forgotten).
func TestMoveToExcludedPathStillDeletes(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "notes/a.md", []byte("# a\n"))
	if err := os.Rename(filepath.Join(dir, "notes", "a.md"), filepath.Join(dir, "notes", "a.tmp")); err != nil {
		t.Fatal(err)
	}
	if err := e.Renamed(ctx, "notes/a.md", "notes/a.tmp"); err != nil {
		t.Fatal(err)
	}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	deleted := false
	for _, op := range remote.commits {
		if op.Op == syncproto.OpDelete && op.FileID == f.FileID {
			deleted = true
		}
	}
	if !deleted {
		t.Fatalf("commits %+v: the server copy of notes/a.md must be deleted", remote.commits)
	}
}

// rejectingRemote refuses the commits of one path with PATH_INVALID.
type rejectingRemote struct {
	memRemote
	path string
}

func (r *rejectingRemote) Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	resp := syncproto.CommitResponse{}
	for i, op := range req.Ops {
		if op.Path == r.path {
			resp.Results = append(resp.Results, syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusRejected, Code: syncproto.CodePathInvalid, Detail: "refused by the test"})
			continue
		}
		r.committed = append(r.committed, op.Path)
		resp.Results = append(resp.Results, syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusAccepted, FileID: op.FileID, Rev: 1, Seq: int64(i + 1)})
	}
	return resp, nil
}

func unsentByPath(t *testing.T, e *Engine) map[string]UnsentItem {
	t.Helper()
	items, err := e.Unsent(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]UnsentItem{}
	for _, it := range items {
		if _, dup := out[it.Path]; dup {
			t.Errorf("%s listed twice", it.Path)
		}
		out[it.Path] = it
	}
	return out
}

// The list of the files not sent (ADR-0066): parked and rejected files with their code, invalid names,
// symlinks, and the version control folder and the trash as informative entries; OS junk is not
// listed. Status.Unsent counts what calls for the user, and RetryUnsent sends a parked file again.
func TestUnsentListsWhatIsNotSent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("':' and symlinks cannot be created by an ordinary Windows user")
	}
	ctx := context.Background()
	remote := &rejectingRemote{path: "bad.md"}
	e, dir := newTestEngine(t, remote, 1024)
	writeFile(t, dir, "big.bin", bytes.Repeat([]byte{1}, 2048))
	writeFile(t, dir, "note.md", []byte("# ok"))
	writeFile(t, dir, "bad.md", []byte("# refused"))
	writeFile(t, dir, "Meeting 10:30.md", []byte("x"))
	writeFile(t, dir, ".DS_Store", []byte("x"))
	for _, d := range []string{".git", ".trash"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeFile(t, dir, ".git/HEAD", []byte("ref"))
	writeFile(t, dir, ".trash/old.md", []byte("old"))
	if err := os.Symlink(filepath.Join(dir, "note.md"), filepath.Join(dir, "link.md")); err != nil {
		t.Fatal(err)
	}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	got := unsentByPath(t, e)
	want := map[string]UnsentItem{
		"big.bin":          {Path: "big.bin", Reason: UnsentTooLarge, Code: string(syncproto.CodeFileTooLarge), Detail: "file of 2048 bytes exceeds the limit of 1024", Retryable: true},
		"bad.md":           {Path: "bad.md", Reason: UnsentRejected, Code: string(syncproto.CodePathInvalid), Detail: "refused by the test", Retryable: true},
		"Meeting 10:30.md": {Path: "Meeting 10:30.md", Reason: UnsentInvalidName, Detail: "forbidden character in Meeting 10:30.md"},
		"link.md":          {Path: "link.md", Reason: UnsentSymlink},
		".git":             {Path: ".git", IsDir: true, Reason: UnsentVCS, Info: true},
		".trash":           {Path: ".trash", IsDir: true, Reason: UnsentTrash, Info: true},
	}
	if len(got) != len(want) {
		t.Fatalf("unsent %+v", got)
	}
	for p, w := range want {
		if got[p] != w {
			t.Errorf("%s: got %+v want %+v", p, got[p], w)
		}
	}
	if n := e.Status().Unsent; n != 4 {
		t.Fatalf("Status.Unsent = %d, want 4", n)
	}
	items, _ := e.Unsent(ctx)
	if items[len(items)-1].Info != true || items[0].Info {
		t.Fatalf("informative entries must come last: %+v", items)
	}

	// The limit goes up: Retry sends the big file; the refused one is refused again.
	e.cfg.MaxFileBytes = func() int64 { return 0 }
	if n, err := e.RetryUnsent(ctx, []string{"big.bin"}); err != nil || n != 1 {
		t.Fatalf("retry: %d %v", n, err)
	}
	if r := parked(t, e, "bad.md"); r.Attempts < MaxAttempts {
		t.Fatalf("bad.md was retried too: %+v", r)
	}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	got = unsentByPath(t, e)
	if _, ok := got["big.bin"]; ok {
		t.Fatalf("big.bin still unsent: %+v", got["big.bin"])
	}
	if got["bad.md"].Reason != UnsentRejected {
		t.Fatalf("bad.md: %+v", got["bad.md"])
	}
	if n, err := e.RetryUnsent(ctx, nil); err != nil || n != 1 {
		t.Fatalf("retry all: %d %v", n, err)
	}
}

// A file held back by a server change to merge first is listed while it waits, not counted; a file in
// conflict for too many concurrent edits is listed and left to the conflict view.
func TestUnsentAwaitingMergeAndConflict(t *testing.T) {
	ctx := context.Background()
	e, _ := newTestEngine(t, &memRemote{}, 0)
	waiting := File{Path: "w.md", FileID: newFileID(), ServerRev: 1, BaseRev: 1, State: StateLocalModify}
	stuck := File{Path: "c.md", FileID: newFileID(), ServerRev: 1, BaseRev: 1, State: StateConflict, Attempts: MaxAttempts, LastError: "too many concurrent edits: resolve manually"}
	quarantined := File{Path: "q.md", FileID: newFileID(), ServerRev: 1, BaseRev: 1, State: StateSynced, LastError: quarantinedError}
	for _, r := range []File{waiting, stuck, quarantined} {
		if err := e.cfg.DB.PutFile(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.cfg.DB.PutPending(ctx, transportChange{FileID: waiting.FileID, Rev: 2, Op: "modify", Path: "w.md"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	got := unsentByPath(t, e)
	if len(got) != 2 || got["w.md"].Reason != UnsentAwaitingMerge || got["c.md"].Reason != UnsentTooManyConflicts || got["c.md"].Retryable {
		t.Fatalf("unsent %+v", got)
	}
	if got["c.md"].Code != CodeTooManyConflicts {
		t.Fatalf("legacy text not classified: %+v", got["c.md"])
	}
	if n := e.unsentCount(ctx); n != 1 {
		t.Fatalf("unsentCount = %d, want 1 (the conflict)", n)
	}
	if n, err := e.RetryUnsent(ctx, nil); err != nil || n != 0 {
		t.Fatalf("retry touched a conflict: %d %v", n, err)
	}
}

func TestClassifyLastError(t *testing.T) {
	for _, tt := range []struct{ in, code, detail string }{
		{"FILE_TOO_LARGE: file of 3 bytes exceeds the limit of 2", "FILE_TOO_LARGE", "file of 3 bytes exceeds the limit of 2"},
		{"PATH_INVALID: invalid path \"a:b\": forbidden character in a:b", "PATH_INVALID", "invalid path \"a:b\": forbidden character in a:b"},
		{"FILE_TOO_LARGE (413)", "FILE_TOO_LARGE", ""},
		{"SHARE_ROOT_MOVE", "SHARE_ROOT_MOVE", ""},
		{"ENCRYPT_FAILED: cannot encrypt the path: x", CodeEncryptFailed, "cannot encrypt the path: x"},
		// Free text written by earlier versions.
		{"cannot encrypt the content: boom", CodeEncryptFailed, "cannot encrypt the content: boom"},
		{"too many concurrent edits: resolve manually", CodeTooManyConflicts, "too many concurrent edits: resolve manually"},
		{"parked by the test", "", "parked by the test"},
		{"Bad: lower case is not a code", "", "Bad: lower case is not a code"},
	} {
		code, detail := classifyLastError(tt.in)
		if code != tt.code || detail != tt.detail {
			t.Errorf("classifyLastError(%q) = %q, %q want %q, %q", tt.in, code, detail, tt.code, tt.detail)
		}
	}
	if lastError("A_B", "x") != "A_B: x" || lastError("", "x") != "x" || lastError("A_B", "") != "A_B" {
		t.Error("lastError")
	}
}
