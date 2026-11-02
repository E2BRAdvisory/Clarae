package sync

// Folder renames (ADR-0040): one move_prefix per renamed folder in shared
// vaults, per-file moves in private ones, SHARE_ROOT_MOVE recovered or parked,
// and a folder renamed elsewhere applied as one directory rename. The server
// is folderServer, an in-memory model of the cloud's commit rules for moves.

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	stdsync "sync"
	"testing"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

type fsFile struct {
	path    string
	rev     int
	hash    string
	deleted bool
}

// folderServer keeps files, a changelog (own commits included, as the real
// server does), blobs and folder shares; it expands move_prefix into one move
// per file, rebases the shares and refuses a per-file move taking the last
// file out of a share root.
type folderServer struct {
	mu           stdsync.Mutex
	private      bool
	files        map[string]*fsFile
	changes      []transport.Change
	blobs        map[string][]byte
	shares       []string // folder share roots
	rejectPrefix syncproto.Code
	commits      [][]syncproto.Op
}

func newFolderServer() *folderServer {
	return &folderServer{files: map[string]*fsFile{}, blobs: map[string][]byte{}}
}

func (s *folderServer) seq() int64 { return int64(len(s.changes)) }

func (s *folderServer) log(id string, op, prev string) {
	f := s.files[id]
	s.changes = append(s.changes, transport.Change{Seq: s.seq() + 1, FileID: id, Op: op, Path: f.path, Rev: f.rev, BlobHash: f.hash, PrevPath: prev})
}

func (s *folderServer) keyTaken(path, except string) bool {
	k := pathrules.Key(path)
	for id, f := range s.files {
		if id != except && !f.deleted && pathrules.Key(f.path) == k {
			return true
		}
	}
	return false
}

func (s *folderServer) Tree(context.Context) (transport.Tree, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	t := transport.Tree{AsOfSeq: s.seq()}
	for id, f := range s.files {
		if !f.deleted {
			t.Items = append(t.Items, transport.TreeEntry{Path: f.path, FileID: id, Rev: f.rev, Hash: f.hash})
		}
	}
	return t, nil
}

func (s *folderServer) Changes(_ context.Context, since int64, _ string, limit int) (transport.Changes, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := transport.Changes{NextSeq: since}
	for _, c := range s.changes {
		if c.Seq > since {
			if len(out.Items) == limit {
				out.HasMore = true
				break
			}
			out.Items = append(out.Items, c)
			out.NextSeq = c.Seq
		}
	}
	return out, nil
}

func (s *folderServer) CheckBlobs(_ context.Context, hashes []string) ([]string, error) {
	return hashes, nil
}

func (s *folderServer) Upload(_ context.Context, hash string, data []byte, _ string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.blobs[hash] = append([]byte(nil), data...)
	return "", nil
}

func (s *folderServer) Download(_ context.Context, hash string, w io.Writer) error {
	s.mu.Lock()
	b, ok := s.blobs[hash]
	s.mu.Unlock()
	if !ok {
		return os.ErrNotExist
	}
	_, err := w.Write(b)
	return err
}

func (s *folderServer) RevisionContent(context.Context, string, int, io.Writer) error {
	return os.ErrNotExist
}

func (s *folderServer) FolderShareRoots(context.Context) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.shares...), nil
}

func (s *folderServer) Commit(_ context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.commits = append(s.commits, req.Ops)
	var resp syncproto.CommitResponse
	for _, op := range req.Ops {
		resp.Results = append(resp.Results, s.apply(op))
	}
	resp.LastSeq = s.seq()
	return resp, nil
}

func reject(op syncproto.Op, code syncproto.Code, detail string) syncproto.OpResult {
	return syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusRejected, Code: code, Detail: detail}
}

