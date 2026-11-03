package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rs/zerolog"
)

func TestHostedSessionUsesThePageToken(t *testing.T) {
	cloud := newFakeCloud(t, "http://issuer.invalid")
	var asked atomic.Int32
	dir := t.TempDir()
	newHosted := func() *Service {
		return New(Options{
			DataDir: dir, Logger: zerolog.Nop(), Platform: "web",
			Hosted: &Hosted{ServerURL: cloud.URL, Token: func(context.Context) (string, error) {
				asked.Add(1)
				return "at-from-page", nil
			}},
		})
	}
	svc := newHosted()
	if err := svc.Login(context.Background(), "ignored"); err != nil {
		t.Fatalf("hosted login: %v", err)
	}
	st := svc.State()
	if st.Status != StatusReady || st.Profile.Username != "user1" || st.DeviceID != testDeviceID || st.ServerURL != cloud.URL {
		t.Fatalf("state after login = %+v", st)
	}
	if asked.Load() == 0 {
		t.Fatal("the page was never asked for a token")
	}
	if svc.Client() == nil {
		t.Fatal("no API client for a signed-in hosted session")
	}
	if svc.GRPCEndpoint() != "" {
		t.Fatalf("a hosted session must not announce gRPC (the browser uses SSE), got %q", svc.GRPCEndpoint())
	}

	// The browser keeps its device registration across a sign-out and a reload.
	if err := svc.Logout(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st := svc.State(); st.Status != StatusSignedOut {
		t.Fatalf("state after logout = %+v", st)
	}
	again := newHosted()
	again.Restore(context.Background())
	if got := again.State().DeviceID; got != testDeviceID {
		t.Fatalf("restored device id = %q, want %s", got, testDeviceID)
	}
	// Restore finishes the sign-in in the background; let it end before the directory goes away.
	deadline := time.Now().Add(5 * time.Second)
	for again.State().Status != StatusReady && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if st := again.State(); st.Status != StatusReady {
		t.Fatalf("restored session status = %s, want ready", st.Status)
	}
}

func TestHostedTokenFailureDisconnects(t *testing.T) {
	cloud := newFakeCloud(t, "http://issuer.invalid")
	fail := atomic.Bool{}
	svc := New(Options{
		DataDir: t.TempDir(), Logger: zerolog.Nop(),
		Hosted: &Hosted{ServerURL: cloud.URL, Token: func(context.Context) (string, error) {
			if fail.Load() {
				return "", errors.New("page signed out")
			}
			return "at-ok", nil
		}},
	})
	if err := svc.Login(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	fail.Store(true)
	if _, err := svc.Token(context.Background()); err == nil {
		t.Fatal("expected an error when the page has no token")
	}
	if st := svc.State(); st.Status != StatusDisconnected {
		t.Fatalf("status = %s, want disconnected", st.Status)
	}
	fail.Store(false)
	if _, err := svc.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	if st := svc.State(); st.Status != StatusReady {
		t.Fatalf("status = %s, want ready after the page recovers", st.Status)
	}
}

// A caller that gives up while the page is answering (a notification stream restarted by a change
// of the session) is not a disconnection: reporting it changed the session again, which restarted
// the stream and cancelled its next token request, in a loop of disconnected and ready states.
func TestHostedTokenCancelledByTheCallerKeepsTheSession(t *testing.T) {
	cloud := newFakeCloud(t, "http://issuer.invalid")
	var states atomic.Int32
	svc := New(Options{
		DataDir: t.TempDir(), Logger: zerolog.Nop(),
		OnState: func(State) { states.Add(1) },
		Hosted: &Hosted{ServerURL: cloud.URL, Token: func(ctx context.Context) (string, error) {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			return "at-ok", nil
		}},
	})
	if err := svc.Login(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	before := states.Load()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := svc.Token(ctx); err == nil {
		t.Fatal("expected the cancelled request to fail")
	}
	if st := svc.State(); st.Status != StatusReady {
		t.Fatalf("status = %s, want ready: the caller gave up, the session is fine", st.Status)
	}
	if n := states.Load(); n != before {
		t.Fatalf("%d state changes for a cancelled request, want none", n-before)
	}
}

func TestDeviceIsDroppedWhenTheAccountChanges(t *testing.T) {
	cloud := newFakeCloud(t, "http://issuer.invalid")
	dir := t.TempDir()
	if err := saveSession(dir, &persisted{ServerURL: cloud.URL, DeviceID: "old-device", Profile: Profile{UserID: "someone-else"}}); err != nil {
		t.Fatal(err)
	}
	svc := New(Options{DataDir: dir, Logger: zerolog.Nop(), Hosted: &Hosted{ServerURL: cloud.URL, Token: func(context.Context) (string, error) { return "at-x", nil }}})
	if err := svc.Login(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if got := svc.State().DeviceID; got != testDeviceID {
		t.Fatalf("device id = %q, want a new registration (%s) for the new account", got, testDeviceID)
	}
}

// memDevices is a HostedDevice in memory, like the page's IndexedDB store.
type memDevices struct {
	mu   sync.Mutex
	m    map[string][2]string
	fail bool
}

func (d *memDevices) LoadDevice(_ context.Context, server string) (string, string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.fail {
		return "", "", errors.New("indexeddb blocked")
	}
	v := d.m[server]
	return v[0], v[1], nil
}

func (d *memDevices) SaveDevice(_ context.Context, server, id, user string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.m[server] = [2]string{id, user}
	return nil
}

// deviceCloud serves /me and /me/devices (list and register), numbering the registrations.
type deviceCloud struct {
	*httptest.Server
	registered atomic.Int32
	mu         sync.Mutex
	active     map[string]bool
	userID     string
}

func newDeviceCloud(t *testing.T) *deviceCloud {
	t.Helper()
	c := &deviceCloud{active: map[string]bool{}, userID: "0190a0a0-0000-7000-8000-0000000000a1"}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/me", func(w http.ResponseWriter, _ *http.Request) {
		c.mu.Lock()
		user := c.userID
		c.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"id": user, "username": "user1", "email": "user1@memobrain.local", "role": "user", "status": "active", "quota_bytes": 1, "used_bytes": 0, "config_version": 0, "created_at": time.Now()})
	})
	mux.HandleFunc("/api/v1/me/devices", func(w http.ResponseWriter, r *http.Request) {
		c.mu.Lock()
		defer c.mu.Unlock()
		if r.Method == http.MethodPost {
			id := fmt.Sprintf("0190a0a0-0000-7000-8000-%012d", c.registered.Add(1))
			c.active[id] = true
			w.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(w).Encode(map[string]any{"id": id, "name": "web", "platform": "web", "created_at": time.Now()})
			return
		}
		items := []map[string]any{}
		for id := range c.active {
			items = append(items, map[string]any{"id": id, "name": "web", "platform": "web", "created_at": time.Now()})
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"items": items})
	})
	c.Server = httptest.NewServer(mux)
	t.Cleanup(c.Close)
	return c
}

