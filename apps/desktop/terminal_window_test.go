package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/wailsapp/wails/v3/pkg/application"

	"clarae/apps/desktop/internal/app"
	"clarae/apps/desktop/internal/shell"
)

// The page of the separate terminal window is served by the asset server of the application, behind
// the same middleware as the main page: it carries the same Content-Security-Policy. A page that the
// build did not produce is a 404, not the main page under another URL.
func TestTerminalPageHasTheSameCSP(t *testing.T) {
	dist := fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>main</title>")},
		"terminal.html": {Data: []byte("<!doctype html><title>terminal</title>")},
	}
	srv := httptest.NewServer(assetMiddleware(shell.NewUploadStore())(application.BundledAssetFileServer(dist)))
	defer srv.Close()

	get := func(path string) *http.Response {
		t.Helper()
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = resp.Body.Close() })
		return resp
	}
	for _, page := range []string{"/", "/terminal.html"} {
		resp := get(page)
		if resp.StatusCode != http.StatusOK {
			t.Errorf("%s: status %d", page, resp.StatusCode)
		}
		if got := resp.Header.Get("Content-Security-Policy"); got != app.ContentSecurityPolicy || got == "" {
			t.Errorf("%s: CSP %q, want the policy of the application", page, got)
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s: no nosniff", page)
		}
	}
	if resp := get("/nowhere.html"); resp.StatusCode != http.StatusNotFound {
		t.Errorf("a page that does not exist answers %d, want 404", resp.StatusCode)
	}
}
