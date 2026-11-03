package sync

// The lifecycle of mounts and of linked vaults when the server says NOT_FOUND: only a NOT_FOUND
// about the share or the vault itself, confirmed with the server for the signed-in account, ends
// a mount (revoked) or disconnects a folder (cloud vault deleted elsewhere). A switch of account
// never judges the mounts of the other one.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	stdsync "sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/syncproto"
)

const (
	mountShareA = "0198f1c2-aaaa-7bbb-8ccc-000000000031"
	mountShareB = "0198f1c2-aaaa-7bbb-8ccc-000000000032"
	mountCloud  = "0198f1c2-aaaa-7bbb-8ccc-000000000033"
	otherUser   = "0198f1c2-aaaa-7bbb-8ccc-0000000000ee"
	testServer  = "http://test"
)

// accountSession is signed in on testServer with a client of a test server, as an account that
// can be switched.
type accountSession struct {
	c    *transport.Client
	mu   stdsync.Mutex
	user string
}

func (s *accountSession) Client() *transport.Client { return s.c }

func (s *accountSession) Info() (SessionInfo, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return SessionInfo{ServerURL: testServer, DeviceID: "d", UserID: s.user, DeviceName: "test"}, true
}

func (s *accountSession) switchTo(user string) {
	s.mu.Lock()
	s.user = user
	s.mu.Unlock()
}

// accountCloud is the part of the cloud API that confirms a NOT_FOUND: the account's accepted
// shares and its live vaults.
type accountCloud struct {
	mu     stdsync.Mutex
	shares map[string]bool // live shares of the signed-in account
	vaults map[string]bool // live vaults
	calls  []string
}

func newAccountCloud(t *testing.T) (*accountCloud, *accountSession) {
	t.Helper()
	ac := &accountCloud{shares: map[string]bool{}, vaults: map[string]bool{}}
	srv := httptest.NewServer(ac)
	t.Cleanup(srv.Close)
	c, err := transport.New(srv.URL, staticToken{}, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	c.Retries = 0
	return ac, &accountSession{c: c, user: lifeOwner}
}

func (ac *accountCloud) set(shares, vaults map[string]bool) {
	ac.mu.Lock()
	defer ac.mu.Unlock()
	if shares != nil {
		ac.shares = shares
	}
	if vaults != nil {
		ac.vaults = vaults
	}
}

func (ac *accountCloud) called(call string) int {
	ac.mu.Lock()
	defer ac.mu.Unlock()
	n := 0
	for _, c := range ac.calls {
		if c == call {
			n++
		}
	}
	return n
}

func (ac *accountCloud) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ac.mu.Lock()
	defer ac.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, transport.BasePath)
	ac.calls = append(ac.calls, r.Method+" "+path)
	reply := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	switch {
	case r.Method == http.MethodGet && path == "/shared-with-me":
		out := []any{}
		for id := range ac.shares {
			out = append(out, map[string]any{
				"share_id": id, "vault_id": mountCloud, "scope": "share:" + id, "permission": PermEditor,
				"display_name": "Team", "owner_name": "ada", "resource_type": "folder",
			})
		}
		reply(out)
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/vaults/") && ac.vaults[strings.TrimPrefix(path, "/vaults/")]:
		id := strings.TrimPrefix(path, "/vaults/")
		reply(map[string]any{
			"id": id, "owner_id": lifeOwner, "name": "Notes", "kind": "shared", "last_seq": 1,
			"total_bytes": 0, "file_count": 0, "created_at": "2026-10-01T10:00:00Z",
		})
	default:
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "about:blank", "title": "NOT_FOUND", "status": 404, "code": "NOT_FOUND"})
	}
}

func notFound(what string) error {
	return &transport.ProblemError{StatusCode: http.StatusNotFound, Problem: syncproto.Problem{
		Status: http.StatusNotFound, Code: syncproto.CodeNotFound, Detail: what,
	}}
}

