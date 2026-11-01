package sync

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	"github.com/rs/zerolog"

	"memobrain/apps/desktop/internal/crypto"
	"memobrain/apps/desktop/internal/sync/transport"
	"memobrain/apps/desktop/internal/vault"
	"memobrain/shared/syncproto"
)

const linkVault = "0198f1c2-aaaa-7bbb-8ccc-0000000000aa"

// createServer creates vaults (always linkVault) and deletes them.
type createServer struct {
	mu      stdsync.Mutex
	created bool
	deleted bool
	failDel bool
}

func (cs *createServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	path := strings.TrimPrefix(r.URL.Path, transport.BasePath)
	switch {
	case path == "/vaults" && r.Method == http.MethodPost:
		var body struct{ Name, Kind string }
		_ = json.NewDecoder(r.Body).Decode(&body)
		cs.created = true
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": linkVault, "owner_id": lifeOwner, "name": body.Name, "kind": body.Kind, "last_seq": 0,
			"total_bytes": 0, "file_count": 0, "created_at": "2026-11-01T10:00:00Z",
		})
	case path == "/vaults/"+linkVault && r.Method == http.MethodDelete && !cs.failDel:
		cs.deleted = true
		w.WriteHeader(http.StatusNoContent)
	default:
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "about:blank", "title": "no", "status": 403, "code": string(syncproto.CodeForbidden)})
	}
}

// brokenKeychain refuses to store anything, like a Linux desktop without a
// Secret Service.
type brokenKeychain struct{}

func (brokenKeychain) Set(string, string) error   { return errors.New("keychain unavailable") }
func (brokenKeychain) Get(string) (string, error) { return "", nil }
func (brokenKeychain) Delete(string) error        { return nil }

func linkManager(t *testing.T, store crypto.KeyStore) (*Manager, *createServer, *crypto.Manager) {
	t.Helper()
	cs := &createServer{}
	srv := httptest.NewServer(cs)
	t.Cleanup(srv.Close)
	c, err := transport.New(srv.URL, staticToken{}, nil, "test")
	if err != nil {
		t.Fatal(err)
	}
	c.Retries = 0
	cm := crypto.NewManager(crypto.Options{Store: store, KDFTarget: time.Millisecond})
	m := NewManager(clientSession{c: c}, cm, zerolog.Nop(), nil)
	m.remoteFor = func(string) Remote { return idleRemote{} }
	fs, err := vault.NewFS(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	attach(t, m, "v", fs)
	return m, cs, cm
}

const linkPass = "correct horse battery staple 42"

// A keychain that cannot store the vault key must not cost the recovery key
// of a vault that already exists on the server.
func TestLinkPrivateKeepsRecoveryKeyWhenKeychainFails(t *testing.T) {
	m, cs, cm := linkManager(t, brokenKeychain{})
	res, err := m.Link(context.Background(), "v", "Secret", "private", linkPass)
	if err != nil {
		t.Fatalf("link: %v", err)
	}
	if res.RecoveryKey == "" || res.CloudVaultID != linkVault || res.Warning != WarnKeychainUnavailable {
		t.Fatalf("result = %+v", res)
	}
	if cs.deleted {
		t.Fatal("the cloud vault must stay")
	}
	if cm.IsLocked(linkVault) {
		t.Fatal("the vault must stay unlocked for this session")
	}
	info, err := m.Info(context.Background(), "v")
	if err != nil || !info.Linked || info.CloudVaultID != linkVault {
		t.Fatalf("info = %+v, %v", info, err)
	}
}

// When the link cannot be saved the new cloud vault is deleted again; if even
// that fails, the recovery key is still returned with the vault left unlinked.
func TestLinkPrivateRollsBackOrReturnsTheKey(t *testing.T) {
	for _, failDel := range []bool{false, true} {
		m, cs, cm := linkManager(t, crypto.NewMemoryStore())
		cs.failDel = failDel
		mv, err := m.get("v")
		if err != nil {
			t.Fatal(err)
		}
		_ = mv.sdb.Close() // saveLink fails
		res, err := m.Link(context.Background(), "v", "Secret", "private", linkPass)
		if !cs.created {
			t.Fatal("no vault created")
		}
		if !failDel {
			if err == nil || !cs.deleted || res.RecoveryKey != "" {
				t.Fatalf("rollback: res=%+v err=%v deleted=%v", res, err, cs.deleted)
			}
		} else if err != nil || res.RecoveryKey == "" || res.Warning != WarnLinkIncomplete {
			t.Fatalf("no rollback: res=%+v err=%v", res, err)
		}
		if !cm.IsLocked(linkVault) {
			t.Fatal("an unlinked vault must not stay unlocked")
		}
	}
}