func (s *folderServer) apply(op syncproto.Op) syncproto.OpResult {
	ok := func(id string) syncproto.OpResult {
		f := s.files[id]
		return syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusAccepted, FileID: id, Rev: f.rev, Seq: s.seq()}
	}
	f := s.files[op.FileID]
	if op.BaseRev != nil && f != nil && *op.BaseRev < f.rev {
		return syncproto.OpResult{OpID: op.OpID, Status: syncproto.StatusConflict, Code: syncproto.CodeRevConflict, FileID: op.FileID, CurrentRev: f.rev, CurrentHash: f.hash}
	}
	switch op.Op {
	case syncproto.OpCreate:
		if s.keyTaken(op.Path, "") {
			return reject(op, syncproto.CodePathCollision, op.Path+" already exists")
		}
		s.files[op.FileID] = &fsFile{path: op.Path, rev: 1, hash: op.BlobHash}
		s.log(op.FileID, "create", "")
		return ok(op.FileID)
	case syncproto.OpModify:
		f.rev, f.hash = f.rev+1, op.BlobHash
		s.log(op.FileID, "modify", "")
		return ok(op.FileID)
	case syncproto.OpDelete:
		f.rev, f.deleted = f.rev+1, true
		s.log(op.FileID, "delete", "")
		return ok(op.FileID)
	case syncproto.OpMove:
		if s.keyTaken(op.Path, op.FileID) {
			return reject(op, syncproto.CodePathCollision, op.Path+" already exists")
		}
		for _, root := range s.shares {
			if pathrules.HasPrefix(f.path, root) && !pathrules.HasPrefix(op.Path, root) && s.countBelow(root) <= 1 {
				return reject(op, syncproto.CodeShareRootMove, "moving "+f.path+" would take the last file out of the shared folder "+root+": rename the folder instead")
			}
		}
		prev := f.path
		f.path, f.rev = op.Path, f.rev+1
		s.log(op.FileID, "move", prev)
		return ok(op.FileID)
	case syncproto.OpMovePrefix:
		if s.private {
			return reject(op, syncproto.CodeVaultEncrypted, "move_prefix is not available on private vaults")
		}
		if s.rejectPrefix != "" {
			return reject(op, s.rejectPrefix, "refused by the test")
		}
		p := prefixPair{from: op.From, to: op.To}
		var ids []string
		for id, f := range s.files {
			if !f.deleted && pathrules.HasPrefix(pathrules.Key(f.path), pathrules.Key(op.From)) {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			return reject(op, syncproto.CodeNotFound, "nothing under "+op.From)
		}
		sort.Slice(ids, func(i, j int) bool { return s.files[ids[i]].path < s.files[ids[j]].path })
		moving := map[string]bool{}
		for _, id := range ids {
			moving[id] = true
		}
		for _, id := range ids {
			np := prefixTarget(s.files[id].path, p)
			for oid, of := range s.files {
				if !moving[oid] && !of.deleted && pathrules.Key(of.path) == pathrules.Key(np) {
					return reject(op, syncproto.CodePathCollision, np+" already exists")
				}
			}
		}
		for _, id := range ids {
			f := s.files[id]
			prev := f.path
			f.path, f.rev = prefixTarget(prev, p), f.rev+1
			s.log(id, "move", prev)
		}
		for i, root := range s.shares {
			if r, ok := pathrules.Rebase(root, op.From, op.To); ok {
				s.shares[i] = r
			}
		}
		return ok(ids[len(ids)-1])
	}
	return reject(op, syncproto.CodeValidationFailed, "unknown op")
}

func (s *folderServer) countBelow(root string) int {
	n := 0
	for _, f := range s.files {
		if !f.deleted && pathrules.HasPrefix(f.path, root) {
			n++
		}
	}
	return n
}

// paths lists the live server paths.
func (s *folderServer) paths() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []string
	for _, f := range s.files {
		if !f.deleted {
			out = append(out, f.path)
		}
	}
	sort.Strings(out)
	return out
}

// sent lists the kinds of the operations committed since mark.
func (s *folderServer) sent(mark int) []syncproto.Op {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []syncproto.Op
	for _, c := range s.commits[mark:] {
		out = append(out, c...)
	}
	return out
}

func (s *folderServer) mark() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.commits)
}

func countOps(ops []syncproto.Op, kind syncproto.OpKind) int {
	n := 0
	for _, o := range ops {
		if o.Op == kind {
			n++
		}
	}
	return n
}

func put(t *testing.T, dir, rel, content string) {
	t.Helper()
	abs := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustRename(t *testing.T, dir, from, to string) {
	t.Helper()
	abs := filepath.Join(dir, filepath.FromSlash(to))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, filepath.FromSlash(from)), abs); err != nil {
		t.Fatal(err)
	}
}

