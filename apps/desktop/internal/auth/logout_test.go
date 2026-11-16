//go:build !js

package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

// deviceLog collects the devices the fake cloud was asked to revoke, in the order of the IdP's
// calls (both write to the same ordered list through record).
type deviceLog struct {
	mu  sync.Mutex
	ids []string
	idp *fakeIdP
}

func (d *deviceLog) revoke(id string) {
	d.mu.Lock()
	d.ids = append(d.ids, id)
	d.mu.Unlock()
	d.idp.record("device:" + id)
}

func (d *deviceLog) revoked() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.ids...)
}

func signedInService(t *testing.T, announce bool, opts func(*Options)) (*Service, *fakeIdP, *deviceLog, *httptest.Server, *browser) {
	t.Helper()
	idp := newFakeIdP(t)
	idp.announceEndpoints.Store(announce)
	dl := &deviceLog{idp: idp}
	cloud := newFakeCloudWith(t, idp.srv.URL, dl.revoke)
	br := &browser{t: t, follow: true}
	o := Options{
		DataDir: t.TempDir(), Logger: zerolog.Nop(), OpenURL: br.open, RedirectMode: RedirectLoopback,
		Secrets: NewMemoryStore(), LoginTimeout: 10 * time.Second, AppVersion: "test", DeviceName: "test-device", Platform: "linux",
	}
	if opts != nil {
		opts(&o)
	}
	svc := New(o)
	if err := svc.Login(context.Background(), cloud.URL); err != nil {
		t.Fatal(err)
	}
	return svc, idp, dl, cloud, br
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Logout stops the synchronization, revokes the device on the cloud while the token is valid, ends
// the session at the endpoints of the discovery document and the keychain is emptied; the next
// interactive login carries prompt=login, once.
func TestLogoutRevokesDeviceAndEndsIdentityProviderSession(t *testing.T) {
	var paused atomic.Int32
	var idpRef atomic.Pointer[fakeIdP]
	svc, idp, dl, cloud, br := signedInService(t, true, func(o *Options) {
		o.BeforeLogout = func(context.Context) {
			paused.Add(1)
			idpRef.Load().record("paused")
		}
	})
	idpRef.Store(idp)
	if p := idp.lastPrompt.Load(); p == nil || *p != "" {
		t.Fatalf("the first sign-in must not force the prompt: %v", p)
	}
	secrets := svc.secrets.(*MemoryStore)

	if err := svc.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"paused",
		"device:" + testDeviceID,
		"logout:clarae-desktop:rt-1",
		"revoke:clarae-desktop:rt-1",
	}
	if got := idp.recorded(); !equal(got, want) {
		t.Fatalf("sign-out sequence:\n got %v\nwant %v", got, want)
	}
	if got := dl.revoked(); len(got) != 1 || got[0] != testDeviceID {
		t.Fatalf("revoked devices: %v", got)
	}
	if rt, _ := secrets.Get(cloud.URL); rt != "" {
		t.Fatal("the refresh token must be gone from the keychain")
	}
	if st := svc.State(); st.Status != StatusSignedOut || st.DeviceID != "" {
		t.Fatalf("state after logout: %+v", st)
	}
	if _, err := os.Stat(sessionPath(svc.opts.DataDir)); !os.IsNotExist(err) {
		t.Fatalf("auth.json must be deleted: %v", err)
	}
	if !explicitLogoutPending(svc.opts.DataDir) {
		t.Fatal("the explicit logout marker is missing")
	}

	// The next interactive login asks for the credentials, and only that one.
	if err := svc.Login(context.Background(), cloud.URL); err != nil {
		t.Fatal(err)
	}
	if got := *br.lastURL.Load(); !strings.Contains(got, "prompt=login") {
		t.Fatalf("login after logout must carry prompt=login: %s", got)
	}
	if p := idp.lastPrompt.Load(); p == nil || *p != "login" {
		t.Fatalf("the identity provider saw prompt=%v", p)
	}
	if explicitLogoutPending(svc.opts.DataDir) {
		t.Fatal("the marker must be cleared by a successful login")
	}
	if err := svc.Logout(context.Background()); err != nil { // sign out and in once more: marker again
		t.Fatal(err)
	}
	if !explicitLogoutPending(svc.opts.DataDir) {
		t.Fatal("second logout must mark again")
	}
	if paused.Load() != 2 {
		t.Fatalf("BeforeLogout calls: %d", paused.Load())
	}
}

