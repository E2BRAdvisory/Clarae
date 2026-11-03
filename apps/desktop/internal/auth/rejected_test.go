//go:build !js

package auth

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	"memobrain/apps/desktop/internal/sync/transport"
)

// A token the cloud refused is dropped: the next Token call refreshes it. A
// late report about an older token leaves the current one alone.
func TestInvalidateTokenForcesARefresh(t *testing.T) {
	idp := newFakeIdP(t)
	cloud := newFakeCloud(t, idp.srv.URL)
	svc, _ := newService(t, RedirectAuto, &browser{t: t, follow: true})
	ctx := context.Background()
	if err := svc.Login(ctx, cloud.URL); err != nil {
		t.Fatal(err)
	}
	if tok, _ := svc.Token(ctx); tok != "at-1" {
		t.Fatalf("token %q", tok)
	}
	svc.InvalidateToken("at-0")
	if tok, _ := svc.Token(ctx); tok != "at-1" {
		t.Fatalf("a stale invalidation dropped the token: %q", tok)
	}
	svc.InvalidateToken("at-1")
	if tok, err := svc.Token(ctx); err != nil || tok != "at-2" {
		t.Fatalf("token after invalidation: %q %v", tok, err)
	}
}

// A session the cloud keeps refusing stays disconnected, with the reason,
// until the user signs in again: new tokens do not turn it ready (each change
// of state would restart the notification stream), and repeated reports do
// not change the state again.
func TestSessionExpiredStaysUntilSignIn(t *testing.T) {
	idp := newFakeIdP(t)
	cloud := newFakeCloud(t, idp.srv.URL)
	svc, _ := newService(t, RedirectAuto, &browser{t: t, follow: true})
	var changes atomic.Int32
	svc.opts.OnState = func(State) { changes.Add(1) }
	ctx := context.Background()
	if err := svc.Login(ctx, cloud.URL); err != nil {
		t.Fatal(err)
	}

	svc.SessionExpired(transport.ErrSessionRejected)
	st := svc.State()
	if st.Status != StatusDisconnected || st.Error != transport.ErrSessionRejected.Error() {
		t.Fatalf("state: %+v", st)
	}
	n := changes.Load()
	svc.InvalidateToken("at-1")
	if tok, err := svc.Token(ctx); err != nil || tok != "at-2" {
		t.Fatalf("token: %q %v", tok, err)
	}
	svc.SessionExpired(transport.ErrSessionRejected)
	if st := svc.State(); st.Status != StatusDisconnected || changes.Load() != n {
		t.Fatalf("state %+v, %d changes after the report", st, changes.Load()-n)
	}

	if err := svc.Login(ctx, cloud.URL); err != nil {
		t.Fatal(err)
	}
	if st := svc.State(); st.Status != StatusReady {
		t.Fatalf("after a new sign-in: %+v", st)
	}
	svc.SessionExpired(transport.ErrSessionRejected)
	if st := svc.State(); st.Status != StatusDisconnected {
		t.Fatalf("the new session can be reported too: %+v", st)
	}
}

// Plain http is refused for a server on another computer, and for an
// identity provider on another computer announced by a local server.
func TestLoginRefusesPlainHTTP(t *testing.T) {
	svc, _ := newService(t, RedirectAuto, &browser{t: t})
	ctx := context.Background()
	if err := svc.Login(ctx, "http://cloud.example.com"); !errors.Is(err, transport.ErrInsecureURL) {
		t.Fatalf("err: %v", err)
	}
	if st := svc.State(); st.Status == StatusSigningIn {
		t.Fatalf("state: %+v", st)
	}

	cloud := newFakeCloud(t, "http://idp.example.com/realms/memobrain")
	if err := svc.Login(ctx, cloud.URL); !errors.Is(err, transport.ErrInsecureURL) {
		t.Fatalf("err: %v", err)
	}
}

// A session saved with plain http to another computer (before the rule) is
// not resumed: nothing is sent in clear, and the user is told why.
func TestRestoreSkipsAnInsecureSession(t *testing.T) {
	svc, secrets := newService(t, RedirectAuto, &browser{t: t})
	const server = "http://cloud.example.com"
	if err := saveSession(svc.opts.DataDir, &persisted{ServerURL: server, Issuer: "https://idp.example.com/realms/memobrain", ClientID: "memobrain-desktop"}); err != nil {
		t.Fatal(err)
	}
	_ = secrets.Set(server, "rt-1")
	svc.Restore(context.Background())
	st := svc.State()
	if st.Status != StatusSignedOut || st.Error == "" {
		t.Fatalf("state: %+v", st)
	}
	if svc.Client() != nil {
		t.Fatal("no client for an insecure session")
	}
}
