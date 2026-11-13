package sync

// Unit tests of the engine's failure paths against a scripted server: a merge
// that fails must not lose the remote change, a vault locked mid-cycle must not
// move the cursor, unreadable server entries are never taken for deletions,
// conflict copies exist before the original is overwritten, and path clashes
// never wedge the pull.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	stdsync "sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"clarae/apps/desktop/internal/crypto"
	"clarae/apps/desktop/internal/sync/transport"
	"clarae/shared/pathrules"
	"clarae/shared/syncproto"
)

// scriptRemote is a tiny in-memory server: a changelog the test fills, blobs,
// revision contents and optimistic concurrency on commit.
type scriptRemote struct {
	mu        stdsync.Mutex
	changes   []transport.Change
	tree      transport.Tree
	blobs     map[string][]byte
	revs      map[string]map[int][]byte
	cur       map[string]int
	curHash   map[string]string
	failBlob  map[string]error
	commits   []syncproto.Op
	conflicts int
}

func newScriptRemote() *scriptRemote {
	return &scriptRemote{blobs: map[string][]byte{}, revs: map[string]map[int][]byte{}, cur: map[string]int{}, curHash: map[string]string{}, failBlob: map[string]error{}}
}

// put records revision rev of a file on the server (content, blob, current rev).
func (r *scriptRemote) put(fileID string, rev int, content []byte) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	h := hashOf(content)
	r.blobs[h] = content
	if r.revs[fileID] == nil {
		r.revs[fileID] = map[int][]byte{}
	}
	r.revs[fileID][rev] = content
	r.cur[fileID], r.curHash[fileID] = rev, h
	return h
}

func (r *scriptRemote) Tree(context.Context) (transport.Tree, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.tree, nil
}

func (r *scriptRemote) Changes(_ context.Context, since int64, _ string, _ int) (transport.Changes, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := transport.Changes{NextSeq: since}
	for _, c := range r.changes {
		if c.Seq > since {
			out.Items = append(out.Items, c)
			out.NextSeq = c.Seq
		}
	}
	return out, nil
}

func (r *scriptRemote) CheckBlobs(_ context.Context, hashes []string) ([]string, error) {
	return hashes, nil
}

func (r *scriptRemote) Upload(_ context.Context, hash string, data []byte, _ string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.blobs[hash] = append([]byte(nil), data...)
	return "", nil
}

func (r *scriptRemote) Download(_ context.Context, hash string, w io.Writer) error {
	r.mu.Lock()
	err, b := r.failBlob[hash], r.blobs[hash]
	r.mu.Unlock()
	if err != nil {
		return err
	}
	if b == nil {
		return fmt.Errorf("blob %s not found", hash)
	}
	_, werr := w.Write(b)
	return werr
}

func (r *scriptRemote) RevisionContent(_ context.Context, fileID string, rev int, w io.Writer) error {
	r.mu.Lock()
	b := r.revs[fileID][rev]
	r.mu.Unlock()
	if b == nil {
		return os.ErrNotExist
	}
	_, err := w.Write(b)
	return err
}

func (r *scriptRemote) Commit(_ context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	resp := syncproto.CommitResponse{}
	for _, op := range req.Ops {
		r.commits = append(r.commits, op)
		cur := r.cur[op.FileID]
		if op.BaseRev != nil && *op.BaseRev < cur {
			r.conflicts++
			resp.Results = append(resp.Results, syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusConflict, Code: syncproto.CodeRevConflict, FileID: op.FileID, CurrentRev: cur, CurrentHash: r.curHash[op.FileID]})
			continue
		}
		rev := cur + 1
		r.cur[op.FileID] = rev
		if op.BlobHash != "" {
			r.curHash[op.FileID] = op.BlobHash
			if r.revs[op.FileID] == nil {
				r.revs[op.FileID] = map[int][]byte{}
			}
			r.revs[op.FileID][rev] = r.blobs[op.BlobHash]
		}
		resp.Results = append(resp.Results, syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusAccepted, FileID: op.FileID, Rev: rev})
	}
	return resp, nil
}

func (r *scriptRemote) committed(kind syncproto.OpKind, fileID string) []syncproto.Op {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []syncproto.Op
	for _, op := range r.commits {
		if op.Op == kind && (fileID == "" || op.FileID == fileID) {
			out = append(out, op)
		}
	}
	return out
}