// diskFiles lists the vault files (no .memobrain, no trash) with their content.
func diskFiles(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	_ = filepath.WalkDir(dir, func(p string, de os.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // test helper
		}
		if de.IsDir() {
			if p != dir && (de.Name() == ".memobrain" || de.Name() == ".trash") {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		b, _ := os.ReadFile(p)
		out[filepath.ToSlash(rel)] = string(b)
		return nil
	})
	return out
}

func keys(m map[string]string) string {
	k := make([]string, 0, len(m))
	for p := range m {
		k = append(k, p)
	}
	sort.Strings(k)
	return strings.Join(k, ",")
}

func exists(dir, rel string) bool {
	_, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(rel)))
	return err == nil
}

func syncOK(t *testing.T, e *Engine) {
	t.Helper()
	if err := e.Sync(context.Background()); err != nil {
		t.Fatalf("sync: %v", err)
	}
}

func allSynced(t *testing.T, e *Engine) {
	t.Helper()
	rows, err := e.cfg.DB.Files(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range rows {
		if r.State != StateSynced {
			t.Errorf("%s: state %s (%+v)", r.Path, r.State, r)
		}
	}
}

// twoDevices links two engines to one folderServer, with a tree already synced.
func twoDevices(t *testing.T, s *folderServer, files map[string]string) (a *Engine, adir string, b *Engine, bdir string) {
	t.Helper()
	a, adir = newTestEngine(t, s, 0)
	b, bdir = newTestEngine(t, s, 0)
	for p, c := range files {
		put(t, adir, p, c)
	}
	syncOK(t, a)
	syncOK(t, b)
	if got, want := keys(diskFiles(t, bdir)), keys(diskFiles(t, adir)); got != want {
		t.Fatalf("setup: B %s, A %s", got, want)
	}
	return a, adir, b, bdir
}

var acme = map[string]string{
	"Acme/plan.md":      "# plan\n",
	"Acme/sub/notes.md": "# notes\n",
	"Acme/sub/pic.png":  "png",
	"other.md":          "# other\n",
}

// A folder renamed on disk (seen by the scan) is one move_prefix; the other
// device renames its folder in one go, and the share follows.
func TestFolderRenameIsOneMovePrefix(t *testing.T) {
	s := newFolderServer()
	s.shares = []string{"Acme"}
	a, adir, b, bdir := twoDevices(t, s, acme)

	mark := s.mark()
	mustRename(t, adir, "Acme", "Acme-2024")
	syncOK(t, a)
	ops := s.sent(mark)
	if len(ops) != 1 || ops[0].Op != syncproto.OpMovePrefix || ops[0].From != "Acme" || ops[0].To != "Acme-2024" {
		t.Fatalf("sent %+v, want one move_prefix Acme -> Acme-2024", ops)
	}
	if s.shares[0] != "Acme-2024" {
		t.Errorf("share root %q did not follow the folder", s.shares[0])
	}
	allSynced(t, a)
	// The echo of the move_prefix gave every row its new revision.
	row := parked(t, a, "Acme-2024/sub/notes.md")
	if row.ServerRev != 2 || row.BaseRev != 2 {
		t.Errorf("row after the echo: %+v", row)
	}

	syncOK(t, b)
	if got, want := keys(diskFiles(t, bdir)), "Acme-2024/plan.md,Acme-2024/sub/notes.md,Acme-2024/sub/pic.png,other.md"; got != want {
		t.Fatalf("B: %s, want %s", got, want)
	}
	if exists(bdir, "Acme") {
		t.Error("B moved the files one by one (the old folder is left behind)")
	}
	allSynced(t, b)
	if len(s.sent(mark)) != 1 {
		t.Errorf("B sent operations back: %+v", s.sent(mark)[1:])
	}
}

// The rename hint of the UI (Renamed) leads to the same single move_prefix,
// for a nested folder too.
func TestRenamedHintForAFolder(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, acme)
	mark := s.mark()
	mustRename(t, adir, "Acme/sub", "Acme/Sub folder")
	if err := a.Renamed(context.Background(), "Acme/sub", "Acme/Sub folder"); err != nil {
		t.Fatal(err)
	}
	syncOK(t, a)
	ops := s.sent(mark)
	if len(ops) != 1 || ops[0].Op != syncproto.OpMovePrefix || ops[0].From != "Acme/sub" || ops[0].To != "Acme/Sub folder" {
		t.Fatalf("sent %+v", ops)
	}
	syncOK(t, b)
	if got := diskFiles(t, bdir)["Acme/Sub folder/notes.md"]; got != "# notes\n" || exists(bdir, "Acme/sub") {
		t.Fatalf("B: %s", keys(diskFiles(t, bdir)))
	}
}

