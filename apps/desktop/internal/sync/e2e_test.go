//go:build integration

package sync_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/crypto"
	"memobrain/apps/desktop/internal/store"
	syncpkg "memobrain/apps/desktop/internal/sync"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/syncproto"
)

type tokens struct{ user string }

func (t tokens) Token(context.Context) (string, error) { return issuer.Token(t.user), nil }

func newClient(t *testing.T, user string) *transport.Client {
	t.Helper()
	c, err := transport.New(serverURL, tokens{user}, &http.Client{Timeout: 2 * time.Minute}, "e2e")
	if err != nil {
		t.Fatal(err)
	}
	c.Retries = 1
	return c
}

// flaky delegates to the real server and can lose the answer of a commit.
type flaky struct {
	syncpkg.Remote
	loseNextCommit bool
	commits        int
}

func (f *flaky) Commit(ctx context.Context, req syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	f.commits++
	resp, err := f.Remote.Commit(ctx, req)
	if err == nil && f.loseNextCommit {
		f.loseNextCommit = false
		return syncproto.CommitResponse{}, errors.New("connection reset by peer")
	}
	return resp, err
}

// FolderShareRoots passes the share roots of the real server through, so the
// engine can recover from SHARE_ROOT_MOVE as with the application's remote.
func (f *flaky) FolderShareRoots(ctx context.Context) ([]string, error) {
	if r, ok := f.Remote.(syncpkg.FolderShareRooter); ok {
		return r.FolderShareRoots(ctx)
	}
	return nil, nil
}

type device struct {
	t         *testing.T
	name      string
	user      string
	dir       string
	fs        *vault.FS
	db        *syncpkg.DB
	eng       *syncpkg.Engine
	client    *transport.Client
	remote    *flaky
	conflicts []syncpkg.Conflict
	vaultID   string
	// cfg is the configuration eng was built with (a test may tune it and
	// build the engine again).
	cfg syncpkg.Config
	// overwritten records path and content each time a merge is about to replace local content.
	overwritten []string
}

// newDevice creates a local vault folder and an engine linked to cloudVault.
func newDevice(t *testing.T, user, name, cloudVault string, cipher syncpkg.Cipher) *device {
	t.Helper()
	return newDeviceRef(t, user, name, cloudVault, false, cipher)
}

