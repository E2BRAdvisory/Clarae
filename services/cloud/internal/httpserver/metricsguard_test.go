package httpserver

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rs/zerolog"

	"memobrain/services/cloud/internal/system"
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

// Through the router: /readyz lists the failing check only to direct internal callers; the
// internet and anything relayed by the ingress see the bare status, never the error text.
func TestReadyzDetailsOnlyForDirectInternalCallers(t *testing.T) {
	sys := system.NewHTTP("v1", system.ClientConfig{},
		system.CheckerFunc{N: "database", F: func(context.Context) error { return errors.New("dial tcp 10.9.8.7:5432: refused") }})
	r := NewRouter(Deps{Logger: zerolog.Nop(), System: sys})
	for _, c := range []struct {
		name, peer, xff string
		details         bool
	}{
		{"kubelet on the node", "10.0.0.1:5000", "", true},
		{"loopback", "127.0.0.1:5000", "", true},
		{"internet", "203.0.113.9:5000", "", false},
		{"via ingress", "10.0.0.2:5000", "203.0.113.9", false},
	} {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/readyz", nil)
		req.RemoteAddr = c.peer
		if c.xff != "" {
			req.Header.Set("X-Forwarded-For", c.xff)
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		body := rec.Body.String()
		if rec.Code != http.StatusServiceUnavailable || !strings.Contains(body, `"unavailable"`) {
			t.Fatalf("%s: %d %s", c.name, rec.Code, body)
		}
		if got := strings.Contains(body, "10.9.8.7"); got != c.details {
			t.Errorf("%s: details shown %v, want %v (%s)", c.name, got, c.details, body)
		}
	}
}
