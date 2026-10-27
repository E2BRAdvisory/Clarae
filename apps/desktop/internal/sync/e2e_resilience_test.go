//go:build integration

package sync_test

// Network faults during pull (M7-WP2b): the connection is lost while the
// changelog is being paged or while a blob is being downloaded. The cursor
// must never move past changes that were fully applied, and a later run over
// a healthy network must converge to exactly the state of the other device.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	stdsync "sync"
	"testing"
	"time"

	syncpkg "nodus/apps/desktop/internal/sync"
	"nodus/apps/desktop/internal/sync/transport"
)

// faultTransport wraps the real transport. Once armed it fails every request
// that matches, so the client's own retries cannot hide the outage.
type faultTransport struct {
	base http.RoundTripper

	mu        stdsync.Mutex
	changes   int  // changes requests seen
	downloads int  // blob downloads seen
	cutChange int  // fail changes requests from this call on (0 = never)
	cutBlob   int  // damage blob downloads from this call on (0 = never)
	silent    bool // truncate the body but end the stream cleanly (no error)
	injected  int
}

func (f *faultTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	f.mu.Lock()
	switch {
	case strings.Contains(req.URL.Path, "/changes"):
		f.changes++
		if f.cutChange > 0 && f.changes >= f.cutChange {
			f.injected++
			f.mu.Unlock()
			return nil, errors.New("read tcp: connection reset by peer")
		}
	case strings.Contains(req.URL.Path, "/blobs/") && req.Method == http.MethodGet:
		f.downloads++
		if f.cutBlob > 0 && f.downloads >= f.cutBlob {
			f.injected++
			silent := f.silent
			f.mu.Unlock()
			resp, err := f.base.RoundTrip(req)
			if err != nil {
				return nil, err
			}
			resp.Body = &cutBody{rc: resp.Body, left: 5, silent: silent}
			return resp, nil
		}
	}
	f.mu.Unlock()
	return f.base.RoundTrip(req)
}

// heal restores the network.
func (f *faultTransport) heal() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cutChange, f.cutBlob = 0, 0
}

func (f *faultTransport) injections() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.injected
}

// cutBody delivers a few bytes and then either fails or ends early.
type cutBody struct {
	rc     io.ReadCloser
	left   int
	silent bool
}

func (c *cutBody) Read(p []byte) (int, error) {
	if c.left <= 0 {
		if c.silent {
			return 0, io.EOF
		}
		return 0, io.ErrUnexpectedEOF
	}
	if len(p) > c.left {
		p = p[:c.left]
	}
	n, err := c.rc.Read(p)
	c.left -= n
	return n, err
}

func (c *cutBody) Close() error { return c.rc.Close() }

// flakyDevice is a device whose engine talks to the server through ft.
func flakyDevice(t *testing.T, user, name, vaultID string) (*device, *faultTransport) {
	t.Helper()
	d := newDevice(t, user, name, vaultID, nil)
	ft := &faultTransport{base: http.DefaultTransport}
	c, err := transport.New(serverURL, tokens{user}, &http.Client{Timeout: 2 * time.Minute, Transport: ft}, "e2e-flaky")
	if err != nil {
		t.Fatal(err)
	}
	c.Retries = 1
	d.remote.Remote = syncpkg.HTTPRemote{C: c, Vault: vaultID}
	return d, ft
}

func writeMany(d *device, n int, tag string) {
	for i := 0; i < n; i++ {
		d.write(fmt.Sprintf("bulk/%s-%04d.md", tag, i), fmt.Sprintf("note %s %d\n%s", tag, i, strings.Repeat("x", i%50)))
	}
}

