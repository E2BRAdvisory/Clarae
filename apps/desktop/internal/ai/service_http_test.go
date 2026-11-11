//go:build !js

package ai

// The tests that need a server on the loopback interface (not available in the browser build, where
// the package is only compiled).

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// sseServer answers every request with the given events and counts the requests it got.
func sseServer(t *testing.T, events string) (*httptest.Server, *int) {
	t.Helper()
	n := new(int)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*n++
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, events)
	}))
	t.Cleanup(srv.Close)
	return srv, n
}

// The core of the "inactive" promise (ADR-0050): with any one gate closed, Start returns a refusal
// and not a single HTTP request is made, whatever the other three say.
func TestNoRequestWhenAGateIsClosed(t *testing.T) {
	srv, hits := sseServer(t, "data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\ndata: [DONE]\n\n")
	cases := []struct {
		name   string
		mutate func(*gates)
		reason Reason
		is     error
	}{
		{"build constant off", func(g *gates) { g.build = false }, ReasonBuild, ErrBuildOff},
		{"profile flag off", func(g *gates) { g.flag = false }, ReasonProfile, ErrFlagOff},
		{"private vault", func(g *gates) { g.private = true }, ReasonPrivateVault, ErrPrivateVault},
		{"vault that cannot be classified", func(g *gates) { g.privateErr = errors.New("vault is not open") }, ReasonPrivateVault, ErrPrivateVault},
		{"provider not configured", func(g *gates) { g.configured = false }, ReasonNotConfigured, ErrNotConfigured},
		{"no key for a remote provider", func(g *gates) { g.key = ""; g.cfg.BaseURL = "https://api.example.com" }, ReasonNotConfigured, ErrNotConfigured},
		{"everything off", func(g *gates) { *g = gates{} }, ReasonBuild, ErrBuildOff},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := &recorder{}
			g := openGates()
			g.cfg.BaseURL = srv.URL
			c.mutate(&g)
			svc := g.service(newSink(), func(o *Options) { o.Client = rec.client() })
			defer svc.Close()

			st := svc.Status(context.Background(), "v1")
			if st.Available || st.Reason != c.reason {
				t.Fatalf("Status = %+v, want unavailable for %q", st, c.reason)
			}
			err := svc.Start(context.Background(), startReq("r1"))
			var ref *Refusal
			if !errors.As(err, &ref) || ref.Reason != c.reason || !errors.Is(err, c.is) {
				t.Fatalf("Start = %v, want a refusal for %q", err, c.reason)
			}
			if rec.count() != 0 || *hits != 0 {
				t.Fatalf("%d requests left the client and %d reached the server, want none", rec.count(), *hits)
			}
		})
	}
}

// The control of the test above: with every gate open the same setup does reach the server.
func TestRequestRunsWhenEveryGateIsOpen(t *testing.T) {
	srv, hits := sseServer(t, "data: {\"choices\":[{\"delta\":{\"content\":\"HE\"}}]}\n\n"+
		"data: {\"choices\":[{\"delta\":{\"content\":\"LLO\"}}]}\n\ndata: [DONE]\n\n")
	rec := &recorder{}
	g := openGates()
	g.cfg.BaseURL = srv.URL
	s := newSink()
	svc := g.service(s, func(o *Options) { o.Client = rec.client() })
	defer svc.Close()

	if st := svc.Status(context.Background(), "v1"); !st.Available || st.Provider != KindOpenAI || st.Model != "m" || st.Reason != ReasonNone {
		t.Fatalf("Status = %+v", st)
	}
	if err := svc.Start(context.Background(), startReq("r1")); err != nil {
		t.Fatal(err)
	}
	if d := s.wait(t); !d.OK || d.RequestID != "r1" || d.Error != "" {
		t.Fatalf("done = %+v", d)
	}
	if got := s.text(); got != "HELLO" {
		t.Fatalf("text = %q", got)
	}
	for i, c := range s.chunks {
		if c.Seq != i || c.RequestID != "r1" {
			t.Fatalf("chunk %d = %+v", i, c)
		}
	}
	if rec.count() != 1 || *hits != 1 {
		t.Fatalf("requests = %d (server %d), want 1", rec.count(), *hits)
	}
}

// Cancel stops a request that is streaming: no chunk follows it, and the end says cancelled. The
// connection to the server is closed (its handler sees the cancellation).
func TestCancelStopsTheStream(t *testing.T) {
	handlerDone := make(chan struct{})
	first := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerDone)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"one\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(first)
		<-r.Context().Done() // the client went away
	}))
	defer srv.Close()
	g := openGates()
	g.cfg.BaseURL = srv.URL
	s := newSink()
	svc := g.service(s)
	defer svc.Close()
	if err := svc.Start(context.Background(), startReq("r1")); err != nil {
		t.Fatal(err)
	}
	<-first
	deadline := time.Now().Add(5 * time.Second)
	for s.text() != "one" && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if !svc.Cancel("r1") {
		t.Fatal("Cancel found no request")
	}
	n := len(s.chunks)
	d := s.wait(t)
	if !d.Cancelled || d.OK || d.Error != "" {
		t.Fatalf("done = %+v", d)
	}
	if len(s.chunks) != n {
		t.Fatalf("a chunk was delivered after Cancel")
	}
	select {
	case <-handlerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("the connection to the provider was not closed")
	}
	if svc.Cancel("r1") {
		t.Error("a finished request cannot be cancelled again")
	}
}