// Files moved one by one out of a folder that stays are per-file moves.
func TestFilesMovedOutOfAFolderStayPerFile(t *testing.T) {
	s := newFolderServer()
	a, adir, _, _ := twoDevices(t, s, acme)
	mark := s.mark()
	mustRename(t, adir, "Acme/sub/notes.md", "Archive/sub/notes.md")
	mustRename(t, adir, "Acme/sub/pic.png", "Archive/sub/pic.png")
	syncOK(t, a)
	ops := s.sent(mark)
	// Every file of Acme/sub left, but the folder is still there (empty).
	if len(ops) != 2 || countOps(ops, syncproto.OpMove) != 2 {
		t.Fatalf("sent %+v, want two moves", ops)
	}

	// Now one file out of Acme, which still exists: a plain move.
	mark = s.mark()
	mustRename(t, adir, "Acme/plan.md", "Archive/plan.md")
	syncOK(t, a)
	ops = s.sent(mark)
	if len(ops) != 1 || ops[0].Op != syncproto.OpMove || ops[0].Path != "Archive/plan.md" {
		t.Fatalf("sent %+v", ops)
	}
	allSynced(t, a)
}

// A case-only rename of a folder is a move_prefix too.
func TestFolderCaseOnlyRename(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, map[string]string{"notes/a.md": "a", "notes/b.md": "b"})
	mark := s.mark()
	mustRename(t, adir, "notes", "tmp-rename")
	mustRename(t, adir, "tmp-rename", "Notes")
	syncOK(t, a)
	ops := s.sent(mark)
	if len(ops) != 1 || ops[0].Op != syncproto.OpMovePrefix || ops[0].From != "notes" || ops[0].To != "Notes" {
		t.Fatalf("sent %+v", ops)
	}
	syncOK(t, b)
	if got := keys(diskFiles(t, bdir)); got != "Notes/a.md,Notes/b.md" {
		t.Fatalf("B: %s", got)
	}
}

// Private vaults: the server cannot see folders, so a folder rename is one
// move per file, each with its path encrypted again.
func TestPrivateFolderRenameIsPerFile(t *testing.T) {
	s := newFolderServer()
	s.private = true
	a, _, adir := newPrivateEngine(t, s)
	put(t, adir, "Acme/plan.md", "# plan\n")
	put(t, adir, "Acme/sub/notes.md", "# notes\n")
	syncOK(t, a)
	b, _, bdir := newPrivateEngine(t, s)
	syncOK(t, b)

	mark := s.mark()
	mustRename(t, adir, "Acme", "Acme-2024")
	syncOK(t, a)
	ops := s.sent(mark)
	if len(ops) != 2 || countOps(ops, syncproto.OpMove) != 2 {
		t.Fatalf("sent %+v, want two moves", ops)
	}
	for _, o := range ops {
		if !strings.HasPrefix(o.Path, "enc:Acme-2024/") || o.PathKey == "" {
			t.Errorf("move without its new encrypted path: %+v", o)
		}
	}
	allSynced(t, a)
	syncOK(t, b)
	if got := keys(diskFiles(t, bdir)); got != "Acme-2024/plan.md,Acme-2024/sub/notes.md" {
		t.Fatalf("B: %s", got)
	}
	if exists(bdir, "Acme") {
		t.Error("B did not rename the folder in one go")
	}
}

