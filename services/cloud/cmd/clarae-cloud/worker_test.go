package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestWorkerHealth(t *testing.T) {
	now := time.Unix(10_000, 0)
	var tick time.Time
	h := &workerHealth{lastTick: func() time.Time { return tick }, heartbeat: 10 * time.Second, now: func() time.Time { return now }}
	srv := workerHandler(h, "v1")
	probe := func(path string) (int, string) {
		rec := httptest.NewRecorder()
		srv.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec.Code, rec.Body.String()
	}
	for _, c := range []struct {
		name            string
		waiting         bool
		tick            time.Time
		healthz, readyz int
		state           string
	}{
		{"waiting for the schema", true, time.Time{}, 200, 503, "waiting-for-schema"},
		{"scheduler ticking", false, now.Add(-5 * time.Second), 200, 200, "running"},
		{"scheduler stalled", false, now.Add(-time.Minute), 503, 503, "stalled"},
		{"scheduler stopped", false, time.Time{}, 503, 503, "stalled"},
	} {
		h.waiting.Store(c.waiting)
		tick = c.tick
		code, body := probe("/healthz")
		if code != c.healthz || !strings.Contains(body, c.state) {
			t.Errorf("%s: /healthz %d %s", c.name, code, body)
		}
		if code, body := probe("/readyz"); code != c.readyz {
			t.Errorf("%s: /readyz %d %s", c.name, code, body)
		}
	}
	if code, body := probe("/metrics"); code != 200 || !strings.Contains(body, "go_goroutines") {
		t.Fatalf("/metrics: %d", code)
	}
	if code, _ := probe("/api/v1/me"); code != http.StatusNotFound {
		t.Fatalf("unknown path: %d", code)
	}
}

func TestServeInternalShutsDownWithTheContext(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := lis.Addr().String()
	_ = lis.Close()
	srv := &http.Server{Addr: addr, Handler: http.NotFoundHandler(), ReadHeaderTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- serveInternal(ctx, srv, time.Second) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		resp, err := http.Get("http://" + addr + "/x")
		if err == nil {
			_ = resp.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("shutdown: %v", err)
	}
}
