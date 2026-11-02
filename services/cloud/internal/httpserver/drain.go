package httpserver

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"
)

// ErrDraining is reported by the readiness check once shutdown started.
var ErrDraining = errors.New("shutting down")

// Drain coordinates a graceful shutdown in two phases. Phase one (Start)
// flips readiness to "unavailable" so the load balancer stops sending new
// requests while the server keeps serving; phase two (Close) ends the
// long-lived streams (SSE), which would otherwise keep http.Server.Shutdown
// waiting until its timeout.
type Drain struct {
	start, closed chan struct{}
	startOnce     sync.Once
	closeOnce     sync.Once
}

// NewDrain returns a Drain in the serving state.
func NewDrain() *Drain {
	return &Drain{start: make(chan struct{}), closed: make(chan struct{})}
}

// Start begins draining (idempotent).
func (d *Drain) Start() { d.startOnce.Do(func() { close(d.start) }) }

// Close ends the long-lived streams (idempotent).
func (d *Drain) Close() { d.closeOnce.Do(func() { close(d.closed) }) }

// Closed is closed by Close: the other long-lived streams of the process
// (gRPC) end then too, once the endpoint left the load balancer.
func (d *Drain) Closed() <-chan struct{} { return d.closed }

// Draining reports whether Start was called.
func (d *Drain) Draining() bool {
	select {
	case <-d.start:
		return true
	default:
		return false
	}
}

// Check is a readiness check that fails while draining.
func (d *Drain) Check(context.Context) error {
	if d.Draining() {
		return ErrDraining
	}
	return nil
}

// Streams wraps a handler for long-lived responses: the request context is
// cancelled when the drain closes.
func (d *Drain) Streams(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		go func() {
			select {
			case <-d.closed:
				cancel()
			case <-ctx.Done():
			}
		}()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// Serve runs srv until ctx is done and then shuts it down gracefully:
// readiness fails first, the server keeps serving for delay (so the endpoint
// is removed from the load balancer before connections are refused), then
// in-flight requests get up to timeout to finish. A nil drain skips the
// readiness phase. The drain is closed whenever Serve returns, also when the
// listener fails, so whoever waits on Closed is never left hanging.
func Serve(ctx context.Context, srv *http.Server, drain *Drain, delay, timeout time.Duration) error {
	if drain != nil {
		defer drain.Close()
	}
	errc := make(chan error, 1)
	go func() { errc <- srv.ListenAndServe() }()
	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	if drain != nil {
		drain.Start()
	}
	if delay > 0 {
		time.Sleep(delay)
	}
	if drain != nil {
		drain.Close()
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	err := srv.Shutdown(shutdownCtx)
	if serveErr := <-errc; serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
		return serveErr
	}
	return err
}