func cursorOf(t *testing.T, d *device) int64 {
	t.Helper()
	c, err := d.db.Cursor(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func syncErr(d *device) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	return d.eng.Sync(ctx)
}

func assertSameFiles(t *testing.T, a, b *device) {
	t.Helper()
	fa, fb := a.files(), b.files()
	if len(fa) != len(fb) {
		t.Fatalf("%s has %d files, %s has %d", a.name, len(fa), b.name, len(fb))
	}
	for p, content := range fa {
		if got, ok := fb[p]; !ok || got != content {
			t.Fatalf("%s differs between devices", p)
		}
	}
}

// The changelog is paged (500 per request). The connection dies on the second
// page: page one stays applied and the cursor sits exactly after it.
func TestPullConnectionLostBetweenPages(t *testing.T) {
	v := createVault(t, "ada", "flaky-pages")
	a := newDevice(t, "ada", "A", v, nil)
	b, ft := flakyDevice(t, "ada", "B", v)
	b.sync() // bootstrap on the empty vault: later syncs use the changelog

	writeMany(a, 650, "p")
	a.sync()
	start := cursorOf(t, b)

	ft.mu.Lock()
	ft.cutChange = ft.changes + 2 // first page passes, the second one is cut
	ft.mu.Unlock()
	err := syncErr(b)
	if ft.injections() == 0 {
		t.Fatal("no request was cut: fault not injected")
	}
	if err == nil {
		t.Fatal("sync succeeded although the connection was lost")
	}
	mid := cursorOf(t, b)
	if mid <= start || mid >= cursorOf(t, a) {
		t.Fatalf("cursor %d must be after the first page (start %d) and before the end (%d)", mid, start, cursorOf(t, a))
	}
	// Everything the cursor claims is really on disk: 500 changes -> 500 files.
	if got := len(b.files()); got != int(mid-start) {
		t.Fatalf("cursor advanced by %d but %d files were applied", mid-start, got)
	}

	ft.heal()
	b.sync()
	assertSameFiles(t, a, b)
	if len(b.conflicts) != 0 {
		t.Fatalf("interrupted pull produced %d conflicts", len(b.conflicts))
	}
	if cursorOf(t, b) < cursorOf(t, a) {
		t.Fatalf("cursor %d did not reach the end after the retry", cursorOf(t, b))
	}
}

// The connection dies (or the body is silently truncated) in the middle of a
// download: the file is not written half, the cursor does not move past the
// page, and the next run converges.
func TestPullDownloadInterrupted(t *testing.T) {
	for _, silent := range []bool{false, true} {
		name := "error"
		if silent {
			name = "silent-truncation"
		}
		t.Run(name, func(t *testing.T) {
			v := createVault(t, "ada", "flaky-dl-"+name)
			a := newDevice(t, "ada", "A", v, nil)
			b, ft := flakyDevice(t, "ada", "B", v)
			b.sync()
			writeMany(a, 120, "d")
			a.sync()
			start := cursorOf(t, b)

			ft.mu.Lock()
			ft.cutBlob, ft.silent = ft.downloads+60, silent
			ft.mu.Unlock()
			err := syncErr(b)
			if ft.injections() == 0 {
				t.Fatal("no download was damaged: fault not injected")
			}
			if err == nil {
				t.Fatal("sync succeeded although a download was damaged")
			}
			// The whole page was not applied: the cursor stays where it was.
			if got := cursorOf(t, b); got != start {
				t.Fatalf("cursor moved from %d to %d although the page was not fully applied", start, got)
			}
			// No half-written file: whatever exists is complete.
			for p, content := range b.files() {
				if want, ok := a.files()[p]; !ok || want != content {
					t.Fatalf("%s on B is not a complete copy of A's file (%d bytes)", p, len(content))
				}
			}
			ft.heal()
			b.sync()
			assertSameFiles(t, a, b)
			if len(b.conflicts) != 0 {
				t.Fatalf("interrupted download produced %d conflicts", len(b.conflicts))
			}
		})
	}
}

// Losing the connection while pushing: the commit may or may not have been
// applied; retrying must not duplicate (op_id idempotence) and both devices
// converge.
func TestPushConnectionLostAfterApplyIsIdempotent(t *testing.T) {
	v := createVault(t, "ada", "flaky-push")
	a := newDevice(t, "ada", "A", v, nil)
	b := newDevice(t, "ada", "B", v, nil)
	writeMany(a, 30, "push")
	a.remote.loseNextCommit = true // the server applies the batch, the answer is lost
	if err := syncErr(a); err == nil {
		t.Fatal("expected the lost answer to fail the sync")
	}
	if a.remote.commits == 0 {
		t.Fatal("no commit was sent")
	}
	a.sync()
	b.sync()
	assertSameFiles(t, a, b)
	if n := len(b.files()); n != 30 {
		t.Fatalf("B has %d files, want 30 (duplicates or losses)", n)
	}
	if !bytes.Equal([]byte(a.read("bulk/push-0007.md")), []byte(b.read("bulk/push-0007.md"))) {
		t.Fatal("content differs")
	}
}
