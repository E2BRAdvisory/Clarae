package keycloak

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
)

// fakeRealm implements the slice of Keycloak the client uses and records every call.
type fakeRealm struct {
	mu     sync.Mutex
	tokens int
	calls  []string
	bodies map[string]string
}

func (f *fakeRealm) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := io.ReadAll(r.Body)
	key := r.Method + " " + r.URL.Path
	if f.bodies == nil {
		f.bodies = map[string]string{}
	}
	f.bodies[key] = string(b)
	if r.URL.Path == "/realms/nodus/protocol/openid-connect/token" {
		f.tokens++
		form, _ := url.ParseQuery(string(b))
		if form.Get("grant_type") != "client_credentials" || form.Get("client_secret") != "s3cret" {
			http.Error(w, "bad", http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "tok", "expires_in": 300})
		return
	}
	if r.Header.Get("Authorization") != "Bearer tok" {
		http.Error(w, "no token", http.StatusUnauthorized)
		return
	}
	f.calls = append(f.calls, key)
	switch key {
	case "POST /admin/realms/nodus/users":
		if strings.Contains(string(b), `"username":"dup"`) {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.Header().Set("Location", "http://kc/admin/realms/nodus/users/uid-1")
		w.WriteHeader(http.StatusCreated)
	case "GET /admin/realms/nodus/users/uid-1/role-mappings/realm/available":
		_ = json.NewEncoder(w).Encode([]map[string]string{{"id": "role-0", "name": "nodus-user"}, {"id": "role-1", "name": "nodus-admin"}})
	case "GET /admin/realms/nodus/users/uid-1/role-mappings/realm":
		_ = json.NewEncoder(w).Encode([]map[string]string{{"id": "role-1", "name": "nodus-admin"}})
	case "GET /admin/realms/nodus/users/uid-1/sessions":
		_ = json.NewEncoder(w).Encode([]map[string]any{{"id": "s1", "ipAddress": "1.2.3.4", "start": 1700000000000, "lastAccess": 1700000600000, "clients": map[string]string{"c1": "nodus-web"}}})
	case "PUT /admin/realms/nodus/users/uid-1/execute-actions-email":
		http.Error(w, "smtp", http.StatusInternalServerError)
	case "GET /admin/realms/nodus/users/missing/sessions":
		w.WriteHeader(http.StatusNotFound)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func newTestClient(t *testing.T) (Admin, *fakeRealm) {
	t.Helper()
	f := &fakeRealm{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return New(Config{BaseURL: srv.URL + "/", Realm: "nodus", ClientID: "svc", ClientSecret: "s3cret"}), f
}

func TestClientCreatesUsersAndCachesTheToken(t *testing.T) {
	kc, f := newTestClient(t)
	ctx := context.Background()
	sub, err := kc.CreateUser(ctx, UserSpec{Username: "ada", Email: "ada@x.io", FirstName: "Ada", Admin: true})
	if err != nil || sub != "uid-1" {
		t.Fatalf("create: %q %v", sub, err)
	}
	var rep map[string]any
	_ = json.Unmarshal([]byte(f.bodies["POST /admin/realms/nodus/users"]), &rep)
	if acts, _ := rep["requiredActions"].([]any); len(acts) != 2 || rep["enabled"] != true {
		t.Fatalf("a user without a password must choose one and verify the e-mail: %v", rep)
	}
	if !strings.Contains(f.bodies["POST /admin/realms/nodus/users/uid-1/role-mappings/realm"], `"nodus-admin"`) {
		t.Fatalf("the admin role was not granted: %v", f.calls)
	}
	if err := kc.SetAdmin(ctx, "uid-1", false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(f.bodies["DELETE /admin/realms/nodus/users/uid-1/role-mappings/realm"], `"role-1"`) {
		t.Fatalf("the admin role was not revoked: %v", f.calls)
	}
	if _, err := kc.CreateUser(ctx, UserSpec{Username: "dup", Email: "d@x.io"}); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate: %v", err)
	}
	if f.tokens != 1 {
		t.Fatalf("the service-account token was requested %d times, want 1", f.tokens)
	}
}

func TestClientTemporaryPasswordIsTemporary(t *testing.T) {
	kc, f := newTestClient(t)
	if _, err := kc.CreateUser(context.Background(), UserSpec{Username: "bob", Email: "b@x.io", TemporaryPassword: "changeme1"}); err != nil {
		t.Fatal(err)
	}
	body := f.bodies["POST /admin/realms/nodus/users"]
	if !strings.Contains(body, `"temporary":true`) || strings.Contains(body, "requiredActions") {
		t.Fatalf("body: %s", body)
	}
}

func TestClientDisableLogsTheUserOut(t *testing.T) {
	kc, f := newTestClient(t)
	ctx := context.Background()
	if err := kc.SetEnabled(ctx, "uid-1", false); err != nil {
		t.Fatal(err)
	}
	if got := f.bodies["PUT /admin/realms/nodus/users/uid-1"]; got != `{"enabled":false}` {
		t.Fatalf("disable body %s", got)
	}
	if _, ok := f.bodies["POST /admin/realms/nodus/users/uid-1/logout"]; !ok {
		t.Fatalf("sessions were not revoked: %v", f.calls)
	}
	f.calls = nil
	if err := kc.SetEnabled(ctx, "uid-1", true); err != nil || len(f.calls) != 1 {
		t.Fatalf("enable: %v %v", err, f.calls)
	}
}

func TestClientSessionsAndErrors(t *testing.T) {
	kc, _ := newTestClient(t)
	ctx := context.Background()
	got, err := kc.Sessions(ctx, "uid-1")
	if err != nil || len(got) != 1 || got[0].IPAddress != "1.2.3.4" || got[0].Clients[0] != "nodus-web" || got[0].LastAccess.Before(got[0].Started) {
		t.Fatalf("sessions: %+v %v", got, err)
	}
	if _, err := kc.Sessions(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	sent, err := kc.RequirePasswordReset(ctx, "uid-1")
	if err != nil || sent {
		t.Fatalf("a mail failure must not fail the reset: sent=%v err=%v", sent, err)
	}
}

func TestClientRejectsWrongCredentialsAndDisabledConfig(t *testing.T) {
	f := &fakeRealm{}
	srv := httptest.NewServer(f)
	defer srv.Close()
	bad := New(Config{BaseURL: srv.URL, Realm: "nodus", ClientID: "svc", ClientSecret: "wrong"})
	if _, err := bad.CreateUser(context.Background(), UserSpec{Username: "x", Email: "x@x.io"}); err == nil {
		t.Fatal("expected a token error")
	}
	off := New(Config{})
	if err := off.SetEnabled(context.Background(), "x", false); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled: %v", err)
	}
}
