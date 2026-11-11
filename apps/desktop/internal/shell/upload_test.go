//go:build !js

package shell

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func post(t *testing.T, h http.Handler, id string, offset int64, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, UploadPath+id+"?offset="+strconv.FormatInt(offset, 10), bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func newHandler(s *UploadStore) http.Handler {
	return s.Middleware()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTeapot) // "the rest of the asset server"
	}))
}

func TestUploadRoundTripInChunks(t *testing.T) {
	s := NewUploadStore()
	h := newHandler(s)
	data := bytes.Repeat([]byte("0123456789"), MaxUploadChunk/10*2+7) // two full chunks and a tail
	id, err := s.Begin(int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	for off := 0; off < len(data); off += MaxUploadChunk {
		end := min(off+MaxUploadChunk, len(data))
		if rec := post(t, h, id, int64(off), data[off:end]); rec.Code != http.StatusNoContent {
			t.Fatalf("chunk at %d: %d %s", off, rec.Code, rec.Body)
		}
	}
	got, err := s.Take(id)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("Take: %v, equal=%v", err, bytes.Equal(got, data))
	}
	if _, err := s.Take(id); err == nil {
		t.Fatal("an upload is consumed by Take")
	}
	if rec := post(t, h, id, 0, []byte("x")); rec.Code != http.StatusNotFound {
		t.Fatalf("a chunk for a consumed upload: %d", rec.Code)
	}
	if s.pending != 0 || len(s.uploads) != 0 {
		t.Fatalf("the store keeps %d bytes in %d uploads", s.pending, len(s.uploads))
	}
}

func TestUploadRefusesWhatDoesNotFit(t *testing.T) {
	s := NewUploadStore()
	h := newHandler(s)
	for _, total := range []int64{0, -1, MaxUploadBytes + 1} {
		if _, err := s.Begin(total); err == nil {
			t.Errorf("Begin(%d) must fail", total)
		}
	}
	cases := []struct {
		name   string
		total  int64
		chunks [][]byte // sent in order at the running offset, unless offsetAt says otherwise
		offset int64
		want   int
	}{
		{"gap", 10, [][]byte{[]byte("abc")}, 5, http.StatusConflict},
		{"overlap", 10, [][]byte{[]byte("abc"), []byte("def")}, 1, http.StatusConflict},
		{"more than announced", 4, [][]byte{[]byte("abcde")}, 0, http.StatusRequestEntityTooLarge},
		{"chunk too large", MaxUploadChunk * 3, [][]byte{make([]byte, MaxUploadChunk+1)}, 0, http.StatusRequestEntityTooLarge},
	}
	for _, c := range cases {
		id, err := s.Begin(c.total)
		if err != nil {
			t.Fatal(err)
		}
		off, code := int64(0), 0
		for i, chunk := range c.chunks {
			at := off
			if i == len(c.chunks)-1 && c.offset != 0 {
				at = c.offset
			}
			if code = post(t, h, id, at, chunk).Code; code != http.StatusNoContent {
				break
			}
			off += int64(len(chunk))
		}
		if code != c.want {
			t.Errorf("%s: %d, want %d", c.name, code, c.want)
		}
		// A refused chunk drops the upload: the page must start over, never run a call on a hole.
		if _, err := s.Take(id); err == nil {
			t.Errorf("%s: the upload survived a refused chunk", c.name)
		}
	}
	if s.pending != 0 {
		t.Fatalf("%d bytes still reserved", s.pending)
	}
}

func TestUploadTakeRefusesAnIncompleteUpload(t *testing.T) {
	s := NewUploadStore()
	id, _ := s.Begin(10)
	if rec := post(t, newHandler(s), id, 0, []byte("abc")); rec.Code != http.StatusNoContent {
		t.Fatal(rec.Code)
	}
	if _, err := s.Take(id); err == nil || !strings.Contains(err.Error(), "incomplete") {
		t.Fatalf("Take of 3 bytes of 10: %v", err)
	}
	if s.pending != 0 {
		t.Fatal("an incomplete upload is dropped by Take")
	}
}

func TestUploadLimitsInFlightAndAbort(t *testing.T) {
	s := NewUploadStore()
	a, err := s.Begin(MaxUploadBytes)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Begin(MaxUploadBytes); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Begin(1); err == nil {
		t.Fatal("a third upload must wait")
	}
	s.Abort(a)
	s.Abort(a) // idempotent
	s.Abort("no such id")
	if _, err := s.Begin(1); err != nil {
		t.Fatalf("a slot is free after Abort: %v", err)
	}
}

func TestUploadExpiresWhenIdle(t *testing.T) {
	s := NewUploadStore()
	s.idle = 40 * time.Millisecond
	id, _ := s.Begin(100)
	h := newHandler(s)
	// Activity keeps it alive past one idle period...
	for range 3 {
		time.Sleep(25 * time.Millisecond)
		if rec := post(t, h, id, 0, nil); rec.Code != http.StatusNoContent {
			t.Fatalf("an upload with activity expired: %d", rec.Code)
		}
	}
	// ...silence does not.
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		n, pending := len(s.uploads), s.pending
		s.mu.Unlock()
		if n == 0 && pending == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("an idle upload is never dropped")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := s.Take(id); err == nil {
		t.Fatal("an expired upload cannot be taken")
	}
}

func TestUploadMiddlewareRouting(t *testing.T) {
	s := NewUploadStore()
	h := newHandler(s)
	// Everything else goes to the asset server.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/index.html", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("/index.html: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/wails/runtime", nil))
	if rec.Code != http.StatusTeapot {
		t.Fatalf("/wails/runtime must pass: %d", rec.Code)
	}
	id, _ := s.Begin(4)
	for _, c := range []struct {
		method, url string
		want        int
	}{
		{http.MethodGet, UploadPath + id + "?offset=0", http.StatusMethodNotAllowed},
		{http.MethodPut, UploadPath + id + "?offset=0", http.StatusMethodNotAllowed},
		{http.MethodPost, UploadPath + id, http.StatusBadRequest},
		{http.MethodPost, UploadPath + id + "?offset=-1", http.StatusBadRequest},
		{http.MethodPost, UploadPath + id + "?offset=abc", http.StatusBadRequest},
		{http.MethodPost, UploadPath + "nope?offset=0", http.StatusNotFound},
		{http.MethodPost, UploadPath + "?offset=0", http.StatusNotFound},
		{http.MethodPost, UploadPath + "../" + id + "?offset=0", http.StatusNotFound},
	} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(c.method, c.url, strings.NewReader("ab")))
		if rec.Code != c.want {
			t.Errorf("%s %s: %d, want %d", c.method, c.url, rec.Code, c.want)
		}
	}
	// None of the refusals above was a chunk that reached the upload.
	if got := post(t, h, id, 0, []byte("abcd")); got.Code != http.StatusNoContent {
		t.Fatalf("the upload was disturbed: %d", got.Code)
	}
}

func TestUploadConcurrentChunksAreSerialised(t *testing.T) {
	s := NewUploadStore()
	h := newHandler(s)
	id, _ := s.Begin(8)
	var wg sync.WaitGroup
	codes := make(chan int, 4)
	for range 4 { // all at offset 0: exactly one wins, the rest find the upload gone or out of order
		wg.Add(1)
		go func() {
			defer wg.Done()
			codes <- post(t, h, id, 0, []byte("abcd")).Code
		}()
	}
	wg.Wait()
	close(codes)
	ok := 0
	for c := range codes {
		if c == http.StatusNoContent {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("%d chunks accepted at the same offset", ok)
	}
}
