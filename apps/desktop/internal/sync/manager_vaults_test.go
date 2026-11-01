package sync

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	stdsync "sync"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/store"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/pathrules"
	"memobrain/shared/syncproto"
)

const (
	lifeVault  = "0198f1c2-aaaa-7bbb-8ccc-000000000001"
	otherVault = "0198f1c2-aaaa-7bbb-8ccc-000000000002"
	lifeOwner  = "0198f1c2-aaaa-7bbb-8ccc-0000000000ff"
)

type staticToken struct{}

func (staticToken) Token(context.Context) (string, error) { return "t", nil }

// clientSession is signed in with a client of a test server.
type clientSession struct{ c *transport.Client }

func (s clientSession) Client() *transport.Client { return s.c }
func (clientSession) Info() (SessionInfo, bool) {
	return SessionInfo{ServerURL: "http://test", DeviceID: "d", UserID: lifeOwner, DeviceName: "test"}, true
}

// idleRemote never reaches a server: the engines of these tests only need to exist.
type idleRemote struct{}

func (idleRemote) Tree(context.Context) (transport.Tree, error) {
	return transport.Tree{}, errSignedOut
}
func (idleRemote) Changes(context.Context, int64, int) (transport.Changes, error) {
	return transport.Changes{}, errSignedOut
}
func (idleRemote) CheckBlobs(context.Context, []string) ([]string, error) { return nil, errSignedOut }
func (idleRemote) Upload(context.Context, string, []byte, string) (string, error) {
	return "", errSignedOut
}
func (idleRemote) Download(context.Context, string, io.Writer) error { return errSignedOut }
func (idleRemote) RevisionContent(context.Context, string, int, io.Writer) error {
	return errSignedOut
}
func (idleRemote) Commit(context.Context, syncproto.CommitRequest) (syncproto.CommitResponse, error) {
	return syncproto.CommitResponse{}, errSignedOut
}

// vaultServer is the vault part of the cloud API: one owner, vaults by id.
type vaultServer struct {
	mu      stdsync.Mutex
	vaults  map[string]map[string]any
	calls   []string
	failDel bool
}

func newVaultServer(t *testing.T) (*vaultServer, *transport.Client) {
	t.Helper()
	vs := &vaultServer{vaults: map[string]map[string]any{}}
	for id, name := range map[string]string{lifeVault: "Notes", otherVault: "Work"} {
		vs.vaults[id] = map[string]any{
			"id": id, "owner_id": lifeOwner, "name": name, "kind": "shared", "last_seq": 3,
			"total_bytes": 10, "file_count": 1, "created_at": "2026-10-01T10:00:00Z",
		}
	}
	srv := httptest.NewServer(vs)
	t.Cleanup(srv.Close)
	c, err := transport.New(srv.URL, staticToken{}, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	c.Retries = 0
	return vs, c
}

func (vs *vaultServer) problem(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"type": "about:blank", "title": code, "status": status, "code": code})
}

func (vs *vaultServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	vs.mu.Lock()
	defer vs.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, transport.BasePath)
	vs.calls = append(vs.calls, r.Method+" "+path)
	reply := func(v any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(v)
	}
	if path == "/vaults" && r.Method == http.MethodGet {
		all := r.URL.Query().Get("include_deleted") == "true"
		items := []map[string]any{}
		for _, v := range vs.vaults {
			if _, deleted := v["deleted_at"]; !deleted || all {
				items = append(items, v)
			}
		}
		reply(map[string]any{"items": items, "mounts": []any{}})
		return
	}
	id, action, _ := strings.Cut(strings.TrimPrefix(path, "/vaults/"), ":")
	v := vs.vaults[id]
	if v == nil {
		vs.problem(w, http.StatusNotFound, string(syncproto.CodeNotFound))
		return
	}
	_, deleted := v["deleted_at"]
	switch {
	case action == "" && r.Method == http.MethodPatch && !deleted:
		var body struct{ Name string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		v["name"] = body.Name
		reply(v)
	case action == "" && r.Method == http.MethodDelete && !deleted:
		if vs.failDel {
			vs.problem(w, http.StatusForbidden, "FORBIDDEN")
			return
		}
		v["deleted_at"] = "2026-11-01T09:00:00Z"
		w.WriteHeader(http.StatusNoContent)
	case action == "restore" && r.Method == http.MethodPost && deleted:
		delete(v, "deleted_at")
		reply(v)
	default:
		vs.problem(w, http.StatusNotFound, string(syncproto.CodeNotFound))
	}
}

// linkTo makes dir a vault linked to a cloud vault (scope set: a mount of a share).
func linkTo(t *testing.T, cloud, scope string) *vault.FS {
	t.Helper()
	dir := t.TempDir()
	fs, err := vault.NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	sdb, err := store.Open(context.Background(), filepath.Join(dir, pathrules.ConfigDir, "sync.db"), store.KindSync)
	if err != nil {
		t.Fatal(err)
	}
	meta := map[string]string{MetaCloudVault: cloud, MetaKind: "shared", MetaVaultName: "Notes"}
	if scope != "" {
		meta[MetaScope], meta[MetaPermission], meta[MetaShareID] = scope, PermEditor, "share-1"
	}
	db := NewDB(sdb)
	for k, v := range meta {
		if err := db.SetMeta(context.Background(), k, v); err != nil {
			t.Fatal(err)
		}
	}
	_ = sdb.Close()
	return fs
}

