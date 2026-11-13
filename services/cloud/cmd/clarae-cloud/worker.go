package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// workerHealth is the state behind the worker's /healthz and /readyz.
type workerHealth struct {
	// waiting is set while the worker waits for the API to migrate the schema.
	waiting atomic.Bool
	// lastTick returns the scheduler heartbeat (jobs.Runner.LastTick) and
	// heartbeat its interval.
	lastTick  func() time.Time
	heartbeat time.Duration
	now       func() time.Time
}

// ticking reports whether the scheduler recorded a heartbeat recently (three
// intervals tolerate a busy host).
func (h *workerHealth) ticking() bool {
	t := h.lastTick()
	return !t.IsZero() && h.now().Sub(t) < 3*h.heartbeat
}

// workerHandler serves the internal endpoints of the worker role, which has
// no API listener: /metrics for Prometheus (the job metrics live in this
// process), /healthz for liveness and /readyz for readiness. Liveness holds
// while the worker waits for the schema (restarting would not help) and while
// the scheduler ticks; readiness needs the scheduler running.
func workerHandler(h *workerHealth, version string) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", promhttp.Handler())
	reply := func(w http.ResponseWriter, ok bool, state string) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		status := "ok"
		if !ok {
			status = "unavailable"
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"status": status, "state": state, "version": version})
	}
	state := func() string {
		switch {
		case h.waiting.Load():
			return "waiting-for-schema"
		case h.ticking():
			return "running"
		default:
			return "stalled"
		}
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		s := state()
		reply(w, s != "stalled", s)
	})
	mux.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		s := state()
		reply(w, s == "running", s)
	})
	return mux
}

// serveInternal runs srv until ctx ends, then shuts it down within timeout.
func serveInternal(ctx context.Context, srv *http.Server, timeout time.Duration) error {
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil {
		return err
	}
	if err := <-errc; !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