// blobHash is the digest of the one file pullRemote lists.
const blobHash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

// pullRemote lists one file whose blob answers NOT_FOUND (moved out of a share after the change
// was listed). With gone set, the tree and the changelog answer NOT_FOUND as well: the share or
// the vault itself is not found.
type pullRemote struct {
	idleRemote
	gone atomic.Bool
}

func (r *pullRemote) Tree(context.Context) (transport.Tree, error) {
	if r.gone.Load() {
		return transport.Tree{}, notFound("share")
	}
	return transport.Tree{AsOfSeq: 1, Items: []transport.TreeEntry{{Path: "a.md", FileID: "f1", Rev: 1, Hash: blobHash, Size: 5}}}, nil
}

func (r *pullRemote) Changes(context.Context, int64, string, int) (transport.Changes, error) {
	if r.gone.Load() {
		return transport.Changes{}, notFound("share")
	}
	return transport.Changes{NextSeq: 1, Items: []transport.Change{{Seq: 1, FileID: "f1", Op: "create", Path: "a.md", Rev: 1, BlobHash: blobHash, Size: 5}}}, nil
}

func (r *pullRemote) Download(context.Context, string, io.Writer) error { return notFound("blob") }

// recorder keeps the events of a manager.
type recorder struct {
	mu       stdsync.Mutex
	names    []string
	statuses []Status
}

func (r *recorder) emit(name string, payload any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.names = append(r.names, name)
	if st, ok := payload.(Status); ok && name == EventStatus.Name() {
		r.statuses = append(r.statuses, st)
	}
}

func (r *recorder) count(name string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, x := range r.names {
		if x == name {
			n++
		}
	}
	return n
}

func (r *recorder) status(match func(Status) bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.statuses {
		if match(s) {
			return true
		}
	}
	return false
}

// mountAt makes dir the mount of a share, accepted by user on testServer.
func mountAt(t *testing.T, dir, share, user string) *vault.FS {
	t.Helper()
	mm := MountMeta{ShareID: share, CloudVaultID: mountCloud, Scope: "share:" + share, Permission: PermEditor, Name: "Team", OwnerName: "ada", ResourceType: "folder"}
	if err := PrepareMount(context.Background(), dir, mm, SessionInfo{ServerURL: testServer, DeviceID: "d", UserID: user}); err != nil {
		t.Fatal(err)
	}
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	return fs
}

func revoked(t *testing.T, dir string) bool {
	t.Helper()
	mm, ok, err := ReadMount(context.Background(), dir)
	if err != nil || !ok {
		t.Fatalf("read mount %s: %v %v", dir, ok, err)
	}
	return mm.Revoked
}

// The wrapper that marks the whole-vault NOT_FOUND keeps what the remote can do besides Remote
// (the folder shares of a vault, ADR-0040), and only marks the tree and the changelog.
func TestScopedRemoteMarksOnlyTheWholeVaultEndpoints(t *testing.T) {
	if _, ok := scoped(newFolderServer()).(FolderShareRooter); !ok {
		t.Fatal("a remote that lists folder shares lost it once wrapped")
	}
	if _, ok := scoped(idleRemote{}).(FolderShareRooter); ok {
		t.Fatal("a remote that lists no folder shares gained it once wrapped")
	}
	rem := &pullRemote{}
	rem.gone.Store(true)
	r := scoped(rem)
	ctx := context.Background()
	if _, err := r.Changes(ctx, 0, "", 10); !isScopeNotFound(err) || !transport.IsCode(err, syncproto.CodeNotFound) {
		t.Fatalf("changes: %v", err)
	}
	if _, err := r.Tree(ctx); !isScopeNotFound(err) {
		t.Fatalf("tree: %v", err)
	}
	if err := r.Download(ctx, blobHash, io.Discard); isScopeNotFound(err) || !transport.IsCode(err, syncproto.CodeNotFound) {
		t.Fatalf("download: %v", err)
	}
}