// A move_prefix the server refuses falls back to per-file moves.
func TestRefusedMovePrefixFallsBackToMoves(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, acme)
	s.rejectPrefix = syncproto.CodeForbidden
	mark := s.mark()
	mustRename(t, adir, "Acme", "Acme-2024")
	syncOK(t, a)
	ops := s.sent(mark)
	if countOps(ops, syncproto.OpMovePrefix) != 1 || countOps(ops, syncproto.OpMove) != 3 {
		t.Fatalf("sent %+v, want a refused move_prefix then three moves", ops)
	}
	allSynced(t, a)
	syncOK(t, b)
	if got := keys(diskFiles(t, bdir)); got != "Acme-2024/plan.md,Acme-2024/sub/notes.md,Acme-2024/sub/pic.png,other.md" {
		t.Fatalf("B: %s", got)
	}
}

// SHARE_ROOT_MOVE on a per-file move that renames the share root (the old
// folder is still on disk, so no move_prefix was tried): the engine sends the
// rename of the share root instead and the share follows.
func TestShareRootMoveRecoveredAsMovePrefix(t *testing.T) {
	s := newFolderServer()
	s.shares = []string{"Acme"}
	a, adir, b, bdir := twoDevices(t, s, map[string]string{"Acme/plan.md": "# plan\n", "other.md": "x"})
	mark := s.mark()
	mustRename(t, adir, "Acme/plan.md", "Acme-2024/plan.md") // Acme stays, empty
	syncOK(t, a)
	ops := s.sent(mark)
	if len(ops) != 2 || ops[0].Op != syncproto.OpMove || ops[1].Op != syncproto.OpMovePrefix || ops[1].From != "Acme" || ops[1].To != "Acme-2024" {
		t.Fatalf("sent %+v, want the refused move then the move_prefix of the share root", ops)
	}
	if s.shares[0] != "Acme-2024" {
		t.Fatalf("share root %q", s.shares[0])
	}
	allSynced(t, a)
	if st := a.Status(); st.Error != "" || st.Phase != PhaseIdle {
		t.Errorf("status %+v", st)
	}
	syncOK(t, b)
	if got := keys(diskFiles(t, bdir)); got != "Acme-2024/plan.md,other.md" {
		t.Fatalf("B: %s", got)
	}
}

// SHARE_ROOT_MOVE on a move that is not a rename of the share root: the move
// is parked (nothing is lost, the file stays where the user put it), the
// status explains it, and moving the file back clears it.
func TestShareRootMoveParkedWithNotice(t *testing.T) {
	s := newFolderServer()
	s.shares = []string{"Acme"}
	a, adir, _, _ := twoDevices(t, s, map[string]string{"Acme/plan.md": "# plan\n", "other.md": "x"})
	mustRename(t, adir, "Acme/plan.md", "Elsewhere/renamed-plan.md")
	syncOK(t, a)
	row := parked(t, a, "Elsewhere/renamed-plan.md")
	if row.State != StateLocalMoved || row.Attempts < MaxAttempts || !strings.HasPrefix(row.LastError, string(syncproto.CodeShareRootMove)) {
		t.Fatalf("row %+v", row)
	}
	if got := diskFiles(t, adir)["Elsewhere/renamed-plan.md"]; got != "# plan\n" {
		t.Fatalf("the file was touched: %q", got)
	}
	st := a.Status()
	if st.Phase != PhaseIdle || !strings.Contains(st.Error, "shared folder") || !strings.Contains(st.Error, "Elsewhere/renamed-plan.md") {
		t.Fatalf("status %+v", st)
	}
	if got := s.paths(); strings.Join(got, ",") != "Acme/plan.md,other.md" {
		t.Fatalf("server %v", got)
	}
	// Parked: the next cycle sends nothing and keeps the notice.
	mark := s.mark()
	syncOK(t, a)
	if len(s.sent(mark)) != 0 || a.Status().Error == "" {
		t.Fatalf("sent %+v, status %+v", s.sent(mark), a.Status())
	}
	// Moved back: nothing to send, no notice.
	mustRename(t, adir, "Elsewhere/renamed-plan.md", "Acme/plan.md")
	syncOK(t, a)
	if len(s.sent(mark)) != 0 || a.Status().Error != "" {
		t.Fatalf("sent %+v, status %+v", s.sent(mark), a.Status())
	}
	allSynced(t, a)
}

