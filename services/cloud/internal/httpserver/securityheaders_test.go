package httpserver

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/rs/zerolog"
)

// Every response class carries the baseline headers: API success and errors,
// the 404 of unknown API paths and metrics.
func TestEveryResponseCarriesTheSecurityHeaders(t *testing.T) {
	r := NewRouter(Deps{Logger: zerolog.Nop()})
	for _, c := range []struct{ method, path string }{
		{http.MethodGet, "/api/v1/does-not-exist"},
		{http.MethodGet, "/metrics"},
		{http.MethodPost, "/api/v1/vaults"},
		{http.MethodDelete, "/api/v1/me"},
		{http.MethodGet, "/nothing-here"},
	} {
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(c.method, c.path, nil))
		h := rec.Header()
		if h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Referrer-Policy") != "no-referrer" || h.Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s %s (%d): missing security headers: %v", c.method, c.path, rec.Code, h)
		}
	}
}
