package httpserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/shared/syncproto"
)

const blobPath = "/api/v1/vaults/0190f3c4-0000-7000-8000-000000000001/blobs/" +
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func TestIsStreaming(t *testing.T) {
	for path, want := range map[string]bool{
		blobPath:                                true,
		"/api/v1/vaults/v1/export.zip":          true,
		"/api/v1/vaults/v1/exports/e1/download": true,
		"/api/v1/me/export":                     true,
		"/api/v1/vaults/v1/blobs:check":         false,
		"/api/v1/vaults/v1/commit":              false,
		"/api/v1/vaults/v1/exports/e1":          false,
		"/api/v1/vaults":                        false,
		"/api/v1/me":                            false,
		"/vaults/v1/export.zip":                 false,
	} {
		if got := isStreaming(path); got != want {
			t.Errorf("isStreaming(%q) = %v, want %v", path, got, want)
		}
	}
}

// Regression (D1): a global 60 s timeout cut the SSE stream, tus uploads and
// large ZIP downloads. JSON operations keep a deadline, byte streams do not.
func TestAPILimitsDeadlineOnlyOnJSONOperations(t *testing.T) {
	var hasDeadline bool
	h := apiLimits(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, hasDeadline = r.Context().Deadline()
	}))
	for path, want := range map[string]bool{
		"/api/v1/vaults/v1/commit":     true,
		blobPath:                       false,
		"/api/v1/vaults/v1/export.zip": false,
	} {
		h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, path, nil))
		if hasDeadline != want {
			t.Errorf("%s: deadline = %v, want %v", path, hasDeadline, want)
		}
	}
}

// Routes outside the generated operations (SSE, tus, Web UI) get no router
// level deadline any more.
func TestRouterHasNoGlobalTimeout(t *testing.T) {
	var hasDeadline, served bool
	ui := http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		served = true
		_, hasDeadline = r.Context().Deadline()
	})
	NewRouter(Deps{Logger: zerolog.Nop(), WebUI: ui}).ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/vaults", nil))
	if !served || hasDeadline {
		t.Fatalf("served %v, deadline %v: the router still imposes a timeout", served, hasDeadline)
	}
}

// Regression (D7): JSON bodies were unbounded.
func TestAPILimitsRejectsLargeBodies(t *testing.T) {
	h := apiLimits(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err != nil {
			writeRequestError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	big := strings.Repeat("x", maxJSONBody+1)

	// Declared length: refused before reading.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/vaults/v1/commit", strings.NewReader(big)))
	assertProblem(t, rec, http.StatusRequestEntityTooLarge, syncproto.CodeFileTooLarge)

	// Unknown length (chunked): refused when the reader hits the limit.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/vaults/v1/commit", io.NopCloser(strings.NewReader(big)))
	req.ContentLength = -1
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusRequestEntityTooLarge, syncproto.CodeFileTooLarge)

	// At the limit: accepted.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/vaults/v1/commit", strings.NewReader(big[1:])))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("body of exactly %d bytes refused: %d", maxJSONBody, rec.Code)
	}

	// Blob uploads have their own cap and are not limited here.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPut, blobPath, strings.NewReader(big)))
	if rec.Code != http.StatusNoContent {
		t.Fatalf("blob upload limited by the JSON cap: %d", rec.Code)
	}
}

// The limits wrap the generated operations, ahead of authentication: an
// oversized body is refused without touching auth (nil in this router).
func TestRouterAppliesTheBodyLimit(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/vaults", strings.NewReader("{}"))
	req.ContentLength = maxJSONBody + 1
	rec := httptest.NewRecorder()
	NewRouter(Deps{Logger: zerolog.Nop()}).ServeHTTP(rec, req)
	assertProblem(t, rec, http.StatusRequestEntityTooLarge, syncproto.CodeFileTooLarge)
}

func assertProblem(t *testing.T, rec *httptest.ResponseRecorder, status int, code syncproto.Code) {
	t.Helper()
	var p syncproto.Problem
	if err := json.Unmarshal(rec.Body.Bytes(), &p); err != nil {
		t.Fatalf("status %d, body %q is not a problem document: %v", rec.Code, rec.Body.String(), err)
	}
	if rec.Code != status || p.Code != code {
		t.Fatalf("got %d %s, want %d %s", rec.Code, p.Code, status, code)
	}
}