// An edit made elsewhere inside the folder while it is renamed here: both
// apply, at the new path, on both devices.
func TestConcurrentEditInsideRenamedFolder(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, acme)
	mustRename(t, adir, "Acme", "Acme-2024")
	put(t, bdir, "Acme/sub/notes.md", "# notes\nedited on B\n")
	syncOK(t, a) // move_prefix first
	syncOK(t, b) // pulls the moves onto a modified file, then pushes the edit
	syncOK(t, a)
	for name, dir := range map[string]string{"A": adir, "B": bdir} {
		files := diskFiles(t, dir)
		if got := keys(files); got != "Acme-2024/plan.md,Acme-2024/sub/notes.md,Acme-2024/sub/pic.png,other.md" {
			t.Errorf("%s: %s", name, got)
		}
		if got := files["Acme-2024/sub/notes.md"]; got != "# notes\nedited on B\n" {
			t.Errorf("%s: notes %q", name, got)
		}
	}
	allSynced(t, a)
	allSynced(t, b)
}

// A file of the folder edited here, then the folder renamed from the UI (the
// hint keeps the identity of the edited file): the move_prefix goes first,
// the content on the next round, on the moved file.
func TestRenamedFolderWithLocalEdit(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, acme)
	mark := s.mark()
	put(t, adir, "Acme/plan.md", "# plan\nedited on A\n")
	mustRename(t, adir, "Acme", "Acme-2024")
	if err := a.Renamed(context.Background(), "Acme", "Acme-2024"); err != nil {
		t.Fatal(err)
	}
	syncOK(t, a)
	ops := s.sent(mark)
	if len(ops) != 2 || ops[0].Op != syncproto.OpMovePrefix || ops[1].Op != syncproto.OpModify {
		t.Fatalf("sent %+v, want move_prefix then modify", ops)
	}
	allSynced(t, a)
	syncOK(t, b)
	if got := diskFiles(t, bdir)["Acme-2024/plan.md"]; got != "# plan\nedited on A\n" {
		t.Fatalf("B: %q (%s)", got, keys(diskFiles(t, bdir)))
	}
}

// A file deleted here below a renamed folder is deleted first, then the rest
// moves as one folder.
func TestRenamedFolderWithLocalDelete(t *testing.T) {
	s := newFolderServer()
	a, adir, _, _ := twoDevices(t, s, acme)
	mark := s.mark()
	if err := os.Remove(filepath.Join(adir, "Acme", "sub", "pic.png")); err != nil {
		t.Fatal(err)
	}
	mustRename(t, adir, "Acme", "Acme-2024")
	syncOK(t, a)
	ops := s.sent(mark)
	if len(ops) != 2 || ops[0].Op != syncproto.OpDelete || ops[1].Op != syncproto.OpMovePrefix {
		t.Fatalf("sent %+v, want delete then move_prefix", ops)
	}
	if got := strings.Join(s.paths(), ","); got != "Acme-2024/plan.md,Acme-2024/sub/notes.md,other.md" {
		t.Fatalf("server %s", got)
	}
	allSynced(t, a)
}

// Pull: a local file in the folder that the remote moves do not cover (new
// here) keeps the per-file path: nothing is lost and the new file is sent.
func TestRemoteFolderRenameWithLocalNewFile(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, acme)
	mustRename(t, adir, "Acme", "Acme-2024")
	syncOK(t, a)
	put(t, bdir, "Acme/sub/new.md", "new on B")
	syncOK(t, b)
	files := diskFiles(t, bdir)
	for _, p := range []string{"Acme-2024/plan.md", "Acme-2024/sub/notes.md", "Acme-2024/sub/pic.png", "Acme/sub/new.md"} {
		if _, ok := files[p]; !ok {
			t.Errorf("B lacks %s: %s", p, keys(files))
		}
	}
	allSynced(t, b)
	syncOK(t, a)
	if got := diskFiles(t, adir)["Acme/sub/new.md"]; got != "new on B" {
		t.Errorf("A: %s", keys(diskFiles(t, adir)))
	}
}