// syncedFile puts a file on disk and on the server at revision 1, as a
// previous cycle would have left it.
func syncedFile(t *testing.T, e *Engine, remote *scriptRemote, dir, path string, content []byte) File {
	t.Helper()
	ctx := context.Background()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, path)), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, path, content)
	st, err := os.Stat(filepath.Join(dir, path))
	if err != nil {
		t.Fatal(err)
	}
	id := newFileID()
	h := remote.put(id, 1, content)
	f := File{Path: path, FileID: id, ServerRev: 1, BaseRev: 1, ServerHash: h, LocalHash: hashOf(content), LocalSize: st.Size(), LocalMtime: st.ModTime().UnixNano(), State: StateSynced}
	if err := e.cfg.DB.PutFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1"); err != nil {
		t.Fatal(err)
	}
	return f
}

// remoteEdit records a modification by another device as changelog entry seq.
func remoteEdit(remote *scriptRemote, seq int64, f File, rev int, content []byte) {
	h := remote.put(f.FileID, rev, content)
	remote.mu.Lock()
	remote.changes = append(remote.changes, transport.Change{Seq: seq, FileID: f.FileID, Op: "modify", Path: f.Path, Rev: rev, BlobHash: h, AuthorID: "other"})
	remote.mu.Unlock()
}

func readFile(t *testing.T, dir, path string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, path))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func cursor(t *testing.T, e *Engine) int64 {
	t.Helper()
	n, err := e.cfg.DB.Cursor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func pendingIDs(t *testing.T, e *Engine) map[string]transportChange {
	t.Helper()
	p, err := e.cfg.DB.Pending(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return p
}

const (
	baseText   = "line one\nline two\nline three\n"
	localText  = "LINE ONE (local)\nline two\nline three\n"
	remoteText = "line one\nline two\nLINE THREE (remote)\n"
	mergedText = "LINE ONE (local)\nline two\nLINE THREE (remote)\n"
)

// A remote change parked behind a local edit survives a failed merge (the
// blob cannot be downloaded) and a restart: the cursor already moved past it,
// so the next run must still merge it instead of losing it (D-04).
func TestCandidateSurvivesFailedFetchAndRestart(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "a.md", []byte(baseText))
	writeFile(t, dir, "a.md", []byte(localText))
	remoteEdit(remote, 2, f, 2, []byte(remoteText))
	remote.failBlob[remote.curHash[f.FileID]] = errors.New("storage backend unavailable")

	if err := e.Sync(ctx); err == nil {
		t.Fatal("sync succeeded although the remote blob could not be read")
	}
	if got := cursor(t, e); got != 2 {
		t.Fatalf("cursor = %d, want 2", got)
	}
	if _, ok := pendingIDs(t, e)[f.FileID]; !ok {
		t.Fatal("the remote change is not persisted as pending after a failed merge")
	}
	if n := len(remote.committed(syncproto.OpModify, f.FileID)); n != 0 {
		t.Fatalf("the local edit was pushed over an unmerged remote change (%d commits)", n)
	}

	// Restart: a fresh engine on the same sync.db, the storage is back.
	remote.mu.Lock()
	remote.failBlob = map[string]error{}
	remote.mu.Unlock()
	e2 := New(e.cfg)
	if err := e2.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "a.md"); got != mergedText {
		t.Fatalf("a.md = %q, want the merge %q", got, mergedText)
	}
	if len(pendingIDs(t, e2)) != 0 {
		t.Fatal("pending change not removed after the merge")
	}
	mods := remote.committed(syncproto.OpModify, f.FileID)
	if len(mods) != 1 || *mods[0].BaseRev != 2 || remote.conflicts != 0 {
		t.Fatalf("modify commits %+v, conflicts %d: want one modify on base 2 and no conflict", mods, remote.conflicts)
	}
}

// The file changes on disk between the read and the write of the merge
// (vault.ErrHashMismatch): the candidate is kept and the next round merges the
// new local text with the remote change.
func TestCandidateSurvivesHashMismatch(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "a.md", []byte(baseText))
	writeFile(t, dir, "a.md", []byte(localText))
	remoteEdit(remote, 2, f, 2, []byte(remoteText))

	const again = "LINE ONE (local, edited again)\nline two\nline three\n"
	var edits atomic.Int32
	e.cfg.BeforeOverwrite = func(path string) {
		if edits.Add(1) == 1 {
			writeFile(t, dir, path, []byte(again)) // the user types while the merge runs
		}
	}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	want := "LINE ONE (local, edited again)\nline two\nLINE THREE (remote)\n"
	if got := readFile(t, dir, "a.md"); got != want {
		t.Fatalf("a.md = %q, want %q", got, want)
	}
	if edits.Load() < 2 {
		t.Fatal("the merge was not retried after the file changed")
	}
	if len(pendingIDs(t, e)) != 0 || remote.conflicts != 0 {
		t.Fatalf("pending %v, server conflicts %d", pendingIDs(t, e), remote.conflicts)
	}
}

