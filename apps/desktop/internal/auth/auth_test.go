package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// fakeIdP is a minimal OIDC provider: discovery, authorize (redirects with a
// code), token (code and refresh grants with rotation) and revoke.
type fakeIdP struct {
	srv      *httptest.Server
	tokens   atomic.Int32
	revoked  atomic.Int32
	rejectRT atomic.Bool
	// singleUse makes refresh tokens one-shot (rotation with reuse detection, as Keycloak does).
	singleUse atomic.Bool
	usedRT    sync.Map
	// rejectLoopback answers loopback redirect URIs like Keycloak answers an
	// unregistered one: a 400 error page, no redirect.
	rejectLoopback atomic.Bool
}

func newFakeIdP(t *testing.T) *fakeIdP {
	t.Helper()
	f := &fakeIdP{}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer":                 f.srv.URL,
			"authorization_endpoint": f.srv.URL + "/auth",
			"token_endpoint":         f.srv.URL + "/token",
			"jwks_uri":               f.srv.URL + "/jwks",
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"keys":[]}`)) })
	mux.HandleFunc("/auth", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
			http.Error(w, "pkce required", http.StatusBadRequest)
			return
		}
		if f.rejectLoopback.Load() && strings.HasPrefix(q.Get("redirect_uri"), "http://127.0.0.1") {
			w.Header().Set("Content-Type", "text/html")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`<html><body><p id="kc-error-message">Invalid parameter: redirect_uri</p></body></html>`))
			return
		}
		redirect, _ := url.Parse(q.Get("redirect_uri"))
		v := redirect.Query()
		v.Set("code", "code-123")
		v.Set("state", q.Get("state"))
		redirect.RawQuery = v.Encode()
		http.Redirect(w, r, redirect.String(), http.StatusFound) //nolint:gosec // test fake IdP
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			if r.Form.Get("code") != "code-123" || r.Form.Get("code_verifier") == "" {
				http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
				return
			}
		case "refresh_token":
			if f.rejectRT.Load() || !strings.HasPrefix(r.Form.Get("refresh_token"), "rt-") {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"Token is not active"}`))
				return
			}
		default:
			http.Error(w, "unsupported", http.StatusBadRequest)
			return
		}
		if r.Form.Get("grant_type") == "refresh_token" && f.singleUse.Load() {
			if _, reused := f.usedRT.LoadOrStore(r.Form.Get("refresh_token"), true); reused {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"invalid_grant","error_description":"Token reuse detected"}`))
				return
			}
		}
		n := f.tokens.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-" + itoa(n), "refresh_token": "rt-" + itoa(n),
			"token_type": "Bearer", "expires_in": 300,
		})
	})
	mux.HandleFunc("/protocol/openid-connect/revoke", func(w http.ResponseWriter, _ *http.Request) {
		f.revoked.Add(1)
		w.WriteHeader(http.StatusOK)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func itoa(n int32) string { return strconv.Itoa(int(n)) }

// testDeviceID is the id the fake cloud gives the registered device.
const testDeviceID = "0190a0a0-0000-7000-8000-0000000000d1"

// fakeCloud serves /client-config, /me and /me/devices.
func newFakeCloud(t *testing.T, issuer string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/client-config", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": issuer, "desktop_client_id": "memobrain-desktop", "audience": "memobrain-api", "grpc_endpoint": "127.0.0.1:18082", "api_version": "test"})
	})
	authed := func(w http.ResponseWriter, r *http.Request) bool {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer at-") {
			w.Header().Set("Content-Type", "application/problem+json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"type":"x","title":"x","status":401,"code":"UNAUTHENTICATED"}`))
			return false
		}
		return true
	}
	mux.HandleFunc("/api/v1/me", func(w http.ResponseWriter, r *http.Request) {
		if !authed(w, r) {
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "0190a0a0-0000-7000-8000-0000000000a1", "username": "user1", "email": "user1@memobrain.local", "display_name": "Uno", "role": "user", "status": "active", "quota_bytes": 1, "used_bytes": 0, "config_version": 0, "created_at": time.Now()})
	})
	mux.HandleFunc("/api/v1/me/devices", func(w http.ResponseWriter, r *http.Request) {
		if !authed(w, r) {
			return
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"id": testDeviceID, "name": "x", "platform": "macos", "created_at": time.Now()})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

// browser simulates the system browser: follows the authorize redirect to
// the loopback callback (or records the URL for the scheme flow).
type browser struct {
	t       *testing.T
	lastURL atomic.Pointer[string]
	follow  bool
}

func (b *browser) open(u string) error {
	b.lastURL.Store(&u)
	if !b.follow {
		return nil
	}
	go func() {
		resp, err := http.Get(u) //nolint:gosec // test server
		if err != nil {
			b.t.Errorf("browser: %v", err)
			return
		}
		_ = resp.Body.Close()
	}()
	return nil
}

func newService(t *testing.T, mode RedirectMode, br *browser) (*Service, *MemoryStore) {
	t.Helper()
	secrets := NewMemoryStore()
	svc := New(Options{
		DataDir: t.TempDir(), Logger: zerolog.Nop(), OpenURL: br.open, RedirectMode: mode,
		Secrets: secrets, LoginTimeout: 10 * time.Second, AppVersion: "test", DeviceName: "test-device", Platform: "linux",
	})
	return svc, secrets
}

func TestLoginLoopbackRefreshLogout(t *testing.T) {
	idp := newFakeIdP(t)
	cloud := newFakeCloud(t, idp.srv.URL)
	br := &browser{t: t, follow: true}
	svc, secrets := newService(t, RedirectAuto, br)
	ctx := context.Background()

	if err := svc.Login(ctx, cloud.URL); err != nil {
		t.Fatal(err)
	}
	st := svc.State()
	if st.Status != StatusReady || st.Profile.Username != "user1" || st.DeviceID != testDeviceID || st.ServerURL != cloud.URL {
		t.Fatalf("state after login: %+v", st)
	}
	if rt, _ := secrets.Get(cloud.URL); rt != "rt-1" {
		t.Fatalf("refresh token not stored: %q", rt)
	}
	if u := *br.lastURL.Load(); !strings.Contains(u, "redirect_uri=http%3A%2F%2F127.0.0.1%3A") {
		t.Fatalf("expected loopback redirect, got %s", u)
	}
	tok, err := svc.Token(ctx)
	if err != nil || tok != "at-1" {
		t.Fatalf("token: %q %v", tok, err)
	}

	// Force expiry: the next Token() refreshes and rotates the refresh token.
	svc.mu.Lock()
	svc.expiry = time.Now()
	svc.mu.Unlock()
	tok, err = svc.Token(ctx)
	if err != nil || tok != "at-2" {
		t.Fatalf("refreshed token: %q %v", tok, err)
	}
	if rt, _ := secrets.Get(cloud.URL); rt != "rt-2" {
		t.Fatalf("rotated refresh token not stored: %q", rt)
	}

	// A revoked refresh token signs the user out.
	idp.rejectRT.Store(true)
	svc.mu.Lock()
	svc.expiry = time.Now()
	svc.mu.Unlock()
	if _, err := svc.Token(ctx); err == nil {
		t.Fatal("expected error for revoked refresh token")
	}
	if svc.State().Status != StatusSignedOut {
		t.Fatalf("expected signed_out, got %s", svc.State().Status)
	}
	if rt, _ := secrets.Get(cloud.URL); rt != "" {
		t.Fatal("refresh token should be deleted after revocation")
	}
}

func TestLoginSchemeFallbackAndRestore(t *testing.T) {
	idp := newFakeIdP(t)
	cloud := newFakeCloud(t, idp.srv.URL)
	br := &browser{t: t, follow: false}
	svc, secrets := newService(t, RedirectScheme, br)
	ctx := context.Background()

	done := make(chan error, 1)
	go func() { done <- svc.Login(ctx, cloud.URL) }()
	// Wait for the browser to be "opened", then simulate the OS delivering memobrain://auth/callback.
	var authURL string
	for i := 0; i < 100 && authURL == ""; i++ {
		if p := br.lastURL.Load(); p != nil {
			authURL = *p
		}
		time.Sleep(10 * time.Millisecond)
	}
	u, err := url.Parse(authURL)
	if err != nil || u.Query().Get("redirect_uri") != SchemeRedirectURI {
		t.Fatalf("expected scheme redirect, got %q", authURL)
	}
	if !svc.HandleCallback(url.Values{"code": {"code-123"}, "state": {u.Query().Get("state")}}) {
		t.Fatal("callback not accepted")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if svc.State().Status != StatusReady {
		t.Fatalf("state: %+v", svc.State())
	}

	// A new service instance restores the session from disk + secrets.
	restored := New(Options{DataDir: svc.opts.DataDir, Logger: zerolog.Nop(), OpenURL: br.open, Secrets: secrets, AppVersion: "test"})
	restored.Restore(ctx)
	deadline := time.Now().Add(5 * time.Second)
	for restored.State().Status != StatusReady && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if st := restored.State(); st.Status != StatusReady || st.Profile.Username != "user1" || st.DeviceID != testDeviceID {
		t.Fatalf("restored state: %+v", st)
	}

	if err := restored.Logout(ctx); err != nil {
		t.Fatal(err)
	}
	if restored.State().Status != StatusSignedOut || idp.revoked.Load() != 1 {
		t.Fatalf("logout: %+v revoked=%d", restored.State(), idp.revoked.Load())
	}
	if p, _ := loadSession(svc.opts.DataDir); p != nil {
		t.Fatal("session file should be deleted")
	}
}

func TestStateMismatchRejected(t *testing.T) {
	idp := newFakeIdP(t)
	cloud := newFakeCloud(t, idp.srv.URL)
	br := &browser{t: t, follow: false}
	svc, _ := newService(t, RedirectScheme, br)
	done := make(chan error, 1)
	go func() { done <- svc.Login(context.Background(), cloud.URL) }()
	for br.lastURL.Load() == nil {
		time.Sleep(10 * time.Millisecond)
	}
	svc.HandleCallback(url.Values{"code": {"code-123"}, "state": {"wrong"}})
	if err := <-done; err == nil || !strings.Contains(err.Error(), "state mismatch") {
		t.Fatalf("expected state mismatch, got %v", err)
	}
	if svc.State().Status != StatusSignedOut {
		t.Fatalf("expected signed_out, got %s", svc.State().Status)
	}
}

// A session cleared while completeSession is about to run must not panic on a nil client.
func TestCompleteSessionSignedOut(t *testing.T) {
	svc, _ := newService(t, RedirectLoopback, &browser{})
	if err := svc.completeSession(context.Background()); err == nil {
		t.Fatal("expected an error when signed out")
	}
}

// Concurrent callers (startup restore, the sync loops, the notifier) must not refresh with the same
// single-use refresh token: the loser would be rejected and the whole session signed out.
func TestConcurrentRefreshKeepsSession(t *testing.T) {
	idp := newFakeIdP(t)
	cloud := newFakeCloud(t, idp.srv.URL)
	svc, _ := newService(t, RedirectAuto, &browser{t: t, follow: true})
	ctx := context.Background()
	if err := svc.Login(ctx, cloud.URL); err != nil {
		t.Fatal(err)
	}
	idp.singleUse.Store(true)
	svc.mu.Lock()
	svc.expiry = time.Now()
	svc.mu.Unlock()

	var wg sync.WaitGroup
	errs := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := svc.Token(ctx); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent Token: %v", err)
	}
	if svc.State().Status == StatusSignedOut {
		t.Fatal("the session was signed out by a concurrent refresh")
	}
}

// waitAuthURL returns the authorization URL the "browser" was asked to open.
func waitAuthURL(t *testing.T, br *browser) *url.URL {
	t.Helper()
	for i := 0; i < 300; i++ {
		if p := br.lastURL.Load(); p != nil {
			u, err := url.Parse(*p)
			if err != nil {
				t.Fatal(err)
			}
			return u
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the browser was never opened")
	return nil
}

// D-08 rule (b): when the identity provider rejects the loopback redirect URI,
// auto mode falls back to the custom scheme instead of opening a dead-end page.
func TestAutoFallsBackToSchemeWhenLoopbackIsRejected(t *testing.T) {
	idp := newFakeIdP(t)
	idp.rejectLoopback.Store(true)
	cloud := newFakeCloud(t, idp.srv.URL)
	br := &browser{t: t}
	svc, _ := newService(t, "", br)
	done := make(chan error, 1)
	go func() { done <- svc.Login(context.Background(), cloud.URL) }()
	u := waitAuthURL(t, br)
	if got := u.Query().Get("redirect_uri"); got != SchemeRedirectURI {
		t.Fatalf("redirect_uri = %q, want the custom scheme", got)
	}
	if !svc.HandleCallback(url.Values{"code": {"code-123"}, "state": {u.Query().Get("state")}}) {
		t.Fatal("callback not accepted")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// Forced loopback never probes nor falls back, even when the provider rejects it.
func TestLoopbackModeDoesNotFallBack(t *testing.T) {
	idp := newFakeIdP(t)
	idp.rejectLoopback.Store(true)
	cloud := newFakeCloud(t, idp.srv.URL)
	br := &browser{t: t}
	svc, _ := newService(t, RedirectLoopback, br)
	svc.opts.LoginTimeout = 300 * time.Millisecond
	_ = svc.Login(context.Background(), cloud.URL) // times out: nobody completes the flow
	if got := waitAuthURL(t, br).Query().Get("redirect_uri"); !strings.HasPrefix(got, "http://127.0.0.1:") {
		t.Fatalf("redirect_uri = %q, want loopback", got)
	}
}

// D-08 rule (c): the Config Profile can force the scheme; an explicit option
// (the environment variable) still wins over it.
func TestManagedRedirectMode(t *testing.T) {
	for _, c := range []struct {
		name    string
		opt     RedirectMode
		managed string
		scheme  bool
	}{
		{"profile forces the scheme", "", "custom_scheme", true},
		{"profile auto", "", "auto", false},
		{"no profile", "", "", false},
		{"option wins over the profile", RedirectLoopback, "custom_scheme", false},
	} {
		t.Run(c.name, func(t *testing.T) {
			idp := newFakeIdP(t)
			cloud := newFakeCloud(t, idp.srv.URL)
			br := &browser{t: t}
			svc, _ := newService(t, c.opt, br)
			svc.SetManagedRedirectMode(ParseRedirectMode(c.managed))
			svc.opts.LoginTimeout = 300 * time.Millisecond
			_ = svc.Login(context.Background(), cloud.URL)
			got := waitAuthURL(t, br).Query().Get("redirect_uri")
			if (got == SchemeRedirectURI) != c.scheme {
				t.Fatalf("redirect_uri = %q, scheme expected: %v", got, c.scheme)
			}
		})
	}
}

func TestParseRedirectMode(t *testing.T) {
	for in, want := range map[string]RedirectMode{
		"auto": RedirectAuto, "loopback": RedirectLoopback, "custom_scheme": RedirectScheme, "scheme": RedirectScheme, "": "", "other": "",
	} {
		if got := ParseRedirectMode(in); got != want {
			t.Errorf("ParseRedirectMode(%q) = %q, want %q", in, got, want)
		}
	}
}
