package httpserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/rs/zerolog"

	webembed "nodus/services/cloud/web-embed"
)

// The SPA is mounted behind the API: unknown non-API paths get the index, while
// the API keeps answering its own problem documents and /metrics stays reachable.
func TestRouterMountsWebUIBehindTheAPI(t *testing.T) {
	ui := webembed.Handler(webembed.Options{
		Issuer: "https://id.example.com/realms/nodus",
		FS:     fstest.MapFS{"index.html": {Data: []byte("<html>spa</html>")}},
	})
	r := NewRouter(Deps{Logger: zerolog.Nop(), WebUI: ui})

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	spa := get("/shares/abc")
	if spa.Code != http.StatusOK || !strings.Contains(spa.Body.String(), "spa") {
		t.Fatalf("SPA route: %d %q", spa.Code, spa.Body.String())
	}
	if !strings.Contains(spa.Header().Get("Content-Security-Policy"), "connect-src 'self' https://id.example.com;") {
		t.Fatalf("CSP: %q", spa.Header().Get("Content-Security-Policy"))
	}

	api := get("/api/v1/does-not-exist")
	if api.Code != http.StatusNotFound || !strings.HasPrefix(api.Header().Get("Content-Type"), "application/problem+json") {
		t.Fatalf("API 404 must stay a problem document: %d %q", api.Code, api.Header().Get("Content-Type"))
	}
	if strings.Contains(api.Body.String(), "<html>") {
		t.Fatal("the SPA shadowed an API path")
	}

	if m := get("/metrics"); m.Code != http.StatusOK || strings.Contains(m.Body.String(), "<html>") {
		t.Fatalf("/metrics: %d", m.Code)
	}
}
