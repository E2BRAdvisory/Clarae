package httpserver

import (
	"context"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// TestServeDrainsBeforeClosing proves the shutdown order: readiness fails while the
// server still accepts requests, a request in flight when the signal arrives
// completes, and an open stream is ended instead of stalling the shutdown.
func TestServeDrainsBeforeClosing(t *testing.T) {
	drain := NewDrain()
	var readyChecks atomic.Int32
	inflight := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		if err := drain.Check(r.Context()); err != nil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		readyChecks.Add(1)
	})
	mux.HandleFunc("/slow", func(w http.ResponseWriter, _ *http.Request) {
		close(inflight)
		time.Sleep(500 * time.Millisecond)
		_, _ = w.Write([]byte("done"))
	})
	mux.Handle("/stream", drain.Streams(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	})))

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	ctx, stop := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Serve(ctx, srv, drain, 600*time.Millisecond, 5*time.Second) }()
	waitUp(t, "http://"+addr+"/ready")

	streamResp, err := http.Get("http://" + addr + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	slowRes := make(chan string, 1)
	go func() {
		resp, err := http.Get("http://" + addr + "/slow")
		if err != nil {
			slowRes <- err.Error()
			return
		}
		defer func() { _ = resp.Body.Close() }()
		b := make([]byte, 4)
		n, _ := resp.Body.Read(b)
		slowRes <- string(b[:n])
	}()
	<-inflight
	stop() // SIGTERM equivalent

	// During the drain window the server still answers, but reports not ready.
	time.Sleep(150 * time.Millisecond)
	resp, err := http.Get("http://" + addr + "/ready")
	if err != nil {
		t.Fatalf("server must still accept connections while draining: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("readiness while draining = %d, want 503", resp.StatusCode)
	}

	start := time.Now()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Serve: %v", err)
		}
	case <-time.After(8 * time.Second):
		t.Fatal("shutdown stalled: the open stream was not ended")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatalf("shutdown took %v", time.Since(start))
	}
	if got := <-slowRes; got != "done" {
		t.Fatalf("in-flight request was cut: %q", got)
	}
	_ = streamResp.Body.Close()
	if _, err := http.Get("http://" + addr + "/ready"); err == nil {
		t.Fatal("server still accepts connections after shutdown")
	}
}

func waitUp(t *testing.T, url string) {
	t.Helper()
	for i := 0; i < 100; i++ {
		if resp, err := http.Get(url); err == nil { //nolint:gosec // loopback test server
			_ = resp.Body.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("server did not start")
}
