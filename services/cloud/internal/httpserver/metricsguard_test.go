package httpserver

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestInternalOnlyRefusesProxiedRequests(t *testing.T) {
	h := internalOnly(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) }))
	for name, hdr := range map[string]http.Header{
		"direct scrape":       {},
		"via ingress (XFF)":   {"X-Forwarded-For": {"203.0.113.9"}},
		"via proxy (RFC7239)": {"Forwarded": {"for=203.0.113.9"}},
	} {
		req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
		req.Header = hdr
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		want := http.StatusOK
		if name != "direct scrape" {
			want = http.StatusNotFound
		}
		if rec.Code != want {
			t.Errorf("%s: status %d, want %d", name, rec.Code, want)
		}
	}
}