// A blob that answers NOT_FOUND (its file left the share after the change was listed) is an
// ordinary error of the cycle: the share is not marked revoked, the server is not even asked.
func TestMountBlobNotFoundIsNotARevocation(t *testing.T) {
	cloud, sess := newAccountCloud(t)
	cloud.set(map[string]bool{mountShareA: true}, nil)
	rec := &recorder{}
	m := NewManager(sess, nil, zerolog.Nop(), rec.emit)
	rem := &pullRemote{}
	m.remoteFor = func(string) Remote { return rem }
	dir := t.TempDir()
	attach(t, m, "mount", mountAt(t, dir, mountShareA, lifeOwner))

	waitTill(t, "a failed cycle", func() bool {
		return rec.status(func(s Status) bool { return s.VaultID == "mount" && s.Phase == PhaseError })
	})
	time.Sleep(200 * time.Millisecond) // the loop has decided by now
	if n := rec.count(EventMountRevoked.Name()); n != 0 {
		t.Fatalf("a blob NOT_FOUND revoked the mount (%d events)", n)
	}
	if revoked(t, dir) || m.ReadOnly(context.Background(), "mount") {
		t.Fatal("a blob NOT_FOUND marked the mount revoked")
	}
	if n := cloud.called("GET /shared-with-me"); n != 0 {
		t.Fatalf("a blob NOT_FOUND asked for the shares (%d times)", n)
	}
}

// A NOT_FOUND of the share's changelog marks the mount revoked only once the server confirms that
// the share is gone from the account's mounts.
func TestMountRevokedOnlyWhenTheShareIsGone(t *testing.T) {
	cloud, sess := newAccountCloud(t)
	cloud.set(map[string]bool{mountShareA: true}, nil)
	rec := &recorder{}
	m := NewManager(sess, nil, zerolog.Nop(), rec.emit)
	rem := &pullRemote{}
	rem.gone.Store(true)
	m.remoteFor = func(string) Remote { return rem }
	dir := t.TempDir()
	attach(t, m, "mount", mountAt(t, dir, mountShareA, lifeOwner))

	waitTill(t, "the share to be checked", func() bool { return cloud.called("GET /shared-with-me") > 0 })
	time.Sleep(200 * time.Millisecond)
	if rec.count(EventMountRevoked.Name()) != 0 || revoked(t, dir) {
		t.Fatal("a share still listed by the server was marked revoked")
	}

	cloud.set(map[string]bool{}, nil) // the owner revokes it
	if err := m.SyncNow("mount"); err != nil {
		t.Fatal(err)
	}
	waitTill(t, "the revocation", func() bool { return rec.count(EventMountRevoked.Name()) == 1 })
	if !revoked(t, dir) || !m.ReadOnly(context.Background(), "mount") {
		t.Fatal("a share gone from the server must leave the mount revoked and read-only")
	}
}

// After a switch of account, the open mount of the first account is not revoked by the NOT_FOUND
// the other account gets for its share.
func TestMountOfAnotherAccountIsNotRevokedByTheLoop(t *testing.T) {
	cloud, sess := newAccountCloud(t)
	rec := &recorder{}
	m := NewManager(sess, nil, zerolog.Nop(), rec.emit)
	rem := &pullRemote{}
	rem.gone.Store(true)
	m.remoteFor = func(string) Remote { return rem }
	dir := t.TempDir()
	attach(t, m, "mount", mountAt(t, dir, mountShareA, otherUser))

	waitTill(t, "a failed cycle", func() bool {
		return rec.status(func(s Status) bool { return s.VaultID == "mount" && s.Phase == PhaseError })
	})
	time.Sleep(200 * time.Millisecond)
	if rec.count(EventMountRevoked.Name()) != 0 || revoked(t, dir) {
		t.Fatal("the mount of another account was marked revoked")
	}
	if n := cloud.called("GET /shared-with-me"); n != 0 {
		t.Fatalf("the shares of the wrong account were asked for (%d times)", n)
	}
}