// Safety net: the server answers a conflict for a file whose remote change is
// not parked anywhere (lost by an older version). The current revision becomes
// a candidate and is merged in the next round instead of parking the file.
func TestCommitConflictSynthesizesCandidate(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "a.md", []byte(baseText))
	writeFile(t, dir, "a.md", []byte(localText))
	remote.put(f.FileID, 2, []byte(remoteText)) // on the server, but the cursor is past it
	if err := e.cfg.DB.SetCursor(ctx, 2, "", true); err != nil {
		t.Fatal(err)
	}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "a.md"); got != mergedText {
		t.Fatalf("a.md = %q, want %q", got, mergedText)
	}
	row, _, _ := e.cfg.DB.GetFileByID(ctx, f.FileID)
	if row.State != StateSynced || row.ServerRev != 3 || remote.conflicts != 1 {
		t.Fatalf("row %+v, conflicts %d: want synced at rev 3 after one conflict", row, remote.conflicts)
	}
}

// fakeCipher "encrypts" paths as "enc:<path>" and leaves blobs as they are.
// It can lock itself on the first path it decrypts (the idle timeout or the
// user locking the vault while a cycle runs).
type fakeCipher struct {
	locked       atomic.Bool
	lockOnDecode atomic.Bool
}

func (c *fakeCipher) Locked() bool { return c.locked.Load() }

func (c *fakeCipher) PathV2() bool { return false }

func (c *fakeCipher) EncryptPath(_, p string, _ bool) (string, string, error) {
	if c.locked.Load() {
		return "", "", crypto.ErrLocked
	}
	return "enc:" + p, "key:" + p, nil
}

func (c *fakeCipher) DecryptFilePath(_, tok string) (string, error) { return c.DecryptPath(tok) }

func (c *fakeCipher) DecryptPath(tok string) (string, error) {
	if c.lockOnDecode.CompareAndSwap(true, false) {
		c.locked.Store(true)
	}
	if c.locked.Load() {
		return "", crypto.ErrLocked
	}
	p, ok := strings.CutPrefix(tok, "enc:")
	if !ok {
		return "", errors.New("message authentication failed")
	}
	return p, nil
}

func (c *fakeCipher) EncryptBlob(_ string, b []byte) ([]byte, error) {
	if c.locked.Load() {
		return nil, crypto.ErrLocked
	}
	return b, nil
}

func (c *fakeCipher) DecryptBlob(_ string, b []byte) ([]byte, error) {
	if c.locked.Load() {
		return nil, crypto.ErrLocked
	}
	return b, nil
}

func newPrivateEngine(t *testing.T, remote Remote) (*Engine, *fakeCipher, string) {
	t.Helper()
	e, dir := newTestEngine(t, remote, 0)
	c := &fakeCipher{}
	cfg := e.cfg
	cfg.Cipher = c
	cfg.CacheDir = filepath.Join(t.TempDir(), "outbox")
	return New(cfg), c, dir
}

// The vault is locked while the changelog is applied: the cycle ends as
// locked, the cursor does not move past the change, and after the unlock the
// change is applied.
func TestLockedMidPullKeepsCursor(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, c, dir := newPrivateEngine(t, remote)
	if err := e.cfg.DB.SetMeta(ctx, MetaBootstrapped, "1"); err != nil {
		t.Fatal(err)
	}
	id := newFileID()
	h := remote.put(id, 1, []byte("# from the other device"))
	remote.changes = []transport.Change{{Seq: 1, FileID: id, Op: "create", Path: "enc:b.md", Rev: 1, BlobHash: h}}
	c.lockOnDecode.Store(true)

	err := e.Sync(ctx)
	if !errors.Is(err, ErrLocked) {
		t.Fatalf("sync error = %v, want ErrLocked", err)
	}
	if st := e.Status(); st.Phase != PhaseLocked {
		t.Fatalf("phase = %s, want locked", st.Phase)
	}
	if got := cursor(t, e); got != 0 {
		t.Fatalf("cursor moved to %d past a change that was not applied", got)
	}
	if q, _ := e.cfg.DB.Quarantined(ctx); len(q) != 0 {
		t.Fatalf("a locked vault quarantined %v", q)
	}

	c.locked.Store(false)
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "b.md"); got != "# from the other device" || cursor(t, e) != 1 {
		t.Fatalf("after unlock: b.md = %q, cursor %d", got, cursor(t, e))
	}
}