func TestHostedDeviceSurvivesAWipedDataDirectory(t *testing.T) {
	cloud := newDeviceCloud(t)
	store := &memDevices{m: map[string][2]string{}}
	signIn := func() *Service {
		t.Helper()
		hosted := (&Hosted{ServerURL: cloud.URL, Token: func(context.Context) (string, error) { return "at-x", nil }}).WithDevice(store)
		svc := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Platform: "web", Hosted: hosted}) // a fresh (wiped) data directory each time
		if err := svc.Login(context.Background(), ""); err != nil {
			t.Fatal(err)
		}
		return svc
	}

	first := signIn().State().DeviceID
	if first == "" || cloud.registered.Load() != 1 {
		t.Fatalf("first sign-in: device %q, %d registrations", first, cloud.registered.Load())
	}
	if got := signIn().State().DeviceID; got != first || cloud.registered.Load() != 1 {
		t.Fatalf("after a wipe: device %q (want %q), %d registrations (want 1)", got, first, cloud.registered.Load())
	}

	// Revoked from the console: the next sign-in registers a new device and remembers it.
	cloud.mu.Lock()
	delete(cloud.active, first)
	cloud.mu.Unlock()
	second := signIn().State().DeviceID
	if second == first || cloud.registered.Load() != 2 || store.m[cloud.URL][0] != second {
		t.Fatalf("after a revocation: device %q, %d registrations, stored %v", second, cloud.registered.Load(), store.m[cloud.URL])
	}

	// Another account in the same browser does not take this account's device.
	cloud.mu.Lock()
	cloud.userID = "0190a0a0-0000-7000-8000-0000000000a2"
	cloud.mu.Unlock()
	if got := signIn().State().DeviceID; got == second || cloud.registered.Load() != 3 {
		t.Fatalf("another account: device %q, %d registrations", got, cloud.registered.Load())
	}
}

