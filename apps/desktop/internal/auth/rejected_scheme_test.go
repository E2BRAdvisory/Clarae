//go:build !js

package auth

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"testing"
	"time"
)

// The custom-scheme redirect URI and the realms made for 1.x (ADR-0052): the probe of rejected_test.go
// applied to the new URI and the old one.

// signInWithScheme runs a login against idp up to the callback that the OS would deliver, and
// returns the redirect URI of the authorization request.
func signInWithScheme(t *testing.T, idp *fakeIdP, mode RedirectMode) string {
	t.Helper()
	cloud := newFakeCloud(t, idp.srv.URL)
	br := &browser{t: t}
	svc, _ := newService(t, mode, br)
	done := make(chan error, 1)
	go func() { done <- svc.Login(context.Background(), cloud.URL) }()
	u := waitAuthURL(t, br)
	redirect := u.Query().Get("redirect_uri")
	if !svc.HandleCallback(url.Values{"code": {"code-123"}, "state": {u.Query().Get("state")}}) {
		t.Fatal("callback not accepted")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if svc.State().Status != StatusReady {
		t.Fatalf("state: %+v", svc.State())
	}
	return redirect
}

// A realm made for 1.x has only the old redirect URI registered: the sign-in must work with no
// change by the administrator, by trying the old URI when the new one is rejected.
func TestSchemeFallsBackToTheRedirectURIOf1xWhenTheRealmRejectsTheNewOne(t *testing.T) {
	for _, mode := range []RedirectMode{RedirectScheme, RedirectAuto} {
		t.Run(string(mode), func(t *testing.T) {
			idp := newFakeIdP(t)
			idp.rejectURI.Store(SchemeRedirectURI, true)
			if mode == RedirectAuto {
				idp.rejectLoopback.Store(true) // the loopback is refused too: the scheme is the way left
			}
			if got := signInWithScheme(t, idp, mode); got != LegacySchemeRedirectURI {
				t.Fatalf("redirect_uri = %q, want %q", got, LegacySchemeRedirectURI)
			}
		})
	}
}

// A realm that has the new URI is not asked about the old one: one probe, and the new URI in the
// request of the browser.
func TestSchemeUsesTheNewRedirectURIWhenTheRealmKnowsIt(t *testing.T) {
	idp := newFakeIdP(t)
	if got := signInWithScheme(t, idp, RedirectScheme); got != SchemeRedirectURI {
		t.Fatalf("redirect_uri = %q, want %q", got, SchemeRedirectURI)
	}
	if n := idp.authRequests.Load(); n != 1 {
		t.Fatalf("%d requests to the authorization endpoint, want the one probe (the browser is a stub)", n)
	}
}

// A realm that has registered neither is not the client's to fix: the new URI goes to the browser,
// which shows the page of the provider.
func TestSchemeKeepsTheNewRedirectURIWhenTheRealmRejectsBoth(t *testing.T) {
	idp := newFakeIdP(t)
	idp.rejectURI.Store(SchemeRedirectURI, true)
	idp.rejectURI.Store(LegacySchemeRedirectURI, true)
	cloud := newFakeCloud(t, idp.srv.URL)
	br := &browser{t: t}
	svc, _ := newService(t, RedirectScheme, br)
	svc.opts.LoginTimeout = 300 * time.Millisecond
	_ = svc.Login(context.Background(), cloud.URL)
	if got := waitAuthURL(t, br).Query().Get("redirect_uri"); got != SchemeRedirectURI {
		t.Fatalf("redirect_uri = %q, want %q", got, SchemeRedirectURI)
	}
}

// An identity provider that cannot be asked is not taken for one that rejects: the new URI.
func TestSchemeKeepsTheNewRedirectURIWhenTheProbeFails(t *testing.T) {
	idp := newFakeIdP(t)
	cloud := newFakeCloud(t, idp.srv.URL)
	br := &browser{t: t}
	svc, _ := newService(t, RedirectScheme, br)
	svc.opts.LoginTimeout = 300 * time.Millisecond
	svc.hc = &http.Client{Transport: failAuthorize{http.DefaultTransport}}
	_ = svc.Login(context.Background(), cloud.URL)
	if got := waitAuthURL(t, br).Query().Get("redirect_uri"); got != SchemeRedirectURI {
		t.Fatalf("redirect_uri = %q, want %q", got, SchemeRedirectURI)
	}
}

// failAuthorize fails the requests to /auth and lets the others through.
type failAuthorize struct{ next http.RoundTripper }

func (f failAuthorize) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Path == "/auth" {
		return nil, errors.New("connection reset")
	}
	return f.next.RoundTrip(r)
}
