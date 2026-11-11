package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"memobrain/apps/desktop/internal/app"
	"memobrain/apps/desktop/internal/shell"
)

// B-W4b: a call whose arguments are larger than the transport of Wails takes (64 MiB per request)
// goes through an upload. These tests do what the shim does, against the real core and the real
// asset-server middleware, without a window: BeginUpload, the chunks over HTTP, CallUploaded.

// uploadedCall is the shim's side of an upload: it announces len(body) bytes, sends them in chunks
// of shell.MaxUploadChunk to the asset server at srvURL, and asks for the call.
func uploadedCall(t testing.TB, b *CoreBridge, srvURL, service, method string, body []byte) (json.RawMessage, error) {
	t.Helper()
	id, err := b.BeginUpload(int64(len(body)))
	if err != nil {
		return nil, err
	}
	began := time.Now()
	for off := 0; off < len(body); off += shell.MaxUploadChunk {
		end := min(off+shell.MaxUploadChunk, len(body))
		resp, err := http.Post(fmt.Sprintf("%s%s%s?offset=%d", srvURL, shell.UploadPath, id, off), "application/octet-stream", bytes.NewReader(body[off:end]))
		if err != nil {
			b.AbortUpload(id)
			return nil, err
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNoContent {
			b.AbortUpload(id)
			return nil, fmt.Errorf("chunk at %d: HTTP %d", off, resp.StatusCode)
		}
		if got := resp.Header.Get("Content-Security-Policy"); got != app.ContentSecurityPolicy {
			t.Fatalf("the chunk response carries CSP %q: the policy must be the same as the assets'", got)
		}
	}
	t.Logf("  chunks sent in %v", time.Since(began).Round(time.Millisecond))
	return b.CallUploaded(service, method, id)
}

// exportDoc is a standalone HTML document of size bytes: a few tags around lines of text with
// quotes and line breaks (JSON escapes both, so the arguments are larger than the document). The
// time the binding takes to check a document grows with its tags, not with its size, and it is not
// what these tests are about.
func exportDoc(size int) string {
	const head, tail = "<!doctype html><html><body><pre>", "</pre></body></html>"
	line := "She said \"hello\" and left, caf\u00e9.\n"
	var sb strings.Builder
	sb.Grow(size)
	sb.WriteString(head)
	for sb.Len()+len(line)+len(tail) <= size {
		sb.WriteString(line)
	}
	sb.WriteString(tail)
	return sb.String()
}

// peakHeap samples the heap while f runs; the figure is the largest HeapInuse seen, minus the
// heap before, in MiB.
func peakHeap(f func()) (peakMiB float64) {
	runtime.GC()
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	base := m.HeapInuse
	var peak atomic.Uint64
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		var s runtime.MemStats
		for {
			runtime.ReadMemStats(&s)
			if s.HeapInuse > peak.Load() {
				peak.Store(s.HeapInuse)
			}
			select {
			case <-done:
				return
			case <-time.After(20 * time.Millisecond):
			}
		}
	}()
	f()
	close(done)
	<-stopped
	return (float64(peak.Load()) - float64(base)) / (1 << 20)
}

func TestUploadedSaveHTMLBeyondTheTransportLimit(t *testing.T) {
	if testing.Short() {
		t.Skip("exports of hundreds of MiB")
	}
	b, _, _, h := newBridge(t, t.TempDir())
	srv := httptest.NewServer(assetMiddleware(b.uploads)(http.NotFoundHandler()))
	t.Cleanup(srv.Close)

	root := filepath.Join(t.TempDir(), "vault")
	info := call[app.VaultInfo](t, b, "VaultAPI", "OpenVault", root)

	// 65 and 200 MiB are the sizes of the spike, which failed on Wails' transport; the largest is
	// just under maxExportHTML (256 MiB), except under the race detector (see race_on_test.go).
	sizes := []int{65}
	if largeUploadMiB > 65 {
		sizes = append(sizes, 200, largeUploadMiB)
	}
	for _, mib := range sizes {
		t.Run(fmt.Sprintf("%dMiB", mib), func(t *testing.T) {
			doc := exportDoc(mib << 20)
			dest := filepath.Join(t.TempDir(), "out.html")
			h.mu.Lock()
			h.saveTo = dest
			h.mu.Unlock()
			args, err := json.Marshal([]any{info.ID, "big note", doc})
			if err != nil {
				t.Fatal(err)
			}
			if len(args) <= 64<<20 {
				t.Fatalf("the arguments are %d bytes: not beyond the transport limit", len(args))
			}

			var out json.RawMessage
			var callErr error
			start := time.Now()
			peak := peakHeap(func() { out, callErr = uploadedCall(t, b, srv.URL, "ExportAPI", "SaveHTML", args) })
			if callErr != nil {
				t.Fatal(callErr)
			}
			t.Logf("%d MiB (%d bytes of JSON): %v, peak heap +%.0f MiB", mib, len(args), time.Since(start).Round(time.Millisecond), peak)

			var res app.ExportResult
			if err := json.Unmarshal(out, &res); err != nil || res.Cancelled {
				t.Fatalf("result %s: %v", out, err)
			}
			got, err := os.ReadFile(dest)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != doc {
				t.Fatalf("the file written is not the document: %d bytes against %d", len(got), len(doc))
			}
			if n := b.uploads.Len(); n != 0 {
				t.Fatalf("%d uploads left", n)
			}
		})
	}
}

// The core still refuses what it always refused: the upload is a way in for the bytes, not a way
// round the checks of the binding.
func TestUploadedCallKeepsTheChecksOfTheBinding(t *testing.T) {
	b, _, _, h := newBridge(t, t.TempDir())
	srv := httptest.NewServer(assetMiddleware(b.uploads)(http.NotFoundHandler()))
	t.Cleanup(srv.Close)
	info := call[app.VaultInfo](t, b, "VaultAPI", "OpenVault", filepath.Join(t.TempDir(), "vault"))
	h.saveTo = filepath.Join(t.TempDir(), "out.html")

	args, _ := json.Marshal([]any{info.ID, "n", "<p>x</p><script>alert(1)</script>"})
	if _, err := uploadedCall(t, b, srv.URL, "ExportAPI", "SaveHTML", args); err == nil || !strings.Contains(err.Error(), "not self-contained") {
		t.Fatalf("a script in an uploaded export: %v", err)
	}
	if _, err := uploadedCall(t, b, srv.URL, "NoSuchAPI", "Nothing", []byte("[]")); err == nil || !strings.Contains(err.Error(), "unknown service") {
		t.Fatalf("an unknown service: %v", err)
	}
	if _, err := uploadedCall(t, b, srv.URL, "ExportAPI", "SaveHTML", []byte("not json")); err == nil {
		t.Fatal("malformed arguments must be refused")
	}
	if _, err := b.CallUploaded("ExportAPI", "SaveHTML", "no such upload"); err == nil {
		t.Fatal("a call on an unknown upload must be refused")
	}
	if _, err := b.BeginUpload(shell.MaxUploadBytes + 1); err == nil {
		t.Fatal("an upload above the limit must be refused")
	}
}