func TestLoginWithoutLogoutDoesNotForcePrompt(t *testing.T) {
	_, idp, _, _, br := signedInService(t, true, nil)
	if got := *br.lastURL.Load(); strings.Contains(got, "prompt=") {
		t.Fatalf("no explicit logout, no prompt: %s", got)
	}
	if p := idp.lastPrompt.Load(); p == nil || *p != "" {
		t.Fatalf("prompt: %v", p)
	}
}

// Without revocation_endpoint in the discovery document the Keycloak URL is used; without
// end_session_endpoint there is no back-channel logout.
func TestLogoutFallsBackToKeycloakRevocation(t *testing.T) {
	svc, idp, dl, _, _ := signedInService(t, false, nil)
	if err := svc.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	want := []string{"device:" + testDeviceID, "revoke:keycloak-default"}
	if got := idp.recorded(); !equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if len(dl.revoked()) != 1 {
		t.Fatalf("revoked: %v", dl.revoked())
	}
}

// A dead cloud and a dead identity provider never keep the user signed in, and never take longer
// than the sign-out budget.
func TestLogoutNeverBlocksOnNetworkFailures(t *testing.T) {
	svc, idp, _, cloud, _ := signedInService(t, true, nil)
	cloud.Close()
	idp.srv.Close()

	start := time.Now()
	if err := svc.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > logoutNetworkTimeout+2*time.Second {
		t.Fatalf("logout took %v", d)
	}
	if svc.State().Status != StatusSignedOut {
		t.Fatalf("state: %+v", svc.State())
	}
	if !explicitLogoutPending(svc.opts.DataDir) {
		t.Fatal("the marker must be written even when the network is down")
	}
}

// A cloud that answers an error to the revocation (device already gone) and an identity provider
// that refuses the logout do not stop the sign-out either.
func TestLogoutIgnoresRefusals(t *testing.T) {
	idp := newFakeIdP(t)
	idp.announceEndpoints.Store(true)
	cloud := newFakeCloud(t, idp.srv.URL)
	// A cloud in front of the fake one that refuses every DELETE.
	target, _ := url.Parse(cloud.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.Header().Set("Content-Type", "application/problem+json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"type":"x","title":"x","status":404,"code":"NOT_FOUND"}`))
			return
		}
		proxy.ServeHTTP(w, r)
	}))
	t.Cleanup(front.Close)
	br := &browser{t: t, follow: true}
	svc := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), OpenURL: br.open, RedirectMode: RedirectLoopback,
		Secrets: NewMemoryStore(), LoginTimeout: 10 * time.Second, AppVersion: "test", DeviceName: "test-device", Platform: "linux"})
	if err := svc.Login(context.Background(), front.URL); err != nil {
		t.Fatal(err)
	}
	if err := svc.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if svc.State().Status != StatusSignedOut {
		t.Fatalf("state: %+v", svc.State())
	}
	// The identity provider was still asked, after the cloud refused.
	if got := idp.recorded(); len(got) != 2 || !strings.HasPrefix(got[0], "logout:") {
		t.Fatalf("calls: %v", got)
	}
}

// A revoked device (the console did it) is not revoked again at sign-out.
func TestLogoutSkipsRevokedDevice(t *testing.T) {
	svc, _, dl, _, _ := signedInService(t, true, nil)
	svc.DeviceRevoked("")
	if err := svc.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := dl.revoked(); len(got) != 0 {
		t.Fatalf("a revoked device must not be revoked again: %v", got)
	}
}