// Pull: the destination folder already exists locally: the files are moved
// one by one into it (makeRoom handles clashes), nothing is lost.
func TestRemoteFolderRenameOntoExistingFolder(t *testing.T) {
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, acme)
	put(t, bdir, "Acme-2024/plan.md", "local plan on B")
	mustRename(t, adir, "Acme", "Acme-2024")
	syncOK(t, a)
	syncOK(t, b)
	files := diskFiles(t, bdir)
	if files["Acme-2024/plan.md"] != "# plan\n" || files["Acme-2024/plan (1).md"] != "local plan on B" {
		t.Fatalf("B: %v", files)
	}
	allSynced(t, b)
}

func TestRenameCandidates(t *testing.T) {
	got := renameCandidates("Work/Acme/sub/n.md", "Job/Acme/sub/n.md")
	want := []prefixPair{{"Work", "Job"}, {"Work/Acme", "Job/Acme"}, {"Work/Acme/sub", "Job/Acme/sub"}}
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%v, want %v", got, want)
		}
	}
	if c := renameCandidates("a/n.md", "a/m.md"); len(c) != 0 {
		t.Errorf("a file rename is no folder rename: %v", c)
	}
	if c := renameCandidates("n.md", "a/n.md"); len(c) != 0 {
		t.Errorf("a file moved from the root is no folder rename: %v", c)
	}
	if c := renameCandidates("a/n.md", "a/b/a/n.md"); len(c) != 0 {
		t.Errorf("a folder cannot move into itself: %v", c)
	}
	if p := prefixTarget("A/b/c.md", prefixPair{"A", "X/Y"}); p != "X/Y/b/c.md" {
		t.Errorf("target %q", p)
	}
}

// A remote change of a file of the renamed folder that cannot be merged yet
// holds the whole rename back (sending the others one by one would split the
// folder); once it is settled the folder goes as one move_prefix.
func TestFolderRenameWaitsForPendingMerge(t *testing.T) {
	ctx := context.Background()
	s := newFolderServer()
	a, adir, _, _ := twoDevices(t, s, acme)
	mustRename(t, adir, "Acme", "Acme-2024")
	id := parked(t, a, "Acme/plan.md").FileID
	missing := strings.Repeat("ab", 32) // a blob the server cannot serve: the merge fails
	a.candidates[id] = transportChange{Seq: 1, FileID: id, Op: "modify", Path: "Acme/plan.md", Rev: 5, BlobHash: missing}
	mark := s.mark()
	if err := a.Sync(ctx); err == nil {
		t.Fatal("the failed merge was not reported")
	}
	if ops := s.sent(mark); len(ops) != 0 {
		t.Fatalf("sent %+v while a file of the folder waits for a merge", ops)
	}
	if err := a.dropCandidate(ctx, id); err != nil {
		t.Fatal(err)
	}
	syncOK(t, a)
	if ops := s.sent(mark); len(ops) != 1 || ops[0].Op != syncproto.OpMovePrefix {
		t.Fatalf("sent %+v", ops)
	}
	allSynced(t, a)
}

// A file moved away and back (with an edit on the way) before the cycle runs
// is no move any more: only its content is sent.
func TestMovedBackWithEditSendsOnlyTheEdit(t *testing.T) {
	ctx := context.Background()
	s := newFolderServer()
	a, adir, b, bdir := twoDevices(t, s, map[string]string{"Acme/plan.md": "# plan\n"})
	mustRename(t, adir, "Acme/plan.md", "Other/plan.md")
	if err := a.Renamed(ctx, "Acme/plan.md", "Other/plan.md"); err != nil {
		t.Fatal(err)
	}
	put(t, adir, "Other/plan.md", "# plan\nedited\n")
	mustRename(t, adir, "Other/plan.md", "Acme/plan.md")
	if err := a.Renamed(ctx, "Other/plan.md", "Acme/plan.md"); err != nil {
		t.Fatal(err)
	}
	mark := s.mark()
	syncOK(t, a)
	if ops := s.sent(mark); len(ops) != 1 || ops[0].Op != syncproto.OpModify {
		t.Fatalf("sent %+v, want one modify", ops)
	}
	syncOK(t, b)
	if got := diskFiles(t, bdir)["Acme/plan.md"]; got != "# plan\nedited\n" {
		t.Fatalf("B: %q", got)
	}
}
