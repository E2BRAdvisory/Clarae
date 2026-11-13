package app

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/rs/zerolog"
)

// The links that 1.x wrote in notes and the system hands to the application under the old scheme are
// handled like the new ones, whichever way they arrive (the command line of the first instance, the
// arguments of a second one, the event of macOS), and keep their order.
func TestLegacySchemeLinksAreHandled(t *testing.T) {
	a, h, got := newSignalApp(t)
	a.HandleURL("memobrain://open?vault=A&file=a.md") // before DomReady: queued
	a.OnSecondInstance([]string{"/bin/clarae", "--flag", "memobrain://open?vault=B&file=b.md"})
	a.OnSecondInstance([]string{"/bin/clarae", "clarae://open?vault=C"})
	if n := len(openRequests(*got)); n != 0 {
		t.Fatalf("%d open requests before DomReady, want 0 (queued)", n)
	}
	a.DomReady(context.Background())
	a.HandleURL("MEMOBRAIN://open?vault=D")

	reqs := openRequests(*got)
	want := []OpenRequestPayload{{Vault: "A", File: "a.md"}, {Vault: "B", File: "b.md"}, {Vault: "C"}, {Vault: "D"}}
	if len(reqs) != len(want) {
		t.Fatalf("open requests = %+v, want %+v", reqs, want)
	}
	for i := range want {
		if reqs[i] != want[i] {
			t.Errorf("open request %d = %+v, want %+v", i, reqs[i], want[i])
		}
	}
	if h.shown != 2 {
		t.Errorf("ShowWindow called %d times, want 2 (once per second instance)", h.shown)
	}
}

// A callback delivered under the old scheme is a callback: it goes to the login (the redirect URI of a
// realm made for 1.x comes back that way), not to the log as an unknown URL.
func TestLegacySchemeAuthCallbackIsRoutedToTheLogin(t *testing.T) {
	var log bytes.Buffer
	a := New(Options{DataDir: t.TempDir(), Logger: zerolog.New(&log), Version: "test"})
	a.ctx = context.Background()
	a.setEmitter(func(string, any) {})
	a.DomReady(context.Background())

	a.HandleURL("memobrain://auth/callback?code=c&state=s") // no login waits for it
	out := log.String()
	if strings.Contains(out, "ignored url") {
		t.Fatalf("the callback was taken for an unknown URL: %s", out)
	}
	if !strings.Contains(out, "auth callback received with no login in progress") {
		t.Fatalf("the callback did not reach the login: %s", out)
	}
}