// A session that is disconnected with an expired access token (just after a Restore, a network
// blip) renews the token to revoke the device. That renewal must not turn the session ready
// again: OnState would restart the synchronization that BeforeLogout stopped, and a cycle could
// commit with a device about to be revoked.
func TestLogoutDoesNotReconnectTheSession(t *testing.T) {
	var mu sync.Mutex
	var seen []Status
	loggingOut := false
	svc, idp, dl, _, _ := signedInService(t, true, func(o *Options) {
		o.BeforeLogout = func(context.Context) {
			mu.Lock()
			loggingOut = true
			mu.Unlock()
		}
		o.OnState = func(st State) {
			mu.Lock()
			defer mu.Unlock()
			if loggingOut {
				seen = append(seen, st.Status)
			}
		}
	})
	svc.setState(func(st *State) { st.Status, st.Error = StatusDisconnected, "network blip" })
	svc.mu.Lock()
	svc.access, svc.expiry = "", time.Time{} // the token must be renewed inside Logout
	svc.mu.Unlock()
	tokens := idp.tokens.Load()

	if err := svc.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if idp.tokens.Load() == tokens {
		t.Fatal("the scenario needs a token renewal during the sign-out")
	}
	if got := dl.revoked(); len(got) != 1 || got[0] != testDeviceID {
		t.Fatalf("the device must still be revoked: %v", got)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 1 || seen[0] != StatusSignedOut {
		t.Fatalf("states notified during the sign-out: %v (want only signed_out)", seen)
	}
	svc.mu.Lock()
	flag := svc.loggingOut
	svc.mu.Unlock()
	if flag {
		t.Fatal("the sign-out must be over once the session is cleared")
	}
}

// The suppression ends with the sign-out: the next sign-in turns ready as usual.
func TestLoginAfterLogoutIsReady(t *testing.T) {
	svc, _, _, cloud, _ := signedInService(t, true, nil)
	if err := svc.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := svc.Login(context.Background(), cloud.URL); err != nil {
		t.Fatal(err)
	}
	if st := svc.State(); st.Status != StatusReady {
		t.Fatalf("state: %+v", st)
	}
}

// After a Restore the discovery has not run: Logout runs it to find the endpoints.
func TestLogoutAfterRestoreDiscoversEndpoints(t *testing.T) {
	svc, idp, dl, cloud, br := signedInService(t, true, nil)
	// A new process over the same data directory and keychain.
	svc2 := New(Options{DataDir: svc.opts.DataDir, Logger: zerolog.Nop(), OpenURL: br.open, RedirectMode: RedirectLoopback,
		Secrets: svc.secrets, LoginTimeout: 10 * time.Second, AppVersion: "test", DeviceName: "test-device", Platform: "linux"})
	svc2.Restore(context.Background())
	waitStatus(t, svc2, StatusReady)
	if err := svc2.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := idp.recorded()
	if len(got) < 3 || got[0] != "device:"+testDeviceID {
		t.Fatalf("calls: %v", got)
	}
	if !strings.HasPrefix(got[1], "logout:") || !strings.HasPrefix(got[2], "revoke:clarae-desktop:") {
		t.Fatalf("calls: %v", got)
	}
	if len(dl.revoked()) != 1 {
		t.Fatalf("revoked: %v", dl.revoked())
	}
	_ = cloud
}

func TestDeviceNameFromEnvironment(t *testing.T) {
	t.Setenv(DeviceNameEnv, "  workstation-b ")
	svc := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Secrets: NewMemoryStore(), Platform: "linux"})
	if got := svc.DeviceName(); got != "workstation-b" {
		t.Fatalf("device name = %q", got)
	}
	// An explicit option still wins over the environment.
	svc = New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Secrets: NewMemoryStore(), Platform: "linux", DeviceName: "explicit"})
	if got := svc.DeviceName(); got != "explicit" {
		t.Fatalf("device name = %q", got)
	}
	t.Setenv(DeviceNameEnv, "")
	svc = New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Secrets: NewMemoryStore(), Platform: "linux"})
	if svc.DeviceName() == "" || svc.DeviceName() == "workstation-b" {
		t.Fatalf("default device name = %q", svc.DeviceName())
	}
}