func TestHostedDeviceStoreFailureStillSignsIn(t *testing.T) {
	cloud := newDeviceCloud(t)
	store := &memDevices{m: map[string][2]string{}, fail: true}
	hosted := (&Hosted{ServerURL: cloud.URL, Token: func(context.Context) (string, error) { return "at-x", nil }}).WithDevice(store)
	svc := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Hosted: hosted})
	if err := svc.Login(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	if svc.State().Status != StatusReady || svc.State().DeviceID == "" {
		t.Fatalf("state = %+v", svc.State())
	}
}

func TestHostedDeviceRevokedThenRegisteredAgain(t *testing.T) {
	cloud := newDeviceCloud(t)
	store := &memDevices{m: map[string][2]string{}}
	dir := t.TempDir()
	var states []Status
	var mu sync.Mutex
	hosted := (&Hosted{ServerURL: cloud.URL, Token: func(context.Context) (string, error) { return "at-x", nil }}).WithDevice(store)
	svc := New(Options{DataDir: dir, Logger: zerolog.Nop(), Platform: "web", Hosted: hosted, OnState: func(st State) {
		mu.Lock()
		states = append(states, st.Status)
		mu.Unlock()
	}})
	if err := svc.Login(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	first := svc.State().DeviceID

	// A late report about another device changes nothing.
	svc.DeviceRevoked("0190a0a0-0000-7000-8000-00000000ffff")
	if st := svc.State(); st.Status != StatusReady {
		t.Fatalf("stale report: %+v", st)
	}
	svc.DeviceRevoked(first)
	st := svc.State()
	if st.Status != StatusDeviceRevoked || st.Error != DeviceRevokedMessage || st.DeviceID != first {
		t.Fatalf("after the revocation: %+v", st)
	}
	if p, err := readSession(dir, false); err != nil || p == nil || !p.DeviceRevoked {
		t.Fatalf("the revocation is not persisted: %+v %v", p, err)
	}
	// A failing token does not hide the revocation behind "disconnected".
	svc.setDisconnected(errors.New("network down"))
	if st := svc.State(); st.Status != StatusDeviceRevoked {
		t.Fatalf("revoked then offline: %+v", st)
	}

	if err := svc.ReregisterDevice(context.Background()); err != nil {
		t.Fatal(err)
	}
	st = svc.State()
	if st.Status != StatusReady || st.DeviceID == first || st.DeviceID == "" || cloud.registered.Load() != 2 {
		t.Fatalf("after registering again: %+v (%d registrations)", st, cloud.registered.Load())
	}
	if store.m[cloud.URL][0] != st.DeviceID {
		t.Fatalf("the browser remembers %v, want %s", store.m[cloud.URL], st.DeviceID)
	}
	if p, _ := readSession(dir, false); p == nil || p.DeviceRevoked || p.DeviceID != st.DeviceID {
		t.Fatalf("persisted after registering again: %+v", p)
	}
	mu.Lock()
	defer mu.Unlock()
	if !containsStatus(states, StatusDeviceRevoked) {
		t.Fatalf("no device_revoked state was published: %v", states)
	}
}

func TestReregisterDeviceFailureStaysRevoked(t *testing.T) {
	cloud := newDeviceCloud(t)
	fail := atomic.Bool{}
	hosted := &Hosted{ServerURL: cloud.URL, Token: func(context.Context) (string, error) {
		if fail.Load() {
			return "", errors.New("the page has no token")
		}
		return "at-x", nil
	}}
	svc := New(Options{DataDir: t.TempDir(), Logger: zerolog.Nop(), Platform: "web", Hosted: hosted})
	if err := svc.Login(context.Background(), ""); err != nil {
		t.Fatal(err)
	}
	first := svc.State().DeviceID
	svc.DeviceRevoked("")
	fail.Store(true)
	if err := svc.ReregisterDevice(context.Background()); err == nil {
		t.Fatal("registering again without a token succeeded")
	}
	if st := svc.State(); st.Status != StatusDeviceRevoked || st.DeviceID != first {
		t.Fatalf("after a failed registration: %+v", st)
	}
}

func containsStatus(list []Status, s Status) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
