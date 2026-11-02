package sync

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"testing"
	"time"

	"memobrain/apps/desktop/internal/crypto"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/syncproto"
	"memobrain/shared/vaultcrypto"
)

// liveRemote is a scriptRemote whose tree and changelog follow the accepted
// commits, like the real server: the migration reads the tree, and its moves
// come back as changes.
type liveRemote struct {
	*scriptRemote
	seq   int64
	files map[string]transport.TreeEntry
	trees int
}

func newLiveRemote() *liveRemote {
	return &liveRemote{scriptRemote: newScriptRemote(), files: map[string]transport.TreeEntry{}}
}

func (r *liveRemote) Tree(context.Context) (transport.Tree, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.trees++
	out := transport.Tree{AsOfSeq: r.seq}
	for _, f := range r.files {
		out.Items = append(out.Items, f)
	}
	sort.Slice(out.Items, func(i, j int) bool { return out.Items[i].FileID < out.Items[j].FileID })
	return out, nil
}

// record appends a change and updates the tree (r.mu held).
func (r *liveRemote) record(op, fileID, path string, rev int, hash string) {
	r.seq++
	r.changes = append(r.changes, transport.Change{Seq: r.seq, FileID: fileID, Op: op, Path: path, Rev: rev, BlobHash: hash, AuthorID: "other"})
	if op == "delete" {
		delete(r.files, fileID)
		return
	}
	f := r.files[fileID]
	f.FileID, f.Rev = fileID, rev
	if path != "" {
		f.Path = path
	}
	if hash != "" {
		f.Hash = hash
	}
	r.files[fileID] = f
}

func (r *liveRemote) Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	resp, err := r.scriptRemote.Commit(ctx, req)
	if err != nil {
		return resp, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, op := range req.Ops {
		if res := resp.Results[i]; res.Status == syncproto.StatusAccepted {
			r.record(string(op.Op), op.FileID, op.Path, res.Rev, op.BlobHash)
		}
	}
	return resp, nil
}

// add creates a file as another device would, with an enc1 or enc2 token.
func (r *liveRemote) add(t *testing.T, c *crypto.Cipher, path, content string, v2 bool) string {
	t.Helper()
	id := newFileID()
	h := putEncrypted(t, r.scriptRemote, c, id, 1, content)
	tok := pathToken(t, c, id, path, v2)
	r.mu.Lock()
	r.record("create", id, tok, 1, h)
	r.mu.Unlock()
	return id
}

// moveTo records a move of a file by another device, to an arbitrary token.
func (r *liveRemote) moveTo(fileID, token string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rev := r.cur[fileID] + 1
	r.cur[fileID] = rev
	r.record("move", fileID, token, rev, "")
}

func (r *liveRemote) versions() (enc1, enc2 int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, f := range r.files {
		switch vaultcrypto.PathTokenVersion(f.Path) {
		case 1:
			enc1++
		case 2:
			enc2++
		}
	}
	return enc1, enc2
}

// newMigrationEngine is newCryptoEngine on a liveRemote, with a small batch,
// a tiny spacing unless given, and a clock the test can move forward.
func newMigrationEngine(t *testing.T, live *liveRemote, batch int, spacing time.Duration) (*Engine, *crypto.Manager, *crypto.Cipher, string, *time.Time) {
	t.Helper()
	e, cm, c, dir := newCryptoEngine(t, live)
	clock := time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)
	cfg := e.cfg
	cfg.PathMigrationBatch, cfg.PathMigrationSpacing = batch, spacing
	if spacing == 0 {
		cfg.PathMigrationSpacing = time.Nanosecond
	}
	cfg.Now = func() time.Time { clock = clock.Add(time.Millisecond); return clock } // time goes by, slowly
	return New(cfg), cm, c, dir, &clock
}

func migrationMeta(t *testing.T, e *Engine) pathMigrationMeta {
	t.Helper()
	return e.loadMigration(context.Background(), lockCloud)
}

func strongPinned(t *testing.T, e *Engine) bool {
	t.Helper()
	v, _ := e.cfg.DB.Meta(context.Background(), metaPathV2Strong(lockCloud))
	return v == "1"
}