// newDeviceRef is newDevice for a vault reference that may carry a share scope
// (transport.Ref), optionally read-only like the mount of a viewer.
func newDeviceRef(t *testing.T, user, name, cloudRef string, readOnly bool, cipher syncpkg.Cipher) *device {
	t.Helper()
	cloudVault := cloudRef
	ctx := context.Background()
	dir := t.TempDir()
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	sdb, err := store.Open(ctx, filepath.Join(dir, ".memobrain", "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	client := newClient(t, user)
	me, err := client.GetMe(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := client.RegisterDevice(ctx, transport.DeviceRegistration{Name: name, Platform: "linux"})
	if err != nil {
		t.Fatal(err)
	}
	d := &device{t: t, name: name, user: user, dir: dir, fs: fs, db: syncpkg.NewDB(sdb), client: client, vaultID: cloudVault}
	d.remote = &flaky{Remote: syncpkg.HTTPRemote{C: client, Vault: cloudVault}}
	cfg := syncpkg.Config{
		LocalID: name, FS: fs, DB: d.db, Remote: d.remote, DeviceID: dev.Id.String(), DeviceName: name, UserID: me.Id.String(), ReadOnly: readOnly,
		Logger: zerolog.Nop(), OnConflict: func(c syncpkg.Conflict) { d.conflicts = append(d.conflicts, c) },
		BeforeOverwrite: func(path string) { d.overwritten = append(d.overwritten, path+"\n"+d.read(path)) },
	}
	if cipher != nil {
		cfg.Cipher = cipher
	}
	d.cfg = cfg
	d.eng = syncpkg.New(cfg)
	return d
}

func createVault(t *testing.T, user, name string) string {
	t.Helper()
	v, err := newClient(t, user).CreateVault(context.Background(), name+"-"+fmt.Sprint(time.Now().UnixNano()), "shared", nil)
	if err != nil {
		t.Fatal(err)
	}
	return v.Id.String()
}

func (d *device) write(path, content string) {
	d.t.Helper()
	abs := filepath.Join(d.dir, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		d.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		d.t.Fatal(err)
	}
}

func (d *device) writeBytes(path string, b []byte) {
	d.t.Helper()
	abs := filepath.Join(d.dir, filepath.FromSlash(path))
	_ = os.MkdirAll(filepath.Dir(abs), 0o755)
	if err := os.WriteFile(abs, b, 0o644); err != nil {
		d.t.Fatal(err)
	}
}

func (d *device) read(path string) string {
	d.t.Helper()
	b, err := os.ReadFile(filepath.Join(d.dir, filepath.FromSlash(path)))
	if err != nil {
		d.t.Fatalf("%s: read %s: %v", d.name, path, err)
	}
	return string(b)
}

func (d *device) exists(path string) bool {
	_, err := os.Stat(filepath.Join(d.dir, filepath.FromSlash(path)))
	return err == nil
}

func (d *device) remove(path string) {
	d.t.Helper()
	if err := os.Remove(filepath.Join(d.dir, filepath.FromSlash(path))); err != nil {
		d.t.Fatal(err)
	}
}

func (d *device) rename(from, to string) {
	d.t.Helper()
	abs := filepath.Join(d.dir, filepath.FromSlash(to))
	_ = os.MkdirAll(filepath.Dir(abs), 0o755)
	if err := os.Rename(filepath.Join(d.dir, filepath.FromSlash(from)), abs); err != nil {
		d.t.Fatal(err)
	}
}

func (d *device) sync() {
	d.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if err := d.eng.Sync(ctx); err != nil {
		d.t.Fatalf("%s: sync: %v", d.name, err)
	}
}

// files lists the synchronized files on disk (paths -> content).
func (d *device) files() map[string]string {
	d.t.Helper()
	out := map[string]string{}
	_ = filepath.WalkDir(d.dir, func(p string, de os.DirEntry, err error) error {
		if err != nil || de.IsDir() {
			if de != nil && de.IsDir() && (de.Name() == ".memobrain" || de.Name() == ".trash") && p != d.dir {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(d.dir, p)
		b, _ := os.ReadFile(p)
		out[filepath.ToSlash(rel)] = string(b)
		return nil
	})
	return out
}

func sortedKeys(m map[string]string) []string {
	k := make([]string, 0, len(m))
	for p := range m {
		k = append(k, p)
	}
	sort.Strings(k)
	return k
}

func lines(n int, prefix string) string {
	var b strings.Builder
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&b, "%s %d\n", prefix, i)
	}
	return b.String()
}

func replaceLine(text string, n int, with string) string {
	ls := strings.SplitAfter(text, "\n")
	ls[n-1] = with + "\n"
	return strings.Join(ls, "")
}

func TestTwoDevicesConverge(t *testing.T) {
	v := createVault(t, "ada", "converge")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)

	a.write("Notes/one.md", "# One\nhello\n")
	a.write("Notes/two.md", "# Two\n")
	a.write("root.md", "root\n")
	a.write("img/pic.png", "not really a png")
	a.sync()

	b.sync() // first link: bootstrap from the manifest
	for p, want := range a.files() {
		if got := b.read(p); got != want {
			t.Errorf("%s: %q, want %q", p, got, want)
		}
	}
	if !b.exists("img/pic.png") {
		t.Fatal("attachment not synced")
	}

	// B edits, renames, deletes; A follows.
	b.write("Notes/one.md", "# One\nhello from b\n")
	b.rename("Notes/two.md", "Archive/two.md")
	b.remove("root.md")
	b.sync()
	a.sync()
	if got := a.read("Notes/one.md"); got != "# One\nhello from b\n" {
		t.Errorf("edit not propagated: %q", got)
	}
	if !a.exists("Archive/two.md") || a.exists("Notes/two.md") {
		t.Errorf("rename not propagated: %v", sortedKeys(a.files()))
	}
	if a.exists("root.md") {
		t.Error("deletion not propagated")
	}
	if fmt.Sprint(sortedKeys(a.files())) != fmt.Sprint(sortedKeys(b.files())) {
		t.Fatalf("devices diverge:\nA %v\nB %v", sortedKeys(a.files()), sortedKeys(b.files()))
	}
	// A deleted file went to the trash, not into the void.
	if !a.exists(".trash/root.md") {
		t.Error("remote deletion did not use the trash")
	}
}

func TestNonOverlappingEditsMerge(t *testing.T) {
	v := createVault(t, "ada", "merge")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	base := lines(8, "line")
	a.write("doc.md", base)
	a.sync()
	b.sync()

	a.write("doc.md", replaceLine(base, 1, "line 1 edited on A"))
	b.write("doc.md", replaceLine(base, 7, "line 7 edited on B"))
	a.sync()
	b.sync() // pulls A's change, merges, pushes the result
	a.sync()

	want := replaceLine(replaceLine(base, 1, "line 1 edited on A"), 7, "line 7 edited on B")
	for _, d := range []*device{a, b} {
		if got := d.read("doc.md"); got != want {
			t.Errorf("%s: %q, want %q", d.name, got, want)
		}
		if len(d.files()) != 1 {
			t.Errorf("%s: unexpected files %v", d.name, sortedKeys(d.files()))
		}
	}
	if len(a.conflicts)+len(b.conflicts) != 0 {
		t.Error("a clean merge must not raise a conflict")
	}
}

// §2.9: before the merged text replaces B's local version (which the server
// does not have), the application is asked to snapshot it.
func TestMergeAsksForASnapshotBeforeOverwriting(t *testing.T) {
	v := createVault(t, "ada", "snapshot")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	base := lines(8, "line")
	a.write("doc.md", base)
	a.sync()
	b.sync()
	if len(b.overwritten) != 0 {
		t.Fatalf("a plain download asked for a snapshot: %v", b.overwritten)
	}

	a.write("doc.md", replaceLine(base, 1, "line 1 edited on A"))
	ours := replaceLine(base, 7, "line 7 edited on B")
	b.write("doc.md", ours)
	a.sync()
	b.sync()
	if len(b.overwritten) != 1 || b.overwritten[0] != "doc.md\n"+ours {
		t.Fatalf("snapshots requested %q, want B's local version once", b.overwritten)
	}
}

func TestOverlappingEditsKeepServerVersionAndCopy(t *testing.T) {
	v := createVault(t, "ada", "conflict")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	base := lines(5, "row")
	a.write("plan.md", base)
	a.sync()
	b.sync()

	a.write("plan.md", replaceLine(base, 3, "row 3 by A"))
	b.write("plan.md", replaceLine(base, 3, "row 3 by B"))
	a.sync()
	b.sync()

	if got := b.read("plan.md"); got != replaceLine(base, 3, "row 3 by A") {
		t.Fatalf("the path must keep the server version, got %q", got)
	}
	var copyPath string
	for p, c := range b.files() {
		if p != "plan.md" {
			copyPath = p
			if c != replaceLine(base, 3, "row 3 by B") {
				t.Errorf("conflict copy lost B's text: %q", c)
			}
		}
	}
	if !strings.HasPrefix(copyPath, "plan (conflitto desktop ") || !strings.HasSuffix(copyPath, ").md") {
		t.Fatalf("conflict copy name: %q", copyPath)
	}
	if len(b.conflicts) != 1 || b.conflicts[0].Path != "plan.md" || b.conflicts[0].CopyPath != copyPath {
		t.Fatalf("conflict record: %+v", b.conflicts)
	}
	// The copy is a normal file: A receives it too, and nothing is lost.
	a.sync()
	b.sync()
	if fmt.Sprint(sortedKeys(a.files())) != fmt.Sprint(sortedKeys(b.files())) || len(a.files()) != 2 {
		t.Fatalf("devices diverge: A %v B %v", sortedKeys(a.files()), sortedKeys(b.files()))
	}
	if got := a.read(copyPath); got != replaceLine(base, 3, "row 3 by B") {
		t.Errorf("A's copy: %q", got)
	}
}

func TestFrontmatterKeysMerge(t *testing.T) {
	v := createVault(t, "ada", "frontmatter")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("n.md", "---\nstatus: draft\nowner: ada\n---\nbody\n")
	a.sync()
	b.sync()
	a.write("n.md", "---\nstatus: done\nowner: ada\n---\nbody\n")
	b.write("n.md", "---\nstatus: draft\nowner: ada\ntags: [x]\n---\nbody\n")
	a.sync()
	b.sync()
	want := "---\nstatus: done\nowner: ada\ntags: [x]\n---\nbody\n"
	if got := b.read("n.md"); got != want {
		t.Fatalf("B: %q", got)
	}
	a.sync()
	if got := a.read("n.md"); got != want {
		t.Fatalf("A: %q", got)
	}
}

func TestRenameVersusModifyApplyBoth(t *testing.T) {
	v := createVault(t, "ada", "renmod")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("old.md", "v1\n")
	a.sync()
	b.sync()

	a.rename("old.md", "new.md")
	b.write("old.md", "v1\nedited on B\n")
	a.sync()
	b.sync()
	a.sync()
	for _, d := range []*device{a, b} {
		if d.exists("old.md") || d.read("new.md") != "v1\nedited on B\n" {
			t.Errorf("%s: %v", d.name, sortedKeys(d.files()))
		}
	}
}

func TestDeleteVersusModifyModificationWins(t *testing.T) {
	v := createVault(t, "ada", "delmod")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("keep.md", "v1\n")
	a.sync()
	b.sync()

	a.remove("keep.md")
	b.write("keep.md", "v1\nprecious edit\n")
	a.sync() // deletes on the server
	b.sync() // modification wins: the file comes back
	a.sync()
	for _, d := range []*device{a, b} {
		if got := d.read("keep.md"); got != "v1\nprecious edit\n" {
			t.Errorf("%s: %q", d.name, got)
		}
	}
}

func TestCreateVersusCreateKeepsBoth(t *testing.T) {
	v := createVault(t, "ada", "crcr")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("same.md", "from A\n")
	b.write("same.md", "from B\n")
	a.sync()
	b.sync()
	a.sync()
	got := b.files()
	if len(got) != 2 || got["same.md"] != "from A\n" || got["same (1).md"] != "from B\n" {
		t.Fatalf("B: %v", got)
	}
	if fmt.Sprint(sortedKeys(a.files())) != fmt.Sprint(sortedKeys(b.files())) {
		t.Fatalf("diverged: A %v B %v", sortedKeys(a.files()), sortedKeys(b.files()))
	}
}

func TestRenameWithHintKeepsIdentityAcrossContentChange(t *testing.T) {
	v := createVault(t, "ada", "hint")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("topic.md", "see [[other]]\n")
	a.write("other.md", "x\n")
	a.sync()
	b.sync()

	// A rename that also rewrites the file (link updates): the hint keeps it one file.
	a.rename("topic.md", "subject.md")
	a.write("subject.md", "see [[other]] and more\n")
	if err := a.eng.Renamed(context.Background(), "topic.md", "subject.md"); err != nil {
		t.Fatal(err)
	}
	a.sync()
	b.sync()
	if b.exists("topic.md") || b.read("subject.md") != "see [[other]] and more\n" {
		t.Fatalf("B: %v", sortedKeys(b.files()))
	}
	// Server-side it is a move + modify of the same file: history has both.
	items, _, err := b.client.ListRevisions(context.Background(), v, fileIDOf(t, b, "subject.md"), 50, "")
	if err != nil {
		t.Fatal(err)
	}
	ops := []string{}
	for _, r := range items {
		ops = append(ops, r.Op)
	}
	if fmt.Sprint(ops) != "[modify move create]" {
		t.Fatalf("history ops: %v", ops)
	}
}

func fileIDOf(t *testing.T, d *device, path string) string {
	t.Helper()
	f, ok, err := d.db.GetFile(context.Background(), path)
	if err != nil || !ok {
		t.Fatalf("no sync row for %s: %v", path, err)
	}
	return f.FileID
}

func TestLostCommitResponseDoesNotDuplicate(t *testing.T) {
	v := createVault(t, "ada", "lost")
	a := newDevice(t, "ada", "laptop", v, nil)
	a.write("n.md", "hello\n")
	a.remote.loseNextCommit = true
	ctx := context.Background()
	if err := a.eng.Sync(ctx); err == nil {
		t.Fatal("the lost response should surface as an error")
	}
	a.sync() // retry: same operation id, so the server answers with the original result
	items, _, err := a.client.ListRevisions(ctx, v, fileIDOf(t, a, "n.md"), 10, "")
	if err != nil || len(items) != 1 {
		t.Fatalf("revisions: %d %v", len(items), err)
	}
	if f, _, _ := a.db.GetFile(ctx, "n.md"); f.State != syncpkg.StateSynced || f.ServerRev != 1 {
		t.Fatalf("row after retry: %+v", f)
	}
	// The pending operation is gone.
	if n, _ := a.db.OutboxCount(ctx); n != 0 {
		t.Fatalf("outbox has %d entries", n)
	}
}

func TestLargeFileUsesResumableUpload(t *testing.T) {
	v := createVault(t, "ada", "big")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	big := make([]byte, 33<<20)
	_, _ = rand.Read(big)
	a.writeBytes("video/clip.bin", big)
	a.sync()
	b.sync()
	got, err := os.ReadFile(filepath.Join(b.dir, "video", "clip.bin"))
	if err != nil || !bytes.Equal(got, big) {
		t.Fatalf("large file differs (%v)", err)
	}
}

func TestSettingsMergePerKey(t *testing.T) {
	v := createVault(t, "ada", "settings")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write(".memobrain/editor.json", `{"fontSize":15,"wrap":true}`)
	a.sync()
	b.sync()
	if !b.exists(".memobrain/editor.json") {
		t.Fatal("settings did not sync")
	}
	// Device-local state never syncs.
	a.write(".memobrain/workspace.json", `{"layout":1}`)
	a.sync()
	b.sync()
	if b.exists(".memobrain/workspace.json") {
		t.Fatal("workspace.json must stay on the device")
	}

	a.write(".memobrain/editor.json", `{"fontSize":18,"wrap":true}`)
	b.write(".memobrain/editor.json", `{"fontSize":15,"wrap":false}`)
	a.sync()
	b.sync()
	a.sync()
	for _, d := range []*device{a, b} {
		got := d.read(".memobrain/editor.json")
		if !strings.Contains(got, `"fontSize": 18`) || !strings.Contains(got, `"wrap": false`) {
			t.Errorf("%s: %s", d.name, got)
		}
	}
}

func TestBootstrapAfterCompaction(t *testing.T) {
	v := createVault(t, "ada", "compact")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("one.md", "1\n")
	a.sync()
	b.sync()

	// B is offline while A keeps working and the server compacts its changelog.
	a.write("two.md", "2\n")
	a.write("one.md", "1 edited\n")
	a.sync()
	pool := openDB(t)
	if _, err := pool.Exec(context.Background(), `UPDATE vaults SET compaction_seq = last_seq WHERE id = $1`, v); err != nil {
		t.Fatal(err)
	}
	b.sync() // 410 CURSOR_EXPIRED -> bootstrap from the manifest
	if b.read("one.md") != "1 edited\n" || b.read("two.md") != "2\n" {
		t.Fatalf("B after bootstrap: %v", b.files())
	}
}

// restorePoint is what a point-in-time restore of the cloud database brings a
// vault back to: its files and its changelog position. Revisions committed
// later are gone; blobs in object storage stay, as with a real PITR.
type restorePoint struct {
	vault      string
	lastSeq    int64
	totalBytes int64
	fileCount  int
	files      []restoredFile
}

type restoredFile struct {
	id, path, pathKey, kind string
	rev                     int
	seq                     int64
	blob                    *string
	size                    int64
	deleted                 bool
}

func takeRestorePoint(t *testing.T, vaultID string) restorePoint {
	t.Helper()
	ctx := context.Background()
	pool := openDB(t)
	rp := restorePoint{vault: vaultID}
	if err := pool.QueryRow(ctx, `SELECT last_seq, total_bytes, file_count FROM vaults WHERE id = $1`, vaultID).Scan(&rp.lastSeq, &rp.totalBytes, &rp.fileCount); err != nil {
		t.Fatal(err)
	}
	rows, err := pool.Query(ctx, `SELECT id::text, path, path_key, kind, current_rev, current_seq, blob_hash, size, is_deleted FROM files WHERE vault_id = $1`, vaultID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var f restoredFile
		if err := rows.Scan(&f.id, &f.path, &f.pathKey, &f.kind, &f.rev, &f.seq, &f.blob, &f.size, &f.deleted); err != nil {
			t.Fatal(err)
		}
		rp.files = append(rp.files, f)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return rp
}

func vaultLastSeq(t *testing.T, vaultID string) int64 {
	t.Helper()
	var n int64
	if err := openDB(t).QueryRow(context.Background(), `SELECT last_seq FROM vaults WHERE id = $1`, vaultID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// restore brings the vault back to the restore point in one transaction.
func (rp restorePoint) restore(t *testing.T) {
	t.Helper()
	ctx := context.Background()
	tx, err := openDB(t).Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ids := make([]string, 0, len(rp.files))
	for _, f := range rp.files {
		ids = append(ids, f.id)
	}
	type stmt struct {
		sql  string
		args []any
	}
	stmts := []stmt{
		{`DELETE FROM file_revisions WHERE vault_id = $1 AND seq > $2`, []any{rp.vault, rp.lastSeq}},
		{`DELETE FROM files WHERE vault_id = $1 AND id::text <> ALL($2::text[])`, []any{rp.vault, ids}},
		{`UPDATE vaults SET last_seq = $2, total_bytes = $3, file_count = $4 WHERE id = $1`, []any{rp.vault, rp.lastSeq, rp.totalBytes, rp.fileCount}},
	}
	for _, f := range rp.files {
		stmts = append(stmts, stmt{`UPDATE files SET path = $2, path_key = $3, kind = $4, current_rev = $5, current_seq = $6, blob_hash = $7, size = $8, is_deleted = $9 WHERE id = $1`,
			[]any{f.id, f.path, f.pathKey, f.kind, f.rev, f.seq, f.blob, f.size, f.deleted}})
	}
	for _, st := range stmts {
		if _, err := tx.Exec(ctx, st.sql, st.args...); err != nil {
			t.Fatalf("restore: %s: %v", st.sql, err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

// The cloud database goes back to a point in time before the last changes
// (a restored backup): the devices, now ahead of it, republish what it lost
// instead of taking its older content or trashing the files it no longer
// lists (ADR-0046), and the server ends up with the newest content again.
func TestBootstrapAfterServerRestore(t *testing.T) {
	v := createVault(t, "ada", "restore")
	a := newDevice(t, "ada", "laptop", v, nil)
	b := newDevice(t, "ada", "desktop", v, nil)
	a.write("one.md", "1\n")
	a.write("keep.md", "untouched\n")
	a.sync()
	b.sync()
	rp := takeRestorePoint(t, v)

	// After the backup: an edit and a new file, which both devices receive,
	// then a file of B's that A has not pulled yet (B's cursor is the furthest).
	a.write("one.md", "1 edited after the backup\n")
	a.write("notes/two.md", "2 created after the backup\n")
	a.sync()
	b.sync()
	b.write("three.md", "3 created on B after the backup\n")
	b.sync()
	want := map[string]string{"one.md": "1 edited after the backup\n", "keep.md": "untouched\n", "notes/two.md": "2 created after the backup\n"}
	if got := a.files(); !maps.Equal(got, want) {
		t.Fatalf("A before the restore: %v", got)
	}
	want["three.md"] = "3 created on B after the backup\n"
	if got := b.files(); !maps.Equal(got, want) {
		t.Fatalf("B before the restore: %v", got)
	}

	rp.restore(t)
	a.sync() // 410 CURSOR_EXPIRED with last_seq -> bootstrap, republish one.md and notes/two.md
	if lastSeq := vaultLastSeq(t, v); cursorOf(t, b) <= lastSeq {
		t.Fatalf("B's cursor %d is not ahead of the server (%d): it would not see the restore", cursorOf(t, b), lastSeq)
	}
	b.sync() // the same: finds A's republished files identical, uploads three.md again
	a.sync() // and A receives it
	for _, d := range []*device{a, b} {
		if got := d.files(); !maps.Equal(got, want) {
			t.Errorf("%s after the restore: %v", d.name, got)
		}
		if len(d.overwritten) != 0 || len(d.conflicts) != 0 {
			t.Errorf("%s: overwritten %q, conflicts %+v", d.name, d.overwritten, d.conflicts)
		}
	}

	// A device linked now gets the newest content from the server alone.
	c := newDevice(t, "ada", "tablet", v, nil)
	c.sync()
	if got := c.files(); !maps.Equal(got, want) {
		t.Fatalf("new device after the restore: %v", got)
	}
}

func TestAdoptsIdenticalLocalFilesOnFirstLink(t *testing.T) {
	v := createVault(t, "ada", "adopt")
	a := newDevice(t, "ada", "laptop", v, nil)
	a.write("a.md", "same\n")
	a.write("b.md", "same b\n")
	a.sync()

	// A copy of the vault on a new device (e.g. restored from a backup): linking must not duplicate anything.
	b := newDevice(t, "ada", "restored", v, nil)
	b.write("a.md", "same\n")
	b.write("b.md", "different here\n")
	b.sync()
	files := b.files()
	if files["a.md"] != "same\n" {
		t.Errorf("a.md: %q", files["a.md"])
	}
	if files["b.md"] != "same b\n" || files["b (1).md"] != "different here\n" {
		t.Errorf("b.md differs from the server's: %v", files)
	}
	items, _, _ := a.client.ListRevisions(context.Background(), v, fileIDOf(t, b, "a.md"), 10, "")
	if len(items) != 1 {
		t.Errorf("adopting an identical file created %d revisions", len(items))
	}
}

func TestDeviceThatCannotSeeServerKeepsLocalWork(t *testing.T) {
	v := createVault(t, "ada", "offline")
	a := newDevice(t, "ada", "laptop", v, nil)
	a.write("n.md", "v1\n")
	a.sync()
	// The network disappears: the engine reports an error but keeps the change pending.
	broken, err := transport.New("http://127.0.0.1:1", tokens{"ada"}, &http.Client{Timeout: time.Second}, "e2e")
	if err != nil {
		t.Fatal(err)
	}
	broken.Retries = 0
	saved := a.remote.Remote
	a.remote.Remote = syncpkg.HTTPRemote{C: broken, Vault: v}
	a.write("n.md", "v2 written offline\n")
	if err := a.eng.Sync(context.Background()); err == nil {
		t.Fatal("expected a network error")
	}
	if st := a.eng.Status(); st.Phase != syncpkg.PhaseOffline || st.Pending != 1 {
		t.Fatalf("status: %+v", st)
	}
	a.remote.Remote = saved
	a.sync()
	b := newDevice(t, "ada", "desktop", v, nil)
	b.sync()
	if b.read("n.md") != "v2 written offline\n" {
		t.Fatalf("offline edit lost: %q", b.read("n.md"))
	}
}

func TestPrivateVaultRoundTripAndOpacity(t *testing.T) {
	ctx := context.Background()
	mgrA := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	mat, err := mgrA.NewMaterial("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	client := newClient(t, "ada")
	pv, err := client.CreateVault(ctx, fmt.Sprintf("diary-%d", time.Now().UnixNano()), "private", mat.Envelopes)
	if err != nil {
		t.Fatal(err)
	}
	if err := mgrA.Adopt(pv.Id.String(), mat); err != nil {
		t.Fatal(err)
	}
	a := newDevice(t, "ada", "laptop", pv.Id.String(), mgrA.Cipher(pv.Id.String()))
	secret := "the treasure is buried under the old oak tree"
	a.write("Journal/day one.md", "# Day one\n"+secret+"\n")
	a.write("Journal/day two.md", "# Day two\n")
	a.sync()

	// The server stores nothing readable: opaque paths, ciphertext blobs.
	tree, err := client.GetTree(ctx, pv.Id.String())
	if err != nil || len(tree.Items) != 2 {
		t.Fatalf("tree: %v %v", tree, err)
	}
	for _, it := range tree.Items {
		// enc2 by default since ADR-0042 release N+1 (bound to the file).
		if !strings.HasPrefix(it.Path, "enc2:") || strings.Contains(it.Path, "Journal") || it.Kind != "opaque" {
			t.Errorf("server sees a readable entry: %+v", it)
		}
		var blob bytes.Buffer
		if _, err := client.GetBlob(ctx, pv.Id.String(), it.Hash, &blob); err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(blob.Bytes(), []byte("treasure")) || !bytes.HasPrefix(blob.Bytes(), []byte("NDS1")) {
			t.Errorf("blob of %s is not ciphertext", it.FileID)
		}
	}

	// A new device unlocks with the passphrase and reads everything.
	envs, err := client.GetKeyEnvelopes(ctx, pv.Id.String())
	if err != nil {
		t.Fatal(err)
	}
	mgrB := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	b := newDevice(t, "ada", "desktop", pv.Id.String(), mgrB.Cipher(pv.Id.String()))
	if err := b.eng.Sync(ctx); !errors.Is(err, syncpkg.ErrLocked) {
		t.Fatalf("a locked vault must not sync, got %v", err)
	}
	if _, err := mgrB.Unlock(pv.Id.String(), envs, "wrong passphrase here", false); !errors.Is(err, crypto.ErrWrongSecret) {
		t.Fatalf("wrong passphrase: %v", err)
	}
	if _, err := mgrB.Unlock(pv.Id.String(), envs, "correct horse battery staple", false); err != nil {
		t.Fatal(err)
	}
	b.sync()
	if got := b.read("Journal/day one.md"); !strings.Contains(got, secret) {
		t.Fatalf("B reads %q", got)
	}

	// Edits, renames and deletes round-trip through the encrypted protocol, merges included.
	base := lines(6, "entry")
	a.write("Journal/long.md", base)
	a.sync()
	b.sync()
	a.write("Journal/long.md", replaceLine(base, 1, "entry 1 by A"))
	b.write("Journal/long.md", replaceLine(base, 6, "entry 6 by B"))
	a.sync()
	b.sync()
	a.sync()
	want := replaceLine(replaceLine(base, 1, "entry 1 by A"), 6, "entry 6 by B")
	if a.read("Journal/long.md") != want || b.read("Journal/long.md") != want {
		t.Fatalf("encrypted merge: A %q B %q", a.read("Journal/long.md"), b.read("Journal/long.md"))
	}
	b.rename("Journal/day two.md", "Archive/day two.md")
	a.remove("Journal/day one.md")
	b.sync()
	a.sync()
	b.sync()
	if !a.exists("Archive/day two.md") || b.exists("Journal/day one.md") || b.exists("Journal/day two.md") {
		t.Fatalf("A %v / B %v", sortedKeys(a.files()), sortedKeys(b.files()))
	}

	// A device holding the wrong key can never decrypt: tampering/foreign keys fail loudly.
	mgrC := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	other, _ := mgrC.NewMaterial("another passphrase entirely")
	_ = mgrC.Adopt(pv.Id.String(), other)
	c := newDevice(t, "ada", "intruder", pv.Id.String(), mgrC.Cipher(pv.Id.String()))
	c.sync() // paths cannot be decrypted: every entry is skipped, nothing is written
	if len(c.files()) != 0 {
		t.Fatalf("a device with the wrong key wrote files: %v", sortedKeys(c.files()))
	}
}

func TestPrivateVaultRecoveryKey(t *testing.T) {
	ctx := context.Background()
	mgr := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	mat, _ := mgr.NewMaterial("correct horse battery staple")
	client := newClient(t, "ada")
	pv, err := client.CreateVault(ctx, fmt.Sprintf("rk-%d", time.Now().UnixNano()), "private", mat.Envelopes)
	if err != nil {
		t.Fatal(err)
	}
	_ = mgr.Adopt(pv.Id.String(), mat)
	a := newDevice(t, "ada", "laptop", pv.Id.String(), mgr.Cipher(pv.Id.String()))
	a.write("n.md", "keep me\n")
	a.sync()

	// The passphrase is lost: the recovery key unlocks, then a new passphrase is set on the server.
	envs, _ := client.GetKeyEnvelopes(ctx, pv.Id.String())
	mgr2 := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	requires, err := mgr2.Unlock(pv.Id.String(), envs, mat.RecoveryKey, true)
	if err != nil || !requires {
		t.Fatalf("recovery unlock: %v %v", requires, err)
	}
	env, err := mgr2.NewPassphraseEnvelope(pv.Id.String(), "a brand new passphrase!")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.PutKeyEnvelope(ctx, pv.Id.String(), env); err != nil {
		t.Fatal(err)
	}
	b := newDevice(t, "ada", "desktop", pv.Id.String(), mgr2.Cipher(pv.Id.String()))
	b.sync()
	if b.read("n.md") != "keep me\n" {
		t.Fatalf("data not recovered: %q", b.read("n.md"))
	}
	// And the new passphrase works on a fresh device with the envelopes now on the server.
	envs, _ = client.GetKeyEnvelopes(ctx, pv.Id.String())
	mgr3 := crypto.NewManager(crypto.Options{Store: crypto.NewMemoryStore(), KDFTarget: time.Millisecond})
	if _, err := mgr3.Unlock(pv.Id.String(), envs, "a brand new passphrase!", false); err != nil {
		t.Fatalf("new passphrase: %v", err)
	}
	if _, err := mgr3.Unlock(pv.Id.String(), envs, "correct horse battery staple", false); err == nil {
		t.Fatal("the old passphrase must stop working")
	}
	_ = io.EOF
}