// ReconcileMounts and Mounts judge only the mounts of the signed-in account: the other account's
// stay as they are, and are its own again when it signs back in.
func TestReconcileMountsIgnoresTheMountsOfAnotherAccount(t *testing.T) {
	ctx := context.Background()
	cloud, sess := newAccountCloud(t)
	m := NewManager(sess, nil, zerolog.Nop(), nil)
	m.remoteFor = func(string) Remote { return idleRemote{} }
	mountsDir := t.TempDir()
	mine := filepath.Join(mountsDir, mountShareA)
	theirs := filepath.Join(mountsDir, mountShareB)
	mountAt(t, mine, mountShareA, lifeOwner)
	attach(t, m, "theirs", mountAt(t, theirs, mountShareB, otherUser)) // open, too

	// Signed in as lifeOwner, who has no share any more: only lifeOwner's mount is revoked.
	n, err := m.ReconcileMounts(ctx, mountsDir)
	if err != nil {
		t.Fatal(err)
	}
	if n != 1 || !revoked(t, mine) {
		t.Fatalf("changed = %d, own mount revoked = %v", n, revoked(t, mine))
	}
	if revoked(t, theirs) || m.ReadOnly(ctx, "theirs") {
		t.Fatal("the mount of another account was marked revoked")
	}
	states, err := m.Mounts(ctx, mountsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 1 || states[0].ShareID != mountShareA || !states[0].Revoked {
		t.Fatalf("mounts = %+v, want only the own revoked one", states)
	}

	// Back to the other account, whose share lives: its mount is listed, untouched; lifeOwner's
	// revoked mount is not its business.
	sess.switchTo(otherUser)
	cloud.set(map[string]bool{mountShareB: true}, nil)
	n, err = m.ReconcileMounts(ctx, mountsDir)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 || revoked(t, theirs) || !revoked(t, mine) {
		t.Fatalf("after switching back: changed = %d, theirs revoked = %v, mine revoked = %v", n, revoked(t, theirs), revoked(t, mine))
	}
	states, err = m.Mounts(ctx, mountsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 1 || states[0].ShareID != mountShareB || states[0].Revoked || !states[0].Mounted || states[0].VaultID != "theirs" {
		t.Fatalf("mounts = %+v, want only the other account's live one", states)
	}
}

// A mount that cannot be read is reported, and the others are reconciled all the same.
func TestReconcileMountsReportsAFailedMountAndHandlesTheOthers(t *testing.T) {
	if runtime.GOOS == "js" {
		t.Skip("the browser core keeps sync.db in sqlite-wasm, not in the file written here")
	}
	ctx := context.Background()
	_, sess := newAccountCloud(t)
	m := NewManager(sess, nil, zerolog.Nop(), nil)
	mountsDir := t.TempDir()
	good := filepath.Join(mountsDir, mountShareA)
	mountAt(t, good, mountShareA, lifeOwner)
	bad := filepath.Join(mountsDir, mountShareB, ".memobrain")
	if err := os.MkdirAll(bad, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bad, "sync.db"), []byte("this is not a database, not even close to one"), 0o644); err != nil {
		t.Fatal(err)
	}
	n, err := m.ReconcileMounts(ctx, mountsDir)
	if err == nil || !strings.Contains(err.Error(), mountShareB) {
		t.Fatalf("err = %v, want the broken mount reported", err)
	}
	if n != 1 || !revoked(t, good) {
		t.Fatalf("changed = %d: the readable mount must be reconciled anyway", n)
	}
	// No mounts directory yet: nothing to do, no error.
	if n, err := m.ReconcileMounts(ctx, filepath.Join(mountsDir, "missing")); n != 0 || err != nil {
		t.Fatalf("missing directory: %d, %v", n, err)
	}
}

// ownLinked is a vault of one's own linked to lifeVault by user on testServer, with a note.
func ownLinked(t *testing.T, user string) *vault.FS {
	t.Helper()
	fs := linkTo(t, lifeVault, "")
	db, closeDB, err := openSyncDB(context.Background(), fs.Root())
	if err != nil {
		t.Fatal(err)
	}
	defer closeDB()
	for k, v := range map[string]string{MetaUserID: user, MetaServerURL: testServer, MetaDeviceID: "d"} {
		if err := db.SetMeta(context.Background(), k, v); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(fs.Root(), "Plan.md"), []byte("# keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	return fs
}

// A vault deleted from the console or from another device: the changelog answers NOT_FOUND, the
// server confirms the vault is gone, and the folder is disconnected with its files, as when the
// delete is made from this device.
func TestCloudVaultDeletedElsewhereUnlinksTheFolder(t *testing.T) {
	ctx := context.Background()
	cloud, sess := newAccountCloud(t)
	rec := &recorder{}
	m := NewManager(sess, nil, zerolog.Nop(), rec.emit)
	rem := &pullRemote{}
	rem.gone.Store(true)
	m.remoteFor = func(string) Remote { return rem }
	fs := ownLinked(t, lifeOwner)
	attach(t, m, "own", fs)

	waitTill(t, "the folder to be disconnected", func() bool { return rec.count(EventCloudVaultDeleted.Name()) == 1 })
	if info, err := m.Info(ctx, "own"); err != nil || info.Linked {
		t.Fatalf("still linked after the cloud vault was deleted: %+v, %v", info, err)
	}
	if b, err := os.ReadFile(filepath.Join(fs.Root(), "Plan.md")); err != nil || string(b) != "# keep me" {
		t.Fatalf("local file: %q, %v", b, err)
	}
	if !rec.status(func(s Status) bool { return s.VaultID == "own" && s.Error == CloudVaultDeletedMessage }) {
		t.Fatal("the status does not say why the folder was disconnected")
	}
	if cloud.called("GET /vaults/"+lifeVault) == 0 {
		t.Fatal("the delete was not confirmed with the server")
	}
}

// A NOT_FOUND is not a delete unless the server confirms it for the account that linked the
// vault: a vault still there, a vault linked by another account, a blob NOT_FOUND all leave the
// link as it is.
func TestCloudVaultNotFoundIsNotADeleteUnlessConfirmed(t *testing.T) {
	for _, tc := range []struct {
		name      string
		live      bool // the server still has the vault
		linkedBy  string
		scopeGone bool
		asked     bool // GET /vaults/{id} is expected
	}{
		{name: "vault still there", live: true, linkedBy: lifeOwner, scopeGone: true, asked: true},
		{name: "another account", linkedBy: otherUser, scopeGone: true},
		{name: "a blob only", linkedBy: lifeOwner},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			cloud, sess := newAccountCloud(t)
			cloud.set(nil, map[string]bool{lifeVault: tc.live})
			rec := &recorder{}
			m := NewManager(sess, nil, zerolog.Nop(), rec.emit)
			rem := &pullRemote{}
			rem.gone.Store(tc.scopeGone)
			m.remoteFor = func(string) Remote { return rem }
			attach(t, m, "own", ownLinked(t, tc.linkedBy))

			waitTill(t, "a failed cycle", func() bool {
				return rec.status(func(s Status) bool { return s.VaultID == "own" && s.Phase == PhaseError })
			})
			if tc.asked {
				waitTill(t, "the server to be asked", func() bool { return cloud.called("GET /vaults/"+lifeVault) > 0 })
			}
			time.Sleep(200 * time.Millisecond)
			if info, _ := m.Info(ctx, "own"); !info.Linked || rec.count(EventCloudVaultDeleted.Name()) != 0 {
				t.Fatalf("disconnected without a confirmed delete: %+v", info)
			}
			if !tc.asked && cloud.called("GET /vaults/"+lifeVault) != 0 {
				t.Fatal("the server was asked about a NOT_FOUND that is not the vault's")
			}
		})
	}
}
