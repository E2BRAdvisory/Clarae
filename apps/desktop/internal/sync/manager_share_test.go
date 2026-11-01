package sync

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/shared/syncproto"
)

const (
	shareSharedVault  = "0198f1c2-aaaa-7bbb-8ccc-000000000011"
	sharePrivateVault = "0198f1c2-aaaa-7bbb-8ccc-000000000012"
	shareID           = "0198f1c2-aaaa-7bbb-8ccc-000000000021"
)

// shareServer is the part of the cloud API behind account-wide share management: two vaults (one
// shared, one private), the share list by scope, creation and update.
type shareServer struct {
	mu      stdsync.Mutex
	calls   []string
	created map[string]any
	updated map[string]any
}

func newShareServer(t *testing.T) (*shareServer, *transport.Client) {
	t.Helper()
	ss := &shareServer{}
	srv := httptest.NewServer(ss)
	t.Cleanup(srv.Close)
	c, err := transport.New(srv.URL, staticToken{}, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	c.Retries = 0
	return ss, c
}

func shareJSON(name string, extra map[string]any) map[string]any {
	out := map[string]any{
		"id": shareID, "vault_id": shareSharedVault, "vault_name": "Team", "resource_type": "vault",
		"display_name": name, "owner_id": lifeOwner, "owner_name": "ada", "created_at": "2026-10-01T10:00:00Z",
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

func (ss *shareServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ss.mu.Lock()
	defer ss.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, transport.BasePath)
	ss.calls = append(ss.calls, r.Method+" "+path+"?"+r.URL.RawQuery)
	reply := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(v)
	}
	vault := func(id, kind string) map[string]any {
		return map[string]any{
			"id": id, "owner_id": lifeOwner, "name": "Team", "kind": kind, "last_seq": 1,
			"total_bytes": 0, "file_count": 0, "created_at": "2026-10-01T10:00:00Z",
		}
	}
	switch {
	case r.Method == http.MethodGet && path == "/shares":
		if r.URL.Query().Get("scope") == "owned" {
			reply(http.StatusOK, []any{shareJSON("Team", nil)})
		} else {
			reply(http.StatusOK, []any{shareJSON("Budget", map[string]any{"my_status": "pending", "my_permission": "editor"})})
		}
	case r.Method == http.MethodGet && path == "/vaults/"+shareSharedVault:
		reply(http.StatusOK, vault(shareSharedVault, "shared"))
	case r.Method == http.MethodGet && path == "/vaults/"+sharePrivateVault:
		reply(http.StatusOK, vault(sharePrivateVault, "private"))
	case r.Method == http.MethodPost && path == "/shares":
		ss.created = map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&ss.created)
		reply(http.StatusCreated, shareJSON(ss.created["display_name"].(string), map[string]any{"resource_type": ss.created["resource_type"]}))
	case r.Method == http.MethodPatch && path == "/shares/"+shareID:
		ss.updated = map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&ss.updated)
		name, _ := ss.updated["display_name"].(string)
		if name == "" {
			name = "Team"
		}
		reply(http.StatusOK, shareJSON(name, nil))
	default:
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "about:blank", "title": "NOT_FOUND", "status": 404, "code": "NOT_FOUND"})
	}
}

func TestListSharesByScope(t *testing.T) {
	ss, c := newShareServer(t)
	m := lifecycleManager(t, c)
	ctx := context.Background()
	owned, err := m.ListShares(ctx, "owned")
	if err != nil || len(owned) != 1 || owned[0].DisplayName != "Team" {
		t.Fatalf("owned = %+v, %v", owned, err)
	}
	received, err := m.ListShares(ctx, "received")
	if err != nil || len(received) != 1 || received[0].DisplayName != "Budget" {
		t.Fatalf("received = %+v, %v", received, err)
	}
	if _, err := m.ListShares(ctx, "everything"); err == nil {
		t.Fatal("an unknown scope must be refused")
	}
	if len(ss.calls) != 2 {
		t.Fatalf("an invalid scope must not reach the server: %v", ss.calls)
	}
}

func TestCreateCloudShareOfAVaultAndOfAFolder(t *testing.T) {
	ss, c := newShareServer(t)
	m := lifecycleManager(t, c)
	ctx := context.Background()

	sh, err := m.CreateCloudShare(ctx, shareSharedVault, "", "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if ss.created["resource_type"] != "vault" || ss.created["display_name"] != "Team" || ss.created["path_prefix"] != nil {
		t.Fatalf("whole vault: %+v", ss.created)
	}
	if sh.DisplayName != "Team" {
		t.Fatalf("share = %+v", sh)
	}

	exp := time.Now().Add(48 * time.Hour).UTC().Truncate(time.Second)
	if _, err := m.CreateCloudShare(ctx, shareSharedVault, "/Projects/Alfa/", "", nil, &exp); err != nil {
		t.Fatal(err)
	}
	if ss.created["resource_type"] != "folder" || ss.created["path_prefix"] != "Projects/Alfa" || ss.created["display_name"] != "Alfa" {
		t.Fatalf("folder: %+v", ss.created)
	}
	if ss.created["expires_at"] == nil {
		t.Fatalf("the expiry is sent: %+v", ss.created)
	}
}

func TestCreateCloudShareRefusesAPrivateVault(t *testing.T) {
	ss, c := newShareServer(t)
	m := lifecycleManager(t, c)
	_, err := m.CreateCloudShare(context.Background(), sharePrivateVault, "", "Secrets", nil, nil)
	if !transport.IsCode(err, syncproto.CodeVaultEncrypted) {
		t.Fatalf("err = %v, want VAULT_ENCRYPTED", err)
	}
	for _, call := range ss.calls {
		if strings.HasPrefix(call, "POST /shares") {
			t.Fatalf("a private vault must not be offered to the server: %v", ss.calls)
		}
	}
}

func TestUpdateShareNameAndExpiry(t *testing.T) {
	ss, c := newShareServer(t)
	m := lifecycleManager(t, c)
	ctx := context.Background()

	sh, err := m.UpdateShare(ctx, shareID, " Handbook ", nil, false)
	if err != nil || sh.DisplayName != "Handbook" {
		t.Fatalf("rename: %+v, %v", sh, err)
	}
	if ss.updated["display_name"] != "Handbook" || ss.updated["clear_expiry"] != nil || ss.updated["expires_at"] != nil {
		t.Fatalf("rename body: %+v", ss.updated)
	}

	exp := time.Now().Add(24 * time.Hour)
	if _, err := m.UpdateShare(ctx, shareID, "", &exp, true); err != nil {
		t.Fatal(err)
	}
	if ss.updated["clear_expiry"] != true || ss.updated["expires_at"] != nil || ss.updated["display_name"] != nil {
		t.Fatalf("clear expiry body: %+v", ss.updated)
	}
}

func TestShareManagementNeedsSignIn(t *testing.T) {
	m := NewManager(offlineSession{}, nil, zerolog.Nop(), nil)
	ctx := context.Background()
	if _, err := m.ListShares(ctx, "owned"); err == nil {
		t.Fatal("ListShares signed out")
	}
	if _, err := m.CreateCloudShare(ctx, shareSharedVault, "", "x", nil, nil); err == nil {
		t.Fatal("CreateCloudShare signed out")
	}
	if _, err := m.UpdateShare(ctx, shareID, "x", nil, false); err == nil {
		t.Fatal("UpdateShare signed out")
	}
}
