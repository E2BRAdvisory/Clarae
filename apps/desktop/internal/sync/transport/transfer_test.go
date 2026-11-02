//go:build !js

package transport

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// These tests need a real connection (the timeouts under test live in the
// http.Client and in the socket reads), so they do not run under js/wasm.

const (
	testVault    = "0190a0a0-0000-7000-8000-000000000001"
	testFile     = "0190a0a0-0000-7000-8000-000000000003"
	testHash     = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	testJSONTO   = 200 * time.Millisecond // total timeout of the http.Client
	testIdleTO   = 300 * time.Millisecond
	testHeaderTO = 2 * time.Second
)

// newTransferClient returns a client whose http.Client has a total timeout far
// shorter than the transfers the tests run, as the desktop's 30 s is for a
// large file on a slow link.
func newTransferClient(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := New(srv.URL, staticTokens("tok"), &http.Client{Timeout: testJSONTO}, "test-agent")
	if err != nil {
		t.Fatal(err)
	}
	c.TransferIdleTimeout, c.TransferHeaderTimeout = testIdleTO, testHeaderTO
	return c
}

// trickle writes n chunks of 1 KiB, one every 50 ms.
func trickle(w http.ResponseWriter, r *http.Request, n int) {
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	chunk := bytes.Repeat([]byte("x"), 1024)
	for i := range n {
		if i > 0 {
			select {
			case <-r.Context().Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
		_, _ = w.Write(chunk)
		w.(http.Flusher).Flush()
	}
}

// waitDone blocks the handler until the client gives up (or the test is long over).
func waitDone(r *http.Request) {
	select {
	case <-r.Context().Done():
	case <-time.After(10 * time.Second):
	}
}

// A download that keeps moving lasts as long as it needs: 1 s of steady bytes
// against a 200 ms request timeout. The same response to a JSON call is cut.
func TestSlowDownloadOutlivesRequestTimeout(t *testing.T) {
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) { trickle(w, r, 21) })
	ctx := context.Background()
	for name, get := range map[string]func(io.Writer) (int64, error){
		"blob":     func(w io.Writer) (int64, error) { return c.GetBlob(ctx, testVault, testHash, w) },
		"revision": func(w io.Writer) (int64, error) { return c.GetRevisionContent(ctx, testVault, testFile, 3, w) },
	} {
		t.Run(name, func(t *testing.T) {
			var buf bytes.Buffer
			start := time.Now()
			n, err := get(&buf)
			if err != nil {
				t.Fatalf("download failed after %s: %v", time.Since(start), err)
			}
			if n != 21*1024 || buf.Len() != 21*1024 {
				t.Fatalf("got %d bytes (buffer %d), want %d", n, buf.Len(), 21*1024)
			}
			if el := time.Since(start); el < 4*testJSONTO {
				t.Fatalf("transfer took %s: it does not exercise the request timeout", el)
			}
		})
	}
	c.Retries = 0
	if _, err := c.GetMe(ctx); err == nil || !strings.Contains(err.Error(), "Client.Timeout") {
		t.Fatalf("JSON call: want the client timeout, got %v", err)
	}
}

// readSlowly consumes the request body 16 KiB every 50 ms and answers status.
func readSlowly(t *testing.T, r *http.Request, w http.ResponseWriter, status int) {
	buf := make([]byte, 16<<10)
	total := 0
	for {
		time.Sleep(50 * time.Millisecond)
		n, err := io.ReadFull(r.Body, buf)
		total += n
		if err != nil {
			break
		}
	}
	if int64(total) != r.ContentLength {
		t.Errorf("%s %s: read %d of %d bytes", r.Method, r.URL.Path, total, r.ContentLength)
	}
	w.WriteHeader(status)
}

// An upload the server reads slowly but steadily also outlives the request
// timeout, with a single PUT and with tus.
func TestSlowUploadOutlivesRequestTimeout(t *testing.T) {
	data := bytes.Repeat([]byte("y"), 256<<10)
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPut:
			readSlowly(t, r, w, http.StatusCreated)
		case http.MethodPost:
			w.Header().Set("Location", BasePath+"/vaults/"+testVault+"/uploads/u1")
			w.WriteHeader(http.StatusCreated)
		case http.MethodPatch:
			readSlowly(t, r, w, http.StatusNoContent)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
		}
	})
	ctx := context.Background()
	start := time.Now()
	if err := c.PutBlob(ctx, testVault, testHash, data); err != nil {
		t.Fatalf("PutBlob failed after %s: %v", time.Since(start), err)
	}
	if el := time.Since(start); el < 4*testJSONTO {
		t.Fatalf("PutBlob took %s: it does not exercise the request timeout", el)
	}
	start = time.Now()
	if _, err := c.TusUpload(ctx, testVault, testHash, data, "", nil); err != nil {
		t.Fatalf("TusUpload failed after %s: %v", time.Since(start), err)
	}
}

// A download that stops moving is aborted after the idle timeout, with an
// error that says so.
func TestStalledDownloadFails(t *testing.T) {
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) {
		trickle(w, r, 2)
		waitDone(r)
	})
	start := time.Now()
	_, err := c.GetBlob(context.Background(), testVault, testHash, io.Discard)
	el := time.Since(start)
	if !errors.Is(err, ErrTransferStalled) || !strings.Contains(err.Error(), "download made no progress") {
		t.Fatalf("want a stalled download, got %v", err)
	}
	if el < testIdleTO || el > 3*time.Second {
		t.Fatalf("stall detected after %s, idle timeout is %s", el, testIdleTO)
	}
}

