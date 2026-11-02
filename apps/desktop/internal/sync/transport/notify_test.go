package transport

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"
)

// reportingTokens is a rotatingTokens that records the sessions reported as expired.
type reportingTokens struct {
	rotatingTokens
	mu      sync.Mutex
	reports []error
}

func (r *reportingTokens) SessionExpired(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reports = append(r.reports, err)
}

func (r *reportingTokens) reported() []error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]error(nil), r.reports...)
}

func fastRetries(t *testing.T) {
	t.Helper()
	prev := retryBase
	retryBase = time.Millisecond
	t.Cleanup(func() { retryBase = prev })
}

func notifyClient(t *testing.T, f *fakeServer, tokens TokenSource) *Client {
	t.Helper()
	c, err := New("https://cloud.example", tokens, &http.Client{Transport: f}, "test-agent")
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// A stream the server keeps refusing drops each token (so the next attempt
// has a new one), backs off and, after maxAuthRefusals refusals in a row,
// reports the session once and stops instead of reconnecting forever.
func TestRefusedStreamGivesUpAndReportsTheSession(t *testing.T) {
	fastRetries(t)
	f := &fakeServer{handlers: []func(*http.Request) *http.Response{reply(http.StatusUnauthorized, "", "")}}
	tokens := &reportingTokens{}
	c := notifyClient(t, f, tokens)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan struct{})
	go func() {
		c.RunNotifications(ctx, NotifyOptions{MaxBackoff: 20 * time.Millisecond})
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("RunNotifications kept reconnecting")
	}
	if got := tokens.reported(); len(got) != 1 || !errors.Is(got[0], ErrSessionRejected) {
		t.Fatalf("reports: %v", got)
	}
	if len(f.reqs) != maxAuthRefusals {
		t.Fatalf("%d requests, want %d", len(f.reqs), maxAuthRefusals)
	}
	for i, r := range f.reqs {
		if want := "Bearer tok-" + strconv.Itoa(i+1); r.header.Get("Authorization") != want {
			t.Fatalf("request %d: %q, want %q", i, r.header.Get("Authorization"), want)
		}
	}
}

// Refusals count only in a row: a stream that connected in between (a token
// that ran out during a long stream, then a refresh) starts a new count.
func TestConnectedStreamResetsTheRefusals(t *testing.T) {
	fastRetries(t)
	refused := reply(http.StatusUnauthorized, "", "")
	stream := reply(http.StatusOK, "text/event-stream", "event: vault_changed\ndata: {\"vault_id\":\"v\",\"seq\":1}\n\n")
	var handlers []func(*http.Request) *http.Response
	for range 3 {
		for range maxAuthRefusals - 1 {
			handlers = append(handlers, refused)
		}
		handlers = append(handlers, stream)
	}
	f := &fakeServer{handlers: handlers}
	tokens := &reportingTokens{}
	c := notifyClient(t, f, tokens)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan VaultEvent, 64)
	done := make(chan struct{})
	go func() {
		c.RunNotifications(ctx, NotifyOptions{MaxBackoff: 5 * time.Millisecond, Handler: func(ev VaultEvent) { events <- ev }})
		close(done)
	}()
	deadline := time.After(10 * time.Second)
	for seen := 0; seen < 3; {
		select {
		case <-events:
			seen++
		case <-done:
			t.Fatalf("RunNotifications stopped: reports %v", tokens.reported())
		case <-deadline:
			t.Fatal("no events")
		}
	}
	cancel()
	<-done
	if got := tokens.reported(); len(got) != 0 {
		t.Fatalf("reports: %v", got)
	}
}