func lifecycleManager(t *testing.T, c *transport.Client) *Manager {
	t.Helper()
	m := NewManager(clientSession{c: c}, nil, zerolog.Nop(), nil)
	m.remoteFor = func(string) Remote { return idleRemote{} }
	return m
}

func attach(t *testing.T, m *Manager, id string, fs *vault.FS) {
	t.Helper()
	if err := m.Attach(context.Background(), id, fs); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Detach(id) })
}

func TestRenameCloudVaultUpdatesTheLinkNotTheFolder(t *testing.T) {
	ctx := context.Background()
	_, c := newVaultServer(t)
	m := lifecycleManager(t, c)
	fs := linkTo(t, lifeVault, "")
	attach(t, m, "a", fs)

	v, err := m.RenameCloudVault(ctx, lifeVault, "Journal")
	if err != nil {
		t.Fatal(err)
	}
	if v.Name != "Journal" {
		t.Fatalf("server name = %q", v.Name)
	}
	info, err := m.Info(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	if !info.Linked || info.Name != "Journal" {
		t.Fatalf("link after rename = %+v, want linked as Journal", info)
	}
	if _, err := os.Stat(fs.Root()); err != nil {
		t.Fatalf("the folder moved: %v", err)
	}
}

func TestDeleteCloudVaultUnlinksAndKeepsTheFiles(t *testing.T) {
	ctx := context.Background()
	srv, c := newVaultServer(t)
	m := lifecycleManager(t, c)
	own := linkTo(t, lifeVault, "")
	other := linkTo(t, otherVault, "")
	mount := linkTo(t, lifeVault, "prefix:Docs/")
	attach(t, m, "own", own)
	attach(t, m, "other", other)
	attach(t, m, "mount", mount)
	note := filepath.Join(own.Root(), "Plan.md")
	if err := os.WriteFile(note, []byte("# keep me"), 0o600); err != nil {
		t.Fatal(err)
	}

	unlinked, err := m.DeleteCloudVault(ctx, lifeVault)
	if err != nil {
		t.Fatal(err)
	}
	if len(unlinked) != 1 || unlinked[0] != "own" {
		t.Fatalf("unlinked = %v, want [own]", unlinked)
	}
	if got := srv.calls[len(srv.calls)-1]; got != "DELETE /vaults/"+lifeVault {
		t.Fatalf("last call = %q", got)
	}
	if info, _ := m.Info(ctx, "own"); info.Linked {
		t.Fatalf("still linked after the delete: %+v", info)
	}
	if b, err := os.ReadFile(note); err != nil || string(b) != "# keep me" {
		t.Fatalf("local file after the delete: %q, %v", b, err)
	}
	if info, _ := m.Info(ctx, "other"); !info.Linked {
		t.Fatal("a vault linked to another cloud vault was disconnected")
	}
	if info, _ := m.Info(ctx, "mount"); !info.Linked || !info.Mount {
		t.Fatal("a mount was disconnected by its owner's delete (its revocation handles it)")
	}
}

func TestDeleteCloudVaultRefusedKeepsTheLink(t *testing.T) {
	ctx := context.Background()
	srv, c := newVaultServer(t)
	srv.failDel = true
	m := lifecycleManager(t, c)
	attach(t, m, "own", linkTo(t, lifeVault, ""))

	if _, err := m.DeleteCloudVault(ctx, lifeVault); err == nil {
		t.Fatal("a refused delete returned no error")
	}
	if info, _ := m.Info(ctx, "own"); !info.Linked {
		t.Fatal("the vault was disconnected although the server refused the delete")
	}
}

func TestDeletedCloudVaultsAndRestore(t *testing.T) {
	ctx := context.Background()
	_, c := newVaultServer(t)
	m := lifecycleManager(t, c)
	if _, err := m.DeleteCloudVault(ctx, lifeVault); err != nil {
		t.Fatal(err)
	}
	deleted, err := m.DeletedCloudVaults(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(deleted) != 1 || deleted[0].Id.String() != lifeVault || deleted[0].DeletedAt == nil {
		t.Fatalf("deleted = %+v, want only %s with deleted_at", deleted, lifeVault)
	}
	live, err := m.CloudVaults(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(live) != 1 || live[0].Id.String() != otherVault {
		t.Fatalf("live = %+v, want only %s", live, otherVault)
	}
	v, err := m.RestoreCloudVault(ctx, lifeVault)
	if err != nil {
		t.Fatal(err)
	}
	if v.DeletedAt != nil || v.Name != "Notes" {
		t.Fatalf("restored = %+v", v)
	}
	if _, err := m.RestoreCloudVault(ctx, lifeVault); !transport.IsCode(err, syncproto.CodeNotFound) {
		t.Fatalf("restoring a live vault: %v, want NOT_FOUND", err)
	}
}

func TestLifecycleNeedsSignIn(t *testing.T) {
	m := NewManager(offlineSession{}, nil, zerolog.Nop(), nil)
	if _, err := m.RenameCloudVault(context.Background(), lifeVault, "x"); err == nil {
		t.Fatal("rename without a client returned no error")
	}
	if _, err := m.DeleteCloudVault(context.Background(), lifeVault); err == nil {
		t.Fatal("delete without a client returned no error")
	}
}