// A server that never answers is aborted after the header timeout.
func TestStalledResponseFails(t *testing.T) {
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body) // the server notices the client leaving only once the body is read
		waitDone(r)
	})
	c.Retries, c.TransferHeaderTimeout = 0, testIdleTO
	start := time.Now()
	err := c.PutBlob(context.Background(), testVault, testHash, []byte("data"))
	if !errors.Is(err, ErrTransferStalled) || !strings.Contains(err.Error(), "no response from the server") {
		t.Fatalf("want a stalled response, got %v", err)
	}
	if el := time.Since(start); el > 3*time.Second {
		t.Fatalf("stall detected after %s", el)
	}
}

// The caller's context still cancels a transfer at any time, and the error is
// the cancellation, not a stall.
func TestTransferCancelledByCaller(t *testing.T) {
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) { trickle(w, r, 100) })
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := c.GetBlob(ctx, testVault, testHash, io.Discard)
	if err == nil || errors.Is(err, ErrTransferStalled) || ctx.Err() == nil {
		t.Fatalf("want the cancellation, got %v", err)
	}
	if el := time.Since(start); el > 2*time.Second {
		t.Fatalf("cancellation took %s", el)
	}
}

// An upload the server stops reading is aborted after the idle timeout. The
// body is larger than the socket buffers, so the transport blocks writing it.
func TestStalledUploadFails(t *testing.T) {
	// The server learns that the client left only by reading the body, which
	// it never does: release the handler before the server is closed.
	release := make(chan struct{})
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) { <-release })
	t.Cleanup(func() { close(release) })
	c.Retries = 0
	start := time.Now()
	err := c.PutBlob(context.Background(), testVault, testHash, bytes.Repeat([]byte("z"), 24<<20))
	el := time.Since(start)
	if !errors.Is(err, ErrTransferStalled) || !strings.Contains(err.Error(), "upload made no progress") {
		t.Fatalf("want a stalled upload, got %v", err)
	}
	if el < testIdleTO || el > 5*time.Second {
		t.Fatalf("stall detected after %s, idle timeout is %s", el, testIdleTO)
	}
}

// A stall before the response is retried like a network error.
func TestStalledResponseIsRetried(t *testing.T) {
	var calls atomic.Int32
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			waitDone(r)
			return
		}
		trickle(w, r, 3)
	})
	c.Retries, c.TransferHeaderTimeout = 1, testIdleTO
	var buf bytes.Buffer
	if _, err := c.GetBlob(context.Background(), testVault, testHash, &buf); err != nil {
		t.Fatalf("GetBlob: %v", err)
	}
	if calls.Load() != 2 || buf.Len() != 3*1024 {
		t.Fatalf("calls=%d bytes=%d, want 2 calls and %d bytes", calls.Load(), buf.Len(), 3*1024)
	}
}

// Zero timeouts disable the watchdog rather than aborting every transfer.
func TestZeroTransferTimeoutsDisableWatchdog(t *testing.T) {
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) { trickle(w, r, 8) })
	c.TransferIdleTimeout, c.TransferHeaderTimeout = 0, 0
	var buf bytes.Buffer
	if _, err := c.GetBlob(context.Background(), testVault, testHash, &buf); err != nil {
		t.Fatalf("GetBlob: %v", err)
	}
	if buf.Len() != 8*1024 {
		t.Fatalf("got %d bytes, want %d", buf.Len(), 8*1024)
	}
}

// rewindingTransport loses the first connection after a few bytes of the
// upload and resends the body rewound through GetBody, as http.Transport does
// on a dead keep-alive connection, slowly but steadily.
type rewindingTransport struct{}

func (rewindingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	_, _ = req.Body.Read(make([]byte, 4))
	_ = req.Body.Close()
	body, err := req.GetBody()
	if err != nil {
		return nil, err
	}
	defer func() { _ = body.Close() }()
	buf := make([]byte, 4)
	for {
		select {
		case <-req.Context().Done():
			return nil, context.Cause(req.Context())
		case <-time.After(testIdleTO / 4):
		}
		if _, err := body.Read(buf); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, err
		}
	}
	return &http.Response{StatusCode: http.StatusCreated, Header: http.Header{}, Body: http.NoBody, Request: req}, nil
}

// The body the transport rewinds is watched too: its steady progress keeps
// the upload alive.
func TestRewoundUploadIsWatched(t *testing.T) {
	c, err := New("https://cloud.example", staticTokens("tok"), &http.Client{Transport: rewindingTransport{}, Timeout: testJSONTO}, "test-agent")
	if err != nil {
		t.Fatal(err)
	}
	c.Retries, c.TransferIdleTimeout, c.TransferHeaderTimeout = 0, testIdleTO, testHeaderTO
	start := time.Now()
	if err := c.PutBlob(context.Background(), testVault, testHash, bytes.Repeat([]byte("r"), 40)); err != nil {
		t.Fatalf("PutBlob failed after %s: %v", time.Since(start), err)
	}
	if el := time.Since(start); el < 2*testIdleTO {
		t.Fatalf("upload took %s: it does not exercise the idle timeout", el)
	}
}
