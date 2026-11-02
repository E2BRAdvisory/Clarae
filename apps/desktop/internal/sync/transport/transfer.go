package transport

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

// Default bounds of a content transfer (see Client.TransferIdleTimeout and
// Client.TransferHeaderTimeout).
const (
	defaultTransferIdleTimeout   = 60 * time.Second
	defaultTransferHeaderTimeout = 2 * time.Minute
)

// ErrTransferStalled is returned by a blob upload or download that the
// watchdog aborted because no bytes moved for too long.
var ErrTransferStalled = errors.New("transfer stalled")

type transferKey struct{}

// transfer marks a request that moves file content (blobs, revision content,
// tus chunks). The total timeout of the http.Client bounds the whole exchange,
// body included, so a large file on a slow link could never complete within
// it: such requests run without it and are bounded by a watchdog instead (see
// Client.send).
func transfer(ctx context.Context) context.Context {
	return context.WithValue(ctx, transferKey{}, true)
}

func isTransfer(ctx context.Context) bool { return ctx.Value(transferKey{}) != nil }

// transferClient is c.http without the total timeout; it shares the Transport,
// so transfers reuse the connections of the JSON calls.
func (c *Client) transferClient() *http.Client {
	hc := *c.http
	hc.Timeout = 0
	return &hc
}

// watchdog bounds one attempt of a transfer: it cancels the attempt's context
// when the server takes longer than header to answer after the request body
// was sent, or when the request or response body moves no bytes for idle.
// Time spent by the caller between reads of the response (writing to disk,
// say) does not count: only a Read blocked on the network does. A bound of
// zero or less is disabled. The caller's context still cancels the attempt at
// any time.
type watchdog struct {
	ctx          context.Context
	cancel       context.CancelCauseFunc
	idle, header time.Duration

	mu        sync.Mutex
	timer     *time.Timer
	armed     bool
	deadline  time.Time
	phase     phase
	responded bool  // Do returned: the request body no longer arms the timer
	stopped   bool  // body closed or attempt over
	stalled   error // set when the watchdog fired
}

func newWatchdog(parent context.Context, idle, header time.Duration) *watchdog {
	ctx, cancel := context.WithCancelCause(parent)
	w := &watchdog{ctx: ctx, cancel: cancel, idle: idle, header: header}
	w.mu.Lock()
	// Until the request body is read, connecting and sending the headers
	// count as waiting for the server.
	w.armLocked(waitResponse)
	w.mu.Unlock()
	return w
}

// phase is what an armed watchdog is waiting for.
type phase int

const (
	waitResponse phase = iota // the response headers
	waitUpload                // the network to accept the next request bytes
	waitDownload              // the next response bytes
)

// armLocked starts (or restarts) the countdown for ph; w.mu is held.
func (w *watchdog) armLocked(ph phase) {
	if w.stopped {
		return
	}
	d := w.idle
	if ph == waitResponse {
		d = w.header
	}
	if d <= 0 { // this bound is disabled
		w.armed = false
		return
	}
	w.armed, w.deadline, w.phase = true, time.Now().Add(d), ph
	if w.timer == nil {
		w.timer = time.AfterFunc(d, w.fire)
	} else {
		w.timer.Reset(d)
	}
}

func (w *watchdog) fire() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.armed || w.stopped || w.stalled != nil || w.ctx.Err() != nil {
		return
	}
	if left := time.Until(w.deadline); left > 0 {
		w.timer.Reset(left) // re-armed while this run was pending
		return
	}
	switch w.phase {
	case waitResponse:
		w.stalled = fmt.Errorf("transport: %w: no response from the server within %s", ErrTransferStalled, w.header)
	case waitUpload:
		w.stalled = fmt.Errorf("transport: %w: upload made no progress for %s", ErrTransferStalled, w.idle)
	default:
		w.stalled = fmt.Errorf("transport: %w: download made no progress for %s", ErrTransferStalled, w.idle)
	}
	w.cancel(w.stalled)
}

// err returns the stall error in place of err when the watchdog fired, so the
// caller sees why the attempt was aborted rather than a bare cancellation.
func (w *watchdog) err(err error) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.stalled != nil && w.ctx.Err() != nil && errors.Is(context.Cause(w.ctx), w.stalled) {
		return w.stalled
	}
	return err
}

// gotResponse ends the request phase: the response headers arrived (or Do failed).
func (w *watchdog) gotResponse() {
	w.mu.Lock()
	w.responded, w.armed = true, false
	w.mu.Unlock()
}

// stop ends the attempt and releases its context.
func (w *watchdog) stop() {
	w.mu.Lock()
	w.stopped, w.armed = true, false
	if w.timer != nil {
		w.timer.Stop()
	}
	w.mu.Unlock()
	w.cancel(context.Canceled)
}

// requestBody watches the upload: the transport reads the next bytes only
// after writing the previous ones, so the time between reads is the time the
// network takes to accept them.
func (w *watchdog) requestBody(body io.ReadCloser) io.ReadCloser {
	return &watchedRequest{w: w, body: body}
}

type watchedRequest struct {
	w    *watchdog
	body io.ReadCloser
}

func (r *watchedRequest) Read(p []byte) (int, error) {
	w := r.w
	w.mu.Lock()
	if !w.responded {
		w.armed = false
	}
	w.mu.Unlock()
	n, err := r.body.Read(p)
	w.mu.Lock()
	if !w.responded {
		if errors.Is(err, io.EOF) {
			w.armLocked(waitResponse)
		} else {
			w.armLocked(waitUpload)
		}
	}
	w.mu.Unlock()
	return n, err
}

func (r *watchedRequest) Close() error { return r.body.Close() }

// responseBody watches the download; closing it ends the attempt.
func (w *watchdog) responseBody(body io.ReadCloser) io.ReadCloser {
	return &watchedResponse{w: w, body: body}
}

type watchedResponse struct {
	w    *watchdog
	body io.ReadCloser
}

func (r *watchedResponse) Read(p []byte) (int, error) {
	w := r.w
	w.mu.Lock()
	w.armLocked(waitDownload)
	w.mu.Unlock()
	n, err := r.body.Read(p)
	w.mu.Lock()
	w.armed = false
	w.mu.Unlock()
	if err != nil && !errors.Is(err, io.EOF) {
		err = w.err(err)
	}
	return n, err
}

func (r *watchedResponse) Close() error {
	err := r.body.Close()
	r.w.stop()
	return err
}
