package auth

import (
	"context"
	"errors"
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