func mustSync(t *testing.T, e *Engine) {
	t.Helper()
	if err := e.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// ADR-0042 release N+1: with features.path_v2 on (the default) the enc1
// tokens of an unlocked vault are rewritten as enc2 in batches, as moves to
// the same path (same hmac1 key, base_rev, content untouched); a file with a
// local change waits, and only a tree with no enc1 left sets the strong pin.
func TestPathMigrationRewritesEnc1InBatches(t *testing.T) {
	ctx := context.Background()
	live := newLiveRemote()
	e, cm, c, dir, clock := newMigrationEngine(t, live, 2, 0)
	names := []string{"a.md", "b.md", "c.md", "d.md", "Notes/e.md"}
	ids := map[string]string{}
	for _, n := range names {
		ids[n] = live.add(t, c, n, "# "+n, false) // written by a release N client
	}
	ids["v2.md"] = live.add(t, c, "v2.md", "# v2", true)

	// Applied with the flag off (nothing migrates), then e.md gets a local
	// change that cannot be sent (parked): the migration must leave it.
	cm.SetPathV2(false)
	mustSync(t, e)
	if n := len(live.committed(syncproto.OpMove, "")); n != 0 || live.trees != 0 {
		t.Fatalf("flag off: %d moves, %d tree reads", n, live.trees)
	}
	parkedRow := parked(t, e, "Notes/e.md")
	parkedRow.State, parkedRow.Attempts, parkedRow.LastError = StateLocalModify, MaxAttempts, "parked by the test"
	if err := e.cfg.DB.PutFile(ctx, parkedRow); err != nil {
		t.Fatal(err)
	}
	cm.SetPathV2(true)

	moves := 0
	for range 6 {
		mustSync(t, e)
		got := len(live.committed(syncproto.OpMove, ""))
		if got-moves > 2 {
			t.Fatalf("a batch rewrote %d tokens, want at most 2", got-moves)
		}
		moves = got
	}
	if moves != 4 {
		t.Fatalf("%d moves, want the 4 free enc1 files", moves)
	}
	if enc1, enc2 := live.versions(); enc1 != 1 || enc2 != 5 {
		t.Fatalf("server tokens: %d enc1, %d enc2", enc1, enc2)
	}
	if strongPinned(t, e) || e.MigrationPending() {
		t.Fatal("strong pin or hurry with an enc1 token left")
	}
	if m := migrationMeta(t, e); m.Migrated != 4 || m.Remaining != 1 || m.Done {
		t.Fatalf("progress %+v", m)
	}
	for _, op := range live.committed(syncproto.OpMove, "") {
		var path string
		for n, id := range ids {
			if id == op.FileID {
				path = n
			}
		}
		_, key, _ := c.EncryptPath(op.FileID, path, false)
		if op.BaseRev == nil || *op.BaseRev != 1 || op.PathKey != key || !strings.HasPrefix(op.Path, "enc2:") || op.FileID == ids["Notes/e.md"] {
			t.Fatalf("migration move %+v for %s", op, path)
		}
		if v, _ := e.cfg.DB.Meta(ctx, metaPathV2File(op.FileID)); v != "1" {
			t.Fatalf("%s not pinned after its rewrite", path)
		}
		row := parked(t, e, path)
		if row.State != StateSynced || row.ServerRev != 2 || row.BaseRev != 2 {
			t.Fatalf("%s after its rewrite: %+v", path, row)
		}
	}

	// The local change is settled: the last token goes after the recheck delay.
	parkedRow.State, parkedRow.Attempts, parkedRow.LastError = StateSynced, 0, ""
	if err := e.cfg.DB.PutFile(ctx, parkedRow); err != nil {
		t.Fatal(err)
	}
	mustSync(t, e)
	if n := len(live.committed(syncproto.OpMove, "")); n != 4 {
		t.Fatalf("the recheck delay was not respected: %d moves", n)
	}
	*clock = clock.Add(pathMigrationRecheck + time.Second)
	mustSync(t, e)
	if strongPinned(t, e) {
		t.Fatal("strong pin set in the batch of the last token, before a tree confirmed it")
	}
	mustSync(t, e)
	if !strongPinned(t, e) || e.MigrationPending() {
		t.Fatal("no strong pin after the last enc1 token")
	}
	if m := migrationMeta(t, e); m.Migrated != 5 || m.Remaining != 0 || !m.Done {
		t.Fatalf("final progress %+v", m)
	}
	for _, n := range names {
		if readFile(t, dir, n) != "# "+n {
			t.Fatalf("%s changed: %q", n, readFile(t, dir, n))
		}
	}
	if readFile(t, dir, "v2.md") != "# v2" {
		t.Fatal("v2.md changed")
	}
	if q := quarantinedIDs(t, e); len(q) != 0 {
		t.Fatalf("quarantined %v", q)
	}
	trees := live.trees
	mustSync(t, e)
	if live.trees != trees {
		t.Fatal("the tree is read again after the strong pin")
	}
}

// After the strong pin every enc1 token of the vault is refused: a new file
// or a move with an enc1 token goes to quarantine and the local files stay
// as they are; new tokens stay enc2 even with the flag turned off.
func TestPathStrongPinRefusesEnc1(t *testing.T) {
	ctx := context.Background()
	live := newLiveRemote()
	e, cm, c, dir, _ := newMigrationEngine(t, live, 10, 0)
	idA := live.add(t, c, "a.md", "# a", false)
	for range 4 {
		mustSync(t, e)
	}
	if !strongPinned(t, e) {
		t.Fatal("vault not strongly pinned after its migration")
	}
	late := live.add(t, c, "late.md", "# late", false)
	live.moveTo(idA, pathToken(t, c, idA, "elsewhere.md", false))
	mustSync(t, e)
	if q := quarantinedIDs(t, e); !q[late] || !q[idA] {
		t.Fatalf("quarantined %v, want the new enc1 file and the enc1 move", q)
	}
	if readFile(t, dir, "a.md") != "# a" || exists(dir, "late.md") || exists(dir, "elsewhere.md") {
		t.Fatal("an enc1 token changed the local files after the strong pin")
	}
	if _, err := e.clearPath(ctx, late, pathToken(t, c, late, "late.md", false)); !errors.Is(err, ErrPathDowngrade) {
		t.Fatalf("enc1 after the strong pin: %v", err)
	}
	cm.SetPathV2(false)
	writeFile(t, dir, "new.md", []byte("# new"))
	mustSync(t, e)
	creates := live.committed(syncproto.OpCreate, "")
	if len(creates) != 1 || !strings.HasPrefix(creates[0].Path, "enc2:") {
		t.Fatalf("creates after the strong pin with the flag off: %+v", creates)
	}
}

// The migration is throttled (one batch per spacing) and resumable: the
// progress and the time of the next batch survive a restart of the engine.
func TestPathMigrationThrottledAndResumable(t *testing.T) {
	live := newLiveRemote()
	e, _, c, _, clock := newMigrationEngine(t, live, 1, time.Hour)
	for _, n := range []string{"a.md", "b.md", "c.md"} {
		live.add(t, c, n, "# "+n, false)
	}
	mustSync(t, e)
	if n := len(live.committed(syncproto.OpMove, "")); n != 1 || !e.MigrationPending() {
		t.Fatalf("first batch: %d moves, pending %t", n, e.MigrationPending())
	}
	mustSync(t, e)
	if n := len(live.committed(syncproto.OpMove, "")); n != 1 {
		t.Fatalf("a batch before the spacing: %d moves", n)
	}
	// A restart: a new engine on the same sync.db.
	cfg := e.cfg
	e = New(cfg)
	mustSync(t, e)
	if n := len(live.committed(syncproto.OpMove, "")); n != 1 {
		t.Fatalf("a restart skipped the spacing: %d moves", n)
	}
	*clock = clock.Add(time.Hour + time.Second)
	mustSync(t, e)
	if n := len(live.committed(syncproto.OpMove, "")); n != 2 {
		t.Fatalf("after the spacing: %d moves", n)
	}
	if m := migrationMeta(t, e); m.Migrated != 2 || m.Remaining != 1 {
		t.Fatalf("progress across the restart: %+v", m)
	}
	raw, _ := e.cfg.DB.Meta(context.Background(), metaPathMigration(lockCloud))
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil || m["next"] == nil {
		t.Fatalf("progress in sync.db: %q %v", raw, err)
	}
}

// With features.path_v2 off nothing is migrated (the tree is not even read),
// and a vault pinned to enc2 still writes enc2.
func TestPathMigrationNeedsFlag(t *testing.T) {
	live := newLiveRemote()
	e, cm, c, dir, _ := newMigrationEngine(t, live, 10, 0)
	cm.SetPathV2(false)
	live.add(t, c, "old.md", "# old", false)
	live.add(t, c, "new.md", "# new", true)
	for range 3 {
		mustSync(t, e)
	}
	if n := len(live.committed(syncproto.OpMove, "")); n != 0 || live.trees != 0 || strongPinned(t, e) {
		t.Fatalf("flag off: %d moves, %d tree reads", n, live.trees)
	}
	writeFile(t, dir, "mine.md", []byte("# mine"))
	mustSync(t, e)
	creates := live.committed(syncproto.OpCreate, "")
	if len(creates) != 1 || !strings.HasPrefix(creates[0].Path, "enc2:") {
		t.Fatalf("pinned vault with the flag off wrote %+v", creates)
	}
}

// A rewrite the server refuses as a conflict (the file changed there) leaves
// the file synced and unparked: nothing is lost, a later pass takes it again.
func TestPathMigrationConflictLeavesFile(t *testing.T) {
	ctx := context.Background()
	live := newLiveRemote()
	e, cm, c, _, _ := newMigrationEngine(t, live, 10, 0)
	id := live.add(t, c, "a.md", "# a", false)
	cm.SetPathV2(false)
	mustSync(t, e)
	live.mu.Lock()
	live.cur[id] = 2 // ahead of the tree and of the changelog
	live.mu.Unlock()
	cm.SetPathV2(true)
	mustSync(t, e)
	if live.conflicts != 1 {
		t.Fatalf("%d conflicts, want the rewrite refused once", live.conflicts)
	}
	row, ok, _ := e.cfg.DB.GetFileByID(ctx, id)
	if !ok || row.State != StateSynced || row.Attempts != 0 || row.LastError != "" || row.ServerRev != 1 {
		t.Fatalf("row after a refused rewrite: %+v", row)
	}
	if strongPinned(t, e) {
		t.Fatal("strong pin with an enc1 token left")
	}
}
