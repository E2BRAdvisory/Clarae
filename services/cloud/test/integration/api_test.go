//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"memobrain/services/cloud/internal/auth/authtest"
	"memobrain/shared/syncproto"
)

func readAll(t *testing.T, resp *http.Response) io.ReadCloser {
	t.Helper()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(b))
	return io.NopCloser(bytes.NewReader(b))
}

func decode[T any](t *testing.T, resp *http.Response) T {
	t.Helper()
	var v T
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return v
}

func (e *env) request(method, path, token string, body any) *http.Response {
	e.t.Helper()
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, e.baseURL+path, r)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return e.do(req)
}

func TestHealth(t *testing.T) {
	e := newEnv(t)
	resp := e.request(http.MethodGet, "/healthz", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("healthz: %d", resp.StatusCode)
	}
	resp = e.request(http.MethodGet, "/readyz", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("readyz: %d", resp.StatusCode)
	}
	ready := decode[map[string]any](t, resp)
	if checks, _ := ready["checks"].(map[string]any); checks["database"] != "ok" {
		t.Fatalf("readyz checks: %v", ready)
	}

	// Public bootstrap document for clients (ADR-0008).
	resp = e.request(http.MethodGet, "/client-config", "", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("client-config: %d", resp.StatusCode)
	}
	cc := decode[map[string]any](t, resp)
	if cc["issuer"] != e.issuer.URL() || cc["desktop_client_id"] != "memobrain-desktop" || cc["audience"] != "memobrain-api" {
		t.Fatalf("client-config: %v", cc)
	}
}

func TestMeRequiresToken(t *testing.T) {
	e := newEnv(t)
	resp := e.request(http.MethodGet, "/me", "", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
	p := decode[syncproto.Problem](t, resp)
	if p.Code != syncproto.CodeUnauthenticated || p.RequestID == "" {
		t.Fatalf("unexpected problem %+v", p)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/problem+json") {
		t.Fatalf("content type %q", ct)
	}

	resp = e.request(http.MethodGet, "/me", "garbage", nil)
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 for garbage token, got %d", resp.StatusCode)
	}
}

func TestMeProvisionsAndReturnsProfile(t *testing.T) {
	e := newEnv(t)
	tok := e.issuer.Token(t, authtest.TokenOptions{Subject: "sub-ada", Username: "ada", Email: "ada@memobrain.local", Name: "Ada Admin", Roles: []string{"memobrain-admin", "memobrain-user"}})

	resp := e.request(http.MethodGet, "/me", tok, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	me := decode[map[string]any](t, resp)
	if me["username"] != "ada" || me["role"] != "admin" || me["status"] != "active" {
		t.Fatalf("unexpected profile %v", me)
	}
	if me["quota_bytes"].(float64) != 5368709120 {
		t.Fatalf("expected default quota from settings, got %v", me["quota_bytes"])
	}

	// Second call hits the status cache and returns the same user id.
	resp = e.request(http.MethodGet, "/me", tok, nil)
	me2 := decode[map[string]any](t, resp)
	if me2["id"] != me["id"] {
		t.Fatalf("user id changed between calls: %v vs %v", me["id"], me2["id"])
	}
}

func TestSuspendedUserIsRejected(t *testing.T) {
	e := newEnv(t)
	sub := "sub-suspended-" + newID()
	tok := e.issuer.Token(t, authtest.TokenOptions{Subject: sub, Username: "bob", Email: sub + "@memobrain.local"})
	if resp := e.request(http.MethodGet, "/me", tok, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("first call: %d", resp.StatusCode)
	}
	if _, err := e.db.Pool.Exec(context.Background(), `UPDATE users SET status='suspended' WHERE keycloak_sub=$1`, sub); err != nil {
		t.Fatal(err)
	}
	e.authn.Invalidate(sub)

	resp := e.request(http.MethodGet, "/me", tok, nil)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403, got %d", resp.StatusCode)
	}
	if p := decode[syncproto.Problem](t, resp); p.Code != syncproto.CodeUserSuspended {
		t.Fatalf("expected USER_SUSPENDED, got %s", p.Code)
	}
}

func TestDevices(t *testing.T) {
	e := newEnv(t)
	tok := e.issuer.Token(t, authtest.TokenOptions{Subject: "sub-dev", Username: "carol"})
	other := e.issuer.Token(t, authtest.TokenOptions{Subject: "sub-other", Username: "dave"})

	resp := e.request(http.MethodPost, "/me/devices", tok, map[string]any{"name": "MacBook", "platform": "macos", "app_version": "0.0.1"})
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: %d", resp.StatusCode)
	}
	dev := decode[map[string]any](t, resp)
	id, _ := dev["id"].(string)
	if id == "" || dev["name"] != "MacBook" {
		t.Fatalf("unexpected device %v", dev)
	}

	resp = e.request(http.MethodGet, "/me/devices", tok, nil)
	list := decode[map[string][]map[string]any](t, resp)
	if len(list["items"]) != 1 || list["items"][0]["id"] != id {
		t.Fatalf("list: %v", list)
	}

	// Validation: platform must be one of the enum values.
	resp = e.request(http.MethodPost, "/me/devices", tok, map[string]any{"name": "x", "platform": "amiga"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid platform, got %d", resp.StatusCode)
	}

	// Another user cannot revoke it (404, existence not revealed).
	resp = e.request(http.MethodDelete, "/me/devices/"+id, other, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404 for foreign device, got %d", resp.StatusCode)
	}

	resp = e.request(http.MethodDelete, "/me/devices/"+id, tok, nil)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("revoke: %d", resp.StatusCode)
	}
	resp = e.request(http.MethodDelete, "/me/devices/"+id, tok, nil)
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("second revoke should be 404, got %d", resp.StatusCode)
	}
	resp = e.request(http.MethodGet, "/me/devices", tok, nil)
	if list = decode[map[string][]map[string]any](t, resp); len(list["items"]) != 0 {
		t.Fatalf("revoked device still listed: %v", list)
	}
}

func TestEffectiveConfigETag(t *testing.T) {
	e := newEnv(t)
	tok := e.issuer.Token(t, authtest.TokenOptions{Subject: "sub-cfg"})

	resp := e.request(http.MethodGet, "/config/effective", tok, nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	etag := resp.Header.Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	cfg := decode[map[string]any](t, resp)
	// Other tests share the database and bump the revision: only its presence is checked here.
	if _, ok := cfg["version"].(float64); !ok || cfg["config"] == nil {
		t.Fatalf("unexpected config %v", cfg)
	}

	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, e.baseURL+"/config/effective", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("If-None-Match", etag)
	if resp = e.do(req); resp.StatusCode != http.StatusNotModified {
		t.Fatalf("expected 304, got %d", resp.StatusCode)
	}
}

func TestUnknownEndpointIsProblem(t *testing.T) {
	e := newEnv(t)
	req, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, e.baseURL+"/nope", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", resp.StatusCode)
	}
	if p := decode[syncproto.Problem](t, resp); p.Code != syncproto.CodeNotFound {
		t.Fatalf("expected NOT_FOUND problem, got %+v", p)
	}
}