// A server entry whose path cannot be decrypted is quarantined during a
// bootstrap, and the local file with the same id is never trashed as if the
// server had deleted it.
func TestBootstrapNeverTrashesOnDecryptFailure(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, _, dir := newPrivateEngine(t, remote)
	f := syncedFile(t, e, remote, dir, "x.md", []byte("# keep me"))
	if err := e.cfg.DB.DeleteMeta(ctx, MetaBootstrapped); err != nil {
		t.Fatal(err)
	}
	remote.tree = transport.Tree{AsOfSeq: 5, Items: []transport.TreeEntry{{Path: "corrupt-token", FileID: f.FileID, Rev: 1, Hash: f.ServerHash}}}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, dir, "x.md"); got != "# keep me" {
		t.Fatalf("x.md = %q", got)
	}
	if _, ok, _ := e.cfg.DB.GetFileByID(ctx, f.FileID); !ok {
		t.Fatal("the row of the unreadable file was dropped")
	}
	q, err := e.cfg.DB.Quarantined(ctx)
	if err != nil || len(q) != 1 || q[0].FileID != f.FileID {
		t.Fatalf("quarantine = %v, %v", q, err)
	}
	if got := cursor(t, e); got != 5 {
		t.Fatalf("cursor = %d, want 5", got)
	}
	if dels := remote.committed(syncproto.OpDelete, ""); len(dels) != 0 {
		t.Fatalf("deletes sent: %v", dels)
	}
}

// Not mergeable (a binary file edited on both sides): the copy with our
// version exists before the original is overwritten, and a long multibyte
// device name still gives a valid file name.
func TestConflictCopyWrittenBeforeOverwrite(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	e.cfg.DeviceName = strings.Repeat("Ordinateur portable de Zoë ", 4) + "日本語のデバイス"
	f := syncedFile(t, e, remote, dir, "data.bin", []byte{0, 1, 2})
	ours, theirs := []byte{0, 1, 2, 3, 4}, []byte{9, 9, 9}
	writeFile(t, dir, "data.bin", ours)
	remoteEdit(remote, 2, f, 2, theirs)

	copyBefore := ""
	e.cfg.BeforeOverwrite = func(string) {
		entries, _ := os.ReadDir(dir)
		for _, en := range entries {
			if strings.Contains(en.Name(), "(conflitto ") && readFile(t, dir, en.Name()) == string(ours) {
				copyBefore = en.Name()
			}
		}
	}
	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if copyBefore == "" {
		t.Fatal("the original was overwritten before the conflict copy existed")
	}
	if err := pathrules.Validate(copyBefore); err != nil || !utf8.ValidString(copyBefore) {
		t.Fatalf("invalid conflict copy name %q: %v", copyBefore, err)
	}
	if got := readFile(t, dir, "data.bin"); got != string(theirs) {
		t.Fatalf("data.bin = %v, want the server version", []byte(got))
	}
	confs, _ := e.cfg.DB.Conflicts(ctx, "open")
	if len(confs) != 1 || confs[0].CopyPath != copyBefore {
		t.Fatalf("conflicts %+v", confs)
	}
	if creates := remote.committed(syncproto.OpCreate, ""); len(creates) != 1 || creates[0].ConflictOf != f.FileID {
		t.Fatalf("conflict copy not uploaded as a conflict of %s: %+v", f.FileID, creates)
	}
}

func TestConflictPathFitsPathRules(t *testing.T) {
	at := time.Date(2026, 11, 1, 10, 30, 0, 0, time.UTC)
	devices := []string{
		strings.Repeat("é", 39),               // 78 bytes: the 40-byte cut falls inside a character
		strings.Repeat("日本", 20),              // 3-byte characters
		strings.Repeat("🙂", 15) + " laptop. ", // 4-byte characters, trailing dot and space
		`bad\name:with*chars?`,
	}
	stems := []string{
		"note",
		strings.Repeat("ü", 120), // 240 bytes: the segment would exceed 255
		strings.Repeat("a", 250),
	}
	for _, dev := range devices {
		for _, stem := range stems {
			for _, dir := range []string{"", "folder/sub", strings.Repeat("d", 200) + "/" + strings.Repeat("e", 200) + "/" + strings.Repeat("f", 200) + "/" + strings.Repeat("g", 200)} {
				path := stem + ".md"
				if dir != "" {
					path = dir + "/" + path
				}
				free := conflictPath(path, dev, at, func(string) bool { return false })
				busy := conflictPath(path, dev, at, func(p string) bool { return p == free })
				for _, p := range []string{free, busy} {
					if err := pathrules.Validate(p); err != nil {
						t.Errorf("conflictPath(%q, %q) = %q: %v", path, dev, p, err)
					}
				}
				if busy == free {
					t.Errorf("taken path returned again: %q", busy)
				}
			}
		}
	}
	if got := sanitizeName(strings.Repeat("é", 39)); !utf8.ValidString(got) || len(got) > maxDeviceBytes {
		t.Fatalf("sanitizeName split a character: %q", got)
	}
	long := strings.Repeat("ü", 126) + ".md" // 255 bytes
	if p := uniquePath(long, func(string) bool { return false }); pathrules.Validate(p) != nil {
		t.Fatalf("uniquePath(%d bytes) = %q is invalid", len(long), p)
	}
}

