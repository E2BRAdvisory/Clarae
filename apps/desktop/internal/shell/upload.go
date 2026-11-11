//go:build !js

package shell

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The calls of the web view reach the core through Wails' HTTP transport, which refuses a request
// of more than 64 MiB (maxRuntimeBodyBytes, "assembled body too large"), while the export of a note
// as HTML accepts documents of 256 MiB (ExportAPI.SaveHTML). A call whose arguments are larger than
// the transport takes goes instead through an upload (B-W4b, ADR-0051): the shim asks for one
// (CoreBridge.BeginUpload), sends the arguments in chunks of at most MaxUploadChunk bytes to
// UploadPath on the asset server of the application, the same origin as /wails/runtime (so the
// Content-Security-Policy is unchanged) and the same kind of request the runtime makes to get around
// the limit of WebView2 on a request body, and then asks the core to run the call on what it has
// received (CoreBridge.CallUploaded). The bytes stay in memory, never on disk: a copy of a private
// vault's note in a temporary file would outlive a crash.

const (
	// UploadPath is the prefix of the URLs of the chunks: UploadPath + id, POST, ?offset=<n>.
	UploadPath = "/memobrain/upload/"
	// MaxUploadBytes is the largest body of an upload: the export of 256 MiB (maxExportHTML), plus
	// the escapes JSON adds to the quotes and the line breaks of a document.
	MaxUploadBytes = 320 << 20
	// MaxUploadChunk is the largest chunk. WebView2 delivers about 2 MiB of a request body at most.
	MaxUploadChunk = 1 << 20

	maxUploadsInFlight = 2
	maxPendingBytes    = 2 * MaxUploadBytes
	uploadIdle         = 30 * time.Second
)

// UploadStore holds the uploads in progress. The id that BeginUpload hands to the page is the
// capability to write to the upload (128 random bits): another page, or a frame, cannot guess it.
type UploadStore struct {
	mu      sync.Mutex
	uploads map[string]*upload
	pending int64 // bytes promised by the uploads in progress
	idle    time.Duration
}

type upload struct {
	mu    sync.Mutex // one chunk at a time
	buf   []byte
	total int64
	timer *time.Timer
	done  bool // taken or dropped: a late chunk finds nothing
}

// NewUploadStore is an empty store.
func NewUploadStore() *UploadStore {
	return &UploadStore{uploads: map[string]*upload{}, idle: uploadIdle}
}

// Begin reserves an upload of total bytes and returns its id. It refuses a size outside
// (0, MaxUploadBytes] and, with too many uploads in flight, one more (a page that begins uploads
// and never sends cannot grow the memory of the process: the reservation expires too).
func (s *UploadStore) Begin(total int64) (string, error) {
	if total <= 0 || total > MaxUploadBytes {
		return "", fmt.Errorf("upload of %d bytes: the limit is %d MiB", total, MaxUploadBytes>>20)
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("upload id: %w", err)
	}
	id := hex.EncodeToString(raw[:])

	s.mu.Lock()
	if len(s.uploads) >= maxUploadsInFlight || s.pending+total > maxPendingBytes {
		s.mu.Unlock()
		return "", errors.New("too many uploads in progress")
	}
	u := &upload{total: total}
	// The capacity is reserved, not touched: the operating system commits the pages as they fill.
	u.buf = make([]byte, 0, total)
	s.uploads[id] = u
	s.pending += total
	s.mu.Unlock()

	// The timer comes after the upload is in the map (and its callback takes the upload's lock
	// before the store's, so it cannot be armed while the store is locked).
	u.mu.Lock()
	u.timer = time.AfterFunc(s.idle, func() { s.drop(id, u) })
	u.mu.Unlock()
	return id, nil
}

// drop forgets an upload (idle too long, or aborted). A chunk that is being written finishes first.
func (s *UploadStore) drop(id string, u *upload) {
	u.mu.Lock()
	defer u.mu.Unlock()
	s.release(id, u)
}

// release removes u under u.mu. The store lock comes after the upload's, never the other way round.
func (s *UploadStore) release(id string, u *upload) {
	if u.done {
		return
	}
	u.done = true
	u.timer.Stop()
	u.buf = nil
	s.mu.Lock()
	if s.uploads[id] == u {
		delete(s.uploads, id)
		s.pending -= u.total
	}
	s.mu.Unlock()
}

func (s *UploadStore) lookup(id string) *upload {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.uploads[id]
}

// Len is the number of uploads in progress.
func (s *UploadStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.uploads)
}

// Abort drops an upload; an unknown id is not an error (the page may abort after the timeout).
func (s *UploadStore) Abort(id string) {
	if u := s.lookup(id); u != nil {
		s.drop(id, u)
	}
}

// Take hands over the bytes of a complete upload and forgets it. An incomplete one is dropped too:
// the call it was for cannot run on a part of its arguments.
func (s *UploadStore) Take(id string) ([]byte, error) {
	u := s.lookup(id)
	if u == nil {
		return nil, errors.New("unknown or expired upload")
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return nil, errors.New("unknown or expired upload")
	}
	buf, total := u.buf, u.total // release forgets the buffer; the caller owns it now
	s.release(id, u)
	if int64(len(buf)) != total {
		return nil, fmt.Errorf("incomplete upload: %d of %d bytes", len(buf), total)
	}
	return buf, nil
}

// append adds one chunk at offset, which must be where the upload stands (the page sends them in
// order, one at a time): a gap or an overlap means the page and the core disagree and the upload is
// dropped.
func (s *UploadStore) append(id string, offset int64, body io.Reader) (int, string) {
	u := s.lookup(id)
	if u == nil {
		return http.StatusNotFound, "unknown or expired upload"
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.done {
		return http.StatusNotFound, "unknown or expired upload"
	}
	if offset != int64(len(u.buf)) {
		s.release(id, u)
		return http.StatusConflict, "chunk out of order"
	}
	// The chunk is read straight into the room of the buffer: no copy, no garbage per chunk.
	room := min(int64(MaxUploadChunk), u.total-offset)
	n, err := io.ReadFull(body, u.buf[len(u.buf):int64(len(u.buf))+room])
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		s.release(id, u)
		return http.StatusBadRequest, "unable to read the chunk"
	}
	var probe [1]byte
	if m, _ := body.Read(probe[:]); m > 0 {
		s.release(id, u)
		return http.StatusRequestEntityTooLarge, "chunk too large or more bytes than announced"
	}
	u.buf = u.buf[:len(u.buf)+n]
	u.timer.Reset(s.idle)
	return http.StatusNoContent, ""
}

// Middleware is the asset-server middleware that receives the chunks; every other request goes on.
func (s *UploadStore) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, ok := strings.CutPrefix(r.URL.Path, UploadPath)
			if !ok {
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", http.MethodPost)
				http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)
				return
			}
			offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
			if err != nil || offset < 0 {
				http.Error(w, "invalid offset", http.StatusBadRequest)
				return
			}
			code, msg := s.append(id, offset, http.MaxBytesReader(w, r.Body, MaxUploadChunk+1))
			if msg != "" {
				http.Error(w, msg, code)
				return
			}
			w.WriteHeader(code)
		})
	}
}
