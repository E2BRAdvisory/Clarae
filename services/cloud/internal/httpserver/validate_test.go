package httpserver

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// countingReader records how many bytes were read before the handler ran.
type countingReader struct {
	r    io.Reader
	read int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.read += n
	return n, err
}

// Regression: the validator buffered every request body, a PUT blob included,
// before any size limit. Byte-stream bodies must reach the handler unread.
func TestValidatorDoesNotBufferBlobBodies(t *testing.T) {
	body := &countingReader{r: strings.NewReader(strings.Repeat("x", 1<<20))}
	var readBefore = -1
	h := requestValidator()(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		readBefore = body.read
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest(http.MethodPut, blobPath, body)
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if readBefore != 0 {
		t.Fatalf("validator read %d bytes of the blob body before the handler", readBefore)
	}
}

// JSON operations are still validated against the schema.
func TestValidatorStillChecksJSONBodies(t *testing.T) {
	called := false
	h := requestValidator()(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/vaults/0190f3c4-0000-7000-8000-000000000001/commit", strings.NewReader(`{"ops":"not-an-array"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if called || rec.Code != http.StatusBadRequest && rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("invalid commit body: called=%v status=%d", called, rec.Code)
	}
}