// The server moves a file we deleted onto a path where we now have another
// file: the pull must not fail on the path clash (it would retry forever
// before moving the cursor), the other file stays, the delete is sent.
func TestMoveOfDeletedFileOntoTakenPathDoesNotWedge(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "old.md", []byte("# old"))
	if err := os.Remove(filepath.Join(dir, "old.md")); err != nil {
		t.Fatal(err)
	}
	f.State = StateLocalDeleted
	if err := e.cfg.DB.PutFile(ctx, f); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, "new.md", []byte("# mine, unrelated"))
	remote.mu.Lock()
	remote.cur[f.FileID] = 2
	remote.changes = []transport.Change{{Seq: 2, FileID: f.FileID, Op: "move", Path: "new.md", PrevPath: "old.md", Rev: 2, BlobHash: f.ServerHash}}
	remote.mu.Unlock()

	if err := e.Sync(ctx); err != nil {
		t.Fatalf("pull wedged on the path clash: %v", err)
	}
	if got := cursor(t, e); got != 2 {
		t.Fatalf("cursor = %d, want 2", got)
	}
	if got := readFile(t, dir, "new.md"); got != "# mine, unrelated" {
		t.Fatalf("new.md = %q", got)
	}
	dels := remote.committed(syncproto.OpDelete, f.FileID)
	if len(dels) != 1 || *dels[0].BaseRev != 2 {
		t.Fatalf("delete commits %+v, want one on base 2", dels)
	}
	if creates := remote.committed(syncproto.OpCreate, ""); len(creates) != 1 || creates[0].Path != "new.md" {
		t.Fatalf("create commits %+v", creates)
	}
}

// A modification whose path differs from ours (a move we missed) is applied
// as a move plus the new content, not written to the old path.
func TestModifyWithNewPathMovesTheFile(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "a.md", []byte(baseText))
	h := remote.put(f.FileID, 2, []byte(remoteText))
	remote.changes = []transport.Change{{Seq: 2, FileID: f.FileID, Op: "modify", Path: "moved/a.md", Rev: 2, BlobHash: h}}

	if err := e.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.md")); !os.IsNotExist(err) {
		t.Fatalf("old path still present: %v", err)
	}
	if got := readFile(t, dir, "moved/a.md"); got != remoteText {
		t.Fatalf("moved/a.md = %q", got)
	}
	row, _, _ := e.cfg.DB.GetFileByID(ctx, f.FileID)
	if row.Path != "moved/a.md" || row.State != StateSynced || row.ServerRev != 2 {
		t.Fatalf("row %+v", row)
	}
}

// A scan between a rename and its hint recorded the new path as a new file
// and the old one as deleted: the hint merges them back into one identity
// instead of failing on the path clash.
func TestRenamedHintMergesScannedNewFile(t *testing.T) {
	ctx := context.Background()
	remote := newScriptRemote()
	e, dir := newTestEngine(t, remote, 0)
	f := syncedFile(t, e, remote, dir, "a.md", []byte(baseText))
	if err := os.Rename(filepath.Join(dir, "a.md"), filepath.Join(dir, "b.md")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, "b.md", []byte(baseText+"[[link updated]]\n"))
	if err := e.scan(ctx); err != nil {
		t.Fatal(err)
	}
	if err := e.Renamed(ctx, "a.md", "b.md"); err != nil {
		t.Fatalf("rename hint failed: %v", err)
	}
	rows, err := e.cfg.DB.Files(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows %+v, want one", rows)
	}
	r := rows[0]
	if r.FileID != f.FileID || r.Path != "b.md" || r.State != StateLocalMoved || !r.Dirty || r.MovedFrom != "a.md" {
		t.Fatalf("row %+v: want the original identity moved and dirty", r)
	}
}
