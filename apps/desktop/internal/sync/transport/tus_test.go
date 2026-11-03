//go:build !js

package transport

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strconv"
	stdsync "sync"
	"testing"
	"time"
)

// tusServer is a tus 1.0.0 server that keeps part of the first PATCH and then
// stops answering it, as a connection lost after the server stored some bytes.
type tusServer struct {
	t        *testing.T
	mismatch int // the status of an offset mismatch: 409 (tus) or 400 (the cloud)
	mu       stdsync.Mutex
	got      []byte
	patches  int
	heads    int
	size     int64
}

func (s *tusServer) handle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Tus-Resumable", "1.0.0")
	switch r.Method {
	case http.MethodPost:
		s.size, _ = strconv.ParseInt(r.Header.Get("Upload-Length"), 10, 64)
		w.Header().Set("Location", BasePath+"/vaults/"+testVault+"/uploads/u1")
		w.WriteHeader(http.StatusCreated)
	case http.MethodHead:
		s.mu.Lock()
		s.heads++
		w.Header().Set("Upload-Offset", strconv.Itoa(len(s.got)))
		s.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	case http.MethodPatch:
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return
		}
		offset, _ := strconv.Atoi(r.Header.Get("Upload-Offset"))
		s.mu.Lock()
		s.patches++
		first := s.patches == 1
		if offset != len(s.got) {
			w.Header().Set("Upload-Offset", strconv.Itoa(len(s.got)))
			s.mu.Unlock()
			w.WriteHeader(s.mismatch)
			return
		}
		if first {
			s.got = append(s.got, body[:len(body)/2]...)
		} else {
			s.got = append(s.got, body...)
		}
		w.Header().Set("Upload-Offset", strconv.Itoa(len(s.got)))
		s.mu.Unlock()
		if first {
			waitDone(r) // the answer never comes: the client's watchdog gives up and retries
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		s.t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusBadRequest)
	}
}

// A PATCH that stalls after the server kept part of it is sent again with the
// same Upload-Offset, which the server refuses: the upload goes on from the
// offset the server reports instead of failing.
func TestTusResumesFromTheServerOffsetAfterAStall(t *testing.T) {
	data := bytes.Repeat([]byte("0123456789abcdef"), 16<<10) // 256 KiB, one chunk
	for name, status := range map[string]int{"tus 409": http.StatusConflict, "cloud 400": http.StatusBadRequest} {
		t.Run(name, func(t *testing.T) {
			s := &tusServer{t: t, mismatch: status}
			c := newTransferClient(t, s.handle)
			c.TransferHeaderTimeout = testIdleTO
			var sent []int64
			loc, err := c.TusUpload(context.Background(), testVault, testHash, data, "", func(n int64) { sent = append(sent, n) })
			if err != nil {
				t.Fatalf("upload: %v", err)
			}
			if loc == "" {
				t.Fatal("no upload URL")
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			if !bytes.Equal(s.got, data) || s.size != int64(len(data)) {
				t.Fatalf("the server holds %d of %d bytes, or other bytes", len(s.got), len(data))
			}
			// The stalled PATCH, its retry refused for the offset, the rest.
			if s.patches != 3 || s.heads != 1 {
				t.Fatalf("%d PATCH and %d HEAD, want 3 and 1", s.patches, s.heads)
			}
			if len(sent) == 0 || sent[len(sent)-1] != int64(len(data)) {
				t.Fatalf("progress %v", sent)
			}
		})
	}
}

// An offset refused again and again (a server that keeps losing bytes) ends
// in an error instead of a loop.
func TestTusGivesUpOnARepeatedOffsetMismatch(t *testing.T) {
	c := newTransferClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Tus-Resumable", "1.0.0")
		switch r.Method {
		case http.MethodPost:
			w.Header().Set("Location", BasePath+"/vaults/"+testVault+"/uploads/u1")
			w.WriteHeader(http.StatusCreated)
		case http.MethodHead:
			w.Header().Set("Upload-Offset", "1")
			w.WriteHeader(http.StatusOK)
		default:
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Upload-Offset", "0")
			w.WriteHeader(http.StatusConflict)
		}
	})
	start := time.Now()
	if _, err := c.TusUpload(context.Background(), testVault, testHash, []byte("abc"), "", nil); err == nil {
		t.Fatal("an upload the server never accepts succeeded")
	}
	if el := time.Since(start); el > 5*time.Second {
		t.Fatalf("gave up after %s", el)
	}
}
